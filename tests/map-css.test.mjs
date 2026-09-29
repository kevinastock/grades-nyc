import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import postcss from "postcss";
import { maplibreCss } from "../build/maplibre-css.mjs";

const stylesheet = fileURLToPath(
  new URL("../node_modules/maplibre-gl/dist/maplibre-gl.css", import.meta.url),
);
const css = await readFile(stylesheet, "utf8");

test("map CSS retains interactive layout and attribution without unused control images", async () => {
  const result = await postcss([maplibreCss()]).process(css, {
    from: stylesheet,
  });
  for (const selector of [
    ".maplibregl-canvas",
    ".maplibregl-touch-zoom-rotate",
    ".maplibregl-touch-drag-pan",
    ".maplibregl-ctrl-group",
    ".maplibregl-ctrl-attrib",
    ".maplibregl-ctrl-attrib-button:focus",
    ".maplibregl-ctrl-group button:focus:focus-visible",
    ".maplibregl-popup-content",
    ".maplibregl-popup-tip",
    ".maplibregl-popup-close-button",
    ".maplibregl-marker",
    ".maplibregl-boxzoom",
    "forced-colors:active",
  ])
    assert.ok(result.css.includes(selector), `keeps ${selector}`);
  for (const unused of [
    "maplibregl-ctrl-geolocate",
    "maplibregl-ctrl-fullscreen",
    "maplibregl-ctrl-compass",
    "maplibregl-ctrl-icon",
    "maplibregl-ctrl-terrain",
    "maplibregl-ctrl-globe",
    "maplibregl-user-location",
    "maplibregl-spin",
  ])
    assert.ok(!result.css.includes(unused), `omits ${unused}`);
  assert.ok(
    gzipSync(result.css).length < gzipSync(css).length / 2,
    "unused embedded images account for most of the transfer size",
  );
});

test("map CSS filtering leaves application and other vendor styles untouched", async () => {
  const result = await postcss([maplibreCss()]).process(css, {
    from: "/src/components/map.css",
  });
  assert.equal(result.css, css);
});
