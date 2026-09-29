import assert from "node:assert/strict";
import test from "node:test";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { Window } from "happy-dom";
import { createBasemapStyle } from "../src/data/local-basemap.mjs";
import { preloadBasemap, mapStyles } from "../src/data/map-resources.mjs";

test("owned basemaps validate, retain geographic context, and have no style or sprite dependency", () => {
  const light = createBasemapStyle("light");
  const dark = createBasemapStyle("dark");
  for (const style of [light, dark]) {
    assert.deepEqual(validateStyleMin(style), []);
    assert.equal(style.layers.length, 13);
    assert.equal(style.sprite, undefined);
    assert.equal(
      style.sources.openmaptiles.url,
      "https://tiles.openfreemap.org/planet",
    );
    assert.match(
      style.sources.openmaptiles.attribution,
      /OpenFreeMap.*OpenMapTiles.*OpenStreetMap/,
    );
    for (const source of [
      "water",
      "park",
      "transportation",
      "transportation_name",
      "place",
    ])
      assert.ok(style.layers.some((layer) => layer["source-layer"] === source));
    for (const layer of style.layers.filter(
      (layer) => layer.type === "symbol",
    )) {
      assert.deepEqual(layer.layout["text-font"], ["Noto Sans Regular"]);
      assert.equal(layer.layout["icon-image"], undefined);
      assert.ok(layer.layout["text-field"]);
    }
  }
  assert.notEqual(
    light.layers[0].paint["background-color"],
    dark.layers[0].paint["background-color"],
  );
});

test("style factory can be serialized into the HTML without imports", () => {
  const factory = new Function(`return (${createBasemapStyle.toString()});`)();
  assert.deepEqual(factory("dark"), createBasemapStyle("dark"));
});

test("HTML can share complete styles and direct resource hints without fetching style JSON", async (t) => {
  const w = new Window({ url: "https://grades.test/nested/#/search" });
  t.after(() => w.happyDOM.close());
  w.matchMedia = () => ({ matches: false });
  w.fetch = () => {
    throw new Error("A local style must not fetch JSON");
  };
  w.eval(`globalThis.warm = () => (${preloadBasemap.toString()})(${JSON.stringify(mapStyles)},
    [{href: './assets/map.js', as: '', rel: 'modulepreload'}], undefined, (${createBasemapStyle.toString()}));`);
  const first = w.warm();
  const second = w.warm();
  assert.equal(first, second);
  const style = await first;
  assert.equal(style.layers.length, 13);
  const hints = [...w.document.head.querySelectorAll("link")];
  assert.equal(hints.length, 3);
  assert.ok(
    hints.some(
      (link) => link.href === "https://grades.test/nested/assets/map.js",
    ),
  );
  assert.ok(hints.some((link) => link.href === style.sources.openmaptiles.url));
  assert.ok(
    hints.some((link) =>
      link.href.endsWith("/fonts/Noto%20Sans%20Regular/0-255.pbf"),
    ),
  );
  assert.ok(hints.every((link) => link.crossOrigin === "anonymous"));
  w.location.hash = "#/watchlist";
  w.document.head.replaceChildren();
  await w.warm();
  assert.equal(w.document.head.querySelectorAll("link").length, 0);
});
