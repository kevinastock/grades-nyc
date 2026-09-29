import {
  disposePreparedExplorer,
  loadData,
  prefetchInspections,
  takeExplorer,
} from "./data/client";
import {
  ExplorerClient,
  type QueryResult,
  type ViewportResult,
} from "./data/explorer-client";
import { matchingCodes } from "./data/model.mjs";
import { locatedFirst } from "./data/map.mjs";
import { relativeDate, titleCase } from "./data/presentation.mjs";
import type { DataSet, Restaurant } from "./data/types";
import { createNavigation, type SearchState } from "./data/navigation";
import type { CameraRequest, MapProps } from "./components/RestaurantMap";
import { createRestaurantDetail } from "./components/RestaurantDetail";
import { createPreferences } from "./components/Preferences";
import {
  gradeAvatar,
  formatDate,
  icon,
  watchCountBadge,
  updateWatchCount,
  restaurantMeta,
} from "./components/shared";
import { createDropdown } from "./components/Dropdown";
import { el } from "./dom";
import { preloadBasemap } from "./data/map-resources";
import { yieldToBrowser } from "./scheduling";

const STORAGE_KEY = "nyc-grades-watchlist-v1";
const REPOSITORY_URL = "https://github.com/kevinastock/grades-nyc";
function readPreferences(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return Array.isArray(value?.selected)
      ? [
          ...new Set<string>(
            value.selected.filter((code: unknown) => typeof code === "string"),
          ),
        ]
      : [];
  } catch {
    return [];
  }
}

/** A persistent shell; each controller updates only the DOM it owns. */
export function createApp(root: HTMLElement) {
  const navigation = createNavigation(window);
  const lifecycle = new AbortController();
  const mobile = matchMedia(
    "(max-width: 850px), (max-width: 1000px) and (orientation: landscape)",
  );
  let route = navigation.current();
  let resultsExpanded = !!route.search.query;
  let cameraRequest: CameraRequest = { key: route.key, view: route.camera };
  let selected = readPreferences();
  let data: DataSet | null = null;
  let lookup = new Map<string, Restaurant>();
  let defaults: Restaurant[] = [];
  let explorer: ExplorerClient | undefined;
  let queryResult: QueryResult | null = null;
  let viewport: ViewportResult | null = null;
  let viewportKey = "";
  let querySequence = 0;
  let searchPending = false;
  let resultCriteria = "";
  let requestedCriteria = "";
  let searchError = "";
  let limit = route.limit;
  let pendingScroll: number | null = route.scrollTop;
  let pendingFocus: string | null = null;
  let scrollTimer: ReturnType<typeof setTimeout> | undefined;
  let dataAttempt = 0;
  let disposed = false;
  let detail: ReturnType<typeof createRestaurantDetail> | undefined;
  let detailId: string | null = null;
  let preferences: ReturnType<typeof createPreferences> | undefined;
  let map:
    | ReturnType<
        typeof import("./components/RestaurantMap").createRestaurantMap
      >
    | undefined;
  let mapModule: typeof import("./components/RestaurantMap") | undefined;
  let mapLoading: Promise<void> | undefined;
  const cards = new Map<
    string,
    { node: HTMLAnchorElement; warnings: HTMLElement }
  >();

  function navLink(text: string, view: "search" | "watchlist") {
    return el(
      "a",
      {
        href: `#/${view}`,
        class: "button ghost small",
        onclick: (event: MouseEvent) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
            return;
          event.preventDefault();
          rememberList();
          navigation.navigate(view);
        },
      },
      text,
    );
  }
  const home = navLink("NYC Inspection Grades", "search");
  const searchLink = navLink("Restaurants", "search");
  searchLink.setAttribute("aria-label", "Restaurants");
  searchLink.title = "Restaurants";
  const violationsLabel = () =>
    `Violations${selected.length ? ` (${selected.length})` : ""}`;
  const watchLink = navLink(violationsLabel(), "watchlist");
  const navigationLinks = el(
    "div",
    { class: "hstack gap-2" },
    searchLink,
    watchLink,
  );
  const navigationChoices = (): [string, string][] => [
    ["search", "Restaurants"],
    ["watchlist", violationsLabel()],
  ];
  const navigationMenu = createDropdown({
    label: "Main navigation menu",
    choices: navigationChoices(),
    value: route.view,
    onChange: (view) => {
      rememberList();
      navigation.navigate(view === "watchlist" ? "watchlist" : "search");
    },
  });
  navigationMenu.element.classList.add("navigation-dropdown");
  navigationMenu.trigger.className = "ghost icon small";
  navigationMenu.trigger.removeAttribute("aria-describedby");
  navigationMenu.trigger.replaceChildren(icon("menu"));
  const source = el("a", {
    class: "data-source text-light is-loading",
    href: "https://data.cityofnewyork.us/Health/DOHMH-New-York-City-Restaurant-Inspection-Results/43nn-pn8j",
    target: "_blank",
    rel: "noopener noreferrer",
  });
  const sourceAge = el("span", {}, "0 days ago");
  source.append(el("span", {}, "Updated "), sourceAge);
  const github = el(
    "a",
    {
      class: "button ghost icon small github-link",
      href: REPOSITORY_URL,
      "aria-label": "GitHub repository",
      title: "GitHub repository",
      target: "_blank",
      rel: "noopener noreferrer",
    },
    icon("github"),
  );
  const header = el(
    "header",
    { class: "site-header hstack" },
    home,
    el(
      "nav",
      { class: "hstack gap-2", "aria-label": "Main navigation" },
      navigationLinks,
      navigationMenu.element,
    ),
    el("div", { class: "header-meta hstack gap-2" }, source, github),
  );
  const storageWarning = el(
    "div",
    { role: "alert", "data-variant": "warning", hidden: true },
    "Watchlist changes could not be saved in this browser.",
  );
  const searchInput = el("input", {
    type: "search",
    placeholder: "Restaurant name or address",
    "aria-label": "Search restaurants by name or street",
    autocomplete: "off",
    oninput: () => changeSearch({ query: searchInput.value }),
  });
  const clearSearch = el(
    "button",
    {
      type: "button",
      class: "outline icon",
      "aria-label": "Clear restaurant search",
      title: "Clear search",
      onclick: () => {
        changeSearch({ query: "" });
        searchInput.focus();
      },
    },
    icon("x"),
  );
  const filterCount = el("span", {
    class: "filter-count",
    "aria-hidden": true,
  });
  const filtersToggle = el(
    "button",
    {
      type: "button",
      class: "outline icon filter-toggle",
      "aria-label": "Filters",
      title: "Filters",
      "aria-controls": "restaurant-filters",
      onclick: () => {
        filters.hidden = !filters.hidden;
        filtersToggle.setAttribute("aria-expanded", String(!filters.hidden));
      },
    },
    icon("filter"),
    filterCount,
  );
  function select(
    label: string,
    key: keyof SearchState,
    choices: [string, string][],
  ) {
    return createDropdown({
      label,
      choices,
      onChange: (value) => changeSearch({ [key]: value || null }),
    });
  }
  const borough = select("Filter by borough", "borough", [
    ["", "All boroughs"],
  ]);
  const cuisine = select("Filter by cuisine", "cuisine", [
    ["", "All cuisines"],
  ]);
  const grade = select("Filter by recorded grade", "grade", [
    ["", "Any grade"],
    ["A", "Grade A"],
    ["B", "Grade B"],
    ["C", "Grade C"],
    ["pending", "Pending"],
    ["none", "Ungraded"],
  ]);
  const watch = select("Filter by watched violations", "watchFilter", [
    ["", "Any watchlist status"],
    ["flagged", "Has watched violations"],
    ["clear", "No watched violations"],
  ]);
  const resetFilters = el(
    "button",
    {
      type: "button",
      class: "filter-reset ghost",
      "aria-label": "Reset filters",
      title: "Reset filters",
      hidden: true,
      onclick: () => {
        clearFilters();
        (mobile.matches ? filtersToggle : borough.trigger).focus();
      },
    },
    "Reset",
  );
  const filterActions = el(
    "div",
    { class: "filter-actions hstack gap-1" },
    filtersToggle,
  );
  const filters = el(
    "div",
    { id: "restaurant-filters", class: "filter-bar hstack gap-2" },
    borough.element,
    cuisine.element,
    grade.element,
    watch.element,
    resetFilters,
  );
  const toolbar = el(
    "section",
    { class: "search-toolbar vstack gap-2", "aria-label": "Find restaurants" },
    el(
      "div",
      { class: "search-row hstack gap-2" },
      el("fieldset", { class: "group" }, searchInput, clearSearch),
      filterActions,
    ),
    filters,
  );
  const loading = el("div", { class: "data-loading p-4", role: "status" });
  const searchWarning = el("div", {
    role: "alert",
    "data-variant": "error",
    hidden: true,
  });
  const unavailable = el("div", {
    role: "alert",
    "data-variant": "warning",
    hidden: true,
  });
  const results = el("section", {
    id: "restaurant-results",
    class: "results-list vstack gap-2",
    "aria-label": "Restaurant search results",
    "data-spinner": "small overlay",
    tabindex: -1,
  });
  const detailBody = el("div", { class: "detail-scroll" });
  const detailPane = el(
    "section",
    { class: "detail-pane", hidden: true },
    detailBody,
  );
  const mapHost = el(
    "section",
    { class: "explore-map", "aria-label": "Restaurant map" },
    el(
      "p",
      { class: "p-4", role: "status", "aria-busy": "true" },
      "Loading map…",
    ),
  );
  const workspace = el(
    "div",
    { class: "workspace", hidden: true },
    results,
    detailPane,
    mapHost,
  );
  const preferencesHost = el("section", {
    class: "preferences-main",
    hidden: true,
  });
  const searchPage = el(
    "div",
    { class: "search-page" },
    toolbar,
    searchWarning,
    unavailable,
    workspace,
  );
  const main = el(
    "main",
    { class: "app-main" },
    storageWarning,
    loading,
    searchPage,
    preferencesHost,
  );
  const app = el("div", { class: "app" }, header, main);
  root.replaceChildren(app);

  function renderLayout() {
    const hasDetail = workspace.classList.contains("has-selection");
    app.classList.toggle("has-detail", hasDetail);
    workspace.classList.toggle(
      "results-visible",
      resultsExpanded && !hasDetail,
    );
    results.hidden = mobile.matches && (hasDetail || !resultsExpanded);
  }
  function toggleResults() {
    resultsExpanded = route.id ? true : !resultsExpanded;
    if (route.id) navigation.close();
    renderLayout();
    renderResults();
    renderMap();
  }

  function clearFilters() {
    if (!activeFilterCount()) return;
    changeSearch({
      borough: null,
      cuisine: null,
      grade: null,
      watchFilter: null,
    });
  }
  function changeSearch(patch: Partial<SearchState>) {
    // Search edits keep keyboard focus on the input, even when leaving details.
    pendingFocus = null;
    detailId = null;
    if (patch.query !== undefined) {
      resultsExpanded = true;
      renderLayout();
      renderResults();
      renderMap();
    }
    navigation.changeSearch(patch);
  }
  function rememberList() {
    clearTimeout(scrollTimer);
    if (route.view === "search")
      navigation.update({ scrollTop: results.scrollTop, limit });
  }
  function selectRestaurant(id: string) {
    rememberList();
    navigation.select(id);
  }
  results.addEventListener("scroll", () => {
    if (pendingScroll !== null) return;
    const key = route.key;
    const scrollTop = results.scrollTop;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      if (navigation.current().key === key) navigation.update({ scrollTop });
    }, 150);
  });
  function criteria() {
    return {
      search: route.search.query.trim(),
      borough: route.search.borough,
      cuisine: route.search.cuisine,
      grade: route.search.grade,
      watchFilter: route.search.watchFilter,
      selected: route.search.watchFilter ? selected : [],
    };
  }
  function activeFilterCount() {
    return [
      route.search.borough,
      route.search.cuisine,
      route.search.grade,
      route.search.watchFilter,
    ].filter(Boolean).length;
  }
  function restoreList() {
    if (
      searchPending ||
      resultCriteria !== JSON.stringify(criteria()) ||
      viewportKey !== route.key ||
      viewport?.revision !== queryResult?.revision ||
      route.view !== "search"
    )
      return;
    if (pendingScroll !== null) {
      results.scrollTop = pendingScroll;
      pendingScroll = null;
    }
    if (pendingFocus && !route.id) {
      const target = results.hidden
        ? mapHost.querySelector<HTMLButtonElement>(".map-results-toggle")
        : cards.get(pendingFocus)?.node || results;
      target?.focus({
        preventScroll: true,
      });
      pendingFocus = null;
    }
  }
  const more = el("button", {
    type: "button",
    class: "outline w-100",
    onclick: () => {
      limit += 40;
      navigation.update({ limit });
      renderResults();
    },
  });
  const empty = el("div", { class: "p-4", role: "status" });
  function renderResults() {
    if (!data || route.view !== "search") return;
    if (results.hidden) {
      restoreList();
      return;
    }
    const ids =
      viewport?.revision === queryResult?.revision
        ? viewport?.ids
        : queryResult?.ids;
    // Worker results use this snapshot's IDs. Resolve only the displayed page,
    // not all 31,000 restaurants on every viewport update.
    const count = ids?.length ?? defaults.length;
    const visible = ids
      ? ids
          .slice(0, limit)
          .map((id) => lookup.get(id)!)
          .filter(Boolean)
      : defaults.slice(0, limit);
    const nodes: HTMLElement[] = [];
    const retained = new Set<string>();
    for (const restaurant of visible) {
      retained.add(restaurant.id);
      let card = cards.get(restaurant.id);
      if (!card) {
        const warnings = watchCountBadge();
        const node = el(
          "a",
          {
            href: restaurantURL(restaurant.id),
            class: "card restaurant-card unstyled",
            "data-restaurant-id": restaurant.id,
            onclick: (event: MouseEvent) => {
              if (
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              selectRestaurant(restaurant.id);
            },
          },
          el(
            "span",
            { class: "grade-avatar-wrap" },
            gradeAvatar(restaurant.grade),
            warnings,
          ),
          el(
            "span",
            { class: "restaurant-card-text vstack gap-1" },
            el("strong", {}, titleCase(restaurant.name)),
            el(
              "span",
              { class: "text-light" },
              `${titleCase(restaurant.address) || "Address unavailable"}, ${restaurant.borough}`,
            ),
            restaurantMeta(
              restaurant.cuisine,
              restaurant.latest_date
                ? el(
                    "time",
                    {
                      datetime: restaurant.latest_date,
                      title: `Inspected ${formatDate(restaurant.latest_date)}`,
                    },
                    relativeDate(restaurant.latest_date),
                  )
                : "Not yet inspected",
            ),
          ),
        );
        for (const event of ["mouseenter", "focus", "pointerdown"])
          node.addEventListener(event, () =>
            prefetchInspections(restaurant.id),
          );
        card = { node, warnings };
        cards.set(restaurant.id, card);
      }
      card.node.href = restaurantURL(restaurant.id);
      if (route.id === restaurant.id)
        card.node.setAttribute("aria-current", "true");
      else card.node.removeAttribute("aria-current");
      const matches = matchingCodes(restaurant, selected, "latest");
      updateWatchCount(card.warnings, matches);
      nodes.push(card.node);
    }
    for (const id of cards.keys()) if (!retained.has(id)) cards.delete(id);
    if (!count) {
      empty.replaceChildren(el("p", {}, "No matching restaurants."));
      if (activeFilterCount())
        empty.append(
          el(
            "button",
            { class: "outline", onclick: clearFilters },
            "Reset filters",
          ),
        );
      nodes.push(empty);
    }
    if (count > limit) {
      more.textContent = `Show more · ${(count - limit).toLocaleString()} remaining`;
      nodes.push(more);
    }
    // Move only changed rows; stable links preserve keyboard focus during updates.
    nodes.forEach((node, index) => {
      if (results.children[index] !== node)
        results.insertBefore(node, results.children[index] || null);
    });
    while (results.children.length > nodes.length)
      results.lastElementChild!.remove();
    restoreList();
  }
  function restaurantURL(id: string) {
    const params = new URLSearchParams(
      window.location.hash.split("?")[1] || "",
    );
    params.set("restaurant", id);
    return `#/search?${params}`;
  }
  function setSelected(next: string[]) {
    selected = [...new Set(next)];
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ selected }));
      storageWarning.hidden = true;
    } catch {
      storageWarning.hidden = false;
    }
    if (!selected.length) navigation.clearWatchFilter();
    renderRoute();
    runQuery();
  }
  function onWatchChange(code: string, watched: boolean) {
    setSelected(
      watched
        ? [...selected, code]
        : selected.filter((value) => value !== code),
    );
  }
  function renderDetail() {
    const restaurant = route.id ? lookup.get(route.id) : undefined;
    unavailable.hidden = !data || !route.id || !!restaurant;
    if (!unavailable.hidden)
      unavailable.replaceChildren(
        el("span", {}, `Restaurant ${route.id} is not in this snapshot.`),
        el(
          "button",
          {
            class: "ghost icon",
            "aria-label": "Close restaurant details",
            title: "Close restaurant details",
            onclick: () => navigation.close(),
          },
          icon("x"),
        ),
      );
    workspace.classList.toggle("has-selection", !!restaurant);
    detailPane.hidden = !restaurant;
    if (!restaurant) {
      if (detailId) pendingFocus = detailId;
      detail?.destroy();
      detail = undefined;
      detailId = null;
      detailBody.replaceChildren();
      return;
    }
    const props = {
      restaurant,
      selected,
      onWatchChange,
      onClose: () => navigation.close(),
    };
    if (detail && detailId === restaurant.id) {
      detail.update(props);
      return;
    }
    detail?.destroy();
    detailId = restaurant.id;
    pendingFocus = null;
    detailPane.setAttribute(
      "aria-label",
      `${titleCase(restaurant.name)} details`,
    );
    detail = createRestaurantDetail(detailBody, props);
    detailBody.scrollTop = 0;
    if (mobile.matches) window.scrollTo(0, 0);
    detailBody.querySelector("h2")?.focus({ preventScroll: true });
  }
  function renderRoute() {
    const searching = route.view === "search";
    if (searching) preloadMap();
    else {
      map?.destroy();
      map = undefined;
    }
    searchPage.hidden = !searching;
    preferencesHost.hidden = searching || !data;
    searchLink.toggleAttribute("aria-current", searching);
    watchLink.toggleAttribute("aria-current", !searching);
    searchLink.classList.toggle("ghost", !searching);
    watchLink.classList.toggle("ghost", searching);
    (searching ? searchLink : watchLink).setAttribute("aria-current", "page");
    navigationMenu.value = route.view;
    if (watchLink.textContent !== violationsLabel()) {
      watchLink.textContent = violationsLabel();
      navigationMenu.setChoices(navigationChoices());
    }
    if (searchInput.value !== route.search.query)
      searchInput.value = route.search.query;
    clearSearch.hidden = !route.search.query;
    for (const [input, value] of [
      [borough, route.search.borough],
      [cuisine, route.search.cuisine],
      [grade, route.search.grade],
      [watch, route.search.watchFilter],
    ] as const)
      input.value = value || "";
    watch.disabled = !selected.length;
    const count = activeFilterCount();
    resetFilters.hidden = !count;
    filterCount.textContent = count ? String(count) : "";
    filterCount.hidden = !count;
    const filtersLabel = `Filters${count ? ` (${count} active)` : ""}`;
    filtersToggle.setAttribute("aria-label", filtersLabel);
    filtersToggle.title = filtersLabel;
    workspace.hidden = !searching;
    renderDetail();
    renderLayout();
    if (data && !searching) {
      const props = {
        violations: data.violations,
        selected,
        onChange: setSelected,
      };
      if (preferences) preferences.update(props);
      else preferences = createPreferences(preferencesHost, props);
    }
    renderResults();
    renderMap();
  }
  function showSearchError(error: unknown) {
    searchError = error instanceof Error ? error.message : String(error);
    searchWarning.hidden = false;
    searchWarning.replaceChildren(
      el("strong", {}, "Search unavailable. "),
      el("span", {}, searchError),
      el(
        "button",
        { class: "outline small", onclick: startExplorer },
        "Retry search",
      ),
    );
  }
  function mapProps(): MapProps {
    return {
      explorer: explorer ?? null,
      result: queryResult,
      dataReady: !!data,
      fitToResults: !!route.search.query.trim() || !!activeFilterCount(),
      restaurants: lookup,
      selectedId: route.id,
      cameraRequest,
      showResultsToggle: mobile.matches,
      resultsVisible: !results.hidden,
      onToggleResults: toggleResults,
      onCamera: (camera) => navigation.update({ camera }),
      onSelect: selectRestaurant,
      onViewport: (value, key) => {
        if (
          disposed ||
          value.revision !== queryResult?.revision ||
          key !== navigation.current().key
        )
          return;
        viewport = value;
        viewportKey = key;
        renderResults();
        renderMap();
      },
      onError: showSearchError,
    };
  }
  function preloadMap() {
    if (disposed || route.view !== "search") return;
    preloadBasemap();
    mapLoading ??= import("./components/RestaurantMap")
      .then(async (module) => {
        if (disposed) return;
        // Module evaluation and GL construction can each occupy a full task.
        await yieldToBrowser();
        if (disposed) return;
        mapModule = module;
        renderMap();
      })
      .catch((error) => {
        mapLoading = undefined;
        if (!disposed) showSearchError(error);
      });
  }
  function renderMap() {
    if (route.view !== "search" || disposed) return;
    if (!mapModule) {
      preloadMap();
      return;
    }
    if (map) map.update(mapProps());
    else map = mapModule.createRestaurantMap(mapHost, mapProps());
  }
  function runQuery() {
    if (!explorer) return;
    const next = criteria();
    const key = JSON.stringify(next);
    if (requestedCriteria === key) return;
    requestedCriteria = key;
    const sequence = ++querySequence;
    searchPending = true;
    results.setAttribute("aria-busy", "true");
    searchWarning.hidden = true;
    renderMap();
    void explorer
      .query(sequence, next)
      .then((value) => {
        if (disposed || sequence !== querySequence || !value) return;
        queryResult = value;
        resultCriteria = key;
        viewport = null;
        searchPending = false;
        results.setAttribute("aria-busy", "false");
        renderResults();
        renderMap();
      })
      .catch((error) => {
        if (disposed || sequence !== querySequence) return;
        searchPending = false;
        results.setAttribute("aria-busy", "false");
        showSearchError(error);
        renderMap();
      });
  }
  function startExplorer() {
    querySequence++;
    explorer?.dispose();
    explorer = undefined;
    queryResult = null;
    viewport = null;
    requestedCriteria = "";
    searchWarning.hidden = true;
    preloadMap();
    try {
      explorer = takeExplorer(data!.restaurants);
      runQuery();
    } catch (error) {
      showSearchError(error);
    }
  }
  async function load() {
    const attempt = ++dataAttempt;
    loading.hidden = false;
    loading.setAttribute("role", "status");
    loading.removeAttribute("data-variant");
    loading.setAttribute("aria-busy", "true");
    try {
      const value = await loadData((message) => {
        loading.textContent = message;
      }, route.id);
      if (disposed || attempt !== dataAttempt) return;
      data = value;
      lookup = new Map(
        data.restaurants.map((restaurant) => [restaurant.id, restaurant]),
      );
      defaults = locatedFirst(data.restaurants);
      for (const [input, options] of [
        [borough, data.boroughs],
        [cuisine, data.cuisines],
      ] as const)
        input.setChoices([
          ["", input === borough ? "All boroughs" : "All cuisines"],
          ...options.map((name): [string, string] => [name, name]),
        ]);
      sourceAge.textContent = relativeDate(data.snapshot);
      source.classList.remove("is-loading");
      source.title = `NYC data last updated ${formatDate(data.snapshot)}`;
      loading.hidden = true;
      renderRoute();
      requestAnimationFrame(() => {
        if (!disposed) startExplorer();
      });
    } catch (error) {
      if (disposed || attempt !== dataAttempt) return;
      loading.removeAttribute("aria-busy");
      loading.setAttribute("role", "alert");
      loading.setAttribute("data-variant", "error");
      loading.replaceChildren(
        el("p", {}, error instanceof Error ? error.message : String(error)),
        el("button", { onclick: load }, "Retry"),
      );
    }
  }
  const unsubscribe = navigation.subscribe((entry) => {
    const keyChanged = route.key !== entry.key;
    const searchChanged =
      JSON.stringify(route.search) !== JSON.stringify(entry.search);
    route = entry;
    if (keyChanged) cameraRequest = { key: route.key, view: route.camera };
    if (keyChanged || searchChanged) {
      clearTimeout(scrollTimer);
      pendingScroll = route.scrollTop;
      limit = route.limit;
    }
    // Mark changed criteria pending before trying to restore a saved list.
    runQuery();
    renderRoute();
  });
  function resizeFilters() {
    const menu =
      navigationMenu.element.querySelector<HTMLElement>("[popover]")!;
    if (menu.matches(":popover-open")) menu.hidePopover();
    navigationLinks.hidden = mobile.matches;
    navigationMenu.element.hidden = !mobile.matches;
    (mobile.matches ? filterActions : filters).append(resetFilters);
    filtersToggle.hidden = !mobile.matches;
    filters.hidden = mobile.matches;
    filtersToggle.setAttribute("aria-expanded", String(!filters.hidden));
    renderLayout();
    renderResults();
    renderMap();
  }
  mobile.addEventListener("change", resizeFilters, {
    signal: lifecycle.signal,
  });
  window.addEventListener(
    "keydown",
    (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        rememberList();
        navigation.navigate("search");
        requestAnimationFrame(() => searchInput.focus());
      } else if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        route.id &&
        !document.querySelector(":popover-open, dialog[open]")
      ) {
        event.preventDefault();
        navigation.close();
      }
    },
    { signal: lifecycle.signal },
  );
  registerSearchTool(changeSearch, lifecycle.signal);
  if (!selected.length) navigation.clearWatchFilter();
  resizeFilters();
  renderRoute();
  if (!mobile.matches && !route.id && route.view === "search")
    searchInput.focus();
  void load();
  return {
    destroy() {
      disposed = true;
      dataAttempt++;
      querySequence++;
      clearTimeout(scrollTimer);
      lifecycle.abort();
      unsubscribe();
      navigation.dispose();
      map?.destroy();
      explorer?.dispose();
      disposePreparedExplorer();
      detail?.destroy();
      preferences?.destroy();
      for (const dropdown of [navigationMenu, borough, cuisine, grade, watch])
        dropdown.destroy();
      root.replaceChildren();
    },
  };
}

function registerSearchTool(
  changeSearch: (patch: Partial<SearchState>) => void,
  signal: AbortSignal,
) {
  const context = (
    document as Document & {
      modelContext?: {
        registerTool: (
          tool: unknown,
          options: { signal: AbortSignal },
        ) => unknown;
      };
    }
  ).modelContext;
  if (!context?.registerTool) return;
  try {
    Promise.resolve(
      context.registerTool(
        {
          name: "search_restaurants",
          title: "Search NYC restaurants",
          description:
            "Open restaurant search and set the restaurant name or street query.",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string", maxLength: 200 } },
            required: ["query"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          async execute(input: unknown) {
            const value = input as { query?: unknown };
            if (
              !value ||
              typeof value.query !== "string" ||
              value.query.length > 200
            )
              throw new Error("Provide a query of at most 200 characters.");
            changeSearch({
              query: value.query,
              borough: null,
              cuisine: null,
              grade: null,
              watchFilter: null,
            });
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            );
            return { view: "search", query: value.query };
          },
        },
        { signal },
      ),
    ).catch(() => {});
  } catch {
    /* Optional browser API. */
  }
}
