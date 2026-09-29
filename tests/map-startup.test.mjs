import assert from "node:assert/strict";
import test from "node:test";
import {
  restaurantBounds,
  startupMapBounds,
} from "../src/data/map-startup.mjs";

test("startup city bounds use the same usable locations as the full map", () => {
  assert.deepEqual(
    restaurantBounds([
      { lat: 40.5, lon: -74.24 },
      { lat: 40.91, lon: -73.7 },
      { lat: null, lon: -74 },
      { lat: 90, lon: 0 },
    ]),
    [-74.24, 40.5, -73.7, 40.91],
  );
});

test("published bounds require an immutable summary identity and a finite geographic box", (t) => {
  const previous = globalThis.__gradesMapBounds;
  t.after(() => {
    if (previous === undefined) delete globalThis.__gradesMapBounds;
    else globalThis.__gradesMapBounds = previous;
  });
  const fallback = restaurantBounds([]);
  const summary = `summary-${"a".repeat(64)}.json`;
  for (const value of [
    undefined,
    { summary: "unversioned.json", bounds: [1, 2, 3, 4] },
    { summary, bounds: [3, 2, 1, 4] },
    { summary, bounds: [1, 2, Infinity, 4] },
  ]) {
    globalThis.__gradesMapBounds = value;
    assert.deepEqual(startupMapBounds(), fallback);
  }
  globalThis.__gradesMapBounds = {
    summary,
    bounds: [-74.2, 40.5, -73.7, 40.9],
  };
  assert.deepEqual(startupMapBounds(), [-74.2, 40.5, -73.7, 40.9]);
});
