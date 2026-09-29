import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { Window } from "happy-dom";
import { fileURLToPath } from "node:url";

// Keep the real app, navigation and child views together. Only external work
// (data, worker queries and MapLibre) is controlled so races are deterministic.
const stubs = {
  "./data/client": `
    import { ExplorerClient } from "./data/explorer-client";
    export const loadData = (...args) => globalThis.appTest.loadData(...args);
    export const getExplorerData = () => undefined;
    export const takeExplorer = (restaurants) => new ExplorerClient(restaurants);
    export const disposePreparedExplorer = () => {};
    export const prefetchInspections = () => {};
    export const getInspections = async () => [];
  `,
  "./data/explorer-client": `
    export class ExplorerClient {
      constructor(restaurants) { this.client = globalThis.appTest.createExplorer(restaurants); }
      query(...args) { return this.client.query(...args); }
      dispose() { this.client.dispose(); }
    }
  `,
  "./data/map-resources": `
    export const preloadBasemap = () => globalThis.appTest.basemapWarmups++;
  `,
  "./components/RestaurantMap": `
    globalThis.appTest.mapImports++;
    export const createRestaurantMap = (...args) => globalThis.appTest.createMap(...args);
  `,
};
const bundled = await build({
  entryPoints: [fileURLToPath(new URL("../src/App.ts", import.meta.url))],
  loader: { ".svg": "text" },
  bundle: true,
  format: "iife",
  globalName: "AppUnderTest",
  write: false,
  plugins: [
    {
      name: "app-boundaries",
      setup(builder) {
        builder.onLoad({ filter: /\.svg$/ }, async (args) =>
          args.suffix === "?url"
            ? { contents: await readFile(args.path), loader: "dataurl" }
            : undefined,
        );
        builder.onResolve(
          {
            filter:
              /(?:data\/client|data\/explorer-client|data\/map-resources|components\/RestaurantMap)$/,
          },
          (args) => {
            const id = args.path.replace(/^\.\.\//, "./");
            return stubs[id] ? { path: id, namespace: "app-test" } : undefined;
          },
        );
        builder.onLoad({ filter: /.*/, namespace: "app-test" }, (args) => ({
          contents: stubs[args.path],
          loader: "js",
        }));
      },
    },
  ],
});
const code = bundled.outputFiles[0].text;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function dataset(count = 90) {
  return {
    restaurants: Array.from({ length: count }, (_, index) => ({
      id: String(index + 1),
      name: `RESTAURANT ${index + 1}`,
      borough: "Queens",
      address: `${index + 1} MAIN STREET`,
      zip: "11101",
      cuisine: "Pizza",
      lat: 40.75,
      lon: -73.95,
      grade: "A",
      grade_date: "2026-01-01",
      grade_inspected: "2026-01-01",
      latest_date: "2026-01-01",
      latest_codes: "",
      closure: "none",
      closed_date: null,
    })),
    violations: [],
    snapshot: "2026-01-02",
    rowCount: count,
    cuisines: ["Pizza"],
    boroughs: ["Queens"],
  };
}

async function mount(
  t,
  hash = "#/search",
  selected = [],
  size = {},
  { delayMapYield = false } = {},
) {
  const window = new Window({ url: `http://localhost/${hash}`, ...size });
  const mapYields = [];
  window.scheduler = {
    yield() {
      if (!delayMapYield) return Promise.resolve();
      const job = deferred();
      mapYields.push(job);
      return job.promise;
    },
  };
  // Happy DOM treats comma-separated media queries as AND and misses the first
  // true-to-false change. Keep its real query evaluation, with browser OR/change
  // semantics so portrait, landscape and live resizing exercise the app.
  const matchMedia = window.matchMedia.bind(window);
  window.matchMedia = (query) => {
    const branches = query.split(",").map((part) => matchMedia(part.trim()));
    const media = new window.EventTarget();
    Object.defineProperty(media, "matches", {
      get: () => branches.some((branch) => branch.matches),
    });
    let previous = media.matches;
    window.addEventListener("resize", () => {
      if (previous === media.matches) return;
      previous = media.matches;
      media.dispatchEvent(new window.Event("change"));
    });
    return media;
  };
  window.localStorage.setItem(
    "nyc-grades-watchlist-v1",
    JSON.stringify({ selected }),
  );
  const loads = [],
    clients = [],
    maps = [],
    frames = new Map();
  let frameId = 0;
  window.requestAnimationFrame = (callback) => {
    const id = ++frameId;
    frames.set(id, callback);
    return id;
  };
  window.cancelAnimationFrame = (id) => frames.delete(id);
  window.appTest = {
    mapImports: 0,
    basemapWarmups: 0,
    loadData(onProgress, restaurantId) {
      const job = { ...deferred(), onProgress, restaurantId };
      loads.push(job);
      onProgress("Downloading inspection records…");
      return job.promise;
    },
    createExplorer(restaurants) {
      const client = {
        restaurants,
        jobs: [],
        disposed: false,
        query(revision, criteria) {
          const job = { ...deferred(), revision, criteria };
          this.jobs.push(job);
          return job.promise;
        },
        dispose() {
          this.disposed = true;
        },
      };
      clients.push(client);
      return client;
    },
    createMap(host, props) {
      const node = window.document.createElement("div");
      const toggle = window.document.createElement("button");
      toggle.className = "map-results-toggle";
      toggle.setAttribute("aria-controls", "restaurant-results");
      toggle.onclick = () => map.props.onToggleResults();
      node.append(toggle);
      host.replaceChildren(node);
      const map = {
        props,
        destroyed: false,
        update(next) {
          assert.equal(
            this.destroyed,
            false,
            "a disposed map must not receive updates",
          );
          this.props = next;
        },
        destroy() {
          this.destroyed = true;
          node.remove();
        },
      };
      toggle.setAttribute("aria-label", "Show search results");
      maps.push(map);
      return map;
    },
  };
  window.eval(`${code}\nglobalThis.AppUnderTest = AppUnderTest;`);
  const root = window.document.createElement("div");
  window.document.body.append(root);
  const app = window.AppUnderTest.createApp(root);
  t.after(async () => {
    app.destroy();
    await window.happyDOM.close();
  });
  const flush = async () => {
    // Flush promise continuations and explicitly scheduled paint work without
    // sleeping or relying on arbitrary worker/network timing.
    for (let pass = 0; pass < 8; pass++) {
      await Promise.resolve();
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(0));
    }
  };
  const results = () =>
    root.querySelector('[aria-label="Restaurant search results"]');
  const input = () =>
    root.querySelector('[aria-label="Search restaurants by name or street"]');
  const resultIds = () =>
    [...results().querySelectorAll("[data-restaurant-id]")].map(
      (node) => node.dataset.restaurantId,
    );
  const button = (text) =>
    [...root.querySelectorAll("button")].find(
      (node) => node.textContent === text,
    );
  const map = () => maps.at(-1);
  const viewport = (ids = map().props.result.ids, target = map()) => {
    const props = target.props;
    props.onViewport(
      {
        revision: props.result.revision,
        ids,
        visibleMapped: ids.length,
        features: [],
      },
      props.cameraRequest.key,
    );
  };
  const resolveQuery = async (job, ids) => {
    job.resolve({
      revision: job.revision,
      ids,
      mapped: ids.length,
      unmapped: 0,
      bounds: null,
    });
    await flush();
  };
  const boot = async (data = dataset()) => {
    loads.at(-1).resolve(data);
    await flush();
    await resolveQuery(
      clients.at(-1).jobs.at(-1),
      data.restaurants.map(({ id }) => id),
    );
    viewport();
    return data;
  };
  const search = (value) => {
    input().focus();
    input().value = value;
    input().dispatchEvent(new window.Event("input", { bubbles: true }));
    return clients.at(-1).jobs.at(-1);
  };
  return {
    window,
    root,
    app,
    loads,
    clients,
    maps,
    mapYields,
    flush,
    results,
    input,
    resultIds,
    button,
    map,
    viewport,
    resolveQuery,
    boot,
    search,
  };
}

test("SVG controls keep accessible names and the GitHub link opens the repository", async (t) => {
  const h = await mount(t);
  await h.boot();
  const github = h.root.querySelector('[aria-label="GitHub repository"]');
  assert.equal(github.hasAttribute("aria-disabled"), false);
  assert.equal(github.href, "https://github.com/kevinastock/grades-nyc");
  assert.equal(github.target, "_blank");
  assert.equal(github.rel, "noopener noreferrer");
  const search = h.root.querySelector('nav [aria-label="Restaurants"]');
  assert.equal(search.querySelector("svg"), null);
  assert.equal(search.textContent, "Restaurants");
  assert.equal(search.getAttribute("href"), "#/search");
  const query = h.search("pizza");
  await h.resolveQuery(query, ["1"]);
  const clear = h.root.querySelector('[aria-label="Clear restaurant search"]');
  assert.equal(clear.textContent, "");
  const svg = clear.querySelector("svg");
  assert.equal(svg.namespaceURI, "http://www.w3.org/2000/svg");
  assert.equal(svg.getAttribute("aria-hidden"), "true");
  assert.equal(svg.getAttribute("focusable"), "false");
  assert.equal(svg.getAttribute("stroke"), "currentColor");
  clear.click();
  assert.equal(h.input().value, "");
  assert.equal(h.window.document.activeElement, h.input());
});

test("watchlist startup defers the map renderer and basemap until search is opened", async (t) => {
  const h = await mount(t, "#/watchlist");
  h.loads[0].resolve(dataset());
  await h.flush();
  await h.resolveQuery(h.clients[0].jobs[0], ["1"]);
  assert.equal(h.window.appTest.mapImports, 0);
  assert.equal(h.maps.length, 0);
  assert.equal(h.window.appTest.basemapWarmups, 0);

  h.root.querySelector('nav [aria-label="Restaurants"]').click();
  await h.flush();
  assert.equal(h.window.appTest.mapImports, 1);
  assert.equal(h.maps.length, 1);
  assert.ok(h.window.appTest.basemapWarmups > 0);
  h.root.querySelector('nav [aria-label="Restaurants"]').click();
  await h.flush();
  assert.equal(h.window.appTest.mapImports, 1);
});

test("search mounts a visible map before summary or query completion and retains it", async (t) => {
  const h = await mount(t);
  await h.flush();
  const map = h.map();
  assert.ok(map);
  assert.equal(map.props.result, null);
  assert.equal(map.props.explorer, null);
  assert.equal(map.props.dataReady, false);
  assert.equal(h.root.querySelector(".workspace").hidden, false);
  assert.equal(h.clients.length, 0);
  await h.boot(dataset(2));
  assert.equal(h.map(), map);
  assert.equal(map.destroyed, false);
  assert.equal(map.props.dataReady, true);
  assert.equal(map.props.restaurants.size, 2);
  assert.equal(h.maps.length, 1);
});

test("leaving search before data destroys its early map and never mounts in watchlist", async (t) => {
  const h = await mount(t);
  await h.flush();
  const early = h.map();
  h.root.querySelector('a[href="#/watchlist"]').click();
  await h.flush();
  assert.equal(early.destroyed, true);
  h.loads[0].resolve(dataset(2));
  await h.flush();
  await h.resolveQuery(h.clients[0].jobs[0], ["1", "2"]);
  assert.equal(h.maps.length, 1);
  assert.equal(h.root.querySelector(".search-page").hidden, true);
});

for (const [orientation, size] of [
  ["portrait", { width: 390, height: 844 }],
  ["landscape", { width: 932, height: 430 }],
]) {
  test(`mobile ${orientation} starts with the map and toggles results without resetting it`, async (t) => {
    const h = await mount(t, "#/search", [], size);
    await h.boot();
    const map = h.map();
    const historyLength = h.window.history.length;
    const queryCount = h.clients[0].jobs.length;
    assert.equal(h.results().hidden, true);
    assert.equal(h.results().id, "restaurant-results");
    assert.equal(
      h.resultIds().length,
      0,
      "collapsed results do not build hidden cards",
    );
    assert.equal(map.props.showResultsToggle, true);
    assert.equal(map.props.resultsVisible, false);
    assert.notEqual(h.window.document.activeElement, h.input());

    map.props.onToggleResults();
    assert.equal(h.results().hidden, false);
    assert.equal(
      h.resultIds().length,
      40,
      "opening results renders the first page",
    );
    assert.equal(map.props.resultsVisible, true);
    map.props.onToggleResults();
    assert.equal(h.results().hidden, true);
    assert.equal(map.props.resultsVisible, false);
    assert.equal(h.map(), map);
    assert.equal(h.maps.length, 1);
    assert.equal(h.window.history.length, historyLength);
    assert.equal(h.clients[0].jobs.length, queryCount);
  });
}

test("mobile typing reveals results immediately, including an unchanged query, without stealing focus", async (t) => {
  const h = await mount(t, "#/search", [], { width: 390, height: 844 });
  await h.boot();
  const query = h.search("pizza");
  assert.equal(h.results().hidden, false);
  assert.equal(h.results().getAttribute("aria-busy"), "true");
  assert.equal(h.map().props.resultsVisible, true);
  assert.equal(h.window.document.activeElement, h.input());
  await h.resolveQuery(query, ["1", "2"]);
  h.viewport();

  h.map().props.onToggleResults();
  assert.equal(h.results().hidden, true);
  const queryCount = h.clients[0].jobs.length;
  h.search("pizza");
  assert.equal(h.results().hidden, false);
  assert.equal(h.map().props.resultsVisible, true);
  assert.equal(h.clients[0].jobs.length, queryCount);
  assert.equal(h.window.document.activeElement, h.input());

  h.root.querySelector('[data-restaurant-id="1"]').click();
  const next = h.search("bagel");
  assert.equal(h.root.querySelector(".detail-pane").hidden, true);
  assert.equal(h.results().hidden, false);
  assert.equal(h.window.document.activeElement, h.input());
  await h.resolveQuery(next, ["2"]);
  h.viewport();
  assert.equal(h.window.document.activeElement, h.input());
});

test("a mobile search URL exposes its query results on arrival", async (t) => {
  const h = await mount(t, "#/search?q=pizza", [], {
    width: 390,
    height: 844,
  });
  await h.boot();
  assert.equal(h.input().value, "pizza");
  assert.equal(h.results().hidden, false);
  assert.equal(h.map().props.resultsVisible, true);
});

test("mobile map selection and Close preserve collapsed results and restore usable focus", async (t) => {
  const h = await mount(t, "#/search", [], { width: 390, height: 844 });
  await h.boot();
  h.map().props.onSelect("1");
  assert.equal(h.root.querySelector(".detail-pane").hidden, false);
  assert.equal(h.results().hidden, true);
  h.root.querySelector('[aria-label="Close restaurant details"]').click();
  await h.flush();
  h.viewport();
  assert.equal(h.root.querySelector(".detail-pane").hidden, true);
  assert.equal(h.results().hidden, true);
  assert.equal(h.map().props.resultsVisible, false);
  assert.equal(
    h.window.document.activeElement,
    h.root.querySelector(".map-results-toggle"),
  );

  h.map().props.onSelect("2");
  h.map().props.onToggleResults();
  await h.flush();
  h.viewport();
  assert.equal(h.root.querySelector(".detail-pane").hidden, true);
  assert.equal(h.results().hidden, false);
  assert.equal(h.map().props.resultsVisible, true);
});

test("mobile Back restores expanded results, list position and selected-card focus", async (t) => {
  const h = await mount(t, "#/search", [], { width: 390, height: 844 });
  await h.boot();
  h.map().props.onToggleResults();
  h.results().scrollTop = 137;
  h.root.querySelector('[data-restaurant-id="5"]').click();
  assert.equal(h.results().hidden, true);
  h.window.history.back();
  await h.flush();
  h.viewport();
  assert.equal(h.results().hidden, false);
  assert.equal(h.map().props.resultsVisible, true);
  assert.equal(h.results().scrollTop, 137);
  assert.equal(h.window.document.activeElement.dataset.restaurantId, "5");
});

test("resizing shows desktop results while retaining the mobile visibility preference", async (t) => {
  const h = await mount(t, "#/search", [], { width: 390, height: 844 });
  await h.boot();
  const map = h.map();
  h.window.happyDOM.setWindowSize({ width: 1440, height: 900 });
  assert.equal(h.results().hidden, false);
  assert.equal(map.props.showResultsToggle, false);
  assert.equal(map.props.resultsVisible, true);
  h.window.happyDOM.setWindowSize({ width: 932, height: 430 });
  assert.equal(h.results().hidden, true);
  assert.equal(map.props.showResultsToggle, true);
  assert.equal(map.props.resultsVisible, false);
  map.props.onToggleResults();
  h.window.happyDOM.setWindowSize({ width: 1440, height: 900 });
  h.window.happyDOM.setWindowSize({ width: 390, height: 844 });
  assert.equal(h.results().hidden, false);
  assert.equal(map.props.resultsVisible, true);
  assert.equal(h.map(), map);
  assert.equal(h.maps.length, 1);
});

test("latest search wins over older responses and errors", async (t) => {
  const h = await mount(t);
  await h.boot();
  const first = h.search("pizza");
  const second = h.search("bagel");
  const latest = h.search("taco");
  assert.equal(h.results().getAttribute("aria-busy"), "true");
  await h.resolveQuery(latest, ["3"]);
  h.viewport();
  await h.resolveQuery(first, ["1"]);
  second.reject(new Error("Obsolete search failure"));
  await h.flush();
  assert.deepEqual(h.resultIds(), ["3"]);
  assert.equal(h.results().getAttribute("aria-busy"), "false");
  assert.equal(h.root.textContent.includes("Obsolete search failure"), false);
  assert.equal(h.input().value, "taco");
});

test("editing search exits details without stealing input focus", async (t) => {
  const h = await mount(t);
  await h.boot();
  h.root.querySelector('[data-restaurant-id="1"]').click();
  assert.equal(h.window.document.activeElement.tagName, "H2");
  const job = h.search("new query");
  h.input().setSelectionRange(4, 4);
  assert.equal(h.root.querySelector(".detail-pane").hidden, true);
  await h.resolveQuery(job, ["2"]);
  h.viewport();
  assert.equal(h.window.document.activeElement, h.input());
  assert.equal(h.input().selectionStart, 4);
  assert.equal(
    new URLSearchParams(h.window.location.hash.split("?")[1]).get("restaurant"),
    null,
  );
});

test("whole result cards open from their address and show number-only watch counts", async (t) => {
  const h = await mount(t, "#/search", ["01A", "02B"]);
  const data = dataset(2);
  data.restaurants[0].latest_codes = "01A,02B";
  await h.boot(data);
  const card = h.root.querySelector('[data-restaurant-id="1"]');
  assert.equal(card.tagName, "A");
  assert.match(card.href, /restaurant=1/);
  const avatar = card.querySelector('[data-variant="avatar"]');
  assert.equal(avatar.getAttribute("aria-label"), "Grade A");
  assert.equal(avatar.querySelector("img").alt, "");
  assert.match(avatar.querySelector("img").src, /^data:image\/svg\+xml/);
  const badge = card.querySelector(".grade-watch-count");
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, "2");
  assert.equal(badge.getAttribute("aria-label"), "2 watched violations");
  assert.equal(
    h.root.querySelector('[data-restaurant-id="2"] .grade-watch-count').hidden,
    true,
  );
  const address = card.querySelector(".restaurant-card-text > .text-light");
  const modified = new h.window.MouseEvent("click", {
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  address.dispatchEvent(modified);
  assert.equal(modified.defaultPrevented, false);
  const click = new h.window.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
  });
  address.dispatchEvent(click);
  assert.equal(click.defaultPrevented, true);
  assert.match(h.window.location.hash, /restaurant=1/);
  assert.equal(h.root.querySelector(".detail-pane").hidden, false);
});

test("stale map viewports cannot replace results for another camera or query", async (t) => {
  const h = await mount(t);
  await h.boot(dataset(3));
  const oldProps = h.map().props;
  h.root.querySelector('[data-restaurant-id="1"]').click();
  oldProps.onViewport(
    {
      revision: oldProps.result.revision,
      ids: ["3"],
      visibleMapped: 1,
      features: [],
    },
    oldProps.cameraRequest.key,
  );
  assert.deepEqual(h.resultIds(), ["1", "2", "3"]);
  const job = h.search("new query");
  await h.resolveQuery(job, ["2"]);
  const key = h.map().props.cameraRequest.key;
  oldProps.onViewport(
    {
      revision: oldProps.result.revision,
      ids: ["3"],
      visibleMapped: 1,
      features: [],
    },
    key,
  );
  assert.deepEqual(h.resultIds(), ["2"]);
});

test("Back and Close restore the saved camera, expanded list, scroll and result focus", async (t) => {
  const h = await mount(t);
  await h.boot();
  h.button("Show more · 50 remaining").click();
  assert.equal(h.resultIds().length, 80);
  h.results().scrollTop = 437;
  const overview = { lat: 40.72, lon: -73.98, zoom: 12 };
  h.map().props.onCamera(overview);
  h.root.querySelector('[data-restaurant-id="55"]').click();
  h.map().props.onCamera({ lat: 40.75, lon: -73.95, zoom: 17 });
  h.map().props.onSelect("60");
  assert.match(h.window.location.hash, /restaurant=60/);
  h.window.history.back();
  await h.flush();
  assert.match(h.window.location.hash, /restaurant=55/);
  h.viewport();
  h.root.querySelector('[aria-label="Close restaurant details"]').click();
  await h.flush();
  h.viewport();
  assert.equal(h.window.location.hash, "#/search");
  assert.deepEqual({ ...h.map().props.cameraRequest.view }, overview);
  assert.equal(h.resultIds().length, 80);
  assert.equal(h.results().scrollTop, 437);
  assert.equal(h.window.document.activeElement.dataset.restaurantId, "55");
});

test("watchlist disposes the hidden map and Back remounts the saved view", async (t) => {
  const h = await mount(t);
  await h.boot();
  const overview = { lat: 40.71, lon: -73.97, zoom: 11 };
  h.map().props.onCamera(overview);
  const oldMap = h.map();
  const job = h.search("pizza");
  h.root.querySelector('nav a[href="#/watchlist"]').click();
  assert.equal(oldMap.destroyed, true);
  const count = h.maps.length;
  await h.resolveQuery(job, ["1", "2"]);
  assert.equal(
    h.maps.length,
    count,
    "finishing a query while hidden must not remount the map",
  );
  h.window.history.back();
  await h.flush();
  assert.equal(h.maps.length, count + 1);
  assert.deepEqual({ ...h.map().props.cameraRequest.view }, overview);
  h.viewport();
  assert.deepEqual(h.resultIds(), ["1", "2"]);
});

test("failed data loads can retry and expose usable search results", async (t) => {
  const h = await mount(t, "#/search?restaurant=2");
  assert.equal(h.loads[0].restaurantId, "2");
  h.loads[0].reject(new Error("Connection interrupted"));
  await h.flush();
  const error = [...h.root.querySelectorAll('[role="alert"]')].find((node) =>
    node.textContent.includes("Connection interrupted"),
  );
  assert.ok(error && !error.hidden);
  h.button("Retry").click();
  assert.equal(h.loads.length, 2);
  await h.boot(dataset(3));
  assert.deepEqual(h.resultIds(), ["1", "2", "3"]);
  assert.equal(h.window.document.activeElement.textContent, "Restaurant 2");
  assert.equal(
    h.root
      .querySelector('menu[aria-label="Filter by cuisine"]')
      .querySelectorAll("[data-value]").length,
    2,
  );
});

test("search retry replaces the failed worker and keeps the map without accepting its late response", async (t) => {
  const h = await mount(t);
  await h.boot();
  const oldClient = h.clients[0];
  const oldMap = h.map();
  const stale = h.search("old");
  const failed = h.search("retry me");
  failed.reject(new Error("Worker stopped"));
  await h.flush();
  assert.equal(h.results().getAttribute("aria-busy"), "false");
  h.button("Retry search").click();
  assert.equal(oldClient.disposed, true);
  assert.equal(oldMap.destroyed, false);
  assert.equal(h.map(), oldMap);
  const retry = h.clients.at(-1).jobs[0];
  assert.equal(retry.criteria.search, "retry me");
  await h.resolveQuery(retry, ["2"]);
  h.viewport();
  await h.resolveQuery(stale, ["1"]);
  assert.deepEqual(h.resultIds(), ["2"]);
  assert.equal(h.button("Retry search").closest('[role="alert"]').hidden, true);
});

test("disposing during a pending load prevents late mounting", async (t) => {
  const h = await mount(t);
  h.app.destroy();
  h.loads[0].resolve(dataset());
  await h.flush();
  assert.equal(h.root.childElementCount, 0);
  assert.equal(h.clients.length, 0);
  assert.equal(h.maps.length, 0);
});

test("one reset action clears active filters while preserving the query", async (t) => {
  const h = await mount(
    t,
    "#/search?q=pizza&borough=Queens&cuisine=Pizza&grade=A",
  );
  await h.boot(dataset(2));
  assert.equal(
    h.root.querySelectorAll('[aria-label="Reset filters"]').length,
    1,
  );
  assert.equal(h.root.querySelector("menu .dropdown-footer"), null);
  const reset = h.root.querySelector('[aria-label="Reset filters"]');
  assert.equal(reset.hidden, false);
  reset.click();
  assert.equal(reset.hidden, true);
  const job = h.clients.at(-1).jobs.at(-1);
  assert.equal(h.input().value, "pizza");
  assert.equal(job.criteria.search, "pizza");
  for (const key of ["borough", "cuisine", "grade", "watchFilter"])
    assert.equal(job.criteria[key], null);
  const filters = h.root.querySelector('[aria-controls="restaurant-filters"]');
  assert.equal(filters.textContent, "");
  assert.equal(filters.getAttribute("aria-label"), "Filters");
  assert.ok(filters.querySelector("svg.feather-filter"));
  await h.resolveQuery(job, []);
  h.viewport();
  assert.equal(
    h.results().querySelector("button"),
    null,
    "query-only empty results do not offer a redundant reset",
  );
  h.root.querySelector('[aria-label="Clear restaurant search"]').click();
  assert.equal(h.input().value, "");
  assert.equal(h.clients.at(-1).jobs.at(-1).criteria.search, "");
});

test("map import yields before creating GL while retaining one pending import", async (t) => {
  const h = await mount(t, "#/search", [], {}, { delayMapYield: true });
  await h.flush();
  assert.equal(h.window.appTest.mapImports, 1);
  assert.equal(h.mapYields.length, 1);
  assert.equal(h.maps.length, 0);
  h.mapYields[0].resolve();
  await h.flush();
  assert.equal(h.maps.length, 1);
  assert.equal(h.map().props.dataReady, false);
});

test("leaving search during map yield caches the module without mounting in watchlist", async (t) => {
  const h = await mount(t, "#/search", [], {}, { delayMapYield: true });
  await h.flush();
  h.root.querySelector('a[href="#/watchlist"]').click();
  h.mapYields[0].resolve();
  await h.flush();
  assert.equal(h.maps.length, 0);
  h.root.querySelector('nav [aria-label="Restaurants"]').click();
  await h.flush();
  assert.equal(h.maps.length, 1);
  assert.equal(h.window.appTest.mapImports, 1);
  assert.equal(h.mapYields.length, 1);
});

test("disposing while map import yields prevents late construction", async (t) => {
  const h = await mount(t, "#/search", [], {}, { delayMapYield: true });
  await h.flush();
  h.app.destroy();
  h.mapYields[0].resolve();
  await h.flush();
  assert.equal(h.maps.length, 0);
  assert.equal(h.root.childElementCount, 0);
});
