import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { convertData } from "../scripts/convert-data.mjs";
import {
  MODEL_SQL,
  CATALOG_SQL,
  inspectionQuery,
  sqlString,
} from "../scripts/model.mjs";
import { createRestaurantSearch } from "../src/data/search.mjs";
import { groupInspections } from "../src/data/presentation.mjs";
import {
  matchingCodes,
  restaurantLinks,
  hasCoordinates,
} from "../src/data/model.mjs";
import {
  SUMMARY_FIELDS,
  validateManifest,
  validateSummary,
  decodeInspections,
  detailBucket,
} from "../src/data/manifest.mjs";

// Invented records exercise the full CSV -> SQL -> browser JSON pipeline without
// storing a city dataset or coupling these regressions to a changing snapshot.
const headers = [
  "CAMIS",
  "DBA",
  "BORO",
  "BUILDING",
  "STREET",
  "ZIPCODE",
  "PHONE",
  "CUISINE DESCRIPTION",
  "INSPECTION DATE",
  "ACTION",
  "VIOLATION CODE",
  "VIOLATION DESCRIPTION",
  "CRITICAL FLAG",
  "SCORE",
  "GRADE",
  "GRADE DATE",
  "RECORD DATE",
  "INSPECTION TYPE",
  "Latitude",
  "Longitude",
];
const cited = "Violations were cited in the following area(s).";
const reinspection = "Cycle Inspection / Re-inspection";
const initial = "Cycle Inspection / Initial Inspection";
const record = (id, name, date, fields = {}) => ({
  CAMIS: id,
  DBA: name,
  BORO: "Manhattan",
  BUILDING: "001",
  STREET: "TEST STREET",
  ZIPCODE: "00123",
  PHONE: "0012345678",
  "CUISINE DESCRIPTION": "American",
  "INSPECTION DATE": date,
  ACTION: cited,
  "VIOLATION CODE": "10F",
  "VIOLATION DESCRIPTION": "Test surface needs cleaning.",
  "CRITICAL FLAG": "Not Critical",
  SCORE: "12",
  GRADE: "A",
  "GRADE DATE": date,
  "RECORD DATE": "09/26/2026",
  "INSPECTION TYPE": reinspection,
  Latitude: "40.75",
  Longitude: "-73.98",
  ...fields,
});
const ungraded = { GRADE: "", "GRADE DATE": "" };
const latestBakery = record("001001", "ANGELINA'S BAKERY", "09/23/2026", {
  ...ungraded,
  SCORE: "29",
  "INSPECTION TYPE": initial,
  "VIOLATION CODE": "04L",
  "VIOLATION DESCRIPTION": "Test mice finding.",
  "CRITICAL FLAG": "Critical",
});
const rows = [
  record("001001", "ANGELINA'S BAKERY", "02/24/2025"),
  latestBakery,
  latestBakery, // Exact duplicates must not inflate inspections or findings.
  {
    ...latestBakery,
    "VIOLATION CODE": "06A",
    "VIOLATION DESCRIPTION": "Test hygiene finding.",
  },
  {
    ...latestBakery,
    "INSPECTION TYPE": "Smoke-Free Air Act / Initial Inspection",
    SCORE: "",
  },
  record("001001", "ANGELINA'S BAKERY", "09/23/2026", {
    ...ungraded,
    "INSPECTION TYPE": "Smoke-Free Air Act / Initial Inspection",
    SCORE: "",
  }),
  record("001002", "CLOSED TEST CAFE", "09/24/2026", {
    ...ungraded,
    ACTION: "Establishment closed.",
    "VIOLATION CODE": "01A",
    "VIOLATION DESCRIPTION": "Excluded closed-only finding.",
    BORO: "Closed-only borough",
    "CUISINE DESCRIPTION": "Closed-only cuisine",
  }),
  record("001003", "PENDING TEST CAFE", "01/01/1900", {
    ...ungraded,
    BORO: "0",
    SCORE: "",
    "VIOLATION CODE": "",
    "VIOLATION DESCRIPTION": "",
    "CRITICAL FLAG": "",
    Latitude: "",
    Longitude: "",
  }),
  record("001004", "REOPENED TEST CAFE", "05/14/2026", {
    ...ungraded,
    ACTION: "Establishment closed.",
  }),
  record("001004", "REOPENED TEST CAFE", "05/15/2026", {
    ACTION: "Establishment re-opened.",
    GRADE: "C",
    SCORE: "3",
    "INSPECTION TYPE": "Cycle Inspection / Reopening Inspection",
  }),
  ...["Critical", "Not Critical"].map((critical) =>
    record("001005", "KATZ'S TEST DELICATESSEN", "09/22/2026", {
      BUILDING: "205",
      STREET: "EAST HOUSTON",
      GRADE: "B",
      SCORE: "17",
      "VIOLATION CODE": "09A",
      "VIOLATION DESCRIPTION": "Newest test wording.",
      "CRITICAL FLAG": critical,
    }),
  ),
  record("001006", "MCDONALD'S TEST CAFE", "01/01/2025", {
    "VIOLATION CODE": "09A",
    "VIOLATION DESCRIPTION": "Old test wording.",
  }),
  record("001006", "MCDONALD'S TEST CAFE", "09/21/2026", {
    "INSPECTION TYPE": initial,
    SCORE: "7",
    "VIOLATION CODE": "",
    "VIOLATION DESCRIPTION": "",
    "CRITICAL FLAG": "",
  }),
  record("001007", "CAFE KATZ TEST", "09/20/2026"),
];
const csvRow = (values) =>
  values
    .map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`)
    .join(",");
let directory, database, output, manifest, summary, restaurants;
function query(sql) {
  const result = spawnSync("duckdb", ["-bail", "-json", database], {
    input: sql,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : [];
}
const readJson = async (file) =>
  JSON.parse(await readFile(path.join(output, file), "utf8"));
const visits = (id) => query(inspectionQuery(id));

before(async () => {
  const engine = spawnSync("duckdb", ["--version"], { encoding: "utf8" });
  assert.equal(
    engine.status,
    0,
    "DuckDB CLI is required for data tests; install it before running npm test.",
  );
  directory = await mkdtemp(path.join(os.tmpdir(), "nyc-grades-model-test-"));
  database = path.join(directory, "model.duckdb");
  output = path.join(directory, "data");
  const input = path.join(directory, "source.csv");
  await writeFile(
    input,
    [
      csvRow(headers),
      ...rows.map((row) => csvRow(headers.map((name) => row[name]))),
    ].join("\n") + "\n",
  );
  manifest = validateManifest(await convertData(input, output));
  summary = validateSummary(await readJson(manifest.summary.file), manifest);
  const normalized = await readFile(
    new URL("../scripts/normalize.sql", import.meta.url),
    "utf8",
  );
  query(`CREATE TABLE raw AS SELECT * REPLACE (
    strptime("INSPECTION DATE", '%m/%d/%Y')::DATE AS "INSPECTION DATE",
    strptime("GRADE DATE", '%m/%d/%Y')::DATE AS "GRADE DATE",
    strptime("RECORD DATE", '%m/%d/%Y')::DATE AS "RECORD DATE",
    SCORE::INTEGER AS SCORE, Latitude::DOUBLE AS Latitude, Longitude::DOUBLE AS Longitude
  ) FROM read_csv(${sqlString(input)}, header=true, all_varchar=true);
  ${normalized}
  ${["restaurants", "inspections", "violations", "findings"].map((name) => `ALTER TABLE ${name} RENAME TO source_${name};`).join("\n")}
  ${MODEL_SQL}`);
  restaurants = query("SELECT * FROM restaurants");
});
after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("normalization retains six open restaurants and deduplicates nine completed inspections", () => {
  assert.equal(manifest.snapshot, "2026-09-26");
  assert.equal(manifest.rowCount, 15);
  assert.equal(restaurants.length, 6);
  assert.equal(query("SELECT count(*)::INTEGER AS n FROM inspections")[0].n, 9);
  assert.equal(
    query("SELECT count(*)::INTEGER AS n FROM current_grades")[0].n,
    5,
  );
  assert.equal(
    query("SELECT count(DISTINCT code)::INTEGER AS n FROM finding_records")[0]
      .n,
    4,
  );
});

test("newer ungraded inspections preserve the awarded grade and expose newer findings", () => {
  const restaurant = restaurants.find((r) => r.id === "001001");
  assert.equal(restaurant.grade, "A");
  assert.equal(restaurant.grade_inspected, "2025-02-24");
  assert.equal(restaurant.latest_date, "2026-09-23");
  assert.equal(restaurant.grade_codes, "10F");
  assert.equal(restaurant.latest_codes, "04L,06A,10F");
  const inspection = visits(restaurant.id)[0];
  assert.equal(inspection.score, 29);
  assert.equal(inspection.grade, null);
  assert.deepEqual(
    inspection.findings.map((f) => f.code),
    ["04L", "06A"],
  );
});

test("never-inspected sentinel dates and recorded closures are handled separately from grades", () => {
  const pending = restaurants.find((r) => r.id === "001003");
  assert.equal(pending.latest_date, null);
  assert.equal(pending.grade, null);
  assert.equal(pending.borough, "Unknown");
  assert.equal(pending.inspection_count, 0);
  assert.deepEqual(visits(pending.id), []);
  assert.ok(!restaurants.some((r) => r.id === "001002"));
  assert.deepEqual(visits("001002"), []);
  const reopened = restaurants.find((r) => r.id === "001004");
  assert.equal(reopened.closure, "none");
  assert.equal(reopened.closed_date, "2026-05-14");
  assert.equal(reopened.reopened_date, "2026-05-15");
});

test("same-day records become one complete inspection with distinct watched findings first", () => {
  const inspections = visits("001001");
  assert.equal(
    inspections.filter((i) => i.inspected === "2026-09-23").length,
    2,
  );
  const grouped = groupInspections(inspections, ["10F"]);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].inspected, "2026-09-23");
  assert.equal(grouped[0].findings.length, 3);
  assert.equal(grouped[0].findings[0].code, "10F");
  assert.deepEqual(
    new Set(grouped[0].findings.map((f) => f.code)),
    new Set(["04L", "06A", "10F"]),
  );
});

test("reopening grades are never inferred from low scores", () => {
  const reopening = visits("001004")[0];
  assert.equal(reopening.grade, "C");
  assert.equal(reopening.score, 3);
  assert.equal(restaurants.find((r) => r.id === "001004").grade, "C");
});

test("violation catalog uses the latest description and classification and counts distinct restaurants", () => {
  const catalog = query(CATALOG_SQL);
  assert.deepEqual(
    catalog.map((v) => v.code),
    ["04L", "06A", "09A", "10F"],
  );
  assert.deepEqual(
    catalog.find((v) => v.code === "09A"),
    {
      code: "09A",
      description: "Newest test wording.",
      critical: true,
      critical_varies: true,
      occurrences: 2,
    },
  );
  assert.equal(catalog.find((v) => v.code === "10F").occurrences, 3);
  assert.equal(summary.definitions.length, 6);
  assert.ok(
    summary.definitions.some((v) => v.description === "Old test wording."),
  );
  assert.ok(!summary.definitions.some((v) => v.code === "01A"));
});

test("warnings respect inspection scope and distinct codes", () => {
  const restaurant = {
    latest_codes: "04L,06A",
    grade_codes: "06A,10F",
    history_codes: "04L,06A,10F,02B",
  };
  assert.deepEqual(matchingCodes(restaurant, ["06A", "10F", "02B"]), [
    "06A",
    "10F",
  ]);
  assert.deepEqual(matchingCodes(restaurant, ["06A", "10F", "02B"], "latest"), [
    "06A",
  ]);
  assert.deepEqual(
    matchingCodes(restaurant, ["06A", "10F", "02B"], "history"),
    ["06A", "10F", "02B"],
  );
});

test("restaurant links escape names and use addresses and official permit identifiers", () => {
  const restaurant = {
    id: "00123/45?x=1",
    name: "Joe's & Sons",
    address: "12 W 1 ST",
    borough: "Manhattan",
    zip: "10001",
    lat: 40.73,
    lon: -73.98,
  };
  const links = restaurantLinks(restaurant);
  assert.equal(
    links.abcEats,
    "https://a816-health.nyc.gov/ABCEatsRestaurants/#!/Search/00123%2F45%3Fx%3D1",
  );
  assert.ok(
    new URL(links.googleSearch).searchParams.get("q").includes("Joe's & Sons"),
  );
  assert.equal(
    new URL(links.googleAddress).searchParams.get("query"),
    "12 W 1 ST, Manhattan, NY, 10001",
  );
  assert.equal(
    new URL(
      restaurantLinks({ ...restaurant, lat: null, lon: null }).appleAddress,
    ).searchParams.get("q"),
    "12 W 1 ST, Manhattan, NY, 10001",
  );
  assert.equal(hasCoordinates({ lat: null, lon: null }), false);
  assert.equal(restaurants.filter(hasCoordinates).length, 5);
});

test("inspection lookup escapes SQL metacharacters", () => {
  assert.deepEqual(query(inspectionQuery("' OR true --")), []);
  assert.equal(query("SELECT count(*)::INTEGER AS n FROM restaurants")[0].n, 6);
});

test("search prioritizes name prefixes and tolerates typos and punctuation after conversion", () => {
  const search = createRestaurantSearch(summary.restaurants);
  assert.ok(search("angelinas bakry").some((r) => r.id === "001001"));
  assert.equal(search("mcdonald's")[0].id, "001006");
  assert.equal(search("katz")[0].name, "KATZ'S TEST DELICATESSEN");
  assert.equal(search("katz’s test delicatessen")[0].id, "001005");
  assert.ok(search("205 east houston").some((r) => r.id === "001005"));
  assert.equal(search("001005")[0].id, "001005");
  assert.deepEqual(search("!!!"), []);
});

test("generated JSON preserves all retained summary fields and complete bucketed histories", async () => {
  const expected = query(
    `SELECT ${SUMMARY_FIELDS.join(",")} FROM restaurants ORDER BY name,id`,
  ).sort(
    (a, b) =>
      (b.latest_date || "").localeCompare(a.latest_date || "") ||
      a.name.localeCompare(b.name),
  );
  assert.deepEqual(summary.restaurants, expected);
  assert.deepEqual(
    summary.restaurants.map((r) => r.id),
    ["001001", "001005", "001006", "001007", "001004", "001003"],
  );
  assert.deepEqual(summary.restaurants[0], {
    id: "001001",
    name: "ANGELINA'S BAKERY",
    borough: "Manhattan",
    address: "001 TEST STREET",
    zip: "00123",
    cuisine: "American",
    lat: 40.75,
    lon: -73.98,
    grade: "A",
    grade_date: "2025-02-24",
    grade_inspected: "2025-02-24",
    latest_date: "2026-09-23",
    latest_codes: "04L,06A,10F",
    closure: "none",
    closed_date: null,
  });
  assert.deepEqual(summary.violations, query(CATALOG_SQL));
  assert.deepEqual(
    summary.definitions,
    query(
      "SELECT code, description, critical FROM source_violations ORDER BY violation_id",
    ),
  );
  assert.deepEqual(summary.cuisines, ["American"]);
  assert.deepEqual(summary.boroughs, ["Manhattan", "Unknown"]);
  const byId = new Map(
    restaurants.filter((r) => r.latest_date).map((r) => [r.id, visits(r.id)]),
  );
  let count = 0;
  for (const [index, asset] of manifest.details.entries()) {
    const shard = await readJson(asset.file);
    let shardRows = 0;
    for (const [id, tuples] of Object.entries(shard)) {
      assert.equal(detailBucket(id), index);
      const history = decodeInspections(tuples, summary.definitions);
      assert.deepEqual(history, byId.get(id), `complete history ${id}`);
      shardRows += history.length;
      byId.delete(id);
    }
    assert.equal(shardRows, asset.rows);
    count += shardRows;
  }
  assert.equal(count, 9);
  assert.equal(byId.size, 0);
});
