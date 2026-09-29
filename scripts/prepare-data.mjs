import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  MANIFEST_FILE,
  LEGACY_MANIFEST_FILE,
  LEGACY_SCHEMA_VERSION,
  SUMMARY_FIELDS,
  snapshotAssets,
  validateManifest,
  validateSummary,
} from "../src/data/manifest.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

export async function prepareData(
  source = path.join(root, "data"),
  destination = path.join(root, "public/data"),
  { prune = false } = {},
) {
  let manifest, legacy;
  try {
    manifest = validateManifest(
      JSON.parse(await readFile(path.join(source, MANIFEST_FILE), "utf8")),
    );
    legacy = validateManifest(
      JSON.parse(
        await readFile(path.join(source, LEGACY_MANIFEST_FILE), "utf8"),
      ),
      LEGACY_SCHEMA_VERSION,
    );
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error(
        "No complete JSON publication found. Run npm run build-data first.",
      );
    throw error;
  }
  // A publication must provide the same snapshot to new and cached clients.
  try {
    assert.equal(legacy.snapshot, manifest.snapshot);
    assert.equal(legacy.rowCount, manifest.rowCount);
    assert.equal(legacy.summary.rows, manifest.summary.rows);
    assert.deepEqual(legacy.details, manifest.details);
  } catch {
    throw new Error(
      "Current and legacy manifests do not describe the same snapshot.",
    );
  }
  const tables = new Map();
  for (const table of [...snapshotAssets(manifest), legacy.summary]) {
    const previous = tables.get(table.file);
    if (
      previous &&
      (previous.bytes !== table.bytes || previous.rows !== table.rows)
    )
      throw new Error("Conflicting publication asset entries.");
    tables.set(table.file, table);
  }
  // Verify the union before changing any public asset or either manifest.
  const assets = await Promise.all(
    [...tables.values()].map(async (table) => {
      const bytes = await readFile(path.join(source, table.file));
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== table.bytes || !table.file.endsWith(`-${hash}.json`))
        throw new Error(
          `The ${table.file} asset is incomplete or corrupted. Regenerate the dataset.`,
        );
      return { file: table.file, bytes };
    }),
  );
  const summaries = new Map(assets.map(({ file, bytes }) => [file, bytes]));
  const currentSummary = validateSummary(
    JSON.parse(summaries.get(manifest.summary.file)),
    manifest,
  );
  const legacyWire = JSON.parse(summaries.get(legacy.summary.file));
  // Keep the released schema-3 column contract strict even though the current
  // decoder can understand both arrays and compact columns.
  if (
    !legacyWire.restaurants ||
    SUMMARY_FIELDS.some(
      (field) =>
        !Array.isArray(legacyWire.restaurants[field]) ||
        legacyWire.restaurants[field].length !== legacy.summary.rows,
    )
  )
    throw new Error("Legacy restaurant summary must contain plain columns.");
  const legacySummary = validateSummary(legacyWire, legacy);
  try {
    assert.deepEqual(legacySummary, currentSummary);
  } catch {
    throw new Error(
      "Current and legacy summaries do not represent the same snapshot.",
    );
  }
  await mkdir(destination, { recursive: true });
  const staging = await mkdtemp(path.join(destination, ".prepare-"));
  try {
    for (const asset of assets)
      await writeFile(path.join(staging, asset.file), asset.bytes);
    const manifests = [
      [MANIFEST_FILE, manifest],
      [LEGACY_MANIFEST_FILE, legacy],
    ];
    for (const [file, value] of manifests)
      await writeFile(
        path.join(staging, file),
        JSON.stringify(value, null, 2) + "\n",
      );
    for (const asset of assets)
      await rename(
        path.join(staging, asset.file),
        path.join(destination, asset.file),
      );
    for (const [file] of manifests)
      await rename(path.join(staging, file), path.join(destination, file));
    const active = new Set(assets.map((asset) => asset.file));
    for (const file of await readdir(destination)) {
      const stale =
        /^(summary|details-[a-f0-9]{2})-[a-f0-9]{64}\.json$/.test(file) &&
        !active.has(file);
      if (prune && stale) await rm(path.join(destination, file));
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return manifest;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.slice(2).some((arg) => arg !== "--prune"))
    throw new Error("Usage: node scripts/prepare-data.mjs [--prune]");
  const manifest = await prepareData(undefined, undefined, {
    prune: process.argv.includes("--prune"),
  });
  const total = snapshotAssets(manifest).reduce(
    (sum, table) => sum + table.bytes,
    0,
  );
  console.log(
    `Prepared current inspection JSON (${(total / 1e6).toFixed(2)} MB) and schema-3 compatibility assets, snapshot ${manifest.snapshot}`,
  );
}
