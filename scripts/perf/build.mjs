import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build, loadConfigFromFile } from "vite";
import { instrument } from "./instrument.mjs";
import { nameList, outOption, readJson, writeJson } from "./common.mjs";

const { values } = parseArgs({
  options: {
    root: { type: "string", default: "." },
    name: { type: "string" },
    manifest: { type: "string" },
    out: outOption,
  },
});
if (!values.name || nameList(values.name).length !== 1)
  throw new Error(
    "Usage: node scripts/perf/build.mjs --root <checkout> --name <case> [--out .cache/perf]",
  );
const [name] = nameList(values.name);
const root = path.resolve(values.root);
const output = path.resolve(values.out);
const outDir = path.join(output, "cases", name);
const manifestFile =
  values.manifest ??
  (await import(pathToFileURL(path.join(root, "src/data/manifest.mjs")).href))
    .MANIFEST_FILE ??
  "manifest.json";
if (
  typeof manifestFile !== "string" ||
  !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(manifestFile)
)
  throw new Error(
    "Manifest must be a JSON basename, without a directory or URL.",
  );
const loaded = await loadConfigFromFile(
  { command: "build", mode: "production" },
  path.join(root, "vite.config.ts"),
);
if (!loaded) throw new Error(`No Vite config found in ${root}`);
await build({
  ...loaded.config,
  root,
  configFile: false,
  plugins: [instrument(), ...(loaded.config.plugins || [])],
  build: {
    ...loaded.config.build,
    outDir,
    emptyOutDir: true,
    sourcemap: "hidden",
  },
});
let revision = null,
  dirty = null;
try {
  revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  dirty = !!execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {}
const manifest = await readJson(path.join(outDir, "data", manifestFile));
const artifacts = [];
for (const file of [
  "index.html",
  ...(await readdir(path.join(outDir, "assets")))
    .filter((name) => /\.(js|css)$/.test(name))
    .sort()
    .map((name) => `assets/${name}`),
]) {
  const bytes = await readFile(path.join(outDir, file));
  artifacts.push({
    file,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
await writeJson(path.join(output, "cases", `${name}.json`), {
  name,
  root,
  outDir,
  builtAt: new Date().toISOString(),
  revision,
  dirty,
  manifestFile,
  snapshot: manifest.snapshot,
  schemaVersion: manifest.schemaVersion,
  summary: manifest.summary,
  artifacts,
});
console.log(
  `Prepared ${name} in ${outDir}. Normal production builds are unchanged.`,
);
