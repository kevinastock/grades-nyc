// Keep upstream layout, interaction and accessibility rules while omitting the
// optional controls RestaurantMap never installs. In particular, their embedded
// SVG images otherwise make up most of the map stylesheet's transfer size.
const upstreamStylesheet =
  /(?:^|[/\\])maplibre-gl[/\\]dist[/\\]maplibre-gl\.css$/;
const unusedClass =
  /\.maplibregl-(?:ctrl-(?:icon|logo|compass|fullscreen|shrink|geolocate(?:-[\w-]+)?|globe(?:-enabled)?|terrain(?:-enabled)?|scale)|user-location-[\w-]+|cooperative-gesture-screen|cooperative-gestures|mobile-message|pseudo-fullscreen|popup-track-pointer|marker-draggable)(?![\w-])/;

export function maplibreCss() {
  return {
    postcssPlugin: "maplibre-used-controls",
    Once(root) {
      root.walkRules((rule) => {
        if (!upstreamStylesheet.test(rule.source?.input.file ?? "")) return;
        const selectors = rule.selectors.filter(
          (selector) =>
            !unusedClass.test(selector) &&
            !selector.includes(".maplibregl-map:fullscreen"),
        );
        if (selectors.length) rule.selectors = selectors;
        else rule.remove();
      });
      root.walkAtRules((rule) => {
        if (!upstreamStylesheet.test(rule.source?.input.file ?? "")) return;
        if (
          rule.name === "keyframes" &&
          ["maplibregl-spin", "maplibregl-user-location-dot-pulse"].includes(
            rule.params,
          )
        )
          rule.remove();
        else if (rule.nodes?.length === 0) rule.remove();
      });
    },
  };
}
