import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildData } from "../scripts/build-data.mjs";
import {
  DATA_MINIMUMS,
  validateDataHealth,
} from "../scripts/validate-data.mjs";
import { validateSummary } from "../src/data/manifest.mjs";

const smallMinimums = { restaurants: 0, violationTypes: 0 };
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
  const headers = Object.keys(basic);
  return (
    [headers, ...rows.map((row) => headers.map((name) => row[name]))]
      .map((row) =>
        row
          .map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`)
          .join(","),
      )
      .join("\n") + "\n"
  );
}

async function outputBytes(directory) {
  return Object.fromEntries(
    await Promise.all(
      (await readdir(directory)).map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(path.join(directory, file)))
          .digest("hex"),
      ]),
    ),
  );
}

async function readSnapshot(directory) {
  const manifest = JSON.parse(
    await readFile(path.join(directory, "manifest.json"), "utf8"),
  );
  const summary = validateSummary(
    JSON.parse(
      await readFile(path.join(directory, manifest.summary.file), "utf8"),
    ),
    manifest,
  );
  return { manifest, summary };
}

test("nightly build downloads once, reuses local CSV, refreshes atomically, and retries failed refreshes", async () => {
  assert.equal(
    spawnSync("duckdb", ["--version"]).status,
    0,
    "DuckDB CLI is required for data pipeline tests. Install DuckDB and make duckdb available on PATH.",
  );
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "nyc-grades-build-test-"),
  );
  const bin = path.join(directory, "bin");
  const cacheDirectory = path.join(directory, "O'Brien's cache");
  const output = path.join(directory, "O'Brien's dataset");
  const input = path.join(directory, "fixture.csv");
  const calls = path.join(directory, "downloads.log");
  const cache = path.join(cacheDirectory, "inspections.csv");
  const keys = ["PATH", "NYC_TEST_CSV", "NYC_TEST_CALLS", "NYC_TEST_CURL_FAIL"];
  const original = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  try {
    await mkdir(bin);
    await writeFile(
      path.join(bin, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
output=''
while [[ $# -gt 0 ]]; do
case "$1" in --output|-o) output="$2"; shift 2 ;; *) shift ;; esac
done
printf 'download\\n' >> "$NYC_TEST_CALLS"
if [[ "\${NYC_TEST_CURL_FAIL:-0}" != 0 ]]; then
  printf 'partial download' > "$output"
  exit 22
fi
cp -- "$NYC_TEST_CSV" "$output"
`,
      { mode: 0o755 },
    );
    Object.assign(process.env, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      NYC_TEST_CSV: input,
      NYC_TEST_CALLS: calls,
      NYC_TEST_CURL_FAIL: "0",
    });
    const run = (options = {}) =>
      buildData({
        cacheDirectory,
        output,
        minimums: smallMinimums,
        ...options,
      });
    const downloads = async () =>
      (await readFile(calls, "utf8")).trim().split("\n").length;
    const noTemporaryFiles = async () => {
      assert.deepEqual(
        await readdir(cacheDirectory),
        ["inspections.csv"],
        "only the validated CSV remains in the cache",
      );
      assert.ok(
        (await readdir(output)).every((file) => file.endsWith(".json")),
        "only JSON assets remain in the output",
      );
    };

    await writeFile(input, fixture());
    await run();
    assert.equal(await downloads(), 1);
    assert.equal(await readFile(cache, "utf8"), fixture());
    const { manifest, summary } = await readSnapshot(output);
    assert.equal(manifest.schemaVersion, 3);
    assert.equal(manifest.snapshot, "2026-09-26");
    assert.equal(manifest.rowCount, 1);
    assert.equal(summary.restaurants[0].id, "00123456");
    assert.equal(summary.restaurants[0].zip, "00123");
    assert.equal(summary.restaurants[0].grade_inspected, "2026-09-25");
    const initial = await outputBytes(output);
    await noTemporaryFiles();

    // A cached source must still regenerate missing output on every build.
    await rm(path.join(output, "manifest.json"));
    await run();
    assert.equal(await downloads(), 1);
    assert.deepEqual(await outputBytes(output), initial);
    const refreshedCSV = fixture([
      { ...basic, "RECORD DATE": "09/27/2026", SCORE: "11" },
    ]);
    await writeFile(input, refreshedCSV);
    await run();
    assert.equal(await downloads(), 1);
    assert.deepEqual(await outputBytes(output), initial);

    await run({ refresh: true });
    assert.equal(await downloads(), 2);
    assert.equal(await readFile(cache, "utf8"), refreshedCSV);
    assert.equal((await readSnapshot(output)).manifest.snapshot, "2026-09-27");
    const beforeFailure = await outputBytes(output);
    for (const [file, digest] of Object.entries(initial))
      if (file !== "manifest.json")
        assert.equal(
          beforeFailure[file],
          digest,
          "previous immutable assets remain available",
        );

    const unchanged = async () => {
      assert.equal(await readFile(cache, "utf8"), refreshedCSV);
      assert.deepEqual(await outputBytes(output), beforeFailure);
      await noTemporaryFiles();
    };
    for (const csv of [
      fixture([{ ...basic, SCORE: "not-a-number" }]),
      fixture([{ ...basic, "INSPECTION DATE": "99/99/2026" }]),
      fixture([]),
      "CAMIS\n00123456\n",
    ]) {
      await writeFile(input, csv);
      await assert.rejects(run({ refresh: true }));
      await unchanged();
    }

    await writeFile(input, fixture());
    await assert.rejects(
      run({ refresh: true, minimums: { restaurants: 2, violationTypes: 0 } }),
      /restaurant/i,
    );
    await unchanged();
    await assert.rejects(
      run({ refresh: true, minimums: { restaurants: 0, violationTypes: 2 } }),
      /violation/i,
    );
    await unchanged();
    await assert.rejects(
      buildData({ cacheDirectory, output, refresh: true }),
      /restaurant/i,
    );
    await unchanged();
    process.env.NYC_TEST_CURL_FAIL = "1";
    await assert.rejects(run({ refresh: true }));
    await unchanged();

    // Failed refreshes leave the cache usable, including while offline.
    const callsBeforeCacheReuse = await downloads();
    await run();
    assert.equal(await downloads(), callsBeforeCacheReuse);
    await unchanged();
    process.env.NYC_TEST_CURL_FAIL = "0";
    const retryCSV = fixture([
      { ...basic, "RECORD DATE": "09/28/2026", SCORE: "10" },
    ]);
    await writeFile(input, retryCSV);
    await run({ refresh: true });
    assert.equal(await readFile(cache, "utf8"), retryCSV);
    assert.equal((await readSnapshot(output)).manifest.snapshot, "2026-09-28");
    await noTemporaryFiles();
  } finally {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("production data health minimums accept the boundary for both summary formats", () => {
  assert.deepEqual(DATA_MINIMUMS, { restaurants: 10000, violationTypes: 100 });
  const ids = Array.from({ length: 10000 }, (_, index) => String(index));
  const violations = Array.from({ length: 100 }, (_, index) => ({
    code: `V${index}`,
  }));
  assert.doesNotThrow(() =>
    validateDataHealth({ restaurants: ids.map((id) => ({ id })), violations }),
  );
  assert.doesNotThrow(() =>
    validateDataHealth({ restaurants: { id: ids }, violations }),
  );
  assert.throws(
    () => validateDataHealth({ restaurants: { id: ids.slice(1) }, violations }),
    /restaurant/i,
  );
  assert.throws(
    () =>
      validateDataHealth({
        restaurants: { id: ids },
        violations: violations.slice(1),
      }),
    /violation/i,
  );
});

test("health checks count distinct restaurant IDs and violation codes", () => {
  assert.throws(
    () =>
      validateDataHealth(
        {
          restaurants: [{ id: "1" }, { id: "1" }],
          violations: [{ code: "01A" }],
        },
        { restaurants: 2, violationTypes: 1 },
      ),
    /restaurant/i,
  );
  assert.throws(
    () =>
      validateDataHealth(
        {
          restaurants: { id: ["1"] },
          violations: [{ code: "01A" }, { code: "01A" }],
        },
        { restaurants: 1, violationTypes: 2 },
      ),
    /violation/i,
  );
});
