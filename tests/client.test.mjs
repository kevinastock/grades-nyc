import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import {
  DETAIL_BUCKETS,
  SCHEMA_VERSION,
  encodeRestaurantColumns,
  validateManifest,
  validateSummary,
} from "../src/data/manifest.mjs";

const compiled = await build({
  entryPoints: [
    fileURLToPath(new URL("../src/data/client.ts", import.meta.url)),
  ],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  define: { "import.meta.env.BASE_URL": '"/data/"' },
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function useScheduler(t, scheduler) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "scheduler");
  Object.defineProperty(globalThis, "scheduler", {
    value: scheduler,
    configurable: true,
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "scheduler", previous);
    else delete globalThis.scheduler;
  });
}

function fixture() {
  const row = {
    id: "00123",
    name: "Diner",
    borough: "Queens",
    address: "1 Main",
    zip: "00123",
    cuisine: "American",
    lat: 40.73,
    lon: -73.98,
    grade: null,
    grade_date: null,
    grade_inspected: null,
    latest_date: null,
    latest_codes: "",
    closure: "none",
    closed_date: null,
  };
  const summary = {
    restaurants: encodeRestaurantColumns([row]),
    definitions: [],
    violations: [],
    cuisines: ["American"],
    boroughs: ["Queens"],
  };
  // Cover every compact wire representation through actual client expansion,
  // including its local fallback when a worker cannot start.
  summary.restaurants.borough = { values: ["Queens"], indices: [0] };
  summary.restaurants.closure = { constant: "none" };
  summary.restaurants.grade_date = { ref: "grade" };
  const body = JSON.stringify(summary);
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    snapshot: "2026-09-25",
    rowCount: 1,
    summary: {
      file: `summary-${"a".repeat(64)}.json`,
      bytes: Buffer.byteLength(body),
      rows: 1,
    },
    details: Array.from({ length: DETAIL_BUCKETS }, (_, index) => ({
      file: `details-${index.toString(16).padStart(2, "0")}-${"a".repeat(64)}.json`,
      bytes: 2,
      rows: 0,
    })),
  };
  return { row, summary, body, manifest };
}

async function harness(
  t,
  {
    delayFirstSummary = false,
    failFirstInit = false,
    failFirstSummary = false,
    failFirstPost = false,
    failFirstConstruct = false,
  } = {},
) {
  const f = fixture();
  const requests = [],
    workers = [];
  const summaryStarted = deferred(),
    summaryRelease = deferred();
  let summaryRequests = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(url);
    if (url.endsWith("manifest-v4.json"))
      return new Response(JSON.stringify(f.manifest));
    if (url.includes("summary-")) {
      if (failFirstSummary) {
        failFirstSummary = false;
        return new Response("", { status: 503 });
      }
      if (delayFirstSummary && ++summaryRequests === 1) {
        summaryStarted.resolve();
        await summaryRelease.promise;
      }
      if (failFirstInit) {
        failFirstInit = false;
        // Keep the byte count valid while making the restaurant ID invalid.
        return new Response(f.body.replace('"id":["00123"]', '"id":[1234567]'));
      }
      return new Response(f.body);
    }
    throw new Error(`Unexpected request ${url}`);
  });
  class Worker {
    messages = [];
    terminated = false;
    constructor() {
      if (failFirstConstruct) {
        failFirstConstruct = false;
        throw new Error("Worker blocked");
      }
      workers.push(this);
    }
    postMessage(message, transfer = []) {
      if (failFirstPost) {
        failFirstPost = false;
        throw new Error("Worker transfer failed");
      }
      const received = structuredClone(message, { transfer });
      this.messages.push(received);
      queueMicrotask(() => {
        if (this.terminated) return;
        const { id, type, args } = received;
        try {
          let result;
          if (type === "init-summary") {
            const manifest = validateManifest(args[1]);
            const wire = JSON.parse(new TextDecoder().decode(args[0]));
            validateSummary(wire, manifest);
            if (args[2]) result = wire;
          } else if (type === "query") {
            result = {
              revision: args[0],
              ids: [f.row.id],
              mapped: 1,
              unmapped: 0,
              bounds: null,
            };
          }
          this.onmessage({ data: { id, result } });
        } catch (error) {
          this.onmessage({ data: { id, error: error.message } });
        }
      });
    }
    terminate() {
      this.terminated = true;
    }
  }
  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    value: Worker,
    configurable: true,
  });
  t.after(() => {
    if (previousWorker)
      Object.defineProperty(globalThis, "Worker", previousWorker);
    else delete globalThis.Worker;
  });
  const directory = await mkdtemp(path.join(tmpdir(), "nyc-data-client-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "client.mjs");
  await writeFile(file, compiled.outputFiles[0].text);
  const client = await import(pathToFileURL(file).href);
  t.after(() => client.disposePreparedExplorer());
  return { f, client, requests, workers, summaryStarted, summaryRelease };
}

const criteria = {
  search: "",
  borough: null,
  cuisine: null,
  grade: null,
  watchFilter: null,
  selected: [],
};

test("data preparation returns UI rows and hands search the already initialized worker", async (t) => {
  const h = await harness(t);
  const data = await h.client.loadData(() => {});
  assert.deepEqual(data.restaurants, [h.f.row]);
  assert.equal(h.requests.length, 2);
  assert.equal(h.workers.length, 1);
  assert.equal(
    h.workers[0].messages[0].args[2],
    true,
    "initialization requests compact columns back",
  );
  const explorer = h.client.takeExplorer(data.restaurants);
  assert.equal((await explorer.query(1, criteria)).ids[0], h.f.row.id);
  assert.deepEqual(
    h.workers[0].messages.map(({ type }) => type),
    ["init-summary", "query"],
  );
  h.client.disposePreparedExplorer();
  assert.equal(
    h.workers[0].terminated,
    false,
    "the app owns a claimed explorer",
  );
  explorer.dispose();
  assert.equal(h.workers[0].terminated, true);

  h.f.manifest.snapshot = "2026-09-26";
  const retry = h.client.takeExplorer(data.restaurants);
  await retry.query(2, criteria);
  assert.equal(h.workers.length, 2);
  assert.equal(h.workers[1].messages[0].args[1].snapshot, "2026-09-25");
  assert.equal(
    h.workers[1].messages[0].args[2],
    undefined,
    "retries do not clone unused columns back",
  );
  assert.equal(
    h.requests.length,
    2,
    "search retries keep the pinned bytes without another fetch",
  );
  retry.dispose();
});

test("failed preparation is disposed and a data retry gets a fresh worker", async (t) => {
  const h = await harness(t, { failFirstInit: true });
  await assert.rejects(
    h.client.loadData(() => {}),
    /Invalid restaurant summary record/,
  );
  assert.equal(h.workers[0].terminated, true);
  const data = await h.client.loadData(() => {});
  assert.deepEqual(data.restaurants, [h.f.row]);
  assert.equal(h.workers.length, 2);
  assert.equal(h.workers[1].terminated, false);
  assert.equal(h.requests.length, 4);
});

test("a summary request failure disposes the startup worker and permits data retry", async (t) => {
  const h = await harness(t, { failFirstSummary: true });
  await assert.rejects(
    h.client.loadData(() => {}),
    /503/,
  );
  assert.equal(h.workers[0].terminated, true);
  const data = await h.client.loadData(() => {});
  assert.deepEqual(data.restaurants, [h.f.row]);
  assert.equal(h.workers.length, 2);
  assert.equal(h.workers[1].terminated, false);
});

for (const failure of ["failFirstPost", "failFirstConstruct"]) {
  test(`${failure} preserves usable data and allows a fresh search worker`, async (t) => {
    const h = await harness(t, { [failure]: true });
    const data = await h.client.loadData(() => {});
    assert.deepEqual(data.restaurants, [h.f.row]);
    if (h.workers.length) assert.equal(h.workers[0].terminated, true);
    const explorer = h.client.takeExplorer(data.restaurants);
    assert.equal((await explorer.query(1, criteria)).ids[0], h.f.row.id);
    assert.equal(
      h.requests.length,
      2,
      "worker retry keeps the pinned summary bytes",
    );
    explorer.dispose();
  });
}

test("a worker that fails before its summary arrives preserves usable data", async (t) => {
  const h = await harness(t, { delayFirstSummary: true });
  const loading = h.client.loadData(() => {});
  await h.summaryStarted.promise;
  h.workers[0].onerror();
  h.summaryRelease.resolve();
  const data = await loading;
  assert.deepEqual(data.restaurants, [h.f.row]);
  assert.equal(h.workers[0].terminated, true);
  const explorer = h.client.takeExplorer(data.restaurants);
  assert.equal((await explorer.query(1, criteria)).ids[0], h.f.row.id);
  assert.equal(h.workers.length, 2);
  assert.equal(h.requests.length, 2);
  explorer.dispose();
});

test("disposing an unfinished app cannot clear a newer successful data load", async (t) => {
  const h = await harness(t, { delayFirstSummary: true });
  const old = h.client
    .loadData(() => {})
    .then(
      (value) => value,
      (error) => error,
    );
  await h.summaryStarted.promise;
  h.client.disposePreparedExplorer();
  assert.equal(h.workers[0].terminated, true);
  const data = await h.client.loadData(() => {});
  h.summaryRelease.resolve();
  assert.match((await old).message, /Restaurant search closed/);
  assert.equal(await h.client.loadData(() => {}), data);
  assert.deepEqual(await h.client.getInspections(h.f.row.id), []);
  const explorer = h.client.takeExplorer(data.restaurants);
  assert.equal(h.workers.length, 2);
  assert.equal(h.workers[1].terminated, false);
  assert.equal((await explorer.query(1, criteria)).ids[0], h.f.row.id);
  explorer.dispose();
});

test("destroying after data is ready releases an unclaimed worker but retains cached data", async (t) => {
  const h = await harness(t);
  const data = await h.client.loadData(() => {});
  h.client.disposePreparedExplorer();
  assert.equal(h.workers[0].terminated, true);
  assert.equal(await h.client.loadData(() => {}), data);
  const explorer = h.client.takeExplorer(data.restaurants);
  await explorer.query(1, criteria);
  assert.equal(h.workers.length, 2);
  assert.equal(h.requests.length, 2);
  explorer.dispose();
});

test("successful worker decoding yields before exposing rows to loader and UI", async (t) => {
  const yielded = deferred(),
    release = deferred();
  useScheduler(t, {
    yield() {
      yielded.resolve();
      return release.promise;
    },
  });
  const h = await harness(t);
  let completed = false;
  const loading = h.client
    .loadData(() => {})
    .then((data) => {
      completed = true;
      return data;
    });
  await yielded.promise;
  assert.equal(completed, false);
  assert.equal(h.client.getExplorerData(), undefined);
  assert.equal(h.workers[0].terminated, false);
  release.resolve();
  const data = await loading;
  assert.deepEqual(data.restaurants, [h.f.row]);
  assert.equal(h.workers.length, 1);
});

test("disposal while decoding yields cannot revive its rows or clear a newer snapshot", async (t) => {
  const yielded = deferred(),
    release = deferred();
  let calls = 0;
  useScheduler(t, {
    yield() {
      if (++calls === 1) {
        yielded.resolve();
        return release.promise;
      }
      return Promise.resolve();
    },
  });
  const h = await harness(t);
  const old = h.client.loadData(() => {}).catch((error) => error);
  await yielded.promise;
  h.client.disposePreparedExplorer();
  const data = await h.client.loadData(() => {});
  release.resolve();
  assert.match((await old).message, /Restaurant search closed/);
  assert.equal(await h.client.loadData(() => {}), data);
  assert.equal(h.workers[0].terminated, true);
  assert.equal(h.workers[1].terminated, false);
  assert.equal(h.requests.length, 4);
});
