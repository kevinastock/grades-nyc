import { defineConfig } from "vite";
import { maplibreCss } from "./build/maplibre-css.mjs";
import { startupResources } from "./build/startup-resources.mjs";

export default defineConfig({
  base: "./",
  plugins: [startupResources()],
  css: { postcss: { plugins: [maplibreCss()] } },
});
