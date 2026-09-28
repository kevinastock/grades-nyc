import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_SQL, CATALOG_SQL } from "./model.mjs";
import { DATA_MINIMUMS, validateDataHealth } from "./validate-data.mjs";
import {
  SCHEMA_VERSION,
  SUMMARY_FIELDS,
  encodeRestaurantColumns,
  DETAIL_BUCKETS,
  bucketName,
  detailBucket,
  validateManifest,
  validateSummary,
  decodeInspections,
  snapshotAssets,
} from "../src/data/manifest.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const sqlString = (value) => "'" + value.replaceAll("'", "''") + "'";
const TABLES = ["restaurants", "inspections", "violations", "findings"];

/** Run all snapshot SQL once, and atomically publish only browser-ready JSON. */
export async function convertData(
  input,
  output = path.join(root, "data"),
  { minimums } = {},
) {
  input = path.resolve(input);
  output = path.resolve(output);
  const engine = spawnSync("duckdb", ["--version"], { encoding: "utf8" });
  if (engine.error || engine.status !== 0)
    throw new Error(
      "DuckDB CLI is required to convert data. Install it and try again.",
    );
  await mkdir(output, { recursive: true });
  const staging = await mkdtemp(path.join(output, ".nyc-grades-"));
  try {
    let sql = `SET threads=1;
CREATE TABLE raw AS SELECT
  CAMIS, DBA, BORO, BUILDING, STREET, ZIPCODE, PHONE, "CUISINE DESCRIPTION", ACTION,
  "VIOLATION CODE", "VIOLATION DESCRIPTION", "CRITICAL FLAG", GRADE, "INSPECTION TYPE",
  CAST(strptime(NULLIF(trim("INSPECTION DATE"), ''), ['%m/%d/%Y', '%Y-%m-%d']) AS DATE) AS "INSPECTION DATE",
  CAST(strptime(NULLIF(trim("GRADE DATE"), ''), ['%m/%d/%Y', '%Y-%m-%d']) AS DATE) AS "GRADE DATE",
  CAST(strptime(NULLIF(trim("RECORD DATE"), ''), ['%m/%d/%Y', '%Y-%m-%d']) AS DATE) AS "RECORD DATE",
  CAST(NULLIF(trim(SCORE), '') AS INTEGER) AS SCORE,
  CAST(NULLIF(trim(Latitude), '') AS DOUBLE) AS Latitude,
  CAST(NULLIF(trim(Longitude), '') AS DOUBLE) AS Longitude
FROM read_csv(${sqlString(input)}, header=true, all_varchar=true);
`;
    sql += await readFile(new URL("normalize.sql", import.meta.url), "utf8");
    for (const name of TABLES)
      sql += `\nALTER TABLE ${name} RENAME TO source_${name};`;
    sql += MODEL_SQL;
    const exports = {
      restaurants: `SELECT ${SUMMARY_FIELDS.map((key) => (["lat", "lon"].includes(key) ? `CASE WHEN isfinite(${key}) THEN ${key} ELSE NULL END AS ${key}` : key)).join(",")} FROM restaurants ORDER BY name,id`,
      catalog: CATALOG_SQL,
      definitions:
        "SELECT code, description, critical FROM source_violations ORDER BY violation_id",
      history: `SELECT i.restaurant_id AS id, CAST(i.inspected AS VARCHAR) AS inspected,
        i.inspection_type, i.action, i.grade, CAST(i.grade_date AS VARCHAR) AS grade_date,
        i.score, i.score_variants,
        coalesce(list(v.violation_id ORDER BY v.code, v.description, v.critical)
          FILTER (WHERE v.violation_id IS NOT NULL), []) AS findings
        FROM source_inspections i LEFT JOIN source_findings f USING(inspection_id)
        LEFT JOIN source_violations v USING(violation_id)
        WHERE i.inspected IS NOT NULL GROUP BY ALL
        ORDER BY id, inspected DESC, inspection_type, action`,
    };
    for (const [name, query] of Object.entries(exports))
      sql += `\nCOPY (${query}) TO ${sqlString(path.join(staging, `${name}.json`))} (FORMAT JSON, ARRAY true);`;
    sql +=
      "\nSELECT CAST(max(record_date) AS VARCHAR) AS snapshot, count(*)::INTEGER AS rowCount FROM records;";
    const result = spawnSync("duckdb", ["-bail", "-json", ":memory:"], {
      input: sql,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error || result.status !== 0)
      throw new Error(
        result.error?.message || result.stderr || "CSV conversion failed.",
      );
    const [meta] = JSON.parse(result.stdout);
    const read = async (name) =>
      JSON.parse(await readFile(path.join(staging, `${name}.json`), "utf8"));
    const [restaurants, violations, definitions, history] = await Promise.all(
      ["restaurants", "catalog", "definitions", "history"].map(read),
    );
    // Match the previous browser's stable ordering, including its name/id ties.
    restaurants.sort(
      (a, b) =>
        (b.latest_date || "").localeCompare(a.latest_date || "") ||
        a.name.localeCompare(b.name),
    );
    const summary = {
      restaurants: encodeRestaurantColumns(restaurants),
      violations,
      definitions,
      cuisines: [...new Set(restaurants.map((r) => r.cuisine))].sort(),
      boroughs: [...new Set(restaurants.map((r) => r.borough))].sort(),
    };
    if (minimums) validateDataHealth(summary, minimums);
    const buckets = Array.from({ length: DETAIL_BUCKETS }, () =>
      Object.create(null),
    );
    for (const r of history) {
      const bucket = buckets[detailBucket(r.id)];
      (bucket[r.id] ??= []).push([
        r.inspected,
        r.inspection_type,
        r.action,
        r.grade,
        r.grade_date,
        r.score,
        r.score_variants,
        r.findings,
      ]);
    }
    const asset = async (name, value, rows) => {
      const bytes = Buffer.from(JSON.stringify(value));
      const hash = createHash("sha256").update(bytes).digest("hex");
      const file = `${name}-${hash}.json`;
      await writeFile(path.join(staging, file), bytes);
      return { file, bytes: bytes.length, rows };
    };
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      snapshot: meta.snapshot,
      rowCount: meta.rowCount,
      summary: await asset("summary", summary, restaurants.length),
      details: [],
    };
    for (const [index, bucket] of buckets.entries()) {
      let rows = 0;
      for (const inspections of Object.values(bucket)) {
        decodeInspections(inspections, definitions);
        rows += inspections.length;
      }
      manifest.details.push(await asset(bucketName(index), bucket, rows));
    }
    validateManifest(manifest);
    validateSummary(summary, manifest);
    await writeFile(
      path.join(staging, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    // Preserve old immutable assets for clients holding an earlier manifest.
    for (const { file } of snapshotAssets(manifest))
      await rename(path.join(staging, file), path.join(output, file));
    await rename(
      path.join(staging, "manifest.json"),
      path.join(output, "manifest.json"),
    );
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (!process.argv[2] || process.argv.length > 4)
      throw new Error(
        "Usage: node scripts/convert-data.mjs <input.csv> [output-directory]",
      );
    const manifest = await convertData(process.argv[2], process.argv[3], {
      minimums: DATA_MINIMUMS,
    });
    const total = snapshotAssets(manifest).reduce(
      (sum, asset) => sum + asset.bytes,
      0,
    );
    console.log(
      `Converted ${manifest.rowCount.toLocaleString()} source rows into JSON (${(total / 1e6).toFixed(2)} MB), snapshot ${manifest.snapshot}.`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
