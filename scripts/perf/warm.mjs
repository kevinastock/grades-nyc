import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { trial } from "./driver.mjs";
import {
  fixtureRequest,
  nameList,
  outOption,
  profiles,
  readJson,
  writeJson,
} from "./common.mjs";

export async function warm(options) {
  const { output, server, names, profileNames } = options;
  await fixtureRequest(server.origin, "/__perf/warm", {
    method: "POST",
    body: { cases: names.join(",") },
  });
  const status = await fixtureRequest(server.origin, "/__perf/status");
  if (status.spki !== server.spki)
    throw new Error(
      "Fixture server certificate changed; rerun after the server has finished starting.",
    );
  if (status.recording) {
    // Network/CPU throttling is irrelevant during fixture discovery. Keep only
    // distinct viewports so initial vector tiles match the measured cases.
    const viewports = new Map();
    for (const profile of profileNames) {
      const { width, height, dpr } = profiles[profile];
      viewports.set(`${width}:${height}:${dpr}`, profile);
    }
    for (const name of names)
      for (const profile of viewports.values())
        await trial({ ...options, name, profile, priming: true, trace: false });
    await fixtureRequest(server.origin, "/__perf/warm", {
      method: "POST",
      body: { cases: names.join(",") },
    });
    await fixtureRequest(server.origin, "/__perf/freeze", { method: "POST" });
  }
  await writeJson(
    path.join(output, "fixtures.json"),
    await fixtureRequest(server.origin, "/__perf/fixtures"),
  );
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const { values } = parseArgs({
    options: {
      out: outOption,
      cases: { type: "string" },
      profiles: { type: "string", default: "localhost,fiber,5g,moderate-cell" },
      gpu: { type: "string", default: "auto" },
      browser: { type: "string" },
      theme: { type: "string", default: "light" },
      hash: { type: "string", default: "" },
    },
  });
  if (!values.cases) throw new Error("Pass --cases baseline,candidate.");
  const output = path.resolve(values.out),
    profileNames = nameList(values.profiles);
  if (profileNames.some((name) => !profiles[name]))
    throw new Error("Unknown profile.");
  await warm({
    output,
    server: await readJson(path.join(output, "server.json")),
    names: nameList(values.cases),
    profileNames,
    gpu: values.gpu,
    browserPath: values.browser,
    theme: values.theme,
    hash: values.hash,
  });
  console.log(
    "Fixture discovery and response compression complete; recording is frozen.",
  );
}
