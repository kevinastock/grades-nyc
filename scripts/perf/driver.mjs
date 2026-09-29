import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cumulativeLayoutShift,
  fixtureRequest,
  profiles,
  readJson,
  writeJson,
} from "./common.mjs";

const deltaCounts = (before, after) =>
  Object.fromEntries(
    Object.entries(after)
      .map(([url, count]) => [
        url,
        {
          requests: count.requests - (before[url]?.requests || 0),
          encodedBytes: count.encodedBytes - (before[url]?.encodedBytes || 0),
        },
      ])
      .filter(([, value]) => value.requests),
  );

export async function trial({
  output,
  server,
  name,
  profile,
  gpu = "auto",
  browserPath,
  theme = "light",
  hash = "",
  trace = false,
  priming = false,
}) {
  const requested = profiles[profile];
  if (!requested) throw new Error(`Unknown profile: ${profile}`);
  const settings = priming
    ? { ...requested, cpu: 1, latency: 0, kbps: 0 }
    : requested;
  const backend =
    gpu === "auto" ? (process.platform === "darwin" ? "metal" : "native") : gpu;
  if (!["metal", "native", "software"].includes(backend))
    throw new Error("GPU must be auto, metal, native or software.");
  if (backend === "metal" && process.platform !== "darwin")
    throw new Error("Metal is available only on macOS.");
  const tag = `${name}-${profile}-${theme}-${backend}-${Date.now()}`;
  const directory = path.join(output, priming ? "recordings" : "results");
  await mkdir(directory, { recursive: true });
  const caseMetadata = await readJson(
    path.join(output, "cases", `${name}.json`),
  );
  const before = await fixtureRequest(server.origin, "/__perf/stats");
  const flags = [`--ignore-certificate-errors-spki-list=${server.spki}`];
  if (backend === "metal") flags.push("--use-angle=metal");
  if (backend === "software")
    flags.push("--use-angle=swiftshader", "--enable-unsafe-swiftshader");
  // A new browser for every trial also isolates browser-wide compiled-code
  // caches. Server response bodies stay warm; browser caches begin empty.
  const browser = await chromium.launch({
    headless: true,
    executablePath: browserPath,
    args: flags,
  });
  const errors = [],
    requests = [],
    network = [],
    consoleMessages = [];
  const pendingRequests = [];
  const startedAt = new Date().toISOString();
  let page,
    cdp,
    tracing = false,
    failure = null,
    value = null,
    perf = null;
  try {
    const context = await browser.newContext({
      viewport: { width: settings.width, height: settings.height },
      deviceScaleFactor: settings.dpr,
      colorScheme: theme,
      ignoreHTTPSErrors: false,
    });
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()))
        consoleMessages.push({ type: message.type(), text: message.text() });
    });
    page.on("requestfailed", (request) =>
      errors.push(`${request.url()}: ${request.failure()?.errorText}`),
    );
    page.on("requestfinished", (request) => {
      pendingRequests.push(
        (async () => {
          const response = await request.response();
          if (response?.status() >= 400)
            errors.push(`${response.status()}: ${request.url()}`);
          requests.push({
            url: request.url(),
            timing: request.timing(),
            sizes: await request.sizes().catch(() => null),
            status: response?.status(),
            fromServiceWorker: response?.fromServiceWorker(),
          });
        })(),
      );
    });
    cdp.on("Network.requestWillBeSent", (event) =>
      network.push({
        event: "request",
        id: event.requestId,
        url: event.request.url,
        type: event.type,
        timestamp: event.timestamp,
        priority: event.request.initialPriority,
        initiator: event.initiator.type,
      }),
    );
    cdp.on("Network.responseReceived", (event) =>
      network.push({
        event: "response",
        id: event.requestId,
        url: event.response.url,
        timestamp: event.timestamp,
        protocol: event.response.protocol,
        fromDiskCache: event.response.fromDiskCache,
        fromServiceWorker: event.response.fromServiceWorker,
        encodedDataLength: event.response.encodedDataLength,
        headers: Object.fromEntries(
          Object.entries(event.response.headers).filter(([key]) =>
            /^(content-encoding|cache-control|vary)$/i.test(key),
          ),
        ),
      }),
    );
    cdp.on("Network.requestServedFromCache", (event) =>
      network.push({ event: "cache", id: event.requestId }),
    );
    cdp.on("Network.loadingFinished", (event) =>
      network.push({
        event: "finished",
        id: event.requestId,
        timestamp: event.timestamp,
        encodedDataLength: event.encodedDataLength,
      }),
    );
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: settings.latency,
      downloadThroughput: settings.kbps ? (settings.kbps * 1024) / 8 : -1,
      uploadThroughput: settings.kbps ? (settings.kbps * 1024) / 8 : -1,
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: settings.cpu });
    await cdp.send("Performance.enable");
    await page.addInitScript(() => {
      const observations = (globalThis.__bench = {
        longtasks: [],
        lcp: [],
        cls: [],
        marks: {},
      });
      const first = (name) => {
        observations.marks[name] ??= performance.now();
      };
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          observations.longtasks.push({
            start: entry.startTime,
            duration: entry.duration,
          });
      }).observe({ type: "longtask", buffered: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          observations.lcp.push({
            start: entry.startTime,
            size: entry.size,
            element: entry.element?.className,
          });
      }).observe({ type: "largest-contentful-paint", buffered: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          if (!entry.hadRecentInput)
            observations.cls.push({
              start: entry.startTime,
              value: entry.value,
            });
      }).observe({ type: "layout-shift", buffered: true });
      new MutationObserver(() => {
        if (
          !observations.marks.markers &&
          document.querySelector(".map-cluster,.map-restaurant")
        ) {
          first("markers");
          requestAnimationFrame(() =>
            requestAnimationFrame(() => first("markers-painted")),
          );
        }
        if (
          !observations.marks.cards &&
          document.querySelector(".restaurant-card")
        )
          first("cards");
      }).observe(document, { childList: true, subtree: true });
    });
    if (trace && !priming) {
      await cdp.send("Tracing.start", {
        categories:
          "devtools.timeline,v8,blink.user_timing,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler,gpu",
        transferMode: "ReturnAsStream",
      });
      tracing = true;
    }
    await page.goto(`${server.origin}/${name}/${hash}`, {
      waitUntil: "domcontentloaded",
    });
    const ready = () => {
      const state = globalThis.__benchmarkMapReadiness;
      return (
        globalThis.__benchmarkMap?.loaded() &&
        state &&
        state?.render !== null &&
        state?.idle !== null &&
        globalThis.__bench.marks["markers-painted"]
      );
    };
    const deadline = Date.now() + 60000;
    for (;;) {
      if (Date.now() >= deadline)
        throw new Error("Map readiness did not settle.");
      await page.waitForFunction(ready, null, {
        timeout: deadline - Date.now(),
      });
      const revision = await page.evaluate(
        () => globalThis.__benchmarkMapReadiness.revision,
      );
      await page.waitForTimeout(600);
      const stable = await page.evaluate((revision) => {
        const current = globalThis.__benchmarkMapReadiness;
        return (
          current.revision === revision &&
          current.render !== null &&
          current.idle !== null &&
          globalThis.__benchmarkMap.loaded()
        );
      }, revision);
      if (stable) break;
    }
    value = await page.evaluate(() => {
      const map = globalThis.__benchmarkMap;
      const gl = map.getCanvas().getContext("webgl2");
      const extension = gl.getExtension("WEBGL_debug_renderer_info");
      const marks = performance
        .getEntriesByType("mark")
        .filter((entry) => entry.name.startsWith("grades:"));
      const stages = {};
      for (const entry of marks)
        stages[entry.name.slice(7)] ??= entry.startTime;
      return {
        ...globalThis.__bench,
        stages,
        stageEvents: marks.map((entry) => ({
          name: entry.name,
          start: entry.startTime,
        })),
        timeOrigin: performance.timeOrigin,
        measuredUntil: performance.now(),
        paint: performance
          .getEntriesByType("paint")
          .map((entry) => ({ name: entry.name, start: entry.startTime })),
        resources: performance.getEntriesByType("resource").map((entry) => ({
          url: entry.name,
          start: entry.startTime,
          duration: entry.duration,
          transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize,
          decodedBodySize: entry.decodedBodySize,
          protocol: entry.nextHopProtocol,
          initiator: entry.initiatorType,
        })),
        alerts: [...document.querySelectorAll('[role="alert"]')]
          .filter((element) => !element.hidden && element.textContent)
          .map((element) => element.textContent),
        renderer: extension
          ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER),
        mapReadiness: { ...globalThis.__benchmarkMapReadiness },
        map: {
          loaded: map.loaded(),
          center: map.getCenter().toArray(),
          zoom: map.getZoom(),
        },
      };
    });
    if (
      !value.map.loaded ||
      value.mapReadiness.render === null ||
      value.mapReadiness.idle === null
    )
      throw new Error(
        "Map changed during result collection; retry this sample.",
      );
    perf = Object.fromEntries(
      (await cdp.send("Performance.getMetrics")).metrics.map((metric) => [
        metric.name,
        metric.value,
      ]),
    );
    if (
      backend !== "software" &&
      /swiftshader|llvmpipe|software rasterizer/i.test(value.renderer)
    )
      throw new Error(
        `Requested hardware rendering but received ${value.renderer}. Use --gpu software only for an explicitly separate experiment.`,
      );
    if (errors.length) throw new Error(errors.join("\n"));
    if (value.alerts.length)
      throw new Error(`Application alerts: ${value.alerts.join("; ")}`);
    if (!priming)
      await page.screenshot({
        path: path.join(directory, `${tag}.png`),
        fullPage: true,
      });
  } catch (error) {
    failure = error.message;
  } finally {
    if (tracing) {
      try {
        const complete = new Promise((resolve) =>
          cdp.once("Tracing.tracingComplete", resolve),
        );
        await cdp.send("Tracing.end");
        const { stream } = await complete;
        let contents = "";
        while (true) {
          const result = await cdp.send("IO.read", { handle: stream });
          contents += result.data;
          if (result.eof) break;
        }
        await cdp.send("IO.close", { handle: stream });
        await writeFile(path.join(directory, `${tag}.trace.json`), contents);
      } catch (error) {
        errors.push(`Trace collection: ${error.message}`);
      }
    }
    await Promise.allSettled(pendingRequests);
    await browser.close();
  }
  const after = await fixtureRequest(server.origin, "/__perf/stats");
  const firstPaint =
    value?.paint.find((entry) => entry.name === "first-contentful-paint")
      ?.start || 0;
  const blockingAfterFcpMs = value?.longtasks
    .filter((entry) => entry.start >= firstPaint)
    .reduce((total, entry) => total + Math.max(0, entry.duration - 50), 0);
  const result = {
    name,
    profile,
    settings,
    priming,
    startedAt,
    failure,
    errors,
    consoleMessages,
    cacheMode: "cold-browser/spki",
    gpu: backend,
    theme,
    hash,
    trace,
    browserVersion: browser.version(),
    nodeVersion: process.version,
    host: {
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
    },
    case: caseMetadata,
    requests,
    network,
    serverRequests: deltaCounts(before, after),
    ...value,
    perf,
    blockingAfterFcpMs,
    clsScore: value ? cumulativeLayoutShift(value.cls) : null,
    usableMapMs: value
      ? Math.max(
          value.marks["markers-painted"],
          value.mapReadiness.idle,
          value.mapReadiness.render,
        )
      : null,
  };
  await writeJson(path.join(directory, `${tag}.json`), result);
  if (failure) throw new Error(`${tag}: ${failure} (raw diagnostics saved)`);
  if (!priming)
    console.log(
      JSON.stringify({
        name,
        profile,
        usableMapMs: Math.round(result.usableMapMs),
        markersMs: Math.round(value.marks["markers-painted"]),
        mapIdleMs: Math.round(value.mapReadiness.idle),
        blockingAfterFcpMs: Math.round(blockingAfterFcpMs),
        CLS: result.clsScore,
        renderer: value.renderer,
      }),
    );
  return result;
}
