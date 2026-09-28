import { test } from "node:test";
import assert from "node:assert/strict";
import { inMapBounds, locatedFirst } from "../src/data/map.mjs";

const bounds = { west: -74.02, south: 40.7, east: -73.97, north: 40.76 };

test("map filtering includes visible locations and all four map edges", () => {
  for (const [lat, lon] of [
    [40.73, -74],
    [40.7, -74],
    [40.76, -74],
    [40.73, -74.02],
    [40.73, -73.97],
  ]) {
    assert.equal(inMapBounds({ lat, lon }, bounds), true);
  }
});

test("map filtering excludes located restaurants outside any edge", () => {
  for (const [lat, lon] of [
    [40.69, -74],
    [40.77, -74],
    [40.73, -74.03],
    [40.73, -73.96],
  ]) {
    assert.equal(inMapBounds({ lat, lon }, bounds), false);
  }
});

test("restaurants without usable pins remain visible in every map area", () => {
  for (const [lat, lon] of [
    [null, -74],
    [40.73, null],
    [0, 0],
    [NaN, -74],
    [40.73, Infinity],
    [45, -74],
  ]) {
    assert.equal(inMapBounds({ lat, lon }, bounds), true);
    assert.equal(
      inMapBounds(
        { lat, lon },
        { west: -73.9, south: 40.9, east: -73.8, north: 41 },
      ),
      true,
    );
  }
});

test("default ordering puts located restaurants first without reordering either group", () => {
  const unlocated = { id: "u1", lat: null, lon: null },
    located = { id: "l1", lat: 40.73, lon: -74 },
    invalid = { id: "u2", lat: 0, lon: 0 },
    other = { id: "l2", lat: 40.74, lon: -73.98 };
  const input = [unlocated, located, invalid, other];
  assert.deepEqual(locatedFirst(input), [located, other, unlocated, invalid]);
  assert.deepEqual(input, [unlocated, located, invalid, other]);
});

test("viewport ordering groups visible, offscreen, then unlocated without excluding candidates", () => {
  const unlocated = { id: "u1", lat: null, lon: null },
    outside = { id: "o1", lat: 40.8, lon: -74 },
    inside = { id: "i1", lat: 40.73, lon: -74 },
    otherOutside = { id: "o2", lat: 40.8, lon: -73.98 },
    invalid = { id: "u2", lat: 0, lon: 0 },
    otherInside = { id: "i2", lat: 40.74, lon: -73.98 };
  const input = [
    unlocated,
    outside,
    inside,
    otherOutside,
    invalid,
    otherInside,
  ];
  assert.deepEqual(locatedFirst(input, bounds), [
    inside,
    otherInside,
    outside,
    otherOutside,
    unlocated,
    invalid,
  ]);
  assert.deepEqual(input, [
    unlocated,
    outside,
    inside,
    otherOutside,
    invalid,
    otherInside,
  ]);
});

test("the full list remains available before initial map bounds arrive", () => {
  assert.equal(inMapBounds({ lat: 40.73, lon: -74 }, null), true);
  assert.equal(inMapBounds({ lat: null, lon: null }, null), true);
});
