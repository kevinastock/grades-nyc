import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build, createServer } from "vite";
import { startupResources } from "../build/startup-resources.mjs";
import { DETAIL_BUCKETS, SCHEMA_VERSION } from "../src/data/manifest.mjs";

async function fixture(
  t,
  { css = ".entry { color: red; }", page = "index.html" } = {},
) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "nyc-startup-test-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = path.join(root, "public/data");
  await mkdir(data, { recursive: true });
  const summary = '{"restaurants":[]}';
  const hash = createHash("sha256").update(summary).digest("hex");
  const file = `summary-${hash}.json`;
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    snapshot: "2026-09-28",
    rowCount: 1,
    summary: { file, bytes: Buffer.byteLength(summary), rows: 0 },
    details: Array.from({ length: DETAIL_BUCKETS }, (_, index) => ({
      file: `details-${index.toString(16).padStart(2, "0")}-${"0".repeat(64)}.json`,
      bytes: 2,
      rows: 0,
    })),
  };
  await writeFile(path.join(data, "manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(data, file), summary);
  await writeFile(path.join(root, "entry.css"), css);
  await writeFile(path.join(root, "map.css"), ".map-only { color: blue; }");
  await writeFile(
    path.join(root, "map.js"),
    'import "./map.css"; window.mapReady = true;',
  );
  await writeFile(
    path.join(root, "entry.js"),
    'import "./entry.css"; window.loadMap = () => import("./map.js");',
  );
  await mkdir(path.dirname(path.join(root, page)), { recursive: true });
  await writeFile(
    path.join(root, page),
    '<!doctype html><html><head></head><body><script type="module" src="/entry.js"></script></body></html>',
  );
  async function compile(base = "./") {
    const result = await build({
      configFile: false,
      root,
      base,
      plugins: [startupResources()],
      logLevel: "silent",
      build: {
        write: false,
        assetsInlineLimit: 0,
        rollupOptions: { input: path.join(root, page) },
      },
    });
    return {
      html: result.output.find((asset) => asset.fileName === page).source,
      output: result.output,
    };
  }
  return { root, data, file, manifest, compile };
}

test("production inlines entry styles, keeps lazy map styles split, and preloads the exact summary", async (t) => {
  const { compile, file } = await fixture(t, {
    css: '.entry { color: red; background-image: url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E"); }',
  });
  const { html, output } = await compile();
  assert.match(html, /<style data-startup-styles>\.entry\{/);
  assert.match(html, /data:image\/svg\+xml/);
  assert.doesNotMatch(html, /rel="stylesheet"|map-only/);
  assert.match(
    html,
    new RegExp(
      `<link rel="preload" as="fetch" type="application/json" href="\\./data/${file}" crossorigin="anonymous">`,
    ),
  );
  assert.doesNotMatch(html, /manifest\.json/);
  const mapCss = output.find(
    (asset) => asset.type === "asset" && asset.source.includes?.(".map-only"),
  );
  assert.ok(mapCss, "the dynamic map stylesheet is emitted separately");
  assert.ok(
    output.some(
      (asset) =>
        asset.type === "chunk" &&
        asset.code.includes(path.basename(mapCss.fileName)),
    ),
    "the map stylesheet remains attached to Vite's dynamic import",
  );
});

test("preload URLs resolve for relative deployments and configured path or CDN bases", async (t) => {
  for (const base of ["./", "/grades/", "https://assets.example/grades/"]) {
    await t.test(base, async (t) => {
      const { compile, file } = await fixture(t);
      const { html } = await compile(base);
      const href = html.match(/rel="preload"[^>]*href="([^"]+)"/)[1];
      assert.equal(href, `${base}data/${file}`);
      assert.match(html, /<style data-startup-styles>/);
      assert.doesNotMatch(html, /rel="stylesheet"/);
    });
  }
  await t.test("nested HTML with a relative base", async (t) => {
    const { compile, file } = await fixture(t, { page: "pages/index.html" });
    const { html } = await compile();
    assert.ok(html.includes(`href="../data/${file}"`));
    assert.match(html, /<style data-startup-styles>/);
    assert.doesNotMatch(html, /rel="stylesheet"/);
  });
});

test("CSS with relative assets keeps its stylesheet URL and its asset base", async (t) => {
  const { root, compile } = await fixture(t, {
    css: '.entry { background-image: url("./illustration.svg"); }',
  });
  await writeFile(
    path.join(root, "illustration.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
  );
  const { html, output } = await compile();
  assert.doesNotMatch(html, /data-startup-styles/);
  const stylesheetHref = html.match(/rel="stylesheet"[^>]*href="([^"]+)"/)[1];
  const stylesheet = output.find((asset) =>
    stylesheetHref.endsWith(asset.fileName),
  );
  const assetHref = stylesheet.source.match(/url\(["']?([^"')]+)/)[1];
  const documentUrl = "https://grades.test/nested/index.html";
  const resolved = new URL(assetHref, new URL(stylesheetHref, documentUrl));
  assert.ok(
    output.some((asset) => resolved.pathname === `/nested/${asset.fileName}`),
  );
});

test("HTML raw-text terminators and external CSS imports are never inlined", async (t) => {
  for (const css of [
    '.entry:after { content: "</style><script>alert(1)</script>"; }',
    '@import url("https://example.com/fonts.css"); .entry { color: red; }',
  ]) {
    const { compile } = await fixture(t, { css });
    const { html } = await compile();
    assert.doesNotMatch(html, /data-startup-styles/);
    assert.match(html, /rel="stylesheet"/);
  }
});

test("build rejects invalid manifests and a summary that does not match its content hash", async (t) => {
  const { data, file, manifest, compile } = await fixture(t);
  await writeFile(
    path.join(data, "manifest.json"),
    JSON.stringify({
      ...manifest,
      summary: { ...manifest.summary, file: "../outside.json" },
    }),
  );
  await assert.rejects(compile(), /Invalid summary data entry/);
  await writeFile(path.join(data, "manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(data, file), '{"restaurants":{}}');
  await assert.rejects(compile(), /incomplete or corrupted restaurant summary/);
});

test("development HTML is untouched and does not depend on a prepared snapshot", async (t) => {
  const { root, data } = await fixture(t);
  await rm(data, { recursive: true });
  const server = await createServer({
    configFile: false,
    root,
    plugins: [startupResources()],
    logLevel: "silent",
    server: { middlewareMode: true, watch: null },
  });
  t.after(() => server.close());
  const html = await server.transformIndexHtml(
    "/index.html",
    await readFile(path.join(root, "index.html"), "utf8"),
  );
  assert.doesNotMatch(html, /data-startup-styles|rel="preload"/);
  assert.match(html, /src="\/entry.js"/);
});
