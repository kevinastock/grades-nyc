import test from "node:test";
import assert from "node:assert/strict";
import {
  DETAIL_BUCKETS,
  bucketName,
  detailBucket,
  validateManifest,
  encodeRestaurantColumns,
} from "../src/data/manifest.mjs";
import { loadDataFiles } from "../src/data/load-files.mjs";

function fixture() {
  const row = (id, latest_date = "2026-09-25") => ({
    id,
    name: id,
    borough: "Manhattan",
    address: "1 Main",
    zip: "00123",
    cuisine: "American",
    lat: 40.7,
    lon: -74,
    grade: "A",
    grade_date: latest_date,
    grade_inspected: latest_date,
    latest_date,
    latest_codes: "04L",
    closure: "none",
    closed_date: null,
  });
  const id = "00123456",
    index = detailBucket(id);
  const sameBucket = Array.from({ length: 10000 }, (_, i) => String(i)).find(
    (s) => detailBucket(s) === index,
  );
  const rows = [
    row(id),
    row(sameBucket),
    row("uninspected", null),
    row("__proto__"),
  ];
  const summary = {
    restaurants: encodeRestaurantColumns(rows),
    violations: [
      {
        code: "04L",
        description: null,
        critical: null,
        critical_varies: false,
        occurrences: 2,
      },
    ],
    definitions: [{ code: "04L", description: null, critical: null }],
    cuisines: ["American"],
    boroughs: ["Manhattan"],
  };
  const history = [
    "2026-09-25",
    "Cycle Inspection / Re-inspection",
    "Violations cited",
    "A",
    "2026-09-25",
    12,
    1,
    [1],
  ];
  const files = new Map();
  const asset = (name, value, rows) => {
    const body = JSON.stringify(value);
    const file = `${name}-${"a".repeat(64)}.json`;
    files.set(file, body);
    return { file, bytes: Buffer.byteLength(body), rows };
  };
  const buckets = Array.from({ length: DETAIL_BUCKETS }, () =>
    Object.create(null),
  );
  for (const r of rows)
    if (r.latest_date) buckets[detailBucket(r.id)][r.id] = [history];
  const manifest = {
    schemaVersion: 3,
    snapshot: "2026-09-25",
    rowCount: 4,
    summary: asset("summary", summary, rows.length),
    details: buckets.map((b, i) =>
      asset(bucketName(i), b, Object.keys(b).length),
    ),
  };
  return { manifest, files, id, sameBucket, index };
}
function mockFiles(t, f, override = () => undefined) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), options });
    const custom = await override(String(url), options);
    if (custom) return custom;
    const file = String(url).split("/").at(-1);
    return new Response(
      file === "manifest.json" ? JSON.stringify(f.manifest) : f.files.get(file),
    );
  });
  return calls;
}

test("startup requests only manifest and summary; histories are cached lazily within the pinned snapshot", async (t) => {
  const f = fixture(),
    calls = mockFiles(t, f),
    data = await loadDataFiles("/nested/data/");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.cache, "no-cache");
  assert.equal(data.data.restaurants[0].zip, "00123");
  const [a, b] = await Promise.all([
    data.getInspections(f.id),
    data.getInspections(f.sameBucket),
  ]);
  assert.equal(
    calls.length,
    3,
    "same-bucket concurrent requests share a fetch",
  );
  assert.deepEqual(a, b);
  assert.deepEqual(a[0].findings, [
    { code: "04L", description: null, critical: null },
  ]);
  assert.equal(await data.getInspections(f.id), a, "decoded results reused");
  assert.deepEqual(await data.getInspections("uninspected"), []);
  assert.equal(calls.length, 3);
  assert.equal((await data.getInspections("__proto__")).length, 1);
  await assert.rejects(
    data.getInspections("constructor"),
    /not in this snapshot/,
  );
  assert.ok(calls.every((c) => c.url.startsWith("/nested/data/")));
});

test("truncated and failed history downloads are evicted and retryable", async (t) => {
  const f = fixture();
  let mode = "missing";
  mockFiles(t, f, (url) => {
    if (url.includes(f.manifest.details[f.index].file)) {
      if (mode === "missing") return new Response("", { status: 404 });
      if (mode === "truncated") return new Response("{");
    }
  });
  const data = await loadDataFiles("/data/");
  await assert.rejects(data.getInspections(f.id), /404/);
  mode = "truncated";
  await assert.rejects(data.getInspections(f.id), /incomplete/);
  mode = "valid";
  assert.equal((await data.getInspections(f.id)).length, 1);
});

test("missing inspected IDs and bad historical references fail without becoming cached empty history", async (t) => {
  const f = fixture(),
    file = f.manifest.details[f.index].file,
    original = f.files.get(file);
  const bad = JSON.parse(original);
  delete bad[f.id];
  f.files.set(file, JSON.stringify(bad));
  f.manifest.details[f.index].rows--;
  f.manifest.details[f.index].bytes = Buffer.byteLength(f.files.get(file));
  mockFiles(t, f);
  const data = await loadDataFiles("/data/");
  await assert.rejects(data.getInspections(f.id), /missing/);
  const broken = JSON.parse(original);
  broken[f.id][0][7] = [999];
  // A new context is needed when the snapshot's declared sizes change.
  f.files.set(file, JSON.stringify(broken));
  f.manifest.details[f.index].rows++;
  f.manifest.details[f.index].bytes = Buffer.byteLength(f.files.get(file));
  const next = await loadDataFiles("/data/");
  await assert.rejects(next.getInspections(f.id), /reference/);
});

test("invalid decoded history is evicted and can be retried in the same loaded snapshot", async (t) => {
  const f = fixture(),
    file = f.manifest.details[f.index].file,
    malformed = JSON.parse(f.files.get(file));
  malformed[f.id][0][7] = [2];
  const body = JSON.stringify(malformed);
  assert.equal(Buffer.byteLength(body), f.manifest.details[f.index].bytes);
  let invalid = true;
  const calls = mockFiles(t, f, (url) =>
    invalid && url.endsWith(file) ? new Response(body) : undefined,
  );
  const data = await loadDataFiles("/data/");
  await assert.rejects(data.getInspections(f.id), /reference/);
  invalid = false;
  assert.deepEqual((await data.getInspections(f.id))[0].findings, [
    { code: "04L", description: null, critical: null },
  ]);
  assert.equal(calls.filter((call) => call.url.endsWith(file)).length, 2);
});

test("deep links prefetch their bucket alongside the summary", async (t) => {
  const f = fixture(),
    calls = mockFiles(t, f),
    data = await loadDataFiles("/data/", undefined, f.id);
  await data.getInspections(f.id);
  assert.equal(calls.length, 3);
  assert.ok(calls[1].url.endsWith(f.manifest.details[f.index].file));
});

test("expired snapshots require reload instead of silently mixing new history with old summaries", async (t) => {
  const f = fixture();
  let updated = false;
  const newer = {
    ...f.manifest,
    summary: { ...f.manifest.summary, file: `summary-${"b".repeat(64)}.json` },
  };
  mockFiles(t, f, (url) => {
    if (updated && url.endsWith("manifest.json"))
      return new Response(JSON.stringify(newer));
    if (updated && url.endsWith(f.manifest.details[f.index].file))
      return new Response("", { status: 404 });
  });
  const data = await loadDataFiles("/data/");
  updated = true;
  await assert.rejects(data.getInspections(f.id), { code: "SNAPSHOT_EXPIRED" });
  assert.equal(data.data.snapshot, "2026-09-25");
});

test("history-only corrections also expire a pruned shard", async (t) => {
  const f = fixture();
  const newer = structuredClone(f.manifest);
  newer.details[f.index].file = newer.details[f.index].file.replace(
    /-[a-f0-9]{64}\.json$/,
    `-${"b".repeat(64)}.json`,
  );
  let updated = false;
  mockFiles(t, f, (url) => {
    if (updated && url.endsWith("manifest.json"))
      return new Response(JSON.stringify(newer));
    if (updated && url.endsWith(f.manifest.details[f.index].file))
      return new Response("", { status: 410 });
  });
  const data = await loadDataFiles("/data/");
  updated = true;
  assert.equal(newer.summary.file, f.manifest.summary.file);
  await assert.rejects(data.getInspections(f.id), { code: "SNAPSHOT_EXPIRED" });
});

test("invalid manifests, filenames and summary data are rejected", async (t) => {
  const f = fixture();
  for (const schemaVersion of [1, 2, 4])
    assert.throws(
      () => validateManifest({ ...f.manifest, schemaVersion }),
      /Unsupported/,
    );
  assert.throws(
    () => validateManifest({ ...f.manifest, details: [] }),
    /Invalid/,
  );
  const unsafe = structuredClone(f.manifest);
  unsafe.summary.file = "../private.json";
  assert.throws(() => validateManifest(unsafe), /Invalid/);
  const swapped = structuredClone(f.manifest);
  swapped.details.reverse();
  assert.throws(() => validateManifest(swapped), /Invalid/);
  mockFiles(t, f, (url) =>
    url.endsWith(f.manifest.summary.file) ? new Response("{}") : undefined,
  );
  await assert.rejects(loadDataFiles("/data/"), /incomplete/);
  assert.notEqual(detailBucket("00123456"), detailBucket("123456"));
});
