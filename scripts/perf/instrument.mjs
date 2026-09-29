import sourceMap from "source-map-js";

const mark = (name) => `performance.mark(${JSON.stringify(`grades:${name}`)});`;

/** This plugin exists only in the benchmark build, never in vite.config.ts.
 * Anchor failures are deliberate: changed application code needs a reviewed
 * observation point, not silently incomparable results. */
export function instrument() {
  const seen = new Set();
  const required = [
    "/src/main.ts",
    "/src/App.ts",
    "/src/data/load-files.mjs",
    "/src/components/RestaurantMap.ts",
  ];
  return {
    name: "performance-observations",
    enforce: "pre",
    transform(code, id) {
      const file = id.split("?")[0].replaceAll("\\", "/");
      const insertions = [];
      const before = (anchor, text) => {
        const position = code.indexOf(anchor);
        if (position < 0 || code.indexOf(anchor, position + anchor.length) >= 0)
          throw new Error(
            `Missing or ambiguous performance anchor in ${id}: ${anchor}`,
          );
        insertions.push({ position, text });
      };
      if (file.endsWith("/src/main.ts"))
        before("const app = createApp", mark("app-start"));
      if (file.endsWith("/src/App.ts")) {
        before("data = value;", mark("data-ready"));
        before("queryResult = value;", mark("query-ready"));
        before("void load();", mark("shell-ready"));
      }
      if (file.endsWith("/src/data/load-files.mjs")) {
        if (
          /const summary = validateSummary\(\s*await fetchJson\(/.test(code)
        ) {
          // The deployed baseline awaits its download inside validateSummary.
          // Observe completed summary bytes inside fetchJson, before decoding;
          // marking at the declaration would incorrectly include network time.
          before(
            "if (asset && bytes.byteLength !== asset.bytes)",
            `if (asset?.file?.startsWith("summary-")) { ${mark("summary-bytes")} }`,
          );
        } else {
          const summary = code.includes("const summary = decodeSummary")
            ? "const summary = decodeSummary"
            : "const summary = validateSummary(";
          before(summary, mark("summary-bytes"));
        }
        before(
          code.includes("const restaurants = new Map(")
            ? "const restaurants = new Map("
            : "let restaurants;",
          mark("summary-decoded"),
        );
      }
      if (file.endsWith("/src/components/RestaurantMap.ts")) {
        before("const map = new GLMap({", mark("map-constructor"));
        before(
          "map.touchZoomRotate.disableRotation();",
          `
          globalThis.__benchmarkMap = map;
          const mapReadiness = globalThis.__benchmarkMapReadiness = { revision: 0, render: null, idle: null };
          const invalidateReadiness = () => { mapReadiness.revision++; mapReadiness.render = null; mapReadiness.idle = null; };
          map.on('movestart', invalidateReadiness);
          map.on('resize', invalidateReadiness);
          map.on('dataloading', invalidateReadiness);
          const firstMark = (name) => { if (!performance.getEntriesByName('grades:' + name).length) performance.mark('grades:' + name); };
          map.on('load', () => firstMark('map-load'));
          map.on('idle', () => { if (map.loaded()) { mapReadiness.idle ??= performance.now(); firstMark('map-idle'); } });
          map.on('render', () => { if (map.loaded()) { mapReadiness.render ??= performance.now(); firstMark('map-rendered'); } });
          ${mark("map-constructed")}
        `,
        );
        before(
          code.includes("map.setStyle(loadedStyle, {")
            ? "map.setStyle(loadedStyle, {"
            : "map.setStyle(style, {",
          mark("map-set-style"),
        );
      }
      if (!insertions.length) return null;
      for (const suffix of required)
        if (file.endsWith(suffix)) seen.add(suffix);
      // Preserve source positions through inserted marks, including columns.
      // Hidden Vite maps allow optional offline trace attribution.
      insertions.sort((a, b) => a.position - b.position);
      const generator = new sourceMap.SourceMapGenerator({ file: id });
      generator.setSourceContent(id, code);
      let result = "",
        cursor = 0,
        originalLine = 1,
        originalColumn = 0;
      let generatedLine = 1,
        generatedColumn = 0;
      const append = (text, original) => {
        for (const character of text) {
          generator.addMapping({
            source: id,
            original: { line: originalLine, column: originalColumn },
            generated: { line: generatedLine, column: generatedColumn },
          });
          result += character;
          if (character === "\n") {
            generatedLine++;
            generatedColumn = 0;
          } else generatedColumn += character.length;
          if (original) {
            if (character === "\n") {
              originalLine++;
              originalColumn = 0;
            } else originalColumn += character.length;
          }
        }
      };
      for (const insertion of insertions) {
        append(code.slice(cursor, insertion.position), true);
        append(insertion.text, false);
        cursor = insertion.position;
      }
      append(code.slice(cursor), true);
      return { code: result, map: generator.toJSON() };
    },
    generateBundle() {
      const missing = required.filter((file) => !seen.has(file));
      if (missing.length)
        throw new Error(
          `Uninstrumented performance sources: ${missing.join(", ")}`,
        );
    },
  };
}
