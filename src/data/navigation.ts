export type SearchState = {
  query: string;
  borough: string | null;
  cuisine: string | null;
  grade: string | null;
  watchFilter: string | null;
};

export type MapCamera = { lat: number; lon: number; zoom: number };
type SearchContext = {
  camera: MapCamera | null;
  limit: number;
  scrollTop: number;
};
export type NavigationEntry = SearchContext & {
  key: string;
  view: "search" | "watchlist";
  id: string | null;
  search: SearchState;
  detailDepth: number;
  searchContext: SearchContext | null;
};
type SearchSnapshot = SearchContext & { search: SearchState };
type StoredEntry = NavigationEntry & {
  // A direct restaurant URL has no earlier search entry to navigate back to.
  directRoot: boolean;
  rootKey: string;
  lastSearch: SearchSnapshot;
};
type RuntimePatch = Partial<SearchContext>;
type Route = Pick<NavigationEntry, "view" | "id" | "search">;

const STATE_KEY = "nyc-grades-navigation";
const emptySearch: SearchState = {
  query: "",
  borough: null,
  cuisine: null,
  grade: null,
  watchFilter: null,
};
const defaultContext: SearchContext = {
  camera: null,
  limit: 40,
  scrollTop: 0,
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown, max = 200): string | null {
  return typeof value === "string" && value.length ? value.slice(0, max) : null;
}
function searchState(value: unknown): SearchState {
  const input = record(value);
  return {
    query: text(input.query, 2000) || "",
    borough: text(input.borough),
    cuisine: text(input.cuisine),
    grade: text(input.grade),
    watchFilter: text(input.watchFilter),
  };
}
function camera(value: unknown): MapCamera | null {
  const input = record(value);
  const { lat, lon, zoom } = input;
  return typeof lat === "number" &&
    Number.isFinite(lat) &&
    Math.abs(lat) <= 90 &&
    typeof lon === "number" &&
    Number.isFinite(lon) &&
    Math.abs(lon) <= 180 &&
    typeof zoom === "number" &&
    Number.isFinite(zoom) &&
    zoom >= 0 &&
    zoom <= 22
    ? { lat, lon, zoom }
    : null;
}
function bounded(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;
}
function context(value: unknown): SearchContext {
  const input = record(value);
  return {
    camera: camera(input.camera),
    limit: bounded(input.limit, 40, 40, 1_000_000),
    scrollTop: bounded(input.scrollTop, 0, 0, 10_000_000),
  };
}
function routeFromHash(hash: string): Route | null {
  const [path, ...rest] = hash.replace(/^#/, "").split("?");
  if (!["", "/", "/search", "/watchlist"].includes(path)) return null;
  const params = new URLSearchParams(rest.join("?"));
  const view = path === "/watchlist" ? "watchlist" : "search";
  return {
    view,
    id: view === "search" ? text(params.get("restaurant")) : null,
    search: searchState({
      query: params.get("q"),
      borough: params.get("borough"),
      cuisine: params.get("cuisine"),
      grade: params.get("grade"),
      watchFilter: params.get("watch"),
    }),
  };
}
function hashFor(entry: Route) {
  const params = new URLSearchParams();
  if (entry.id) params.set("restaurant", entry.id);
  const { query, borough, cuisine, grade, watchFilter } = entry.search;
  for (const [key, value] of [
    ["q", query],
    ["borough", borough],
    ["cuisine", cuisine],
    ["grade", grade],
    ["watch", watchFilter],
  ]) {
    if (value) params.set(key!, value);
  }
  const queryString = params.toString();
  return `#/${entry.view}${queryString ? `?${queryString}` : ""}`;
}
function restore(state: unknown, route: Route): StoredEntry | null {
  const tagged = record(record(state)[STATE_KEY]);
  const input = record(tagged.entry);
  const key = text(input.key);
  const storedRoute: Route = {
    view: input.view === "watchlist" ? "watchlist" : "search",
    id: text(input.id),
    search: searchState(input.search),
  };
  // A copied/stale history object must not override a manually edited URL.
  if (tagged.version !== 1 || !key || hashFor(storedRoute) !== hashFor(route))
    return null;
  const value = context(input);
  const snapshot = record(input.lastSearch);
  const searchContext = input.searchContext
    ? context(input.searchContext)
    : null;
  return {
    ...value,
    ...route,
    key,
    detailDepth: route.id ? bounded(input.detailDepth, 0, 0, 100_000) : 0,
    searchContext: route.id ? searchContext || { ...defaultContext } : null,
    directRoot: route.id ? input.directRoot === true : false,
    rootKey: text(input.rootKey) || key,
    lastSearch: {
      ...context(snapshot),
      search: searchState(snapshot.search || route.search),
    },
  };
}

/** Browser history owns navigation; camera/list updates enrich its current entry. */
export function createNavigation(browser: Window) {
  let sequence = 0;
  const key = () =>
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${++sequence}`;
  const listeners = new Set<(entry: NavigationEntry) => void>();
  let disposed = false;
  let closing: { rootKey: string; directRoot: boolean } | null = null;

  function fresh(route: Route): StoredEntry {
    const entryKey = key();
    return {
      ...defaultContext,
      ...route,
      key: entryKey,
      detailDepth: 0,
      searchContext: route.id ? { ...defaultContext } : null,
      directRoot: !!route.id,
      rootKey: entryKey,
      lastSearch: { ...defaultContext, search: route.search },
    };
  }
  const initial = routeFromHash(browser.location.hash) || {
    view: "search" as const,
    id: null,
    search: { ...emptySearch },
  };
  let entry = restore(browser.history.state, initial) || fresh(initial);

  function write(next: StoredEntry, push: boolean, notify = true) {
    if (disposed) return;
    const state = {
      ...record(browser.history.state),
      [STATE_KEY]: { version: 1, entry: next },
    };
    browser.history[push ? "pushState" : "replaceState"](
      state,
      "",
      hashFor(next),
    );
    entry = next;
    if (notify) listeners.forEach((listener) => listener(entry));
  }
  function searchEntry(
    snapshot: SearchSnapshot,
    entryKey = key(),
  ): StoredEntry {
    return {
      ...snapshot,
      key: entryKey,
      view: "search",
      id: null,
      detailDepth: 0,
      searchContext: null,
      directRoot: false,
      rootKey: entryKey,
      lastSearch: snapshot,
    };
  }
  function currentSearch(): SearchSnapshot {
    return entry.view === "search" && !entry.id
      ? { ...context(entry), search: entry.search }
      : entry.lastSearch;
  }
  function onHistory() {
    if (disposed) return;
    const route = routeFromHash(browser.location.hash);
    // Leave unrelated fragment navigation and its history state alone.
    if (!route) {
      closing = null;
      return;
    }
    const restored = restore(browser.history.state, route);
    let next = restored || fresh(route);
    if (closing) {
      if (closing.directRoot && next.key === closing.rootKey) {
        // X from a chain rooted in a direct URL lands on that root, then turns
        // it into search. Back never accidentally leaves the app to close it.
        next = searchEntry(next.lastSearch);
        closing = null;
        write(next, false);
        return;
      }
      closing = null;
    }
    if (next.key === entry.key && hashFor(next) === hashFor(entry)) return;
    if (!restored) write(next, false);
    else {
      entry = next;
      listeners.forEach((listener) => listener(entry));
    }
  }
  write(entry, false, false);
  browser.addEventListener("popstate", onHistory);
  browser.addEventListener("hashchange", onHistory);

  function close() {
    if (disposed || closing || !entry.id) return;
    if (entry.detailDepth > 0) {
      closing = { rootKey: entry.rootKey, directRoot: entry.directRoot };
      browser.history.go(-entry.detailDepth);
    } else {
      write(searchEntry(entry.lastSearch), false);
    }
  }
  return {
    current: (): NavigationEntry => entry,
    subscribe(listener: (entry: NavigationEntry) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(patch: RuntimePatch) {
      if (disposed || closing) return;
      const next = { ...entry, ...context({ ...entry, ...patch }) };
      if (next.view === "search" && !next.id)
        next.lastSearch = { ...context(next), search: next.search };
      write(next, false, false);
    },
    select(id: string) {
      const selected = text(id);
      if (
        disposed ||
        closing ||
        !selected ||
        (entry.view === "search" && entry.id === selected)
      )
        return;
      const snapshot = currentSearch();
      const inSearch = entry.view === "search";
      const rootKey = inSearch ? (entry.id ? entry.rootKey : entry.key) : key();
      write(
        {
          ...entry,
          view: "search",
          id: selected,
          search: snapshot.search,
          key: inSearch ? key() : rootKey,
          camera: null,
          detailDepth: inSearch ? entry.detailDepth + 1 : 0,
          searchContext:
            entry.id && inSearch ? entry.searchContext : context(snapshot),
          directRoot: inSearch ? entry.directRoot : true,
          rootKey,
          lastSearch: snapshot,
        },
        true,
      );
    },
    changeSearch(patch: Partial<SearchState>) {
      if (disposed || closing) return;
      const snapshot = currentSearch();
      const search = searchState({ ...snapshot.search, ...patch });
      const inSearch = entry.view === "search" && !entry.id;
      if (inSearch && JSON.stringify(search) === JSON.stringify(entry.search))
        return;
      write(
        searchEntry(
          { ...snapshot, search, limit: 40, scrollTop: 0 },
          inSearch ? entry.key : key(),
        ),
        !inSearch,
      );
    },
    clearWatchFilter() {
      if (
        disposed ||
        closing ||
        (!entry.search.watchFilter && !entry.lastSearch.search.watchFilter)
      )
        return;
      write(
        {
          ...entry,
          search: { ...entry.search, watchFilter: null },
          lastSearch: {
            ...entry.lastSearch,
            search: { ...entry.lastSearch.search, watchFilter: null },
          },
        },
        false,
      );
    },
    close,
    navigate(view: NavigationEntry["view"]) {
      if (disposed || closing) return;
      if (view === "search" && entry.id) return close();
      if (view === entry.view) return;
      const snapshot = currentSearch();
      if (view === "search") write(searchEntry(snapshot), true);
      else {
        const next = searchEntry(snapshot);
        write({ ...next, view, lastSearch: snapshot }, true);
      }
    },
    dispose() {
      disposed = true;
      closing = null;
      listeners.clear();
      browser.removeEventListener("popstate", onHistory);
      browser.removeEventListener("hashchange", onHistory);
    },
  };
}
