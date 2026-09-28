import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convertData } from "./convert-data.mjs";
import { DATA_MINIMUMS } from "./validate-data.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
export const SOURCE_URL =
  "https://data.cityofnewyork.us/api/v3/views/43nn-pn8j/export.csv?accessType=DOWNLOAD";

// Each build reruns the model. Only the large source download is cached.
export async function buildData({
  cacheDirectory = path.join(root, ".cache"),
  output = path.join(root, "data"),
  refresh = false,
  minimums = DATA_MINIMUMS,
} = {}) {
  await mkdir(cacheDirectory, { recursive: true });
  const cached = path.join(cacheDirectory, "inspections.csv");
  const cachedStat = await stat(cached).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  const download = refresh || !cachedStat?.isFile() || cachedStat.size === 0;
  let staging;
  try {
    let input = cached;
    if (download) {
      staging = await mkdtemp(path.join(cacheDirectory, ".download-"));
      input = path.join(staging, "inspections.csv");
      console.log("Downloading the latest NYC inspection CSV…");
      const result = spawnSync(
        "curl",
        [
          "--fail",
          "--location",
          "--retry",
          "3",
          "--retry-delay",
          "2",
          "--connect-timeout",
          "30",
          "--max-time",
          "900",
          "--output",
          input,
          SOURCE_URL,
        ],
        { stdio: "inherit", timeout: 3_700_000 },
      );
      if (result.error || result.status !== 0)
        throw new Error(
          `NYC CSV download failed: ${result.error?.message || `curl exited ${result.status}`}. The previous cache and snapshot have been preserved.`,
        );
    } else {
      console.log(`Using cached CSV: ${cached} (run just update to refresh).`);
    }
    const manifest = await convertData(input, output, { minimums });
    // A bad download must never replace a working local source cache.
    if (download) await rename(input, cached);
    console.log(
      `Validated ${manifest.summary.rows.toLocaleString()} restaurants; snapshot ${manifest.snapshot} from ${manifest.rowCount.toLocaleString()} source rows.`,
    );
    return manifest;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    const positional = args.filter((arg) => !arg.startsWith("--"));
    if (
      positional.length > 1 ||
      args.some((arg) => arg.startsWith("--") && arg !== "--refresh")
    )
      throw new Error(
        "Usage: node scripts/build-data.mjs [--refresh] [output-directory]",
      );
    await buildData({
      refresh: args.includes("--refresh"),
      output: positional[0],
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
