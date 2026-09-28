import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const directory = await mkdtemp(path.join(tmpdir(), "nyc-navigation-"));
const source = await readFile(
  new URL("../src/data/navigation.ts", import.meta.url),
  "utf8",
);
const compiled = path.join(directory, "navigation.mjs");
await writeFile(
  compiled,
  ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText,
);
const { createNavigation } = await import(pathToFileURL(compiled).href);
await rm(directory, { recursive: true, force: true });

const overview = { lat: 40.72, lon: -73.98, zoom: 12 };
const restaurantA = { lat: 40.725, lon: -73.98, zoom: 17 };
const restaurantB = { lat: 40.755, lon: -73.94, zoom: 18 };
const otherArea = { lat: 40.6, lon: -74, zoom: 13 };

function fakeBrowser(hash = "", initialState = { unrelated: "retained" }) {
  const handlers = new Map();
  const entries = [
    { hash: "#outside-the-app", state: { outside: true } },
    { hash, state: initialState },
  ];
  let index = 1;
  const pending = [];
  const emit = (type) =>
    [...(handlers.get(type) || [])].forEach((fn) => fn({ type }));
  const browser = {
    location: {
      get hash() {
        return entries[index].hash;
      },
    },
    history: {
      get state() {
        return structuredClone(entries[index].state);
      },
      get length() {
        return entries.length;
      },
      pushState(state, _, hash) {
        entries.splice(index + 1);
        entries.push({ hash, state: structuredClone(state) });
        index++;
      },
      replaceState(state, _, hash) {
        entries[index] = { hash, state: structuredClone(state) };
      },
      go(amount) {
        const next = index + amount;
        if (next < 0 || next >= entries.length) return;
        // Real browser history traversal is asynchronous and emits both events.
        pending.push(() => {
          index = next;
          emit("popstate");
          emit("hashchange");
        });
      },
      back() {
        this.go(-1);
      },
      forward() {
        this.go(1);
      },
    },
    addEventListener(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      handlers.get(type)?.delete(fn);
    },
    flush() {
      while (pending.length) pending.shift()();
    },
    externalHash(hash, state = this.history.state) {
      this.history.pushState(state, "", hash);
      emit("hashchange");
    },
    emit,
    entries,
    get index() {
      return index;
    },
  };
  return browser;
}

test("search A B browser navigation restores each camera and the search list exactly once", () => {
  const browser = fakeBrowser(),
    navigation = createNavigation(browser),
    notifications = [];
  navigation.subscribe((entry) => notifications.push(entry));
  navigation.changeSearch({ query: "taco bell", borough: "Queens" });
  navigation.update({ camera: overview, limit: 120, scrollTop: 735 });
  const search = navigation.current();
  const beforeUpdates = notifications.length;
  navigation.update({ camera: overview });
  assert.equal(
    notifications.length,
    beforeUpdates,
    "map movement never requests another camera change",
  );
  navigation.select("A");
  assert.equal(navigation.current().camera, null);
  assert.equal(navigation.current().detailDepth, 1);
  navigation.update({ camera: restaurantA });
  const a = navigation.current();
  navigation.select("B");
  navigation.update({ camera: restaurantB });
  assert.deepEqual(navigation.current().searchContext, {
    camera: overview,
    limit: 120,
    scrollTop: 735,
  });
  assert.equal(navigation.current().detailDepth, 2);
  const b = navigation.current();
  let count = notifications.length;
  browser.history.back();
  browser.flush();
  assert.equal(
    notifications.length,
    count + 1,
    "popstate/hashchange must be deduplicated",
  );
  assert.equal(navigation.current().key, a.key);
  assert.deepEqual(navigation.current().camera, restaurantA);
  browser.history.back();
  browser.flush();
  assert.deepEqual(navigation.current(), search);
  browser.history.forward();
  browser.flush();
  browser.history.forward();
  browser.flush();
  assert.deepEqual(navigation.current(), b);
  assert.equal(browser.history.state.unrelated, "retained");
});

test("X skips the selection chain without pushing a route that reopens details on Back", () => {
  const browser = fakeBrowser(),
    navigation = createNavigation(browser);
  navigation.update({ camera: overview, limit: 80, scrollTop: 99 });
  const search = navigation.current();
  navigation.select("A");
  navigation.select("B");
  navigation.select("A");
  assert.equal(navigation.current().detailDepth, 3);
  const length = browser.history.length;
  navigation.close();
  navigation.close();
  browser.flush();
  assert.equal(browser.history.length, length);
  assert.deepEqual(navigation.current(), search);
  browser.history.back();
  browser.flush();
  assert.equal(browser.location.hash, "#outside-the-app");
  assert.deepEqual(
    browser.history.state,
    { outside: true },
    "unrelated history is untouched",
  );
});

test("closing a direct restaurant URL replaces its own entry without leaving the site", () => {
  const browser = fakeBrowser(
      "#/search?restaurant=50002766&q=taco+bell&borough=Queens",
    ),
    navigation = createNavigation(browser);
  assert.equal(navigation.current().id, "50002766");
  assert.equal(navigation.current().search.query, "taco bell");
  const length = browser.history.length;
  const key = navigation.current().key;
  navigation.update({ camera: restaurantA });
  navigation.close();
  browser.flush();
  assert.equal(navigation.current().id, null);
  assert.notEqual(
    navigation.current().key,
    key,
    "closing is a new camera/navigation request",
  );
  assert.equal(browser.history.length, length);
  assert.equal(browser.index, 1);
  assert.equal(
    navigation.current().camera,
    null,
    "detail camera does not become the search overview",
  );
  assert.equal(browser.location.hash, "#/search?q=taco+bell&borough=Queens");
});

test("a direct-link chain supports Back and X replaces only its app root", () => {
  const browser = fakeBrowser("#/search?restaurant=A"),
    navigation = createNavigation(browser);
  const rootKey = navigation.current().key;
  navigation.update({ camera: restaurantA });
  navigation.select("B");
  navigation.update({ camera: restaurantB });
  browser.history.back();
  browser.flush();
  assert.equal(navigation.current().id, "A");
  assert.deepEqual(navigation.current().camera, restaurantA);
  browser.history.forward();
  browser.flush();
  navigation.close();
  browser.flush();
  assert.equal(navigation.current().id, null);
  assert.notEqual(navigation.current().key, rootKey);
  assert.equal(browser.index, 1);
  assert.equal(browser.entries[0].hash, "#outside-the-app");
  browser.history.forward();
  browser.flush();
  assert.equal(navigation.current().id, "B");
  navigation.close();
  browser.flush();
  assert.equal(navigation.current().id, null);
  assert.equal(browser.index, 1);
});

test("search edits replace only the active search, preserve its camera, and reset the list", () => {
  const browser = fakeBrowser(),
    navigation = createNavigation(browser);
  navigation.update({ camera: overview, limit: 160, scrollTop: 900 });
  const originalKey = navigation.current().key,
    length = browser.history.length;
  navigation.changeSearch({
    query: "pizza",
    cuisine: "Pizza",
    grade: "A",
    watchFilter: "flagged",
  });
  assert.equal(navigation.current().key, originalKey);
  assert.equal(browser.history.length, length);
  assert.deepEqual(navigation.current().camera, overview);
  assert.equal(navigation.current().limit, 40);
  assert.equal(navigation.current().scrollTop, 0);
  assert.match(
    browser.location.hash,
    /q=pizza&cuisine=Pizza&grade=A&watch=flagged/,
  );
  navigation.select("A");
  navigation.update({ camera: restaurantA });
  navigation.changeSearch({ query: "bagel", cuisine: null });
  assert.equal(navigation.current().id, null);
  assert.deepEqual(navigation.current().camera, overview);
  assert.notEqual(navigation.current().key, originalKey);
  browser.history.back();
  browser.flush();
  assert.equal(navigation.current().id, "A");
  assert.equal(navigation.current().search.query, "pizza");
  assert.deepEqual(navigation.current().camera, restaurantA);
});

test("watchlist navigation saves search criteria, camera and scroll instead of losing context", () => {
  const browser = fakeBrowser(),
    navigation = createNavigation(browser);
  navigation.changeSearch({ query: "pho" });
  navigation.update({ camera: otherArea, limit: 200, scrollTop: 502 });
  navigation.navigate("watchlist");
  assert.equal(navigation.current().view, "watchlist");
  navigation.navigate("search");
  assert.equal(navigation.current().search.query, "pho");
  assert.deepEqual(navigation.current().camera, otherArea);
  assert.equal(navigation.current().limit, 200);
  assert.equal(navigation.current().scrollTop, 502);
  navigation.select("A");
  navigation.update({ camera: restaurantA });
  navigation.navigate("watchlist");
  navigation.navigate("search");
  assert.equal(navigation.current().id, null);
  assert.deepEqual(navigation.current().camera, otherArea);
  navigation.select("B");
  navigation.navigate("search");
  browser.flush();
  assert.equal(
    navigation.current().id,
    null,
    "search navigation closes details via history",
  );
});

test("clearing watched codes removes the watch filter without navigating out of watchlist", () => {
  const browser = fakeBrowser(),
    navigation = createNavigation(browser);
  navigation.changeSearch({ query: "taco", watchFilter: "flagged" });
  navigation.update({ camera: overview, limit: 80, scrollTop: 200 });
  navigation.navigate("watchlist");
  const key = navigation.current().key,
    length = browser.history.length;
  navigation.clearWatchFilter();
  assert.equal(navigation.current().key, key);
  assert.equal(navigation.current().view, "watchlist");
  assert.equal(navigation.current().search.watchFilter, null);
  assert.equal(browser.history.length, length);
  navigation.navigate("search");
  assert.equal(navigation.current().search.watchFilter, null);
  assert.equal(navigation.current().search.query, "taco");
  assert.deepEqual(navigation.current().camera, overview);
  assert.equal(navigation.current().scrollTop, 200);
});

test("reloading preserves history snapshots; manually edited URL wins over copied history state", () => {
  const browser = fakeBrowser(),
    original = createNavigation(browser);
  original.changeSearch({ query: "x? y&z", borough: "Unknown" });
  original.update({ camera: overview, limit: 80, scrollTop: 41 });
  original.select("A");
  original.update({ camera: restaurantA });
  const entry = original.current();
  original.dispose();
  const navigation = createNavigation(browser);
  assert.deepEqual(navigation.current(), entry);
  navigation.close();
  browser.flush();
  assert.deepEqual(navigation.current().camera, overview);
  assert.equal(navigation.current().scrollTop, 41);
  browser.externalHash("#/search?restaurant=B&q=bagel");
  assert.equal(navigation.current().id, "B");
  assert.equal(navigation.current().search.query, "bagel");
  assert.equal(navigation.current().detailDepth, 0);
  navigation.close();
  browser.flush();
  assert.equal(navigation.current().id, null);
  assert.equal(navigation.current().search.query, "bagel");
});

test("repeat selection is inert and invalid runtime/persisted numbers are normalized", () => {
  const browser = fakeBrowser(),
    navigation = createNavigation(browser);
  navigation.update({
    camera: { lat: NaN, lon: -74, zoom: 500 },
    limit: -100,
    scrollTop: -20,
  });
  assert.deepEqual(
    {
      camera: navigation.current().camera,
      limit: navigation.current().limit,
      scrollTop: navigation.current().scrollTop,
    },
    { camera: null, limit: 40, scrollTop: 0 },
  );
  navigation.select("A");
  const length = browser.history.length,
    entry = navigation.current();
  navigation.select("A");
  navigation.select("");
  assert.equal(browser.history.length, length);
  assert.equal(navigation.current(), entry);
  navigation.dispose();
  const state = browser.history.state;
  state["nyc-grades-navigation"].entry.limit = Infinity;
  state["nyc-grades-navigation"].entry.scrollTop = 1e20;
  state["nyc-grades-navigation"].entry.camera = { lat: 0, lon: -200, zoom: 15 };
  browser.history.replaceState(state, "", browser.location.hash);
  const reloaded = createNavigation(browser);
  assert.equal(reloaded.current().limit, 40);
  assert.equal(reloaded.current().scrollTop, 10_000_000);
  assert.equal(reloaded.current().camera, null);
  let notifications = 0;
  const unsubscribe = reloaded.subscribe(() => notifications++);
  unsubscribe();
  reloaded.close();
  browser.flush();
  assert.equal(notifications, 0);
  reloaded.dispose();
  browser.externalHash("#/search?restaurant=C");
  assert.equal(reloaded.current().id, null);
});
