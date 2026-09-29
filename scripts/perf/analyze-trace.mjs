import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import path from "node:path";
import sourceMap from "source-map-js";
import { outOption } from "./common.mjs";

const { values } = parseArgs({
  options: { out: outOption, trace: { type: "string" } },
});
if (!values.trace)
  throw new Error("Pass --trace <result.trace.json> [--out .cache/perf].");
const output = path.resolve(values.out);
const events = JSON.parse(readFileSync(values.trace, "utf8")).traceEvents;
const threads = new Map(
  events
    .filter((event) => event.name === "thread_name")
    .map((event) => [`${event.pid}:${event.tid}`, event.args.name]),
);
const profiles = new Map(),
  maps = new Map();
function source(frame) {
  if (!frame?.url) return frame?.functionName || "(native)";
  try {
    const pathname = decodeURIComponent(new URL(frame.url).pathname);
    const match = pathname.match(/^\/([a-zA-Z0-9_-]+)\/assets\/([^/]+\.js)$/);
    if (match) {
      const file = path.join(
        output,
        "cases",
        match[1],
        "assets",
        `${match[2]}.map`,
      );
      if (!maps.has(file))
        maps.set(
          file,
          existsSync(file)
            ? new sourceMap.SourceMapConsumer(
                JSON.parse(readFileSync(file, "utf8")),
              )
            : null,
        );
      const map = maps.get(file);
      if (map) {
        const original = map.originalPositionFor({
          line: frame.lineNumber + 1,
          column: Math.max(0, frame.columnNumber),
        });
        if (original.source)
          return `${original.source}:${original.line} ${original.name || frame.functionName}`;
      }
    }
  } catch {}
  return `${frame.url}:${frame.lineNumber + 1} ${frame.functionName}`;
}
for (const event of events) {
  if (event.name !== "ProfileChunk") continue;
  const key = `${event.pid}:${event.tid}:${JSON.stringify(event.id ?? event.id2)}`;
  if (!profiles.has(key))
    profiles.set(key, {
      thread: threads.get(`${event.pid}:${event.tid}`),
      nodes: new Map(),
      samples: [],
    });
  const profile = profiles.get(key),
    data = event.args.data;
  for (const node of data.cpuProfile?.nodes || [])
    profile.nodes.set(node.id, node);
  for (const [index, id] of (data.cpuProfile?.samples || []).entries())
    profile.samples.push({
      id,
      ms: Math.max(0, data.timeDeltas?.[index] || 0) / 1000,
    });
}
const results = [];
for (const [id, profile] of profiles) {
  const parents = new Map(),
    self = new Map(),
    total = new Map();
  for (const node of profile.nodes.values()) {
    if (node.parent !== undefined) parents.set(node.id, node.parent);
    for (const child of node.children || []) parents.set(child, node.id);
  }
  for (const sample of profile.samples) {
    self.set(sample.id, (self.get(sample.id) || 0) + sample.ms);
    const visited = new Set();
    for (
      let current = sample.id;
      current !== undefined && !visited.has(current);
      current = parents.get(current)
    ) {
      visited.add(current);
      total.set(current, (total.get(current) || 0) + sample.ms);
    }
  }
  const top = (times) =>
    [...times]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([node, ms]) => ({
        ms: Math.round(ms * 10) / 10,
        source: source(profile.nodes.get(node)?.callFrame),
      }));
  results.push({
    id,
    thread: profile.thread,
    self: top(self),
    inclusive: top(total),
  });
}
console.log(JSON.stringify(results, null, 2));
