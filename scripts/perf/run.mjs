import path from "node:path";
import { parseArgs } from "node:util";
import { trial } from "./driver.mjs";
import { warm } from "./warm.mjs";
import { nameList, outOption, profiles, readJson } from "./common.mjs";

const { values } = parseArgs({
  options: {
    out: outOption,
    cases: { type: "string" },
    profiles: { type: "string", default: "localhost,fiber,5g,moderate-cell" },
    runs: { type: "string", default: "5" },
    gpu: { type: "string", default: "auto" },
    browser: { type: "string" },
    theme: { type: "string", default: "light" },
    hash: { type: "string", default: "" },
    trace: { type: "boolean", default: false },
  },
});
if (!values.cases)
  throw new Error(
    "Usage: node scripts/perf/run.mjs --cases baseline,candidate [--profiles localhost,fiber,5g,moderate-cell] [--runs 5]",
  );
const output = path.resolve(values.out),
  names = nameList(values.cases),
  profileNames = nameList(values.profiles);
const runs = Number(values.runs);
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 100)
  throw new Error("Runs must be an integer from 1 through 100.");
if (profileNames.some((name) => !profiles[name]))
  throw new Error("Unknown performance profile.");
if (!["light", "dark"].includes(values.theme))
  throw new Error("Theme must be light or dark.");
if (values.hash && !values.hash.startsWith("#"))
  throw new Error("Pass only a route hash, such as --hash '#/search'.");
const options = {
  output,
  server: await readJson(path.join(output, "server.json")),
  names,
  profileNames,
  gpu: values.gpu,
  browserPath: values.browser,
  theme: values.theme,
  hash: values.hash,
  trace: values.trace,
};
// Priming runs are never counted as samples. It is safe to rerun: fixed fixtures
// need only server-side response warming, never a warm measured browser cache.
await warm(options);
for (let round = 0; round < runs; round++) {
  for (const profile of profileNames) {
    for (const name of round % 2 ? [...names].reverse() : names)
      await trial({ ...options, name, profile });
  }
}
