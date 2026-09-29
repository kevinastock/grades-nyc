import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build, createServer } from "vite";
import { Window } from "happy-dom";
import { startupResources } from "../build/startup-resources.mjs";
import {
  preloadBasemap,
  mapStyles,
  createBasemapStyle,
} from "../src/data/map-resources.mjs";
import {
  DETAIL_BUCKETS,
  SCHEMA_VERSION,
  encodeRestaurantColumns,
} from "../src/data/manifest.mjs";

async function fixture(
  t,
  {
    css = ".entry { color: red; }",
    page = "index.html",
    styleFactory,
    restaurants = [],
  } = {},
) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "nyc-startup-test-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = path.join(root, "public/data");
  await mkdir(data, { recursive: true });
  const summary = JSON.stringify({
    restaurants: encodeRestaurantColumns(restaurants),
    violations: [],
    definitions: [],
    cuisines: [],
    boroughs: [],
  });
  const hash = createHash("sha256").update(summary).digest("hex");
  const file = `summary-${hash}.json`;
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    snapshot: "2026-09-28",
    rowCount: 1,
    summary: {
      file,
      bytes: Buffer.byteLength(summary),
      rows: restaurants.length,
    },
    details: Array.from({ length: DETAIL_BUCKETS }, (_, index) => ({
      file: `details-${index.toString(16).padStart(2, "0")}-${"0".repeat(64)}.json`,
      bytes: 2,
      rows: 0,
    })),
  };
  await writeFile(
    path.join(data, "manifest-v4.json"),
    JSON.stringify(manifest),
  );
  // Cached clients have a distinct endpoint. Startup must select v4 even when
  // the old endpoint is present and points to another summary.
  await writeFile(
    path.join(data, "manifest.json"),
    JSON.stringify({
      ...manifest,
      schemaVersion: 3,
      summary: { ...manifest.summary, file: `summary-${"f".repeat(64)}.json` },
    }),
  );
  await writeFile(path.join(data, file), summary);
  await writeFile(path.join(root, "entry.css"), css);
  await writeFile(path.join(root, "map.css"), ".map-only { color: blue; }");
  await mkdir(path.join(root, "src/components"), { recursive: true });
  await writeFile(
    path.join(root, "src/components/RestaurantMap.js"),
    'import "../../map.css"; window.mapReady = true;',
  );
  await writeFile(
    path.join(root, "entry.js"),
    'import "./entry.css"; window.loadMap = () => import("./src/components/RestaurantMap.js");',
  );
  await mkdir(path.dirname(path.join(root, page)), { recursive: true });
  await writeFile(
    path.join(root, page),
    '<!doctype html><html><head><meta charset="UTF-8"></head><body><script type="module" src="/entry.js"></script></body></html>',
  );
  async function compile(base = "./") {
    const result = await build({
      configFile: false,
      root,
      base,
      plugins: [startupResources({ styleFactory })],
      logLevel: "silent",
      build: {
        write: false,
        assetsInlineLimit: 0,
        rollupOptions: { input: path.join(root, page) },
      },
    });
    return {
      html: result.output.find((asset) => asset.fileName === page).source,
      output: result.output,
    };
  }
  return { root, data, file, manifest, compile };
}

test("production inlines entry styles, keeps lazy map styles split, and preloads the exact summary", async (t) => {
  const { compile, file } = await fixture(t, {
    css: '.entry { color: red; background-image: url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E"); }',
  });
  const { html, output } = await compile();
  assert.ok(html.indexOf('meta charset="UTF-8"') < 1024);
  assert.ok(
    html.indexOf('meta charset="UTF-8"') <
      html.indexOf("data-startup-resources"),
  );
  assert.match(html, /<style data-startup-styles>\.entry\{/);
  assert.match(html, /data:image\/svg\+xml/);
  assert.doesNotMatch(html, /rel="stylesheet"|map-only/);
  assert.match(
    html,
    new RegExp(
      `<link rel="preload" as="fetch" type="application/json" href="\\./data/${file}" crossorigin="anonymous">`,
    ),
  );
  assert.match(html, /data-startup-resources/);
  assert.match(html, /manifest-v4\.json/);
  const mapCss = output.find(
    (asset) => asset.type === "asset" && asset.source.includes?.(".map-only"),
  );
  assert.ok(mapCss, "the dynamic map stylesheet is emitted separately");
  assert.ok(
    output.some(
      (asset) =>
        asset.type === "chunk" &&
        asset.code.includes(path.basename(mapCss.fileName)),
    ),
    "the map stylesheet remains attached to Vite's dynamic import",
  );
});

test("preload URLs resolve for relative deployments and configured path or CDN bases", async (t) => {
  for (const base of ["./", "/grades/", "https://assets.example/grades/"]) {
    await t.test(base, async (t) => {
      const { compile, file } = await fixture(t);
      const { html } = await compile(base);
      const href = html.match(/rel="preload"[^>]*href="([^"]+)"/)[1];
      assert.equal(href, `${base}data/${file}`);
      assert.match(html, /<style data-startup-styles>/);
      assert.doesNotMatch(html, /rel="stylesheet"/);
    });
  }
  await t.test("nested HTML with a relative base", async (t) => {
    const { compile, file } = await fixture(t, { page: "pages/index.html" });
    const { html } = await compile();
    assert.ok(html.includes(`href="../data/${file}"`));
    assert.match(html, /<style data-startup-styles>/);
    assert.doesNotMatch(html, /rel="stylesheet"/);
  });
});

test("CSS with relative assets keeps its stylesheet URL and its asset base", async (t) => {
  const { root, compile } = await fixture(t, {
    css: '.entry { background-image: url("./illustration.svg"); }',
  });
  await writeFile(
    path.join(root, "illustration.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
  );
  const { html, output } = await compile();
  assert.doesNotMatch(html, /data-startup-styles/);
  const stylesheetHref = html.match(/rel="stylesheet"[^>]*href="([^"]+)"/)[1];
  const stylesheet = output.find((asset) =>
    stylesheetHref.endsWith(asset.fileName),
  );
  const assetHref = stylesheet.source.match(/url\(["']?([^"')]+)/)[1];
  const documentUrl = "https://grades.test/nested/index.html";
  const resolved = new URL(assetHref, new URL(stylesheetHref, documentUrl));
  assert.ok(
    output.some((asset) => resolved.pathname === `/nested/${asset.fileName}`),
  );
});

test("HTML raw-text terminators and external CSS imports are never inlined", async (t) => {
  for (const css of [
    '.entry:after { content: "</style><script>alert(1)</script>"; }',
    '@import url("https://example.com/fonts.css"); .entry { color: red; }',
  ]) {
    const { compile } = await fixture(t, { css });
    const { html } = await compile();
    assert.doesNotMatch(html, /data-startup-styles/);
    assert.match(html, /rel="stylesheet"/);
  }
});

test("build rejects invalid manifests and a summary that does not match its content hash", async (t) => {
  const { data, file, manifest, compile } = await fixture(t);
  await writeFile(
    path.join(data, "manifest-v4.json"),
    JSON.stringify({
      ...manifest,
      summary: { ...manifest.summary, file: "../outside.json" },
    }),
  );
  await assert.rejects(compile(), /Invalid summary data entry/);
  await writeFile(
    path.join(data, "manifest-v4.json"),
    JSON.stringify(manifest),
  );
  await writeFile(path.join(data, file), '{"restaurants":{}}');
  await assert.rejects(compile(), /incomplete or corrupted restaurant summary/);
});

test("startup bounds are derived from the validated summary and carry its immutable identity", async (t) => {
  const row = {
    id: "a",
    name: "A",
    borough: "Queens",
    address: "1 Main St",
    zip: "11101",
    cuisine: "Pizza",
    lat: 40.71,
    lon: -73.92,
    grade: "A",
    grade_date: null,
    grade_inspected: null,
    latest_date: null,
    latest_codes: "",
    closure: "none",
    closed_date: null,
  };
  const { compile, file } = await fixture(t, {
    restaurants: [
      row,
      { ...row, id: "b", lat: 40.8, lon: -73.97 },
      { ...row, id: "unlocated", lat: null, lon: null },
    ],
  });
  const { html } = await compile();
  const b = await browser(t, html);
  assert.equal(b.window.__gradesMapBounds.summary, file);
  assert.deepEqual(
    Array.from(b.window.__gradesMapBounds.bounds),
    [-73.97, 40.71, -73.92, 40.8],
  );
});

test("development HTML is untouched and does not depend on a prepared snapshot", async (t) => {
  const { root, data } = await fixture(t);
  await rm(data, { recursive: true });
  const server = await createServer({
    configFile: false,
    root,
    plugins: [startupResources()],
    logLevel: "silent",
    server: { middlewareMode: true, watch: null },
  });
  t.after(() => server.close());
  const html = await server.transformIndexHtml(
    "/index.html",
    await readFile(path.join(root, "index.html"), "utf8"),
  );
  assert.doesNotMatch(html, /data-startup-styles|rel="preload"/);
  assert.match(html, /src="\/entry.js"/);
});

async function browser(
  t,
  html,
  {
    dark = false,
    ratio = 1,
    hash = "#/search",
    url = "https://grades.test/deployment/index.html",
  } = {},
) {
  const window = new Window({
    url: `${url}${hash}`,
    settings: {
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
    },
  });
  t.after(() => window.happyDOM.close());
  window.matchMedia = () => ({ matches: dark });
  Object.defineProperty(window, "devicePixelRatio", {
    value: ratio,
    configurable: true,
  });
  const requests = [];
  window.fetch = async (href, options) => {
    requests.push({ href, options });
    return { ok: true, json: async () => ({ manifest: true }) };
  };
  const script = html.match(
    /<script data-startup-resources>([\s\S]*?)<\/script>/,
  )?.[1];
  assert.ok(script, "the build emits a classic inline HTML bootstrap");
  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  const run = async () => {
    window.eval(script);
    await flush();
  };
  await run();
  return {
    window,
    requests,
    run,
    flush,
    script,
    hints: () => [...window.document.head.querySelectorAll("link")],
    warm: async () => {
      window.eval(
        `(${preloadBasemap.toString()})(${JSON.stringify(mapStyles)}, [], undefined, ${createBasemapStyle.toString()})`,
      );
      await flush();
    },
  };
}

test("HTML starts map assets, tile/font hints and a revalidating manifest without a remote style", async (t) => {
  const { compile } = await fixture(t);
  const { html, output } = await compile();
  const b = await browser(t, html);
  assert.equal(b.requests.length, 1);
  const manifest = b.requests[0];
  assert.equal(
    manifest.href,
    "https://grades.test/deployment/data/manifest-v4.json",
  );
  assert.equal(manifest.options.cache, "no-cache");
  assert.ok(manifest.options.signal instanceof b.window.AbortSignal);
  assert.equal(b.window.__gradesManifest.url, manifest.href);
  const mapChunk = output.find(
    (chunk) => chunk.type === "chunk" && chunk.isDynamicEntry,
  );
  const mapCss = output.find(
    (asset) => asset.type === "asset" && asset.source.includes?.(".map-only"),
  );
  const hints = b.hints();
  assert.ok(
    hints.some(
      (link) =>
        link.rel === "modulepreload" && link.href.endsWith(mapChunk.fileName),
    ),
  );
  assert.ok(
    hints.some(
      (link) => link.as === "style" && link.href.endsWith(mapCss.fileName),
    ),
  );
  for (const href of [
    "https://tiles.openfreemap.org/planet",
    "https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf",
  ])
    assert.ok(
      hints.some(
        (link) =>
          link.href === href &&
          link.as === "fetch" &&
          link.crossOrigin === "anonymous",
      ),
    );
  assert.ok(
    !hints.some((link) =>
      /\/styles\/|\/sprites\/|\/index-.*\.css$/.test(link.href),
    ),
  );
  const pending = b.window.__gradesBasemap.styles.get(mapStyles.light);
  assert.equal((await pending).layers.length, 13);
  await b.run();
  await b.warm();
  assert.equal(b.hints().length, hints.length);
  assert.equal(
    b.requests.length,
    1,
    "no warmup or renderer style network request",
  );
  assert.equal(b.window.__gradesBasemap.styles.get(mapStyles.light), pending);
});

test("initial watchlist skips map resources and theme selects a local style at every pixel ratio", async (t) => {
  const { compile } = await fixture(t);
  const { html } = await compile();
  const watch = await browser(t, html, { hash: "#/watchlist?watch=04L" });
  assert.equal(watch.requests.length, 1);
  assert.equal(watch.hints().length, 0);
  assert.equal(watch.window.__gradesBasemap, undefined);
  for (const ratio of [1, 1.25, 2]) {
    const b = await browser(t, html, { dark: true, ratio });
    assert.equal(b.requests.length, 1);
    assert.equal(b.window.__gradesBasemap.styles.has(mapStyles.light), false);
    const style = await b.window.__gradesBasemap.styles.get(mapStyles.dark);
    assert.equal(style.name, createBasemapStyle("dark").name);
    assert.equal(
      b.hints().filter((link) => link.href.endsWith(".pbf")).length,
      1,
    );
    assert.ok(!b.hints().some((link) => /sprites|Italic|Bold/.test(link.href)));
  }
});

test("HTML asset and manifest warmup uses each configured deployment base", async (t) => {
  for (const base of ["./", "/grades/", "https://assets.example/grades/"]) {
    const { compile } = await fixture(t, { page: "pages/index.html" });
    const { html } = await compile(base);
    const b = await browser(t, html, {
      url: "https://grades.test/deployment/pages/index.html",
    });
    const prefix =
      base === "./"
        ? "https://grades.test/deployment/"
        : new URL(base, "https://grades.test/").href;
    assert.equal(
      b.window.__gradesManifest.url,
      `${prefix}data/manifest-v4.json`,
    );
    assert.ok(
      b
        .hints()
        .filter((link) => link.as === "style" || link.rel === "modulepreload")
        .every((link) => link.href.startsWith(`${prefix}assets/`)),
    );
  }
});

test("HTML bootstrap escapes script terminators in deployment URLs", async (t) => {
  const { compile } = await fixture(t);
  const { html } = await compile("/grades/</script>/");
  const script = html.match(
    /<script data-startup-resources>([\s\S]*?)<\/script>/,
  )[1];
  assert.doesNotMatch(script, /<\/script/i);
  const b = await browser(t, html);
  assert.equal(
    b.window.__gradesManifest.url,
    "https://grades.test/grades/%3C/script%3E/data/manifest-v4.json",
  );
});

test("production bootstrap and renderer share the same complete local basemap", async (t) => {
  const { compile } = await fixture(t);
  const { html } = await compile();
  const b = await browser(t, html, { hash: "#/search?restaurant=123" });
  const style = await b.window.__gradesBasemap.styles.get(mapStyles.light);
  assert.deepEqual(
    JSON.parse(JSON.stringify(style)),
    createBasemapStyle("light"),
  );
  const fonts = b.hints().filter((link) => link.href.endsWith(".pbf"));
  assert.equal(fonts.length, 1);
  assert.equal(
    fonts[0].href,
    style.glyphs
      .replace("{fontstack}", "Noto%20Sans%20Regular")
      .replace("{range}", "0-255"),
  );
  assert.ok(
    b.hints().some((link) => link.href === style.sources.openmaptiles.url),
  );
  assert.ok(
    !b.requests.some(({ href }) => href.includes("tiles.openfreemap.org")),
  );
});
