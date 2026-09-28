import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Window } from "happy-dom";

const project = fileURLToPath(new URL("..", import.meta.url));
const bundle = await build({
  stdin: {
    contents:
      'export { createRestaurantMap } from "./src/components/RestaurantMap.ts"; export { default as L } from "leaflet";',
    resolveDir: project,
  },
  bundle: true,
  format: "iife",
  globalName: "Subject",
  write: false,
  loader: { ".css": "empty", ".svg": "text" },
  plugins: [
    {
      name: "isolate-data-loading",
      setup(b) {
        b.onLoad({ filter: /\.svg$/ }, async ({ path, suffix }) =>
          suffix === "?url"
            ? { contents: await readFile(path), loader: "dataurl" }
            : undefined,
        );
        b.onResolve({ filter: /^\.\.\/data\/client$/ }, () => ({
          path: "client",
          namespace: "stub",
        }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: "export const prefetchInspections = () => {};",
        }));
      },
    },
  ],
});

async function harness(t) {
  const w = new Window({ url: "http://localhost/" });
  w.WebKitCSSMatrix = class {
    m11 = 1;
  };
  const frames = new Map();
  let frameId = 0;
  w.requestAnimationFrame = (callback) => {
    frames.set(++frameId, callback);
    return frameId;
  };
  w.cancelAnimationFrame = (id) => frames.delete(id);
  // Drive zoom completion by its normal transition event, never wall-clock waits.
  const timers = new Map();
  let timerId = 0;
  w.setTimeout = (callback) => {
    timers.set(++timerId, callback);
    return timerId;
  };
  w.clearTimeout = (id) => timers.delete(id);
  w.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  Object.defineProperties(w.HTMLElement.prototype, {
    clientWidth: {
      get() {
        return this.classList.contains("map") ? 884 : 0;
      },
    },
    clientHeight: {
      get() {
        return this.classList.contains("map") ? 550 : 0;
      },
    },
  });
  w.eval(bundle.outputFiles[0].text);
  const { createRestaurantMap, L } = w.Subject;
  let map;
  L.Map.addInitHook(function () {
    map = this;
  });
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
  const accepted = [];
  const errors = [];
  const host = w.document.createElement("main");
  w.document.body.append(host);
  const view = createRestaurantMap(host, {
    explorer: {
      viewport(revision, bounds, zoom) {
        return new Promise((resolve) =>
          requests.push({ revision, bounds, zoom, resolve }),
        );
      },
    },
    result: { revision: 1, mapped: rows.length, unmapped: 0 },
    visibleMapped: rows.length,
    pending: false,
    restaurants,
    selectedId: null,
    cameraRequest: {
      key: "search",
      view: { lat: 40.74, lon: -73.97, zoom: 14 },
    },
    onCamera() {},
    onSelect() {},
    onViewport(value) {
      accepted.push(value);
    },
    onError(error) {
      errors.push(error);
    },
  });
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
    request.resolve({
      revision: request.revision,
      ids,
      visibleMapped: ids.length,
      features: ids.map((id) => {
        const row = restaurants.get(id);
        return {
          type: "Feature",
          geometry: { type: "Point", coordinates: [row.lon, row.lat] },
          properties: { cluster: false, id },
        };
      }),
    });
    await Promise.resolve();
  }
  async function startZoom(direction) {
    host.querySelector(`.leaflet-control-zoom-${direction}`).click();
    await frame();
    assert.ok(
      host.querySelector(".leaflet-zoom-anim"),
      "the real Leaflet zoom animation started",
    );
  }
  async function finishZoom() {
    const event = new w.Event("transitionend");
    Object.defineProperty(event, "propertyName", { value: "transform" });
    host.querySelector(".leaflet-proxy").dispatchEvent(event);
    await frame();
    assert.equal(host.querySelector(".leaflet-zoom-anim"), null);
  }
  function markers() {
    const found = [];
    map.eachLayer((layer) => {
      if (layer instanceof L.Marker) found.push(layer);
    });
    return found;
  }
  function assertPositions() {
    assert.equal(markers().length, 2);
    for (const marker of markers()) {
      const expected = map.latLngToLayerPoint(marker.getLatLng()).round();
      assert.ok(
        L.DomUtil.getPosition(marker.getElement()).equals(expected),
        "marker follows the settled camera",
      );
      const point = map.latLngToContainerPoint(marker.getLatLng());
      assert.ok(
        point.x >= 0 && point.x <= 884 && point.y >= 0 && point.y <= 550,
        "central marker remains onscreen",
      );
    }
  }
  await frame();
  assert.equal(requests.length, 1);
  return {
    map,
    requests,
    accepted,
    frame,
    reply,
    startZoom,
    finishZoom,
    markers,
    assertPositions,
  };
}

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
  assert.equal(
    h.markers().length,
    originalMarkers.length,
    "late results must not clear the layer during another zoom",
  );
  assert.ok(
    h.markers().every((marker, index) => marker === originalMarkers[index]),
    "late results must retain the displayed layers",
  );
  assert.equal(h.accepted.length, 1);
  await h.finishZoom();
  assert.equal(
    h.requests.length,
    3,
    "the settled zoom refreshes without another action",
  );
  await h.reply(h.requests[2], ["central", "nearby"]);
  h.assertPositions();
});

test("returning to the same viewport retries a request invalidated by movement", async (t) => {
  const h = await harness(t);
  const original = h.requests[0];
  h.map.panBy([40, 0], { animate: false });
  h.map.panBy([-40, 0], { animate: false });
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
  h.assertPositions();
  assert.equal(
    h.accepted.length,
    1,
    "the invalidated response is ignored even after the fresh response",
  );
});

test("zoom buttons keep retained markers positioned through repeated zooms", async (t) => {
  const h = await harness(t);
  await h.reply(h.requests[0], ["central", "nearby"]);
  const originalMarkers = h.markers();
  h.assertPositions();
  for (const direction of ["in", "in", "out", "out"]) {
    const count = h.requests.length;
    await h.startZoom(direction);
    await h.finishZoom();
    assert.equal(h.requests.length, count + 1);
    h.assertPositions();
    await h.reply(h.requests.at(-1), ["central", "nearby"]);
    assert.ok(
      h.markers().every((marker, index) => marker === originalMarkers[index]),
      "ordinary zooms reuse the existing marker layers",
    );
    h.assertPositions();
  }
});
