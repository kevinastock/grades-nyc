import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeRestaurantColumns,
  validateSummary,
} from "../src/data/manifest.mjs";

// Independent wire and UI fixtures catch fields being transposed in the wrong order.
function wireSummary() {
  return {
    restaurants: {
      id: ["00123", "123"],
      name: ["Z Café", "A Diner"],
      borough: ["Unknown", "Queens"],
      address: ["", "1 Main St"],
      zip: ["00123", "10001"],
      cuisine: ["Coffee/Tea", "American"],
      lat: [null, 40.73],
      lon: [null, -73.98],
      grade: [null, "A"],
      grade_date: [null, "2026-08-01"],
      grade_inspected: [null, "2026-07-30"],
      latest_date: [null, "2026-09-25"],
      latest_codes: ["", "04L,10F"],
      closure: ["none", "uncertain"],
      closed_date: [null, "2026-01-01"],
    },
    violations: [
      {
        code: "04L",
        description: "Mice",
        critical: true,
        critical_varies: false,
        occurrences: 1,
      },
    ],
    definitions: [{ code: "04L", description: null, critical: null }],
    cuisines: ["American", "Coffee/Tea"],
    boroughs: ["Queens", "Unknown"],
  };
}
const expectedRows = [
  {
    id: "00123",
    name: "Z Café",
    borough: "Unknown",
    address: "",
    zip: "00123",
    cuisine: "Coffee/Tea",
    lat: null,
    lon: null,
    grade: null,
    grade_date: null,
    grade_inspected: null,
    latest_date: null,
    latest_codes: "",
    closure: "none",
    closed_date: null,
  },
  {
    id: "123",
    name: "A Diner",
    borough: "Queens",
    address: "1 Main St",
    zip: "10001",
    cuisine: "American",
    lat: 40.73,
    lon: -73.98,
    grade: "A",
    grade_date: "2026-08-01",
    grade_inspected: "2026-07-30",
    latest_date: "2026-09-25",
    latest_codes: "04L,10F",
    closure: "uncertain",
    closed_date: "2026-01-01",
  },
];
const manifest = { summary: { rows: 2 } };

test("summary columns preserve every value, type, identifier and restaurant order", () => {
  const wire = wireSummary(),
    before = structuredClone(wire);
  const decoded = validateSummary(wire, manifest);
  assert.deepEqual(decoded.restaurants, expectedRows);
  assert.deepEqual(decoded, { ...before, restaurants: expectedRows });
  assert.deepEqual(
    wire,
    before,
    "decoding leaves the compact wire data unchanged",
  );
  assert.deepEqual(encodeRestaurantColumns(expectedRows), wire.restaurants);
});

test("an empty summary retains its complete column schema and decodes to no restaurants", () => {
  const wire = wireSummary();
  for (const field of Object.keys(wire.restaurants))
    wire.restaurants[field] = [];
  assert.deepEqual(encodeRestaurantColumns([]), wire.restaurants);
  assert.deepEqual(
    validateSummary(wire, { summary: { rows: 0 } }).restaurants,
    [],
  );
});

test("summary rejects missing, non-array and unequal-length columns before decoding", () => {
  for (const field of Object.keys(wireSummary().restaurants)) {
    for (const corrupt of [
      (columns) => delete columns[field],
      (columns) => {
        columns[field] = null;
      },
      (columns) => {
        columns[field] = "not an array";
      },
      (columns) => columns[field].pop(),
      (columns) => columns[field].push(columns[field][0]),
    ]) {
      const wire = wireSummary();
      corrupt(wire.restaurants);
      assert.throws(
        () => validateSummary(wire, manifest),
        /Invalid restaurant summary/,
        field,
      );
    }
  }
  for (const restaurants of [
    null,
    [],
    expectedRows,
    {},
    { ...wireSummary().restaurants, extra: [1, 2] },
  ]) {
    assert.throws(
      () => validateSummary({ ...wireSummary(), restaurants }, manifest),
      /Invalid restaurant summary/,
    );
  }
  assert.throws(
    () => validateSummary(wireSummary(), { summary: { rows: 1 } }),
    /Invalid restaurant summary/,
  );
});

test("summary rejects duplicate identifiers and malformed typed column values", () => {
  const invalid = {
    id: [123, null],
    name: [null, 0],
    borough: [null, false],
    address: [null, []],
    zip: [123, null],
    cuisine: [null, {}],
    lat: ["40.73", Infinity, NaN],
    lon: ["-73.98", -Infinity, NaN],
    grade: [0, false],
    grade_date: [0, {}],
    grade_inspected: [0, []],
    latest_date: [0, false],
    latest_codes: [null, []],
    closure: ["closed", "", null],
    closed_date: [0, false],
  };
  for (const [field, values] of Object.entries(invalid)) {
    for (const value of values) {
      const wire = wireSummary();
      wire.restaurants[field][0] = value;
      assert.throws(
        () => validateSummary(wire, manifest),
        /Invalid restaurant summary record/,
        field,
      );
    }
  }
  const duplicate = wireSummary();
  duplicate.restaurants.id[1] = duplicate.restaurants.id[0];
  assert.throws(
    () => validateSummary(duplicate, manifest),
    /Invalid restaurant summary record/,
  );
  const specialIds = wireSummary();
  specialIds.restaurants.id = ["__proto__", "constructor"];
  assert.deepEqual(
    validateSummary(specialIds, manifest).restaurants.map((r) => r.id),
    specialIds.restaurants.id,
  );
});
