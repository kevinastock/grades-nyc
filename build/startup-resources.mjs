import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { transform } from "esbuild";
import {
  MANIFEST_FILE,
  validateManifest,
  validateSummary,
} from "../src/data/manifest.mjs";
import { restaurantBounds } from "../src/data/map-startup.mjs";
import {
  mapStyles,
  preloadBasemap,
  createBasemapStyle,
} from "../src/data/map-resources.mjs";

const MAX_INLINE_CSS_BYTES = 48 * 1024;

function assetUrl(file, base, htmlPath) {
  if (base === "./" || base === "") {
    const relative = path.posix.relative(path.posix.dirname(htmlPath), file);
    return relative.startsWith(".") ? relative : `./${relative}`;
  }
  return `${base}${file}`;
}

function htmlAttribute(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function selfContainedCss(css) {
  // Inlining changes the base URL of relative assets. Only inline self-contained
  // CSS (including Oat's embedded SVGs); leave other sheets in Vite's pipeline.
  const withoutDataUrls = css.replace(
    /url\(\s*(?:"data:[^"]*"|'data:[^']*'|data:[^)\s]*)\s*\)/gi,
    "",
  );
  return (
    Buffer.byteLength(css) <= MAX_INLINE_CSS_BYTES &&
    !/@import|(?:url|image-set)\s*\(|\\/i.test(withoutDataUrls) &&
    !/<\/style/i.test(css)
  );
}

function mapAssets(bundle, base, htmlPath) {
  const map = Object.values(bundle).find(
    (chunk) =>
      chunk.type === "chunk" &&
      Object.keys(chunk.modules).some((id) =>
        /\/src\/components\/RestaurantMap\.[jt]s$/.test(
          id.replaceAll("\\", "/"),
        ),
      ),
  );
  const files = new Set();
  const styles = new Set();
  const visit = (file) => {
    if (files.has(file)) return;
    const chunk = bundle[file];
    // The HTML already loads its entry module and inlines its CSS. Do not
    // reintroduce an external entry-CSS fetch via a map's shared imports.
    if (chunk?.type !== "chunk" || chunk.isEntry) return;
    files.add(file);
    for (const css of chunk.viteMetadata?.importedCss || []) styles.add(css);
    for (const dependency of chunk.imports) visit(dependency);
  };
  if (map) visit(map.fileName);
  return [
    ...[...files].map((file) => ({
      href: assetUrl(file, base, htmlPath),
      rel: "modulepreload",
      as: "",
    })),
    ...[...styles].map((file) => ({
      href: assetUrl(file, base, htmlPath),
      rel: "preload",
      as: "style",
    })),
  ];
}

const scriptJson = (value) => JSON.stringify(value).replaceAll("<", "\\u003c");

async function startupScript(manifestUrl, assets, styleFactory, mapBounds) {
  // Fetch the mutable manifest once with its existing revalidation policy. Its
  // Response is consumed by load-files, so HTML warmup never pins a snapshot.
  const code = `(() => {
    globalThis.__gradesMapBounds = ${scriptJson(mapBounds)};
    const url = new URL(${scriptJson(manifestUrl)}, document.baseURI).href;
    if (globalThis.__gradesManifest?.url !== url) {
      const response = fetch(url, {cache: "no-cache", signal: AbortSignal.timeout(60_000)});
      response.catch(() => {});
      globalThis.__gradesManifest = {url, response};
    }
    if (location.hash.split("?")[0] === "#/watchlist") return;
    (${preloadBasemap.toString()})(${scriptJson(mapStyles)}, ${scriptJson(assets)}, undefined, ${styleFactory.toString()});
  })();`;
  const result = await transform(code, {
    minify: true,
    target: "es2022",
    charset: "ascii",
  });
  return result.code.replace(/<\/script/gi, "<\\/script");
}

/** @returns {import("vite").Plugin} */
export function startupResources({ styleFactory = createBasemapStyle } = {}) {
  let base = "./";
  let publicDirectory = "";
  let summaryFile = "";
  let mapBounds;
  return {
    name: "startup-resources",
    apply: "build",
    configResolved(config) {
      base = config.base;
      publicDirectory = config.publicDir;
    },
    async buildStart() {
      // Preload the exact immutable asset copied into this deployment. The
      // runtime still validates its fresh manifest and owns snapshot selection.
      const directory = path.join(publicDirectory, "data");
      const manifest = validateManifest(
        JSON.parse(await readFile(path.join(directory, MANIFEST_FILE), "utf8")),
      );
      const summary = await readFile(
        path.join(directory, manifest.summary.file),
      );
      const hash = createHash("sha256").update(summary).digest("hex");
      if (
        summary.byteLength !== manifest.summary.bytes ||
        !manifest.summary.file.endsWith(`-${hash}.json`)
      )
        throw new Error(
          "Cannot preload an incomplete or corrupted restaurant summary.",
        );
      summaryFile = `data/${manifest.summary.file}`;
      mapBounds = {
        summary: manifest.summary.file,
        bounds: restaurantBounds(
          validateSummary(JSON.parse(summary), manifest).restaurants,
        ),
      };
    },
    transformIndexHtml: {
      order: "post",
      async handler(html, context) {
        if (!context.bundle) return html;
        const htmlPath = context.path.replace(/^\//, "");
        const stylesheets = new Map(
          Object.values(context.bundle)
            .filter(
              (asset) =>
                asset.type === "asset" && asset.fileName.endsWith(".css"),
            )
            .map((asset) => [
              htmlAttribute(assetUrl(asset.fileName, base, htmlPath)),
              typeof asset.source === "string"
                ? asset.source
                : new TextDecoder().decode(asset.source),
            ]),
        );
        // These are Vite's generated entry links only. Lazy map styles remain
        // separate and user-authored links with media/CSP attributes stay intact.
        const inlined = html.replace(
          /<link rel="stylesheet" crossorigin href="([^"]+)">/g,
          (link, href) => {
            const css = stylesheets.get(href);
            return css && selfContainedCss(css)
              ? `<style data-startup-styles>${css}</style>`
              : link;
          },
        );
        const script = `<script data-startup-resources>${await startupScript(
          assetUrl(`data/${MANIFEST_FILE}`, base, htmlPath),
          mapAssets(context.bundle, base, htmlPath),
          styleFactory,
          mapBounds,
        )}</script>`;
        // Keep the character encoding declaration within the first 1024 bytes.
        // Warmup still runs before the entry module without moving this metadata.
        const charset = inlined.match(/<meta\b[^>]*\bcharset\s*=[^>]*>/i)?.[0];
        const warmed = charset
          ? inlined.replace(charset, () => `${charset}\n    ${script}`)
          : inlined.replace(
              /<head(?:\s[^>]*)?>/i,
              (head) => `${head}\n    ${script}`,
            );
        return {
          html: warmed,
          tags: [
            {
              tag: "link",
              attrs: {
                rel: "preload",
                as: "fetch",
                type: "application/json",
                href: assetUrl(summaryFile, base, htmlPath),
                crossorigin: "anonymous",
              },
              injectTo: "head",
            },
          ],
        };
      },
    },
  };
}
