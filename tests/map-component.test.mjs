import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Window } from "happy-dom";
import { createExpression, latest } from "@maplibre/maplibre-gl-style-spec";

const project = fileURLToPath(new URL("..", import.meta.url));
const bundle = await build({
  stdin: {
    contents:
      'export { createRestaurantMap } from "./src/components/RestaurantMap.ts"; export { Map, workerUrls, Popup } from "maplibre-gl";',
    resolveDir: project,
  },
  bundle: true,
  format: "iife",
  globalName: "Subject",
  write: false,
  loader: { ".css": "empty", ".svg": "text" },
  plugins: [
    {
      name: "isolate-rendering-and-data-loading",
      setup(b) {
        b.onLoad({ filter: /\.svg$/ }, async ({ path, suffix }) =>
          suffix === "?url"
            ? { contents: await readFile(path), loader: "dataurl" }
            : undefined,
        );
        b.onResolve({ filter: /^maplibre-gl$/ }, () => ({
          path: fileURLToPath(
            new URL("./helpers/maplibre-stub.mjs", import.meta.url),
          ),
        }));
        b.onResolve({ filter: /\?worker&url$/ }, () => ({
          path: "worker",
          namespace: "stub",
        }));
        b.onResolve({ filter: /^\.\.\/data\/client$/ }, () => ({
          path: "client",
          namespace: "stub",
        }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => ({
          contents:
            path === "worker"
              ? 'export default "/assets/maplibre-worker.mjs";'
              : "export const prefetchInspections = () => {};",
        }));
      },
    },
  ],
});

// These integration tests cover our MapLibre lifecycle. WebGL painting,
// external tile availability and CSS layout require a browser smoke check.
async function harness(
  t,
  overrides = {},
  { hidden = false, dark = false } = {},
) {
  const w = new Window({ url: "http://localhost/" });
  const frames = new Map();
  let frameId = 0;
  w.requestAnimationFrame = (callback) => {
    frames.set(++frameId, callback);
    return frameId;
  };
  w.cancelAnimationFrame = (id) => frames.delete(id);
  const mediaListeners = new Set();
  const media = {
    matches: dark,
    media: "(prefers-color-scheme: dark)",
    addEventListener(type, callback) {
      if (type === "change") mediaListeners.add(callback);
    },
    removeEventListener(type, callback) {
      if (type === "change") mediaListeners.delete(callback);
    },
    addListener(callback) {
      mediaListeners.add(callback);
    },
    removeListener(callback) {
      mediaListeners.delete(callback);
    },
  };
  w.matchMedia = () => media;
  const observers = [];
  w.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe(element) {
      this.element = element;
    }
    disconnect() {
      this.disconnected = true;
    }
  };
  const size = { width: hidden ? 0 : 884, height: hidden ? 0 : 550 };
  Object.defineProperties(w.HTMLElement.prototype, {
    clientWidth: {
      get() {
        return this.classList.contains("map") ? size.width : 0;
      },
    },
    clientHeight: {
      get() {
        return this.classList.contains("map") ? size.height : 0;
      },
    },
  });
  w.eval(bundle.outputFiles[0].text);
  const { createRestaurantMap, Map: GLMap, workerUrls, Popup } = w.Subject;
  const rows = [
    { id: "central", lat: 40.74, lon: -73.97 },
    { id: "nearby", lat: 40.741, lon: -73.971 },
    { id: "southwest", lat: 40.5, lon: -74.24 },
    { id: "northeast", lat: 40.91, lon: -73.7 },
  ].map((row) => ({
    ...row,
    name: row.id,
    grade: "A",
    address: "1 Main Street",
  }));
  const restaurants = new Map(rows.map((row) => [row.id, row]));
  const requests = [];
  const expansions = [];
  const accepted = [];
  const cameras = [];
  const errors = [];
  const selections = [];
  const host = w.document.createElement("main");
  w.document.body.append(host);
  const props = {
    explorer: {
      viewport(revision, bounds, zoom) {
        return new Promise((resolve, reject) =>
          requests.push({ revision, bounds, zoom, resolve, reject }),
        );
      },
      expand(revision, id) {
        return new Promise((resolve) =>
          expansions.push({ revision, id, resolve }),
        );
      },
    },
    result: { revision: 1, mapped: rows.length, unmapped: 0 },
    restaurants,
    selectedId: null,
    showResultsToggle: true,
    resultsVisible: false,
    onToggleResults() {},
    cameraRequest: {
      key: "search",
      view: { lat: 40.74, lon: -73.97, zoom: 14 },
    },
    onCamera(camera, bounds) {
      cameras.push({ camera, bounds });
    },
    onSelect(id) {
      selections.push(id);
    },
    onViewport(value) {
      accepted.push(value);
    },
    onError(error) {
      errors.push(error);
    },
    ...overrides,
  };
  const view = createRestaurantMap(host, props);
  t.after(async () => {
    view.destroy();
    await w.happyDOM.close();
    assert.deepEqual(errors, []);
  });
  async function frame() {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
    await Promise.resolve();
  }
  async function reply(request, ids) {
    return replyFeatures(
      request,
      ids.map((id) => {
        const row = restaurants.get(id);
        return {
          type: "Feature",
          geometry: { type: "Point", coordinates: [row.lon, row.lat] },
          properties: { cluster: false, id },
        };
      }),
      ids,
    );
  }
  async function replyFeatures(request, features, ids = []) {
    request.resolve({
      revision: request.revision,
      ids,
      visibleMapped: ids.length,
      features,
    });
    await Promise.resolve();
  }
  async function startZoom(direction) {
    host.querySelector(`.maplibregl-ctrl-zoom-${direction}`).click();
    await frame();
    assert.equal(map.isMoving(), true);
  }
  async function finishZoom() {
    map.finishMove();
    await frame();
    assert.equal(map.isMoving(), false);
  }
  function markers() {
    return [...map.markers];
  }
  function assertAnchors() {
    assert.equal(markers().length, 2);
    for (const marker of markers()) {
      const id = marker.getLngLat().lat === 40.74 ? "central" : "nearby";
      const row = restaurants.get(id);
      assert.equal(
        marker.getLngLat().lat,
        row.lat,
        "retained marker keeps its geographic anchor",
      );
      assert.equal(marker.getLngLat().lng, row.lon);
      assert.ok(marker.getElement().isConnected);
      assert.ok(
        map.getBounds().contains(marker.getLngLat()),
        "central marker remains within the current viewport",
      );
    }
  }
  async function resize(width, height) {
    size.width = width;
    size.height = height;
    for (const observer of observers)
      if (!observer.disconnected) observer.callback([]);
    await frame();
  }
  function setDark(value) {
    media.matches = value;
    for (const callback of [...mediaListeners])
      callback({ matches: value, media: media.media });
  }
  await frame();
  const map = GLMap.instances.at(-1);
  assert.equal(requests.length, hidden ? 0 : 1);
  return {
    host,
    view,
    props,
    map,
    requests,
    accepted,
    cameras,
    errors,
    selections,
    frame,
    reply,
    replyFeatures,
    startZoom,
    finishZoom,
    markers,
    assertAnchors,
    resize,
    setDark,
    observers,
    mediaListeners,
    frames,
    workerUrls,
    expansions,
    Popup,
  };
}

test("the results control exposes its state and updates without resetting the map", async (t) => {
  let toggles = 0;
  const h = await harness(t, { onToggleResults: () => toggles++ });
  const toggle = h.host.querySelector('[aria-controls="restaurant-results"]');
  assert.equal(toggle.hidden, false);
  assert.equal(toggle.getAttribute("aria-label"), "Show search results");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.ok(toggle.querySelector("svg.feather-list"));
  toggle.click();
  assert.equal(toggles, 1);
  const canvas = h.map.getCanvas();
  const center = h.map.getCenter();
  h.view.update({ ...h.props, resultsVisible: true });
  assert.equal(toggle.getAttribute("aria-label"), "Hide search results");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(h.map.getCanvas(), canvas);
  assert.deepEqual(h.map.getCenter(), center);
  assert.equal(h.requests.length, 1);
  h.view.update({ ...h.props, showResultsToggle: false });
  assert.equal(toggle.hidden, true);
});

test("viewport responses from before the next zoom cannot clear the displayed restaurants", async (t) => {
  const h = await harness(t);
  await h.reply(h.requests[0], ["central", "nearby"]);
  const originalMarkers = h.markers();
  await h.startZoom("in");
  await h.finishZoom();
  assert.equal(h.requests.length, 2);
  const staleRequest = h.requests[1];
  await h.startZoom("out");
  await h.reply(staleRequest, []);
  assert.deepEqual(
    h.markers(),
    originalMarkers,
    "late results retain displayed marker instances while moving",
  );
  assert.equal(h.accepted.length, 1);
  await h.finishZoom();
  assert.equal(
    h.requests.length,
    3,
    "settling the zoom refreshes without another action",
  );
  await h.reply(h.requests[2], ["central", "nearby"]);
  h.assertAnchors();
});

test("returning to the same viewport retries a request invalidated by movement", async (t) => {
  const h = await harness(t);
  const original = h.requests[0];
  const center = h.map.getCenter();
  h.map.jumpTo({ center: [center.lng + 0.001, center.lat] });
  h.map.jumpTo({ center });
  await h.frame();
  assert.equal(
    h.requests.length,
    2,
    "same bounds must not suppress the replacement request",
  );
  assert.deepEqual(h.requests[1].bounds, original.bounds);
  assert.equal(h.requests[1].zoom, original.zoom);
  await h.reply(h.requests[1], ["central", "nearby"]);
  await h.reply(original, []);
  h.assertAnchors();
  assert.equal(
    h.accepted.length,
    1,
    "invalidated response stays ignored after the fresh response",
  );
});

test("zoom buttons retain marker instances and geographic anchors through repeated zooms", async (t) => {
  const h = await harness(t);
  await h.reply(h.requests[0], ["central", "nearby"]);
  const originalMarkers = h.markers();
  h.assertAnchors();
  for (const direction of ["in", "in", "out", "out"]) {
    const count = h.requests.length;
    await h.startZoom(direction);
    await h.finishZoom();
    assert.equal(h.requests.length, count + 1);
    h.assertAnchors();
    await h.reply(h.requests.at(-1), ["central", "nearby"]);
    assert.deepEqual(
      h.markers(),
      originalMarkers,
      "ordinary zooms reuse existing markers",
    );
    h.assertAnchors();
  }
});

test("MapLibre uses longitude first while worker and saved cameras retain their original zoom scale", async (t) => {
  const h = await harness(t);
  assert.equal(h.map.getCenter().lng, -73.97);
  assert.equal(h.map.getCenter().lat, 40.74);
  assert.equal(
    h.map.getZoom(),
    13,
    "512-pixel MapLibre zoom is one below the public 256-pixel zoom",
  );
  assert.equal(h.requests[0].zoom, 14);
  assert.equal(h.cameras[0].camera.zoom, 14);
  assert.equal(h.cameras[0].camera.lon, -73.97);
  assert.equal(h.workerUrls.at(-1), "/assets/maplibre-worker.mjs");
  await h.startZoom("in");
  await h.finishZoom();
  assert.equal(h.map.getZoom(), 14);
  assert.equal(h.requests.at(-1).zoom, 15);
  assert.equal(h.cameras.at(-1).camera.zoom, 15);
});

test("changing the system theme replaces only the style and preserves camera and selection", async (t) => {
  const h = await harness(t, { selectedId: "central" });
  await h.reply(h.requests[0], ["central", "nearby"]);
  const selected = h.host.querySelector(".map-selected");
  const camera = h.map.getCenter();
  const zoom = h.map.getZoom();
  const markers = h.markers();
  assert.ok(selected.querySelector('[aria-pressed="true"]'));
  assert.ok(selected.querySelector(".map-selected-tooltip"));
  assert.equal(
    h.map.styles.at(-1),
    "https://tiles.openfreemap.org/styles/bright",
  );
  assert.equal(
    h.host.querySelectorAll(".map-restaurant").length,
    1,
    "selection is not duplicated as an ordinary marker",
  );
  h.setDark(true);
  assert.equal(
    h.map.styles.at(-1),
    "https://tiles.openfreemap.org/styles/fiord",
  );
  assert.deepEqual(h.map.getCenter(), camera);
  assert.equal(h.map.getZoom(), zoom);
  assert.deepEqual(h.markers(), markers);
  assert.equal(h.host.querySelector(".map-selected"), selected);
  assert.equal(
    h.requests.length,
    1,
    "changing only the basemap does not restart the restaurant query",
  );
  selected.querySelector("button").click();
  assert.deepEqual(h.selections, ["central"]);
  h.setDark(false);
  assert.equal(
    h.map.styles.at(-1),
    "https://tiles.openfreemap.org/styles/bright",
  );
});

test("a dark initial preference starts with Fiord", async (t) => {
  const h = await harness(t, {}, { dark: true });
  assert.equal(
    h.map.styles.at(-1),
    "https://tiles.openfreemap.org/styles/fiord",
  );
});

test("POI sprites retain available icons and use a circle for missing icons without changing other layers", async (t) => {
  const h = await harness(t);
  const icon = ["get", "class"];
  const poi = {
    id: "poi-level-1",
    type: "symbol",
    source: "openmaptiles",
    layout: {
      "icon-image": icon,
      "text-field": ["get", "name"],
      "text-size": 12,
    },
  };
  const road = {
    id: "road-label",
    type: "symbol",
    layout: { "icon-image": ["get", "shield"] },
  };
  const fixedPoi = {
    id: "poi-fixed",
    type: "symbol",
    layout: { "icon-image": "cafe" },
  };
  const background = { id: "background", type: "background" };
  const original = {
    version: 8,
    sources: { openmaptiles: {} },
    sprite: "https://example.com/sprite",
    layers: [poi, road, fixedPoi, background],
  };
  const transformed = h.map.styleOptions
    .at(-1)
    .transformStyle(undefined, original);
  assert.equal(transformed.sources, original.sources);
  assert.equal(transformed.sprite, original.sprite);
  assert.equal(transformed.layers[1], road);
  assert.equal(transformed.layers[2], fixedPoi);
  assert.equal(transformed.layers[3], background);
  assert.equal(
    poi.layout["icon-image"],
    icon,
    "the source style stays untouched",
  );
  assert.equal(
    transformed.layers[0].layout["text-field"],
    poi.layout["text-field"],
  );
  assert.equal(transformed.layers[0].layout["text-size"], 12);
  const parsed = createExpression(
    transformed.layers[0].layout["icon-image"],
    "icon-image",
    latest.layout_symbol["icon-image"],
  );
  assert.equal(
    parsed.result,
    "success",
    "the fallback is a valid MapLibre icon expression",
  );
  const evaluate = (kind, images) =>
    parsed.value.evaluateWithoutErrorHandling(
      { zoom: 14 },
      { type: "Point", properties: { class: kind } },
      undefined,
      undefined,
      images,
    );
  assert.equal(
    evaluate("cafe", ["cafe", "circle"]).name,
    "cafe",
    "an available POI icon keeps its original sprite",
  );
  const fallback = evaluate("missing-poi-class", ["cafe", "circle"]);
  assert.equal(fallback.name, "circle");
  assert.equal(fallback.available, true);
});

test("hidden mounts defer viewport requests until measurable and preserve the camera after hiding", async (t) => {
  const h = await harness(t, {}, { hidden: true });
  assert.equal(h.frames.size, 0, "hidden map does not poll animation frames");
  await h.resize(884, 550);
  assert.equal(h.requests.length, 1);
  await h.reply(h.requests[0], ["central", "nearby"]);
  const camera = h.map.getCenter();
  const zoom = h.map.getZoom();
  const resizeCalls = h.map.resizeCalls;
  await h.resize(0, 0);
  assert.equal(
    h.map.resizeCalls,
    resizeCalls,
    "a zero-size observation does not resize the map",
  );
  assert.equal(h.requests.length, 1);
  await h.resize(600, 550);
  assert.ok(h.map.resizeCalls > resizeCalls);
  assert.deepEqual(h.map.getCenter(), camera);
  assert.equal(h.map.getZoom(), zoom);
  assert.equal(h.requests.length, 2);
  await h.reply(h.requests.at(-1), ["central", "nearby"]);
  h.assertAnchors();
});

test("destroy disconnects observers, theme listeners and pending viewport work", async (t) => {
  const h = await harness(t);
  const pending = h.requests[0];
  const styles = h.map.styles.length;
  h.view.destroy();
  assert.equal(h.map.removed, true);
  assert.ok(h.observers.every((observer) => observer.disconnected));
  assert.equal(h.mediaListeners.size, 0);
  assert.equal(h.frames.size, 0);
  assert.equal(h.host.children.length, 0);
  await h.reply(pending, ["central", "nearby"]);
  h.setDark(true);
  await h.resize(900, 600);
  h.view.update({ ...h.props, selectedId: "nearby" });
  assert.equal(h.accepted.length, 0);
  assert.equal(h.requests.length, 1);
  assert.equal(h.map.styles.length, styles);
  assert.equal(h.host.children.length, 0);
});

test("selecting a place without coordinates leaves the camera intact and explains the missing marker", async (t) => {
  const h = await harness(t, { selectedId: "central" });
  h.props.restaurants.set("missing", {
    id: "missing",
    name: "Missing Place",
    grade: "B",
    address: "2 Main Street",
  });
  const center = h.map.getCenter();
  const zoom = h.map.getZoom();
  assert.ok(h.host.querySelector(".map-selected"));
  h.view.update({
    ...h.props,
    selectedId: "missing",
    cameraRequest: { key: "missing-selection", view: null },
  });
  await h.frame();
  await h.frame();
  await h.frame();
  assert.deepEqual(h.map.getCenter(), center);
  assert.equal(h.map.getZoom(), zoom);
  assert.equal(h.host.querySelector(".map-selected"), null);
  const status = h.host.querySelector('[role="alert"]');
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, "Missing Place has no map location.");
  assert.equal(
    h.requests.length,
    2,
    "the new selection still refreshes the visible results",
  );
});

const cluster = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [-73.97, 40.74] },
  properties: { cluster: true, cluster_id: 42, point_count: 2 },
};

test("cluster expansion reaches maximum navigable zoom and ignores replies after a newer interaction", async (t) => {
  const h = await harness(t);
  await h.replyFeatures(h.requests[0], [cluster]);
  const button = h.host.querySelector(".map-cluster button");
  assert.equal(button.getAttribute("aria-label"), "2 restaurants");
  button.click();
  assert.equal(h.expansions[0].revision, 1);
  assert.equal(h.expansions[0].id, 42);
  h.expansions[0].resolve({ zoom: 19, ids: [] });
  await Promise.resolve();
  assert.equal(h.map.getZoom(), 18);
  assert.equal(h.map.getCenter().lng, -73.97);
  assert.equal(h.map.getCenter().lat, 40.74);
  assert.equal(h.host.querySelector(".map-place-list"), null);
  await h.finishZoom();
  button.click();
  h.map.fire("click");
  h.expansions[1].resolve({ zoom: 20, ids: ["central", "nearby"] });
  await Promise.resolve();
  assert.equal(h.host.querySelector(".map-place-list"), null);
  assert.equal(h.map.getZoom(), 18);
});

test("coincident places open a selectable popup that pans into view and closes on selection", async (t) => {
  const h = await harness(t);
  await h.replyFeatures(h.requests[0], [cluster]);
  h.host.querySelector(".map-cluster button").click();
  h.expansions[0].resolve({ zoom: 20, ids: ["central", "nearby"] });
  await Promise.resolve();
  const popup = h.Popup.instances.at(-1);
  assert.ok(popup.isOpen());
  assert.equal(popup.lngLat.lng, -73.97);
  assert.equal(popup.lngLat.lat, 40.74);
  const list = h.host.querySelector(".map-place-list");
  assert.equal(list.querySelector("strong").textContent, "2 places here");
  assert.equal(list.querySelectorAll("button").length, 2);
  assert.ok(
    popup
      .getElement()
      .querySelector(".maplibregl-popup-close-button svg.feather-x"),
  );
  h.map.getContainer().getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 884,
    bottom: 550,
  });
  popup.getElement().getBoundingClientRect = () => ({
    left: 200,
    top: -40,
    right: 500,
    bottom: 200,
  });
  await h.frame();
  assert.equal(
    h.map.pans.length,
    1,
    "popup outside the top edge causes a reveal pan",
  );
  assert.equal(h.map.pans[0][0], 0);
  assert.equal(h.map.pans[0][1], -48);
  list.querySelector("button").click();
  assert.deepEqual(h.selections, ["central"]);
  assert.equal(popup.isOpen(), false);
  assert.equal(h.host.querySelector(".map-place-list"), null);
});

test("basemap failures show an alert which clears after the replacement style loads", async (t) => {
  const h = await harness(t);
  const status = h.host.querySelector('[role="alert"]');
  assert.equal(status.hidden, true);
  h.map.fire("error", { error: new Error("Tile request failed") });
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, "Map tiles unavailable.");
  h.map.fire("style.load");
  assert.equal(status.hidden, true);
});
