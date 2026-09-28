# NYC Inspection Grades

A static restaurant inspection explorer built with TypeScript, Vite, [Oat UI](https://oat.ink), Fuse.js, Supercluster and Leaflet/OpenStreetMap. The interface uses native DOM events and Oat’s semantic HTML primitives; there is no React, Preact, virtual DOM or component framework. The browser loads precomputed JSON. It has no database engine, SQL, Wasm or Parquet dependency. Search and map clustering run in a dedicated worker.

## Run and build

Requires Node.js 22.12+ (Node 24 is pinned in `.nvmrc` for CI), npm, curl, and the [DuckDB CLI](https://duckdb.org/docs/stable/clients/cli/overview). DuckDB reads the source CSV in memory and exports JSON directly. It is a build/test dependency; it is never shipped to the browser. `just` is optional. On macOS, `brew install duckdb just` installs both command-line tools.

```bash
npm ci
just dev        # Download once if needed, convert CSV to JSON, then run Vite
just release    # Validate data, type-check, and build dist/
just preview    # Serve the release build locally
just test       # Run tests with small fake records; no NYC download
just update     # Force a fresh download and regenerate validated JSON
```

The npm equivalents are `npm run dev`, `npm run build`, `npm run preview`, `npm test`, and `npm run update-data`. `just install` runs `npm ci`; `just data` only builds the data. Development and release builds share the same pipeline and reuse `.cache/inspections.csv`. They rerun the transformations on every build so model changes take effect immediately. Delete that cached CSV or run `just update` to refresh it.

Downloaded CSVs, generated JSON, build output, and reference documents are ignored by Git. The repository contains application code and small synthetic test cases, with no checked-in inspection dataset. Generated files live in `.cache/`, `data/`, `public/data/`, and `dist/`.

Deploy the contents of `dist/` to a static HTTP host. Relative URLs and hash routes support GitHub Pages project paths without a repository-specific base URL or server-side route fallback.

## GitHub Pages

`.github/workflows/pages.yml` tests and builds the full site on pull requests, pushes to `main`, manual runs, and every night at **07:17 UTC (02:17 EST / 03:17 EDT)**. Successful runs on the default branch deploy `dist/` using the official Pages artifact/deployment actions. Pull requests only test and build. A failed download, test, validation, or build prevents deployment, leaving the current site online. Only npm's package download cache is reused in CI; the NYC CSV is downloaded fresh on every run. No generated data is committed back to Git.

After creating the GitHub repository:

1. Push this code with `main` as the default branch. If choosing another branch name, update the workflow's `push.branches` entry.
2. Select **Settings → Pages → Build and deployment → Source → GitHub Actions**.
3. Run **Actions → Build and deploy NYC Inspection Grades → Run workflow** for the initial deployment, or push another change to `main`.

No repository name, custom secret, or personal access token is required by the workflow. It uses GitHub's built-in token and grants Pages deployment permissions only to the deployment job. See [GitHub's Pages workflow setup](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

GitHub runs scheduled workflows from the default branch and may delay them during busy periods. In public repositories, schedules are disabled after 60 days without repository activity; re-enable the workflow in Actions if that happens. See [GitHub's schedule behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

## Exploring restaurants

Search supports restaurant names, streets, punctuation and typos, with exact names and prefixes ranked first. Filters cover borough, cuisine, awarded grade and watched violations. All matches remain available when panning or zooming. Within similar text matches, locations inside the map receive a modest preference, while unlocated records receive a small penalty; strong name and permit-number matches still take priority. Without a text query, the list groups in-view locations, other locations, and unlocated records, preserving latest-inspection order within each group. Closed restaurants and their histories/catalog contributions are excluded during import; restaurants with a later reopening remain included.

The map stays visible alongside inline details. Wide screens show results, details, and map in three columns; medium screens replace results with details. Portrait phones show the map above the active list or details, while landscape phones use side-by-side panels when there is room. Each panel scrolls independently. The update date shares the navigation row, mobile filters expand beside search through a Feather filter-icon button with an active-filter count, and result counts appear only on the map.

Selecting a restaurant centers its independent highlighted pin at street level (zoom 17, preserving a closer view). Subsequent panning and zooming remain under the user's control. Back and Forward retrace selections and restore each saved map view. Closing details returns to the original search camera, list position, loaded results, and filters without adding another history entry. A directly linked restaurant safely closes to search within the app. Typing and filter changes preserve the explored map area. Citywide minimum zoom and NYC pan bounds remain independent of search filters and adapt to the available map size. Unlocated restaurants open normally without moving the map. Restaurants sharing coordinates can be selected from a cluster's list.

Restaurant links and search criteria use bookmarkable hash routes. Each detail panel's grade avatar links directly to the official NYC ABCEats record using the restaurant's permit number (CAMIS). The address links to Apple Maps, and the magnifying-glass link opens Google Search. Panels combine same-day inspections while preserving historical violation definitions and score-conflict rules. Inspection dates use a single accordion, with the newest open initially and older dates collapsed. Clicking a violation code badge directly toggles watching that code and shows a two-second Oat toast. Badge colors and pressed states distinguish watched codes; descriptions remain plain text. Keyboard focus and expanded inspection dates survive watched-finding reordering. Changes share the same persisted watchlist as the Violations page. Hover, keyboard focus and pointer intent prefetch the corresponding small history file; results are cached. Deep links request their history alongside the summary.

The watchlist supports all codes in the current snapshot, ordered by historical frequency or code. Counts are distinct restaurants across all available history. Current warnings and watched-violation filtering use only the latest inspection date. Selected codes are stored under `nyc-grades-watchlist-v1` in localStorage. Clearing the watchlist clears its active filter. Preferences are device-local, with no server account or storage.

## Interface and bundle size

Oat is pinned to `@knadh/oat` 0.8.0. The app imports only the Oat styles it uses and the dropdown web component and toast helper. Oat inputs, switches, buttons, cards, avatars, badges, alerts and inspection disclosures supply the UI. Filters and sort controls use Oat dropdown web components with the browser’s popover API, keyboard navigation, current-choice indicators and type-to-jump. Each filter includes an all/any option. One Reset text action beside the filter controls clears active filter choices while preserving the search text; it is hidden when no filters are active. The search field has one dedicated clear button; its duplicate browser-provided icon is hidden. Restaurant avatars and map pins use the five approved SVGs in `design/grade-avatars/`: blue A, green B, orange C, neutral GP (pending) and purple NG (no recorded grade). The artwork preserves the approved lettering placement, is imported directly through Vite, and has no font dependency. Decorative images sit inside labeled figures or map buttons; normal and selected map pins keep their existing white halos and selection ring. Whole result cards are links; opaque numeric badges on both result and detail avatars count watched violations from the latest inspection. The layout supports current evergreen browsers, including native popovers and CSS `light-dark()`.

`src/App.ts` owns the persistent page shell and coordinates the existing navigation and worker clients. Detail, watchlist and map controllers expose `update()` and `destroy()` lifecycles. `src/dom.ts` constructs text nodes instead of interpreting dataset values as HTML. Result rows retain their DOM nodes across updates to preserve keyboard focus. The map is released while the watchlist is open, then restored from navigation state. Custom CSS is limited to responsive panel sizing, scroll regions, map markers and small layout adjustments; component appearance comes from Oat.

[Feather v4.29.2](https://github.com/feathericons/feather/tree/v4.29.2) supplies the interface icons. Individual SVGs, including the menu and filter icons, are checked in and explicitly imported by `src/icons.ts`; the app includes no Feather runtime, full icon set, font or external icon requests. SVGs inherit the control’s color, are hidden from assistive technology, and their buttons/links retain accessible names. The MIT license is shipped at `licenses/feather.txt`. The header’s GitHub icon links to [kevinastock/grades-nyc](https://github.com/kevinastock/grades-nyc). The header links to Restaurants and Violations. On smaller screens, a Feather menu-icon button opens a dropdown containing both links; Restaurants remains a text label at every size.

Production JavaScript and CSS, excluding data, tiles and the HTML document (decimal KB; gzip level 9 per asset):

| Assets                                                | React / Mantine |    Oat |
| ----------------------------------------------------- | --------------: | -----: |
| Main application JavaScript                           |          430 KB |  47 KB |
| Main stylesheet                                       |          215 KB |  31 KB |
| All JavaScript + CSS, including map and search worker |          858 KB | 293 KB |
| All JavaScript + CSS, gzipped                         |          234 KB |  91 KB |

This reduces total compressed application assets by about **61%** and main application JavaScript by about **89%**. Leaflet now accounts for most of the shipped JavaScript. Search/clustering still runs off the main thread, the map stays dynamically imported, and the inspection data format and lazy history loading are unchanged. Gzip figures are a build comparison, not a claim about the host’s compression configuration.

## Import and refresh

The source is NYC Open Data's [DOHMH Restaurant Inspection Results](https://data.cityofnewyork.us/Health/DOHMH-New-York-City-Restaurant-Inspection-Results/43nn-pn8j). The build downloads its complete CSV export, then uses the transformations in `scripts/normalize.sql` and `scripts/model.mjs` to produce browser-ready JSON directly. There is no Parquet stage or stored database.

```bash
just update                         # Download a new CSV and regenerate data/
just build                          # Reuse the cached CSV and build dist/
just convert /path/to/inspections.csv # Validate/convert a supplied CSV into data/
```

`npm run convert-data -- <input.csv> [output-directory]` and `./update-data.sh [output-directory]` also accept an optional output directory. A manual conversion does not replace the source download cache; the next standard build will use `.cache/inspections.csv`.

Every standard build, refresh, and command-line conversion requires at least **10,000 retained restaurants** and **100 distinct violation codes**. These minimums live in `scripts/validate-data.mjs`. Counts apply to the actual site population after closure filtering. The importer also validates column shapes, values, identifiers, dates/numbers, history references, and the manifest. Builds verify every JSON asset's byte size and content hash before publishing it to `public/data/`.

Identifiers stay strings, findings are deduplicated, and non-finite coordinates become null. Closure classification uses the complete source history; currently closed restaurants are excluded, while later reopenings remain included. Summaries, history files, facets, catalog counts and definitions all use that retained population. Source row counts and snapshot dates describe the original input.

Schema version 3 consists of:

- `manifest.json`: snapshot date, source row count, and each asset's size, row count, and content-hashed filename.
- `summary-<hash>.json`: restaurant fields as 15 column arrays, cuisine/borough choices, the violation catalog, and shared historical definitions.
- `details-<bucket>-<hash>.json`: 256 stable buckets of inspection histories keyed by restaurant ID. Each compact inspection tuple references the shared definition dictionary.

Downloads are staged, and the cached CSV is replaced only after conversion and validation succeed. Conversion validates the complete JSON snapshot before publishing its manifest last. Failed downloads, malformed input, and low counts preserve the previous cache and snapshot. Old content-addressed JSON remains in local `data/` for existing tabs; release builds prune stale JSON from `public/data/` and Vite recreates `dist/`. Generated directories can be deleted and rebuilt from the cached CSV at any time.

The browser initially fetches only the manifest and summary, then loads small history files on demand. HTTP compression is left to the host. No database engine or SQL processing runs in visitors' browsers.

Use manifest revalidation and immutable caching for hashed files. Every tab pins one manifest for its lifetime, so summaries and historical definitions never mix snapshots. If a deployment removes a tab's old, uncached history file, the panel detects a newer snapshot and offers **Reload latest data**. For uninterrupted long-lived tabs, a host may retain prior immutable JSON assets. Requests fail clearly and can be retried; failed prefetches do not poison the cache. Memory is bounded to 16 history buckets and 128 decoded restaurant histories, plus in-flight requests.

No request to jsDelivr or DuckDB extension servers is made by the app. The only external runtime requests are visible OpenStreetMap tiles. A strict CSP should permit the same-origin module worker and `tile.openstreetmap.org`. The map fits actual result bounds before attaching its tile layer, avoiding a redundant initial tile viewport; tiles are not prefetched or stored offline. For higher traffic, configure a provider appropriate to the volume and comply with the OSM tile policy.

Fuse indexing/search, filtering and Supercluster construction live in one worker. Restaurants are sent once, subsequent requests return IDs and visible features, pending searches are coalesced, and revisions prevent stale query/cluster results from replacing current views. Panning reads the existing cluster index. Leaflet retains visible markers; 48px clustering with extent 256 and maximum zoom 19 matches the map's scale. Map code is requested while the JSON summary loads. The browser no longer rebuilds grades, counts, closures or catalog queries on each visit.

## Meaning of the data

The data model follows the current-grade query and data dictionary linked from the [official NYC dataset](https://data.cityofnewyork.us/Health/DOHMH-New-York-City-Restaurant-Inspection-Results/43nn-pn8j):

- `CAMIS` identifies a restaurant. Rows represent violations; a repeated inspection score is never summed.
- Latest recorded grade uses NYC's eligible inspection types and initial-inspection score rule, ranked by inspection date. It is kept separate from the latest visit. Newer administrative, compliance, or ungraded inspections do not silently replace an awarded grade.
- `P` and `Z` display as pending. Restaurants without a qualifying recorded grade are explicitly marked. `1900-01-01` is treated as never inspected.
- All inspection types on the latest date contribute to current watchlist warnings. The restaurant panel groups records by inspection date for presentation without changing the rules used to select the recorded grade. Historical findings remain available separately and do not trigger current warnings.
- Reopening grades can carry forward a preceding re-inspection grade. The app preserves the supplied grade and score even when their usual ranges differ.
- Closures are dated reports, with reopening actions considered. A closure recorded after the last reopening excludes that restaurant from the generated dataset. Same-day closure/reopening with unknown order remains included and is labeled in details; the app does not claim live operating status.
- Preference descriptions/classifications use the latest observed record for each code. Inspection details retain historical wording and classification, with duplicate codes combined within each date. Watchlist occurrence counts count each restaurant once per code across the available history.
- Missing/zero/out-of-NYC coordinates do not produce pins; address links remain available. Source borough `0` is displayed as Unknown.

The site displays the record date supplied by NYC, which can lag the download date. Source records may be incomplete, corrected, or older than current posted grades.

## Verification

```bash
npm test
npm run build
```

The suite generates small invented CSV records in temporary directories and converts them directly to JSON. It needs no downloaded city snapshot or checked-in data files. DuckDB must be installed; conversion tests fail with an installation hint if it is missing. There are no skipped native tests, frozen dataset totals, Wasm database dependencies, or Parquet tests.

Data tests cover grade eligibility, grade retention, same-day inspection grouping, reopening/closure rules, historical descriptions, catalog counts, leading-zero IDs, strict parsing, conflicting scores, coordinates, deterministic output, file integrity, and stale-asset pruning. Pipeline tests check cold downloads, cache reuse, forced refreshes, distinct-count thresholds, failed-refresh recovery, and retry behavior. A small all-closed test exercises the converter itself; production builds still reject the resulting undersized population.

Summary/loader tests check column and history validation, ordering, lazy requests, caching, retry, and expired snapshots. Worker and navigation tests cover ranking, filters, map revisions, selection chains, bookmarked routes, Back/Forward, and restored views.

DOM regression tests additionally cover safe text rendering, watchlist filtering/sorting and focus, out-of-order detail loads, inspection disclosure state, direct badge watch toggles and toast feedback, dropdown selection and type-to-jump, grade avatars, full-card links and watch counts, stale search/map responses, input focus, Back/Close camera and list restoration, and retry/reload behavior. These tests use Happy DOM only as a development dependency.

Interactive verification should cover rapid typing while panning, Show more, the compact navigation menu, desktop/phone filters, watched findings, deep links, first and repeated details, shared-coordinate clusters and retry behavior.
