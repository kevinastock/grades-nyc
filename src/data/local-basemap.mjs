/**
 * App-owned geographic context for restaurant search. Uses the public
 * OpenMapTiles schema: https://openmaptiles.org/docs/schema/.
 * Keep this self-contained so the exact same style can start in the HTML.
 * @param {"light" | "dark"} theme
 * @returns {import("maplibre-gl").StyleSpecification}
 */
export function createBasemapStyle(theme) {
  const colors =
    theme === "dark"
      ? {
          land: "#263442",
          water: "#182735",
          park: "#304d46",
          road: "#60717c",
          major: "#82909a",
          motorway: "#b39768",
          text: "#e1e8ec",
          muted: "#aabcc6",
          waterText: "#93b7d2",
          halo: "#263442",
        }
      : {
          land: "#f3f0e9",
          water: "#bad6e7",
          park: "#d2e3cb",
          road: "#ffffff",
          major: "#ead8ad",
          motorway: "#e8c68a",
          text: "#35414a",
          muted: "#5a6871",
          waterText: "#4a7593",
          halo: "#f3f0e9",
        };
  const label = {
    "text-field": [
      "coalesce",
      ["get", "name:en"],
      ["get", "name_en"],
      ["get", "name"],
    ],
    "text-font": ["Noto Sans Regular"],
    "text-padding": 3,
    "text-max-width": 10,
  };
  const labelPaint = {
    "text-color": colors.text,
    "text-halo-color": colors.halo,
    "text-halo-width": 1,
  };
  const majorClasses = [
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
  ];
  const minorClasses = ["minor", "service", "track", "path"];
  const majorWidth = (wide, narrow) => [
    "match",
    ["get", "class"],
    ["motorway", "trunk", "primary"],
    wide,
    narrow,
  ];
  const vector = (id, type, sourceLayer, options) => ({
    id,
    type,
    source: "openmaptiles",
    "source-layer": sourceLayer,
    ...options,
  });
  return {
    version: 8,
    name: `NYC restaurant map (${theme})`,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: {
      openmaptiles: {
        type: "vector",
        url: "https://tiles.openfreemap.org/planet",
        attribution:
          '<a href="https://openfreemap.org/">OpenFreeMap</a> © <a href="https://openmaptiles.org/">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      },
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": colors.land },
      },
      vector("vegetation", "fill", "landcover", {
        filter: [
          "match",
          ["get", "class"],
          ["wood", "grass", "wetland"],
          true,
          false,
        ],
        paint: { "fill-color": colors.park },
      }),
      vector("parks", "fill", "park", {
        paint: { "fill-color": colors.park },
      }),
      vector("water", "fill", "water", {
        filter: ["!=", ["get", "brunnel"], "tunnel"],
        paint: { "fill-color": colors.water },
      }),
      vector("waterways", "line", "waterway", {
        minzoom: 10,
        filter: ["!=", ["get", "brunnel"], "tunnel"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": colors.water,
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            10,
            0.6,
            16,
            2,
            20,
            5,
          ],
        },
      }),
      vector("local-roads", "line", "transportation", {
        minzoom: 12,
        filter: [
          "all",
          ["==", ["geometry-type"], "LineString"],
          ["match", ["get", "class"], minorClasses, true, false],
        ],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": colors.road,
          "line-width": [
            "interpolate",
            ["exponential", 1.25],
            ["zoom"],
            12,
            0.4,
            16,
            3,
            20,
            12,
          ],
        },
      }),
      vector("main-roads", "line", "transportation", {
        filter: [
          "all",
          ["==", ["geometry-type"], "LineString"],
          ["match", ["get", "class"], majorClasses, true, false],
        ],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": [
            "match",
            ["get", "class"],
            "motorway",
            colors.motorway,
            colors.major,
          ],
          "line-width": [
            "interpolate",
            ["exponential", 1.25],
            ["zoom"],
            7,
            majorWidth(0.6, 0.35),
            12,
            majorWidth(1.4, 0.8),
            16,
            majorWidth(5, 3.5),
            20,
            majorWidth(18, 12),
          ],
        },
      }),
      vector("water-names-point", "symbol", "water_name", {
        filter: ["==", ["geometry-type"], "Point"],
        layout: { ...label, "text-size": 12, "text-letter-spacing": 0.08 },
        paint: { ...labelPaint, "text-color": colors.waterText },
      }),
      vector("water-names-line", "symbol", "water_name", {
        filter: ["==", ["geometry-type"], "LineString"],
        layout: {
          ...label,
          "symbol-placement": "line",
          "symbol-spacing": 450,
          "text-size": 12,
          "text-letter-spacing": 0.08,
        },
        paint: { ...labelPaint, "text-color": colors.waterText },
      }),
      vector("local-street-names", "symbol", "transportation_name", {
        minzoom: 14,
        filter: ["match", ["get", "class"], minorClasses, true, false],
        layout: {
          ...label,
          "symbol-placement": "line",
          "symbol-spacing": 320,
          "text-size": ["interpolate", ["linear"], ["zoom"], 14, 11, 18, 13],
        },
        paint: { ...labelPaint, "text-color": colors.muted },
      }),
      vector("main-street-names", "symbol", "transportation_name", {
        minzoom: 12,
        filter: ["match", ["get", "class"], majorClasses, true, false],
        layout: {
          ...label,
          "symbol-placement": "line",
          "symbol-spacing": 320,
          "text-size": ["interpolate", ["linear"], ["zoom"], 12, 11, 18, 13],
        },
        paint: { ...labelPaint, "text-color": colors.muted },
      }),
      vector("neighborhood-names", "symbol", "place", {
        minzoom: 9,
        maxzoom: 16,
        filter: [
          "match",
          ["get", "class"],
          ["suburb", "quarter", "neighbourhood", "hamlet"],
          true,
          false,
        ],
        layout: {
          ...label,
          "text-transform": "uppercase",
          "text-letter-spacing": 0.05,
          "text-size": ["interpolate", ["linear"], ["zoom"], 9, 10, 14, 12],
          "symbol-sort-key": ["coalesce", ["get", "rank"], 999],
        },
        paint: { ...labelPaint, "text-color": colors.muted },
      }),
      vector("city-names", "symbol", "place", {
        maxzoom: 14,
        filter: [
          "match",
          ["get", "class"],
          ["city", "town", "village"],
          true,
          false,
        ],
        layout: {
          ...label,
          "text-size": ["interpolate", ["linear"], ["zoom"], 7, 12, 11, 17],
          "symbol-sort-key": ["coalesce", ["get", "rank"], 999],
        },
        paint: labelPaint,
      }),
    ],
  };
}
