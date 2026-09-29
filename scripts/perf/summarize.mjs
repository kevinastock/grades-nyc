import { readdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import path from "node:path";
import { outOption, readJson } from "./common.mjs";

const { values } = parseArgs({ options: { out: outOption } });
const directory = path.resolve(values.out, "results");
const groups = new Map();
for (const file of await readdir(directory)) {
  if (!file.endsWith(".json") || file.endsWith(".trace.json")) continue;
  const result = await readJson(path.join(directory, file));
  if (result.priming || result.failure || result.trace) continue;
  const key = JSON.stringify([
    result.name,
    result.profile,
    result.theme,
    result.hash,
    result.renderer,
    result.case.builtAt,
  ]);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(result);
}
function range(values) {
  values = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  return {
    median:
      values.length % 2
        ? values[middle]
        : (values[middle - 1] + values[middle]) / 2,
    min: values[0],
    max: values.at(-1),
  };
}
console.log(
  JSON.stringify(
    [...groups.values()].map((rows) => ({
      name: rows[0].name,
      profile: rows[0].profile,
      theme: rows[0].theme,
      hash: rows[0].hash,
      renderer: rows[0].renderer,
      builtAt: rows[0].case.builtAt,
      snapshot: rows[0].case.snapshot,
      summary: rows[0].case.summary.file,
      samples: rows.length,
      usableMapMs: range(rows.map((row) => row.usableMapMs)),
      markersMs: range(rows.map((row) => row.marks["markers-painted"])),
      mapIdleMs: range(rows.map((row) => row.mapReadiness.idle)),
      CLS: range(rows.map((row) => row.clsScore)),
      blockingAfterFcpMs: range(rows.map((row) => row.blockingAfterFcpMs)),
      firstContentfulPaintMs: range(
        rows.map(
          (row) =>
            row.paint.find((entry) => entry.name === "first-contentful-paint")
              ?.start,
        ),
      ),
      serverEncodedBytes: range(
        rows.map((row) =>
          Object.values(row.serverRequests).reduce(
            (sum, request) => sum + request.encodedBytes,
            0,
          ),
        ),
      ),
    })),
    null,
    2,
  ),
);
