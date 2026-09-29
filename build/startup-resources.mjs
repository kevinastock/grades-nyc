import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { validateManifest } from "../src/data/manifest.mjs";

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

/** @returns {import("vite").Plugin} */
export function startupResources() {
  let base = "./";
  let publicDirectory = "";
  let summaryFile = "";
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
        JSON.parse(
          await readFile(path.join(directory, "manifest.json"), "utf8"),
        ),
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
    },
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
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
        return {
          html: inlined,
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
