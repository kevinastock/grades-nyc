// Keep these tiny requests ahead of the map renderer and restaurant download.
// The browser reuses them when MapLibre requests the active style and TileJSON.
export const mapStyles = {
  light: "https://tiles.openfreemap.org/styles/bright",
  dark: "https://tiles.openfreemap.org/styles/fiord",
};

export function preloadBasemap() {
  const style = window.matchMedia("(prefers-color-scheme: dark)").matches
    ? mapStyles.dark
    : mapStyles.light;
  for (const href of [style, "https://tiles.openfreemap.org/planet"]) {
    if (document.head.querySelector(`link[rel="preload"][href="${href}"]`))
      continue;
    const link = document.createElement("link");
    link.rel = "preload";
    link.as = "fetch";
    link.crossOrigin = "anonymous";
    link.href = href;
    document.head.append(link);
  }
}
