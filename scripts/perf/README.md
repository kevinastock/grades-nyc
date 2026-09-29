# Repeating the startup comparison

These scripts build instrumented copies into `.cache/perf`. They do not change
application source or the normal production build. Use two checkouts with the
same prepared `public/data` snapshot when comparing a code change; use distinct
case names when deliberately comparing data encodings. Do not run builds or
other CPU-heavy work during the serial browser trials.

Required development tools: Node compatible with this project's Vite, OpenSSL,
and `playwright` plus `source-map-js` installed as development dependencies. The
tested dependency versions to add are `playwright@1.62.1` and
`source-map-js@1.2.1`. Install Chromium with `npx playwright install chromium`,
or pass `--browser /absolute/path/to/chromium` to the run command. These packages
are not production runtime dependencies.

From the checkout containing these scripts:

```sh
node scripts/perf/build.mjs --root ../baseline --name baseline
node scripts/perf/build.mjs --root . --name candidate
node scripts/perf/server.mjs --record
```

Leave the fixture server running and use a second terminal:

```sh
node scripts/perf/run.mjs --cases baseline,candidate --profiles localhost,fiber,5g,moderate-cell --runs 5
node scripts/perf/summarize.mjs
```

`--out /absolute/path` selects a shared artifact directory for every command.
Restart the server after rebuilding a case: it intentionally retains compressed
responses in memory. The default `.cache/` directory is already ignored by Git.
Do not commit recorded data, browser results, screenshots, traces or private TLS
keys. The server binds only to loopback and never modifies the system keychain.

The build reads `MANIFEST_FILE` from the selected checkout's data module, falling
back to `manifest.json` for older cases. `--manifest <basename.json>` overrides
that selection when needed. Case metadata records the selected filename and
snapshot; priming includes both current and compatibility manifests, and mutable
manifests use revalidation instead of the immutable-asset cache policy.

The first run primes each case at each required viewport, saves the OpenFreeMap
style, metadata, fonts and initial tiles, precompresses fixture responses, then
freezes upstream recording before collecting samples. These priming navigations
are saved separately under `recordings/` and never enter measured results.
Later runs reuse the fixed fixture files with the server's default offline mode.
Restart with `--record` before introducing a new theme, viewport or camera whose
tiles have not been recorded. Use a new output directory to refresh the fixture
snapshot deliberately. `warm.mjs --cases baseline,candidate` performs the same
priming step separately if desired.

| Profile       | Viewport / DPR | Main-thread CPU multiplier | Added latency | Download/upload cap |
| ------------- | -------------- | -------------------------- | ------------- | ------------------- |
| localhost     | 1440×900 / 2   | 1×                         | 0 ms          | None                |
| fiber         | 1440×900 / 2   | 1×                         | 10 ms         | 100,000 Kibit/s     |
| 5g            | 390×844 / 2    | 2×                         | 40 ms         | 50,000 Kibit/s      |
| moderate-cell | 390×844 / 2    | 4×                         | 40 ms         | 10,000 Kibit/s      |

Profile names describe controlled scenarios, not claims about every device or
connection bearing that name. A fresh browser and context are created for every
sample. Case order reverses on alternate rounds. The server stays warm so
compression, filesystem reads and upstream variability do not contaminate the
browser timing. Measured contexts use a certificate SPKI allowlist derived from
the local certificate, preserving HTTP-cache reuse; broad certificate-error
ignoring would invalidate preload experiments.

On macOS `--gpu auto` selects Metal. The result includes the actual WebGL renderer
and rejects known software renderers unless `--gpu software` was explicit.
Other platforms use their native backend by default. Compare runs on the same
machine and renderer. `--theme dark` and `--hash '#/…'` select another initial
appearance or map route. The runner expects a search/map route containing at
least one mapped restaurant; watchlist-only and empty-result routes require a
different completion condition and are covered by functional tests instead.

Each `results/*.json` contains the snapshot identity, build identity, browser and
host versions, all stage marks, first paint/LCP/CLS observations, long tasks,
resource timings, network-cache signals, actual fixture-server request/byte
counts and the final renderer/camera. A screenshot is saved after measurement.
Failed runs retain diagnostics and do not enter the summary.

`usableMapMs` is the latest of the current camera's loaded-map render and idle event,
and restaurant markers observed across two animation frames. Movement, resize
and new map data invalidate prior render/idle readiness; the runner also requires
the map to be currently loaded after its settling period. Separate marker
and basemap times remain available so an earlier empty map cannot disguise later
restaurant availability. This visual milestone is a proxy for readiness;
interaction correctness still needs the map tests and manual checks.

`blockingAfterFcpMs` sums each observed main-thread task's excess over 50 ms from
first contentful paint until the loaded-map/marker milestone plus a fixed 600 ms
settling period. It is **not Lighthouse TBT**, whose collection and end condition
differ. Canvas contents also do not reliably become browser LCP candidates, so
LCP alone does not describe when the map becomes useful.

For a separate diagnostic trace, rerun with `--trace --runs 1`. Tracing adds
overhead; trace runs are excluded from the normal summary. Hidden source maps
are emitted only in benchmark builds and can be used offline:

```sh
node scripts/perf/analyze-trace.mjs --trace .cache/perf/results/example.trace.json
```

The fixture deliberately serves recorded OpenFreeMap resources from the same
local HTTP/2 origin and uses gzip consistently. This removes CDN variance but
also removes real cross-origin connection costs and changes resource contention;
verify the final change against the real deployment separately. Server request
counts establish whether worker preloads truly reused HTTP-cache bytes. A second
ResourceTiming entry alone does not establish a second transfer. CDP network and
CPU controls attached to the page do not perfectly model worker scheduling, GPU
work or mobile hardware; worker timings must be interpreted with the trace and
host configuration. Report repeated medians and ranges, keep unrelated changes
isolated first, and compare both localhost/fiber and cellular scenarios.
