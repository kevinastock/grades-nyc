import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { convertData } from "../scripts/convert-data.mjs";
import { prepareData } from "../scripts/prepare-data.mjs";
import {
  MANIFEST_FILE,
  LEGACY_MANIFEST_FILE,
  LEGACY_SCHEMA_VERSION,
  SUMMARY_FIELDS,
  validateManifest,
  snapshotAssets,
  detailBucket,
  decodeInspections,
  validateSummary,
} from "../src/data/manifest.mjs";
before(() => {
  const engine = spawnSync("duckdb", ["--version"], { encoding: "utf8" });
  assert.equal(
    engine.status,
    0,
    "DuckDB CLI is required for data pipeline tests. Install DuckDB and make duckdb available on PATH.",
  );
});
const hash = (value) => createHash("sha256").update(value).digest("hex");
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
const basic = {
  CAMIS: "00123456",
  DBA: "O'Brien's Test Cafe",
  BORO: "Manhattan",
  BUILDING: "001",
  STREET: "TEST STREET",
  ZIPCODE: "00123",
  PHONE: "0012345678",
  "CUISINE DESCRIPTION": "American",
  "INSPECTION DATE": "09/25/2026",
  ACTION: "Violations were cited in the following area(s).",
  "VIOLATION CODE": "04L",
  "VIOLATION DESCRIPTION": "Evidence of mice, or live mice present.",
  "CRITICAL FLAG": "Critical",
  SCORE: "12",
  GRADE: "A",
  "GRADE DATE": "09/25/2026",
  "RECORD DATE": "09/26/2026",
  "INSPECTION TYPE": "Cycle Inspection / Re-inspection",
  Latitude: "40.75",
  Longitude: "-73.98",
};
function fixture(rows = [basic]) {
  const csvRow = (row) =>
    row
      .map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`)
      .join(",");
  return (
    [
      csvRow(headers),
      ...rows.map((row) => csvRow(headers.map((name) => row[name]))),
    ].join("\n") + "\n"
  );
}
async function withDirectory(run) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "nyc-grades-data-test-"),
  );
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function readJson(directory, file) {
  return JSON.parse(await readFile(path.join(directory, file), "utf8"));
}
async function snapshotBytes(directory) {
  const manifest = await readJson(directory, MANIFEST_FILE);
  const legacy = await readJson(directory, LEGACY_MANIFEST_FILE);
  const files = new Set([
    MANIFEST_FILE,
    LEGACY_MANIFEST_FILE,
    ...snapshotAssets(manifest).map((asset) => asset.file),
    legacy.summary.file,
  ]);
  return Object.fromEntries(
    await Promise.all(
      [...files].map(async (file) => [
        file,
        hash(await readFile(path.join(directory, file))),
      ]),
    ),
  );
}

async function snapshot(directory, manifest) {
  const wire = await readJson(directory, manifest.summary.file);
  assert.ok(!Array.isArray(wire.restaurants));
  assert.ok(Array.isArray(wire.restaurants.id));
  assert.equal(wire.restaurants.id.length, manifest.summary.rows);
  const summary = validateSummary(wire, manifest);
  return {
    ...summary,
    history: async (id) => {
      const shard = await readJson(
        directory,
        manifest.details[detailBucket(id)].file,
      );
      return decodeInspections(shard[id] || [], summary.definitions);
    },
  };
}

test("JSON retains clean visits, sentinel findings, historical variants, score conflicts, and closure ambiguity", async () =>
  withDirectory(async (directory) => {
    const input = path.join(directory, "history.csv"),
      output = path.join(directory, "data");
    const prior = {
      ...basic,
      "INSPECTION DATE": "01/01/2025",
      "GRADE DATE": "01/01/2025",
      "VIOLATION DESCRIPTION": "Older mice wording",
    };
    const initial = {
      ...basic,
      "INSPECTION DATE": "01/01/2026",
      "GRADE DATE": "01/01/2026",
      "INSPECTION TYPE": "Cycle Inspection / Initial Inspection",
      SCORE: "10",
      "VIOLATION DESCRIPTION": "New mice wording",
      "CRITICAL FLAG": "Not Critical",
    };
    const clean = {
      ...basic,
      "INSPECTION TYPE": "Administrative / Inspection",
      SCORE: "",
      GRADE: "",
      "GRADE DATE": "",
      "VIOLATION CODE": "",
      "VIOLATION DESCRIPTION": "",
      "CRITICAL FLAG": "",
      ACTION: "No violations were recorded at the time of this inspection.",
    };
    const rows = [
      prior,
      initial,
      initial,
      {
        ...initial,
        SCORE: "14",
        "VIOLATION CODE": "10F",
        "VIOLATION DESCRIPTION": "",
        "CRITICAL FLAG": "",
      },
      {
        ...initial,
        "INSPECTION TYPE": "Smoke-Free Air Act / Initial Inspection",
        GRADE: "",
        SCORE: "",
        "CRITICAL FLAG": "Critical",
      },
      clean,
      {
        ...clean,
        CAMIS: "002",
        "INSPECTION DATE": "01/01/1900",
        "VIOLATION CODE": "02B",
        "VIOLATION DESCRIPTION": "Sentinel finding",
        "CRITICAL FLAG": "Critical",
      },
      { ...clean, CAMIS: "003", "INSPECTION DATE": "05/01/2026" },
      {
        ...basic,
        CAMIS: "004",
        "INSPECTION TYPE": "Cycle Inspection / Reopening Inspection",
        GRADE: "C",
        SCORE: "3",
      },
      { ...clean, CAMIS: "005", ACTION: "Establishment closed." },
      { ...clean, CAMIS: "005", ACTION: "Establishment re-opened." },
      { ...clean, CAMIS: "006", Latitude: "NaN", Longitude: "Infinity" },
      { ...basic, CAMIS: "", "RECORD DATE": "12/31/2026" },
    ];
    await writeFile(input, fixture(rows));
    const manifest = await convertData(input, output),
      data = await snapshot(output, manifest);
    assert.equal(manifest.rowCount, rows.length - 1);
    assert.equal(manifest.snapshot, "2026-09-26");
    assert.equal(data.restaurants.length, 6);
    const main = data.restaurants.find((r) => r.id === "00123456");
    assert.equal(main.grade, "A");
    assert.equal(main.grade_inspected, "2025-01-01");
    assert.equal(main.latest_date, "2026-09-25");
    assert.equal(main.latest_codes, "");
    const visits = await data.history(main.id);
    assert.equal(visits.length, 4);
    assert.deepEqual(visits[0].findings, []);
    const conflicting = visits.find(
      (i) => i.inspection_type === initial["INSPECTION TYPE"],
    );
    assert.equal(conflicting.score, 14);
    assert.equal(conflicting.score_variants, 2);
    assert.deepEqual(
      conflicting.findings.find((f) => f.code === "10F"),
      { code: "10F", description: null, critical: null },
    );
    assert.equal(visits.at(-1).findings[0].description, "Older mice wording");
    assert.equal(
      data.restaurants.find((r) => r.id === "002").latest_date,
      null,
    );
    assert.deepEqual(await data.history("002"), []);
    assert.equal(data.restaurants.find((r) => r.id === "004").grade, "C");
    assert.equal(
      data.restaurants.find((r) => r.id === "005").closure,
      "uncertain",
    );
    const invalidPin = data.restaurants.find((r) => r.id === "006");
    assert.equal(invalidPin.lat, null);
    assert.equal(invalidPin.lon, null);
    assert.equal(data.violations.find((v) => v.code === "04L").occurrences, 2);
    assert.equal(
      data.violations.find((v) => v.code === "04L").critical_varies,
      false,
    );
    assert.equal(data.violations.find((v) => v.code === "02B").occurrences, 1);
    assert.deepEqual(
      (await data.history("003")).map((r) => r.findings),
      [[]],
    );
  }));

test("closed restaurants are removed from every JSON export while reopened and uncertain histories remain complete", async () =>
  withDirectory(async (directory) => {
    const input = path.join(directory, "closures.csv"),
      output = path.join(directory, "data");
    const record = (id, inspected, action, fields = {}) => ({
      ...basic,
      CAMIS: id,
      BORO: "Queens",
      "CUISINE DESCRIPTION": "Retained cuisine",
      "INSPECTION DATE": inspected,
      ACTION: action,
      ...fields,
    });
    const closedOnly = {
      BORO: "Closed-only borough",
      "CUISINE DESCRIPTION": "Closed-only cuisine",
      "VIOLATION DESCRIPTION": "Excluded newest wording",
    };
    const rows = [
      record("100", "09/01/2026", basic.ACTION, {
        "VIOLATION DESCRIPTION": "Retained wording",
        "CRITICAL FLAG": "Not Critical",
      }),
      record("200", "09/10/2026", basic.ACTION, {
        ...closedOnly,
        "VIOLATION CODE": "01A",
        "VIOLATION DESCRIPTION": "Closed-only definition",
      }),
      record("200", "09/20/2026", "Establishment closed.", {
        ...closedOnly,
        "RECORD DATE": "09/28/2026",
      }),
      ...[
        ["09/01/2026", "Establishment closed."],
        ["09/02/2026", "Establishment reopened."],
      ].map(([date, action]) =>
        record("300", date, action, {
          "VIOLATION CODE": "03X",
          "VIOLATION DESCRIPTION": "Kept reopening history",
        }),
      ),
      ...["Establishment closed.", "Establishment re-opened."].map((action) =>
        record("400", "09/03/2026", action, {
          "VIOLATION CODE": "03Y",
          "VIOLATION DESCRIPTION": "Kept ambiguous history",
        }),
      ),
      ...[
        ["09/01/2026", "Establishment closed."],
        ["09/02/2026", "Establishment re-opened."],
        ["09/03/2026", "Establishment closed."],
      ].map(([date, action]) =>
        record("500", date, action, {
          "VIOLATION CODE": "01B",
          "VIOLATION DESCRIPTION": "Reclosed-only definition",
        }),
      ),
      record("600", "09/01/2026", "Establishment closed.", {
        "VIOLATION CODE": "01C",
        "VIOLATION DESCRIPTION": "Still-closed definition",
      }),
      record("600", "09/05/2026", "Administrative inspection completed.", {
        "VIOLATION CODE": "",
        "VIOLATION DESCRIPTION": "",
        "CRITICAL FLAG": "",
      }),
      record("700", "01/01/1900", "Establishment closed.", {
        "VIOLATION CODE": "02B",
        "VIOLATION DESCRIPTION": "Undated closure finding",
      }),
    ];
    await writeFile(input, fixture(rows));
    const manifest = await convertData(input, output),
      data = await snapshot(output, manifest);
    assert.equal(
      manifest.rowCount,
      rows.length,
      "metadata counts all source rows",
    );
    assert.equal(
      manifest.snapshot,
      "2026-09-28",
      "excluded rows retain source snapshot provenance",
    );
    assert.deepEqual(data.restaurants.map((r) => r.id).sort(), [
      "100",
      "300",
      "400",
      "700",
    ]);
    assert.deepEqual(data.cuisines, ["Retained cuisine"]);
    assert.deepEqual(data.boroughs, ["Queens"]);
    assert.deepEqual(
      data.violations.map((v) => v.code),
      ["02B", "03X", "03Y", "04L"],
    );
    assert.deepEqual(
      data.definitions.map((v) => v.code),
      ["02B", "03X", "03Y", "04L"],
    );
    assert.deepEqual(
      data.violations.find((v) => v.code === "04L"),
      {
        code: "04L",
        description: "Retained wording",
        critical: false,
        critical_varies: false,
        occurrences: 1,
      },
    );
    assert.deepEqual(
      data.definitions.find((v) => v.code === "04L"),
      {
        code: "04L",
        description: "Retained wording",
        critical: false,
      },
    );
    const shards = await Promise.all(
      manifest.details.map((asset) => readJson(output, asset.file)),
    );
    assert.deepEqual(shards.flatMap((shard) => Object.keys(shard)).sort(), [
      "100",
      "300",
      "400",
    ]);
    assert.equal(
      manifest.details.reduce((count, asset) => count + asset.rows, 0),
      5,
    );
    const reopened = await data.history("300");
    assert.equal(data.restaurants.find((r) => r.id === "300").closure, "none");
    assert.deepEqual(
      reopened.map((visit) => visit.inspected),
      ["2026-09-02", "2026-09-01"],
    );
    assert.equal(reopened[1].action, "Establishment closed.");
    assert.equal(reopened[1].findings[0].description, "Kept reopening history");
    assert.equal(
      data.restaurants.find((r) => r.id === "400").closure,
      "uncertain",
    );
    assert.deepEqual(
      (await data.history("400")).map((visit) => visit.action),
      ["Establishment closed.", "Establishment re-opened."],
    );
    assert.equal(
      data.restaurants.find((r) => r.id === "700").latest_date,
      null,
    );
    assert.equal(data.restaurants.find((r) => r.id === "700").closure, "none");
    assert.deepEqual(await data.history("700"), []);
    assert.equal(data.violations.find((v) => v.code === "02B").occurrences, 1);
  }));

test("a valid source containing only closed restaurants publishes an empty dataset", async () =>
  withDirectory(async (directory) => {
    const input = path.join(directory, "all-closed.csv"),
      output = path.join(directory, "data");
    const rows = [
      { ...basic, "INSPECTION DATE": "09/01/2026" },
      { ...basic, ACTION: "Establishment closed." },
    ];
    await writeFile(input, fixture(rows));
    const manifest = await convertData(input, output),
      data = await snapshot(output, manifest);
    assert.equal(manifest.rowCount, 2);
    assert.equal(manifest.snapshot, "2026-09-26");
    assert.equal(manifest.summary.rows, 0);
    const legacy = await readJson(output, LEGACY_MANIFEST_FILE);
    assert.equal(
      legacy.summary.file,
      manifest.summary.file,
      "empty formats share one immutable summary",
    );
    const publicData = path.join(directory, "public/data");
    await prepareData(output, publicData, { prune: true });
    assert.equal(
      (await readdir(publicData)).length,
      snapshotAssets(manifest).length + 2,
    );
    for (const key of [
      "restaurants",
      "violations",
      "definitions",
      "cuisines",
      "boroughs",
    ])
      assert.deepEqual(data[key], [], key);
    for (const asset of manifest.details) {
      assert.equal(asset.rows, 0);
      assert.deepEqual(await readJson(output, asset.file), {});
    }
  }));

test("prepare validates every hash before publication and prunes stale JSON assets", async () =>
  withDirectory(async (directory) => {
    const input = path.join(directory, "source.csv"),
      output = path.join(directory, "data"),
      publicData = path.join(directory, "public/data");
    await writeFile(input, fixture());
    const manifest = await convertData(input, output);
    await mkdir(publicData, { recursive: true });
    await prepareData(output, publicData);
    assert.equal(
      (await readdir(publicData)).length,
      new Set([
        ...snapshotAssets(manifest).map((asset) => asset.file),
        (await readJson(output, LEGACY_MANIFEST_FILE)).summary.file,
      ]).size + 2,
    );
    const obsolete = `details-00-${"0".repeat(64)}.json`;
    await writeFile(path.join(publicData, obsolete), "{}");
    await prepareData(output, publicData);
    assert.ok((await readdir(publicData)).includes(obsolete));
    await prepareData(output, publicData, { prune: true });
    assert.ok(!(await readdir(publicData)).includes(obsolete));
    const legacy = await readJson(output, LEGACY_MANIFEST_FILE);
    assert.ok((await readdir(publicData)).includes(manifest.summary.file));
    assert.ok((await readdir(publicData)).includes(legacy.summary.file));
    const before = await snapshotBytes(publicData),
      file = path.join(output, manifest.details[0].file),
      bytes = await readFile(file);
    bytes[0] ^= 1;
    await writeFile(file, bytes);
    await assert.rejects(prepareData(output, publicData), /corrupted/);
    assert.deepEqual(await snapshotBytes(publicData), before);
  }));

test("conversion publishes schema-4 and released schema-3 columns for the same snapshot", async () =>
  withDirectory(async (directory) => {
    const input = path.join(directory, "migration.csv"),
      output = path.join(directory, "data");
    await writeFile(
      input,
      fixture([
        {
          ...basic,
          CAMIS: "00123",
          Latitude: "40.71278371",
          Longitude: "-74.00594059",
        },
        {
          ...basic,
          CAMIS: "123",
          DBA: "A Diner",
          ZIPCODE: "00123",
          Latitude: "",
          Longitude: "",
        },
        {
          ...basic,
          CAMIS: "__proto__",
          DBA: "Another Diner",
          "GRADE DATE": "",
          GRADE: "",
        },
      ]),
    );
    const current = await convertData(input, output);
    assert.deepEqual(
      await readJson(output, MANIFEST_FILE),
      current,
      "API returns the current manifest",
    );
    const legacy = validateManifest(
      await readJson(output, LEGACY_MANIFEST_FILE),
      LEGACY_SCHEMA_VERSION,
    );
    assert.throws(
      () => validateManifest(legacy),
      /Unsupported/,
      "new clients require their versioned manifest",
    );
    assert.equal(legacy.schemaVersion, 3);
    assert.equal(LEGACY_MANIFEST_FILE, "manifest.json");
    assert.equal(MANIFEST_FILE, "manifest-v4.json");
    assert.equal(legacy.snapshot, current.snapshot);
    assert.equal(legacy.rowCount, current.rowCount);
    assert.deepEqual(
      legacy.details,
      current.details,
      "histories are shared without renumbering definitions",
    );
    const compact = await readJson(output, current.summary.file);
    const plain = await readJson(output, legacy.summary.file);
    assert.deepEqual(Object.keys(plain.restaurants), SUMMARY_FIELDS);
    const decoded = validateSummary(compact, current);
    for (const field of SUMMARY_FIELDS) {
      assert.ok(
        Array.isArray(plain.restaurants[field]),
        `released schema-3 column ${field} remains an array`,
      );
      assert.deepEqual(
        plain.restaurants[field],
        decoded.restaurants.map((row) => row[field]),
        field,
      );
    }
    assert.ok(
      Object.values(compact.restaurants).some(
        (column) => !Array.isArray(column),
      ),
    );
    assert.deepEqual(validateSummary(plain, legacy), decoded);
    assert.ok(plain.restaurants.id.includes("00123"));
    assert.ok(plain.restaurants.id.includes("123"));
    assert.ok(plain.restaurants.id.includes("__proto__"));
    assert.ok(plain.restaurants.zip.includes("00123"));
    assert.ok(plain.restaurants.lat.includes(null));
    assert.ok(plain.restaurants.grade.includes(null));
  }));

test("prepare rejects incomplete or mismatched legacy output before changing either publication", async () =>
  withDirectory(async (directory) => {
    const input = path.join(directory, "source.csv"),
      output = path.join(directory, "data"),
      publicData = path.join(directory, "public/data");
    await writeFile(input, fixture());
    const current = await convertData(input, output);
    await prepareData(output, publicData);
    const before = await snapshotBytes(publicData);
    const legacyPath = path.join(output, LEGACY_MANIFEST_FILE);
    const legacyBytes = await readFile(legacyPath);
    const legacy = JSON.parse(legacyBytes);
    const plain = await readJson(output, legacy.summary.file);
    const unchanged = async () =>
      assert.deepEqual(await snapshotBytes(publicData), before);
    const restore = () => writeFile(legacyPath, legacyBytes);

    await rm(legacyPath);
    await assert.rejects(
      prepareData(output, publicData, { prune: true }),
      /complete JSON publication/,
    );
    await unchanged();
    await restore();

    await writeFile(
      legacyPath,
      JSON.stringify({ ...legacy, snapshot: "2026-01-01" }),
    );
    await assert.rejects(
      prepareData(output, publicData, { prune: true }),
      /same snapshot/,
    );
    await unchanged();
    await restore();

    const inconsistentHistory = structuredClone(legacy);
    inconsistentHistory.details[0].rows++;
    await writeFile(legacyPath, JSON.stringify(inconsistentHistory));
    await assert.rejects(
      prepareData(output, publicData, { prune: true }),
      /same snapshot/,
    );
    await unchanged();
    await restore();

    const legacyFile = path.join(output, legacy.summary.file);
    const original = await readFile(legacyFile);
    await writeFile(legacyFile, Buffer.from("corrupted"));
    await assert.rejects(
      prepareData(output, publicData, { prune: true }),
      /corrupted/,
    );
    await unchanged();
    await writeFile(legacyFile, original);

    for (const [edit, expected] of [
      [
        (wire) => {
          wire.restaurants.closure = { constant: "none" };
        },
        /plain columns/,
      ],
      [
        (wire) => {
          wire.restaurants.name[0] = "Different restaurant";
        },
        /same snapshot/,
      ],
    ]) {
      const wire = structuredClone(plain);
      edit(wire);
      const bytes = Buffer.from(JSON.stringify(wire));
      const file = `summary-${hash(bytes)}.json`;
      await writeFile(path.join(output, file), bytes);
      await writeFile(
        legacyPath,
        JSON.stringify({
          ...legacy,
          summary: { ...legacy.summary, file, bytes: bytes.length },
        }),
      );
      await assert.rejects(
        prepareData(output, publicData, { prune: true }),
        expected,
      );
      await unchanged();
      await restore();
    }
    assert.deepEqual(
      await prepareData(output, publicData, { prune: true }),
      current,
    );
    await unchanged();
  }));
