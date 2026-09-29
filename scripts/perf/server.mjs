import http2 from "node:http2";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import path from "node:path";
import {
  fixtureCertificate,
  nameList,
  outOption,
  readJson,
  writeJson,
} from "./common.mjs";

const { values } = parseArgs({
  options: {
    out: outOption,
    port: { type: "string", default: "4190" },
    record: { type: "boolean", default: false },
  },
});
const output = path.resolve(values.out);
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid fixture port.");
const origin = `https://127.0.0.1:${port}`;
const upstreamOrigin = "https://tiles.openfreemap.org";
const upstreamDirectory = path.join(output, "upstream");
await mkdir(upstreamDirectory, { recursive: true });
const tls = await fixtureCertificate(output);
let recording = values.record;
const bodies = new Map(),
  pending = new Map(),
  counts = new Map();
const caseMetadata = new Map();
async function metadataFor(name) {
  if (!caseMetadata.has(name))
    caseMetadata.set(
      name,
      readJson(path.join(output, "cases", `${name}.json`)),
    );
  return caseMetadata.get(name);
}
const failures = [];
const mime = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".pbf": "application/octet-stream",
};

function compress(bytes, type) {
  if (/json|javascript|html/.test(type))
    bytes = Buffer.from(
      bytes.toString().replaceAll(upstreamOrigin, `${origin}/external`),
    );
  return { bytes: gzipSync(bytes), decodedBytes: bytes.length, type };
}
async function external(suffix) {
  const url = new URL(suffix, upstreamOrigin).href;
  if (!url.startsWith(`${upstreamOrigin}/`))
    throw new Error("Invalid upstream path.");
  const key = createHash("sha256").update(url).digest("hex");
  const metaFile = path.join(upstreamDirectory, `${key}.json`);
  const bytesFile = path.join(upstreamDirectory, `${key}.bin`);
  let metadata, bytes;
  try {
    metadata = await readJson(metaFile);
    bytes = await readFile(bytesFile);
    if (
      metadata.url !== url ||
      metadata.sha256 !== createHash("sha256").update(bytes).digest("hex")
    )
      throw new Error(`Corrupt recorded fixture: ${url}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (!recording)
      throw new Error(
        `Unrecorded fixture: ${url}. Run the server with --record and prime the cases first.`,
      );
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Upstream ${response.status}: ${url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    metadata = {
      url,
      type: response.headers.get("content-type") || "application/octet-stream",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      recordedAt: new Date().toISOString(),
    };
    await writeFile(bytesFile, bytes);
    await writeJson(metaFile, metadata);
    console.log(`Recorded ${url} (${bytes.length} bytes)`);
  }
  return compress(bytes, metadata.type);
}
async function prepare(requestPath) {
  if (bodies.has(requestPath)) return bodies.get(requestPath);
  if (pending.has(requestPath)) return pending.get(requestPath);
  const task = (async () => {
    let value;
    if (requestPath.startsWith("/external/"))
      value = await external(requestPath.slice("/external".length));
    else {
      const pathname = decodeURIComponent(
        new URL(requestPath, origin).pathname,
      );
      const match = pathname.match(/^\/([a-zA-Z0-9_-]+)\/(.*)$/);
      if (!match) throw new Error("Unknown fixture case path.");
      const directory = path.resolve(output, "cases", match[1]);
      const file = path.resolve(directory, match[2] || "index.html");
      if (!file.startsWith(`${directory}${path.sep}`) || file.endsWith(".map"))
        throw new Error("Invalid fixture path.");
      value = compress(
        await readFile(file),
        mime[path.extname(file)] || "application/octet-stream",
      );
      const metadata = await metadataFor(match[1]);
      value.mutable =
        pathname ===
        `/${match[1]}/data/${metadata.manifestFile || "manifest.json"}`;
    }
    bodies.set(requestPath, value);
    return value;
  })();
  pending.set(requestPath, task);
  try {
    return await task;
  } finally {
    pending.delete(requestPath);
  }
}
async function filesIn(directory, prefix = "") {
  const files = [];
  for (const item of await readdir(path.join(directory, prefix), {
    withFileTypes: true,
  })) {
    const name = path.posix.join(prefix, item.name);
    if (item.isDirectory()) files.push(...(await filesIn(directory, name)));
    else if (item.isFile() && !name.endsWith(".map")) files.push(name);
  }
  return files;
}
async function warm(names) {
  for (const name of names) {
    nameList(name);
    const directory = path.join(output, "cases", name);
    const metadata = await metadataFor(name);
    // Validate the selected current manifest before warming the complete tree;
    // recursive warming also includes any separately published legacy manifest.
    await prepare(`/${name}/data/${metadata.manifestFile || "manifest.json"}`);
    for (const file of await filesIn(directory))
      await prepare(`/${name}/${file}`);
    await prepare(`/${name}/`);
  }
  for (const file of await readdir(upstreamDirectory)) {
    if (!file.endsWith(".json")) continue;
    const metadata = await readJson(path.join(upstreamDirectory, file));
    const url = new URL(metadata.url);
    await prepare(`/external${url.pathname}${url.search}`);
  }
}
async function fixtureMetadata() {
  const upstream = [];
  for (const file of await readdir(upstreamDirectory))
    if (file.endsWith(".json"))
      upstream.push(await readJson(path.join(upstreamDirectory, file)));
  return upstream.sort((a, b) => a.url.localeCompare(b.url));
}
const sendJson = (response, value) => {
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(value));
};
const server = http2.createSecureServer(
  { key: tls.key, cert: tls.cert, allowHTTP1: true },
  async (request, response) => {
    const target = new URL(request.url, origin);
    try {
      if (target.pathname.startsWith("/__perf/")) {
        if (target.pathname === "/__perf/status")
          return sendJson(response, {
            recording,
            origin,
            spki: tls.spki,
            failures,
          });
        if (target.pathname === "/__perf/stats")
          return sendJson(response, Object.fromEntries(counts));
        if (target.pathname === "/__perf/fixtures")
          return sendJson(response, await fixtureMetadata());
        if (target.pathname === "/__perf/warm" && request.method === "POST") {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString());
          await warm(nameList(body.cases));
          return sendJson(response, { warmed: true });
        }
        if (target.pathname === "/__perf/freeze" && request.method === "POST") {
          recording = false;
          return sendJson(response, { recording });
        }
        throw new Error("Unknown fixture control request.");
      }
      const requestPath = `${target.pathname}${target.search}`;
      const value = await prepare(requestPath);
      const previous = counts.get(requestPath) || {
        requests: 0,
        encodedBytes: 0,
      };
      counts.set(requestPath, {
        requests: previous.requests + 1,
        encodedBytes: previous.encodedBytes + value.bytes.length,
      });
      response.setHeader("content-type", value.type);
      response.setHeader("content-encoding", "gzip");
      response.setHeader("content-length", value.bytes.length);
      response.setHeader(
        "cache-control",
        value.mutable ||
          /\/manifest(?:-v\d+)?\.json$/.test(target.pathname) ||
          target.pathname.endsWith("/") ||
          target.pathname.endsWith(".html")
          ? "no-cache"
          : "public, max-age=3600",
      );
      response.end(value.bytes);
    } catch (error) {
      const failure = {
        url: target.href,
        message: error.message,
        time: new Date().toISOString(),
      };
      failures.push(failure);
      console.error(failure.message);
      response.writeHead(404);
      response.end(failure.message);
    }
  },
);
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolve);
});
await writeJson(path.join(output, "server.json"), {
  origin,
  spki: tls.spki,
  output,
  pid: process.pid,
});
console.log(
  `${origin} (${recording ? "recording missing upstream fixtures" : "fixed offline fixtures"})`,
);
console.log(
  "Restart this server after rebuilding a case; compressed response bodies are held in memory.",
);
