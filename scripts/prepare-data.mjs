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
import { snapshotAssets, validateManifest } from "../src/data/manifest.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

export async function prepareData(
  source = path.join(root, "data"),
  destination = path.join(root, "public/data"),
  { prune = false } = {},
) {
  let manifest;
  try {
    manifest = validateManifest(
      JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8")),
    );
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error("No JSON data found. Run npm run build-data first.");
    throw error;
  }
  // Verify the complete snapshot before changing public assets.
  const assets = await Promise.all(
    snapshotAssets(manifest).map(async (table) => {
      const bytes = await readFile(path.join(source, table.file));
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== table.bytes || !table.file.endsWith(`-${hash}.json`))
        throw new Error(
          `The ${table.file} asset is incomplete or corrupted. Regenerate the dataset.`,
        );
      return { file: table.file, bytes };
    }),
  );
  await mkdir(destination, { recursive: true });
  const staging = await mkdtemp(path.join(destination, ".prepare-"));
  try {
    for (const asset of assets)
      await writeFile(path.join(staging, asset.file), asset.bytes);
    await writeFile(
      path.join(staging, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    for (const asset of assets)
      await rename(
        path.join(staging, asset.file),
        path.join(destination, asset.file),
      );
    await rename(
      path.join(staging, "manifest.json"),
      path.join(destination, "manifest.json"),
    );
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
    `Prepared inspection JSON (${(total / 1e6).toFixed(2)} MB), snapshot ${manifest.snapshot}`,
  );
}
