import { createBasemapStyle } from "./local-basemap.mjs";

export const mapStyles = { light: "light", dark: "dark" };
export { createBasemapStyle };

/** Serialized into production HTML with the same app-owned style factory. */
export function preloadBasemap(
  styles = mapStyles,
  assets = [],
  requestedStyle,
  createStyle = createBasemapStyle,
) {
  const state = (globalThis.__gradesBasemap ??= { styles: new Map() });
  const hint = (href, as = "fetch", rel = "preload") => {
    const url = new URL(href, document.baseURI);
    if (!/^https?:$/.test(url.protocol)) return;
    const existing = [...document.head.querySelectorAll("link[href]")].some(
      (link) =>
        link.href === url.href &&
        ((link.rel === rel && link.as === as) ||
          (as === "style" && link.rel === "stylesheet")),
    );
    if (existing) return;
    const link = document.createElement("link");
    link.rel = rel;
    if (as) link.as = as;
    link.crossOrigin = "anonymous";
    link.href = url.href;
    document.head.append(link);
  };
  const theme =
    requestedStyle ||
    (window.matchMedia("(prefers-color-scheme: dark)").matches
      ? styles.dark
      : styles.light);
  const style = createStyle(theme);
  let pending = state.styles.get(theme);
  if (!pending) {
    pending = Promise.resolve(style);
    state.styles.set(theme, pending);
  }
  if (location.hash.split("?")[0] !== "#/watchlist") {
    for (const asset of assets) hint(asset.href, asset.as, asset.rel);
    // The shared style has exactly one source/font stack, known synchronously.
    // No remote style document or sprite discovery precedes these requests.
    hint(style.sources.openmaptiles.url);
    hint(
      style.glyphs
        .replace("{fontstack}", "Noto Sans Regular")
        .replace("{range}", "0-255"),
    );
  }
  return pending;
}

export function loadBasemapStyle(theme) {
  return preloadBasemap(mapStyles, [], theme, createBasemapStyle);
}
