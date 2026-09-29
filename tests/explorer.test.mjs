import test from "node:test";
import assert from "node:assert/strict";
import { createExplorer } from "../src/data/explorer.mjs";
import { createRestaurantSearch } from "../src/data/search.mjs";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const criteria = {
  search: "",
  borough: null,
  cuisine: null,
  grade: null,
  watchFilter: null,
  selected: [],
};
const rows = [
  {
    id: "001",
    name: "KATZ'S DELICATESSEN",
    address: "205 East Houston",
    borough: "Manhattan",
    cuisine: "Sandwiches",
    latest_date: "2026-09-25",
    latest_codes: "04L",
    grade: "A",
    closure: "none",
    lat: 40.73,
    lon: -73.98,
  },
  {
    id: "002",
    name: "KATZ CAFE",
    address: "Same building",
    borough: "Manhattan",
    cuisine: "Coffee",
    latest_date: "2026-09-24",
    latest_codes: "10F",
    grade: "Z",
    closure: "none",
    lat: 40.73,
    lon: -73.98,
  },
  {
    id: "004",
    name: "No pin",
    address: "Unknown",
    borough: "Queens",
    cuisine: "Coffee",
    latest_date: null,
    latest_codes: "",
    grade: null,
    closure: "none",
    lat: null,
    lon: null,
  },
];
const bounds = { west: -74.3, south: 40.4, east: -73.6, north: 41 };

test("worker filtering preserves default order, fuzzy ranking, pending and watchlist semantics", () => {
  const e = createExplorer(rows);
  assert.deepEqual(e.query(1, criteria).ids, ["001", "002", "004"]);
  assert.deepEqual(e.query(2, { ...criteria, search: "katz" }).ids, [
    "001",
    "002",
  ]);
  assert.deepEqual(e.query(3, { ...criteria, grade: "pending" }).ids, ["002"]);
  assert.deepEqual(
    e.query(4, { ...criteria, watchFilter: "flagged", selected: ["04L"] }).ids,
    ["001"],
  );
  assert.deepEqual(
    e.query(5, { ...criteria, watchFilter: "clear", selected: ["04L"] }).ids,
    ["002", "004"],
  );
  assert.deepEqual(e.query(6, { ...criteria, borough: "Queens" }).ids, ["004"]);
  assert.deepEqual(e.query(7, { ...criteria, search: "!!!" }).ids, []);
});

test("viewport requests retain all candidates, bound map features, and reject stale cluster revisions", () => {
  const e = createExplorer(rows),
    q = e.query(1, criteria);
  assert.equal(q.mapped, 2);
  assert.equal(q.unmapped, 1);
  const v = e.viewport(1, bounds, 16);
  assert.deepEqual(v.ids, ["001", "002", "004"]);
  assert.equal(v.visibleMapped, 2);
  assert.equal(v.features.length, 1);
  assert.equal(v.features[0].properties.point_count, 2);
  const id = v.features[0].properties.cluster_id,
    expanded = e.expand(1, id);
  assert.equal(expanded.zoom, 20);
  assert.deepEqual(new Set(expanded.ids), new Set(["001", "002"]));
  const emptyMap = e.viewport(
    1,
    { west: -74.3, south: 40.9, east: -74.2, north: 41 },
    16,
  );
  assert.deepEqual(emptyMap.ids, ["001", "002", "004"]);
  assert.equal(emptyMap.visibleMapped, 0);
  assert.deepEqual(emptyMap.features, []);
  e.query(2, { ...criteria, grade: "none" });
  assert.equal(e.viewport(1, bounds, 16), null);
  assert.equal(e.expand(1, id), null);
  assert.deepEqual(e.viewport(2, bounds, 16).features, []);
});

// Public map zooms use a 256px world; longitude gives an exact horizontal
// screen-space distance without depending on a particular latitude.
function storefronts(pixels, zoom) {
  const longitudeOffset = (pixels * 360) / (256 * 2 ** zoom);
  return [rows[0], { ...rows[1], lon: rows[0].lon + longitudeOffset }];
}

test("adjacent storefronts 36 pixels apart separate at street zoom while remaining clustered one level out", () => {
  const e = createExplorer(storefronts(36, 17));
  e.query(1, criteria);
  const overview = e.viewport(1, bounds, 16);
  assert.equal(overview.features.length, 1);
  assert.equal(overview.features[0].properties.cluster, true);
  assert.equal(overview.features[0].properties.point_count, 2);
  const street = e.viewport(1, bounds, 17);
  assert.equal(street.visibleMapped, 2);
  assert.equal(street.features.length, 2);
  assert.ok(street.features.every((feature) => !feature.properties.cluster));
  assert.deepEqual(
    new Set(street.features.map((feature) => feature.properties.id)),
    new Set(["001", "002"]),
  );
});

test("nearby storefronts expand to the maximum navigable zoom before exposing individual markers", () => {
  const e = createExplorer(storefronts(20, 18));
  e.query(1, criteria);
  const before = e.viewport(1, bounds, 18);
  assert.equal(before.features.length, 1);
  assert.equal(before.features[0].properties.cluster, true);
  const expanded = e.expand(1, before.features[0].properties.cluster_id);
  assert.equal(expanded.zoom, 19);
  assert.deepEqual(
    expanded.ids,
    [],
    "a navigable expansion does not open the place chooser",
  );
  const after = e.viewport(1, bounds, expanded.zoom);
  assert.equal(after.features.length, 2);
  assert.ok(after.features.every((feature) => !feature.properties.cluster));
  assert.deepEqual(
    new Set(after.features.map((feature) => feature.properties.id)),
    new Set(["001", "002"]),
  );
});

test("coincident places stay clustered at maximum zoom and expose their leaf IDs beyond it", () => {
  const e = createExplorer(rows.slice(0, 2));
  e.query(1, criteria);
  const viewport = e.viewport(1, bounds, 19);
  assert.equal(viewport.features.length, 1);
  assert.equal(viewport.features[0].properties.cluster, true);
  assert.equal(viewport.features[0].properties.point_count, 2);
  const id = viewport.features[0].properties.cluster_id;
  const expanded = e.expand(1, id);
  assert.equal(expanded.zoom, 20);
  assert.deepEqual(new Set(expanded.ids), new Set(["001", "002"]));
  e.query(2, { ...criteria, grade: "none" });
  assert.equal(
    e.expand(1, id),
    null,
    "cluster IDs from the earlier revision remain invalid",
  );
  assert.equal(e.viewport(1, bounds, 19), null);
});

test("Unknown borough results remain visible when none of them has a usable location", () => {
  const unknown = { ...rows[2], borough: "Unknown" },
    invalid = { ...unknown, id: "005", lat: 0, lon: 0 };
  const e = createExplorer([...rows.slice(0, 2), unknown, invalid]);
  const result = e.query(1, { ...criteria, borough: "Unknown" });
  assert.deepEqual(result.ids, ["004", "005"]);
  assert.equal(result.mapped, 0);
  assert.equal(result.unmapped, 2);
  assert.equal(result.bounds, null);
  for (const view of [
    bounds,
    { west: -74.3, south: 40.9, east: -74.2, north: 41 },
  ]) {
    const viewport = e.viewport(1, view, 16);
    assert.deepEqual(viewport.ids, ["004", "005"]);
    assert.equal(viewport.visibleMapped, 0);
    assert.deepEqual(viewport.features, []);
  }
});

test("mixed results keep offscreen and unlocated restaurants and preserve default order when search is cleared", () => {
  const unlocated = { ...rows[2], latest_date: "2026-09-27" },
    outside = { ...rows[1], lon: -73.94 },
    otherUnlocated = { ...unlocated, id: "005", lat: 0, lon: 0 };
  const e = createExplorer([unlocated, rows[0], otherUnlocated, outside]);
  assert.deepEqual(e.query(1, criteria).ids, ["001", "002", "004", "005"]);
  const viewport = e.viewport(
    1,
    { west: -74.02, south: 40.7, east: -73.97, north: 40.76 },
    16,
  );
  assert.deepEqual(viewport.ids, ["001", "002", "004", "005"]);
  assert.equal(viewport.visibleMapped, 1);
  assert.deepEqual(
    viewport.features.map((feature) => feature.properties.id),
    ["001"],
  );
  e.query(2, { ...criteria, search: "katz" });
  assert.deepEqual(e.query(3, criteria).ids, ["001", "002", "004", "005"]);
});

test("viewport ranking prefers nearby chain locations without dropping strong offscreen matches", () => {
  const restaurant = (id, name, lon, latest_date = "2026-09-25") => ({
    ...rows[0],
    id,
    name,
    address: "Different address",
    lon,
    lat: lon === null ? null : rows[0].lat,
    latest_date,
  });
  const candidates = [
    restaurant("offscreen", "TACO BELL", -73.94, "2026-09-27"),
    restaurant("unlocated", "TACO BELL", null, "2026-09-27"),
    restaurant("inside", "TACO BELL", -73.98, "2026-09-01"),
    restaurant("weak", "TACO BELL CAFE", -73.98),
  ];
  const e = createExplorer(candidates);
  const query = e.query(1, { ...criteria, search: "taco bell" });
  assert.deepEqual(query.ids, ["offscreen", "inside", "unlocated", "weak"]);
  const firstArea = { west: -74.02, south: 40.7, east: -73.97, north: 40.76 };
  const secondArea = { ...firstArea, west: -73.96, east: -73.92 };
  const first = e.viewport(1, firstArea, 19);
  assert.deepEqual(first.ids, ["inside", "offscreen", "unlocated", "weak"]);
  assert.equal(first.visibleMapped, 2);
  assert.deepEqual(e.viewport(1, secondArea, 19).ids, query.ids);
  assert.deepEqual(e.viewport(1, firstArea, 19), first);
  assert.deepEqual(
    e.viewport(1, { ...firstArea, south: 40.9, north: 41 }, 19).ids,
    query.ids,
  );
  e.query(2, { ...criteria, search: "taco bell", grade: "none" });
  assert.equal(e.viewport(1, firstArea, 19), null);
  assert.deepEqual(e.viewport(2, firstArea, 19).ids, []);
});

test("viewport ranking gives only a modest relevance bonus within the same match class", () => {
  const strong = { ...rows[0], id: "strong", name: "ORCHRD", lon: -73.94 },
    weak = { ...rows[0], id: "weak", name: "ORCHID", lon: -73.98 };
  const e = createExplorer([weak, strong]);
  e.query(1, { ...criteria, search: "orchard" });
  assert.deepEqual(
    e.viewport(1, { west: -74.02, south: 40.7, east: -73.97, north: 40.76 }, 19)
      .ids,
    ["strong", "weak"],
  );
});

test("missing locations slightly lower similar search matches without overriding exact-name or ID priority", () => {
  const restaurant = (id, name, located, latest_date = "2026-09-25") => ({
    ...rows[0],
    id,
    name,
    address: "Different address",
    latest_date,
    lat: located ? 40.73 : null,
    lon: located ? -73.98 : null,
  });
  const search = createRestaurantSearch([
    restaurant("991", "ORCHARD", false),
    restaurant("992", "ORCHARD CAFE", true),
    restaurant("993", "991 DINER", true),
    restaurant("994", "CHEZ LUNA", false, "2026-09-27"),
    restaurant("995", "CHEZ LUNA", true, "2026-09-01"),
  ]);
  assert.deepEqual(
    search("orchard")
      .slice(0, 2)
      .map((r) => r.id),
    ["991", "992"],
  );
  assert.deepEqual(
    search("991")
      .slice(0, 2)
      .map((r) => r.id),
    ["991", "993"],
  );
  assert.deepEqual(
    search("chez luna").map((r) => r.id),
    ["995", "994"],
  );
  const fuzzy = createRestaurantSearch([
    restaurant("near", "ORCHRD", false),
    restaurant("far", "ORCHID", true),
  ]);
  assert.deepEqual(
    fuzzy("orchard").map((r) => r.id),
    ["near", "far"],
  );
});

test("worker client coalesces queued searches and rejects outstanding work on disposal", async (t) => {
  let fake;
  class Worker {
    messages = [];
    terminated = false;
    constructor() {
      fake = this;
    }
    postMessage(message) {
      this.messages.push(message);
      if (message.type === "init")
        queueMicrotask(() => this.onmessage({ data: { id: message.id } }));
    }
    terminate() {
      this.terminated = true;
    }
    reply(message, result) {
      this.onmessage({ data: { id: message.id, result } });
    }
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    value: Worker,
    configurable: true,
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "Worker", previous);
    else delete globalThis.Worker;
  });
  // Compile the actual client so this test also runs on Node 22.12 without a TS loader.
  const directory = await mkdtemp(path.join(tmpdir(), "nyc-worker-client-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await readFile(
    new URL("../src/data/explorer-client.ts", import.meta.url),
    "utf8",
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const compiled = path.join(directory, "client.mjs");
  await writeFile(compiled, output);
  const { ExplorerClient } = await import(pathToFileURL(compiled).href);
  const client = new ExplorerClient(rows);
  const first = client.query(1, criteria),
    second = client.query(2, criteria),
    third = client.query(3, criteria);
  assert.equal(await second, null);
  await new Promise(setImmediate);
  assert.deepEqual(
    fake.messages.map((m) => m.type),
    ["init", "query"],
  );
  fake.reply(fake.messages[1], { revision: 1 });
  assert.equal((await first).revision, 1);
  await new Promise(setImmediate);
  assert.equal(fake.messages[2].args[0], 3);
  fake.reply(fake.messages[2], { revision: 3 });
  assert.equal((await third).revision, 3);
  const pending = client.viewport(3, bounds, 12);
  client.dispose();
  await assert.rejects(pending, /closed/);
  assert.equal(fake.terminated, true);
  await assert.rejects(client.query(4, criteria), /closed/);
});
