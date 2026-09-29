import {
  Map as GLMap,
  Marker,
  Popup,
  NavigationControl,
  LngLatBounds,
  MercatorCoordinate,
  setWorkerUrl,
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import "./map.css";
import type { Restaurant } from "../data/types";
import {
  ExplorerClient,
  type QueryResult,
  type ViewportResult,
  type MapFeature,
} from "../data/explorer-client";
import { prefetchInspections } from "../data/client";
import { hasCoordinates } from "../data/model.mjs";
import { MAX_MAP_ZOOM } from "../data/map.mjs";
import { mapStyles } from "../data/map-resources";
import { titleCase } from "../data/presentation.mjs";
import { gradeImage, icon } from "./shared";

// Bundle the module worker with Vite so relative-path static deployments work.
setWorkerUrl(workerUrl);

// Navigation history and the clustering worker use a 256px world at zoom 0.
// MapLibre uses 512px, so convert only at the renderer boundary.
const toMapZoom = (zoom: number) => zoom - 1;
const fromMapZoom = (zoom: number) => zoom + 1;

const clusterCountFormat = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumSignificantDigits: 2,
});

export type MapCamera = { lat: number; lon: number; zoom: number };
export type CameraRequest = { key: string; view: MapCamera | null };

export type MapProps = {
  explorer: ExplorerClient;
  result: QueryResult;
  restaurants: Map<string, Restaurant>;
  selectedId: string | null;
  cameraRequest: CameraRequest;
  showResultsToggle: boolean;
  resultsVisible: boolean;
  onToggleResults: () => void;
  onCamera: (
    camera: MapCamera,
    bounds: { west: number; south: number; east: number; north: number },
  ) => void;
  onSelect: (id: string) => void;
  onViewport: (value: ViewportResult, cameraKey: string) => void;
  onError: (error: Error) => void;
};

/** Mount one map; update its inputs without replacing MapLibre or its DOM. */
export function createRestaurantMap(host: HTMLElement, initial: MapProps) {
  let props = initial;
  let destroyed = false;
  let tileError = false;
  const wrap = document.createElement("div");
  wrap.className = "map-wrap";
  const element = document.createElement("div");
  element.className = "map";
  element.setAttribute("aria-label", "Map of matching restaurants");
  const toolbar = document.createElement("div");
  toolbar.className = "map-tools vstack gap-2";
  const resultsToggle = document.createElement("button");
  resultsToggle.type = "button";
  resultsToggle.className = "icon map-results-toggle";
  resultsToggle.dataset.variant = "secondary";
  resultsToggle.setAttribute("aria-controls", "restaurant-results");
  resultsToggle.append(icon("list"));
  resultsToggle.addEventListener("click", () => props.onToggleResults());
  const message = document.createElement("div");
  message.className = "map-message";
  message.setAttribute("role", "alert");
  message.dataset.variant = "warning";
  toolbar.append(resultsToggle);
  wrap.append(element, toolbar, message);
  host.replaceChildren(wrap);

  function renderStatus() {
    resultsToggle.hidden = !props.showResultsToggle;
    resultsToggle.title = props.resultsVisible
      ? "Hide search results"
      : "Show search results";
    resultsToggle.setAttribute("aria-label", resultsToggle.title);
    resultsToggle.setAttribute("aria-expanded", String(props.resultsVisible));
    const { result, selectedId, restaurants } = props;
    const selected = selectedId ? restaurants.get(selectedId) : null;
    const messages = tileError ? ["Map tiles unavailable."] : [];
    if (selected && !hasCoordinates(selected))
      messages.push(`${titleCase(selected.name)} has no map location.`);
    else if (!result.mapped) messages.push("No mapped locations.");
    message.textContent = messages.join(" ");
    message.hidden = messages.length === 0;
  }

  function mountMap() {
    const { explorer, restaurants } = props;
    // Search results must not change the citywide navigation limits.
    const cityBounds = new LngLatBounds();
    for (const restaurant of restaurants.values()) {
      if (hasCoordinates(restaurant))
        cityBounds.extend([restaurant.lon!, restaurant.lat!]);
    }
    if (cityBounds.isEmpty())
      cityBounds.extend([-74.2492, 40.4995]).extend([-73.7009, 40.9129]);
    const latPad = (cityBounds.getNorth() - cityBounds.getSouth()) * 0.05;
    const lonPad = (cityBounds.getEast() - cityBounds.getWest()) * 0.05;
    const northWest = MercatorCoordinate.fromLngLat([
      cityBounds.getWest() - lonPad,
      cityBounds.getNorth() + latPad,
    ]);
    const southEast = MercatorCoordinate.fromLngLat([
      cityBounds.getEast() + lonPad,
      cityBounds.getSouth() - latPad,
    ]);
    // Read the initial box once; subsequent measurements come from the browser's
    // layout pass. Camera constraints run on every movement and must not force
    // layout after MapLibre has written marker/canvas styles.
    let viewportWidth = element.clientWidth;
    let viewportHeight = element.clientHeight;
    const hasSize = () => viewportWidth > 0 && viewportHeight > 0;
    const fitOptions = () => ({
      padding: Math.max(
        0,
        Math.min(35, (viewportWidth - 1) / 2, (viewportHeight - 1) / 2),
      ),
      maxZoom: toMapZoom(16),
      duration: 0,
    });
    let minimumZoom = 0;
    // Constrain the center without forcing a zoom when the overview is wider
    // than NYC. At street level the entire viewport stays inside the city.
    const map = new GLMap({
      container: element,
      center: cityBounds.getCenter(),
      maxZoom: toMapZoom(MAX_MAP_ZOOM),
      maxPitch: 0,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      renderWorldCopies: false,
      trackResize: false,
      transformConstrain(center, requestedZoom) {
        const zoom = Math.max(
          minimumZoom,
          Math.min(toMapZoom(MAX_MAP_ZOOM), requestedZoom),
        );
        if (!hasSize()) return { center, zoom };
        const point = MercatorCoordinate.fromLngLat(center);
        const worldSize = 512 * 2 ** zoom;
        const clampAxis = (
          value: number,
          start: number,
          end: number,
          half: number,
        ) =>
          end - start <= half * 2
            ? (start + end) / 2
            : Math.max(start + half, Math.min(end - half, value));
        return {
          center: new MercatorCoordinate(
            clampAxis(
              point.x,
              northWest.x,
              southEast.x,
              viewportWidth / worldSize / 2,
            ),
            clampAxis(
              point.y,
              northWest.y,
              southEast.y,
              viewportHeight / worldSize / 2,
            ),
          ).toLngLat(),
          zoom,
        };
      },
    });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.getCanvas().setAttribute("aria-label", "Map of matching restaurants");
    map.addControl(new NavigationControl({ showCompass: false }), "top-left");
    element
      .querySelector(".maplibregl-ctrl-zoom-in")
      ?.replaceChildren(icon("plus"));
    element
      .querySelector(".maplibregl-ctrl-zoom-out")
      ?.replaceChildren(icon("minus"));
    const updateMinimumZoom = () => {
      minimumZoom = 0;
      map.setMinZoom(0);
      minimumZoom = map.cameraForBounds(cityBounds, fitOptions())?.zoom ?? 0;
      map.setMinZoom(minimumZoom);
    };
    const markers = new Map<string, Marker>();
    let disposed = false;
    let initialized = false;
    let measuredSize = "";
    let frame = 0;
    let cameraFrame = 0;
    let appliedCameraKey: string | null = null;
    let reportedCamera = "";
    let selectedMarker: Marker | null = null;
    let popup: Popup | null = null;
    let popupFrame = 0;
    const closePopup = () => {
      cancelAnimationFrame(popupFrame);
      popup?.remove();
      popup = null;
    };
    let markedSelection: string | null = null;
    let viewSequence = 0;
    let interaction = 0;
    let requestedView = "";
    let moving = false;
    let zooming = false;
    const invalidateViewport = () => {
      viewSequence++;
      requestedView = "";
      cancelAnimationFrame(frame);
    };
    const select = (id: string) => {
      interaction++;
      closePopup();
      props.onSelect(id);
    };
    const fail = (error: unknown) => {
      if (!disposed)
        props.onError(
          error instanceof Error ? error : new Error(String(error)),
        );
    };
    const label = (r: Restaurant) =>
      `${titleCase(r.name)} · ${r.grade === "P" || r.grade === "Z" ? "Pending" : r.grade ? `Grade ${r.grade}` : "No grade"} · ${titleCase(r.address)}`;
    const intent = (button: HTMLElement, id: string) => {
      for (const event of ["mouseenter", "focus", "pointerdown"])
        button.addEventListener(event, () => prefetchInspections(id));
    };
    const renderSelection = () => {
      const id = props.selectedId;
      if (id === markedSelection) return;
      markedSelection = id;
      selectedMarker?.remove();
      selectedMarker = null;
      if (!id) return;
      const restaurant = restaurants.get(id);
      if (!restaurant || !hasCoordinates(restaurant)) return;
      // Selected places remain visible independently of the cluster index.
      const ordinary = markers.get(`restaurant-${id}`);
      if (ordinary) {
        ordinary.remove();
        markers.delete(`restaurant-${id}`);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.append(gradeImage(restaurant.grade));
      button.setAttribute("aria-label", `Selected: ${label(restaurant)}`);
      button.setAttribute("aria-pressed", "true");
      const tooltip = document.createElement("span");
      tooltip.textContent = titleCase(restaurant.name);
      const markerElement = document.createElement("div");
      markerElement.className = "map-selected";
      markerElement.title = `Selected: ${label(restaurant)}`;
      tooltip.className = "map-selected-tooltip";
      markerElement.append(button, tooltip);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        select(restaurant.id);
      });
      intent(button, restaurant.id);
      selectedMarker = new Marker({ element: markerElement })
        .setLngLat([restaurant.lon!, restaurant.lat!])
        .addTo(map);
    };
    const render = (features: MapFeature[], revision: number) => {
      const visible = new Set<string>();
      for (const feature of features) {
        const [lon, lat] = feature.geometry.coordinates;
        const p = feature.properties;
        if (!p.cluster && p.id === props.selectedId) continue;
        // Cluster IDs are only meaningful within the index that produced them.
        const key = p.cluster
          ? `cluster-${revision}-${p.cluster_id}`
          : `restaurant-${p.id}`;
        visible.add(key);
        if (markers.has(key)) continue;
        const button = document.createElement("button");
        button.type = "button";
        if (p.cluster) {
          button.textContent = clusterCountFormat.format(p.point_count);
          button.setAttribute("aria-label", `${p.point_count} restaurants`);
          const markerElement = document.createElement("div");
          markerElement.className = "map-cluster";
          markerElement.append(button);
          const marker = new Marker({ element: markerElement }).setLngLat([
            lon,
            lat,
          ]);
          button.addEventListener("click", (event) => {
            event.stopPropagation();
            closePopup();
            const token = ++interaction;
            void explorer
              .expand(revision, p.cluster_id)
              .then((expanded) => {
                if (
                  disposed ||
                  !hasSize() ||
                  !expanded ||
                  token !== interaction ||
                  props.result.revision !== revision
                )
                  return;
                if (expanded.zoom <= MAX_MAP_ZOOM) {
                  map.easeTo({
                    center: [lon, lat],
                    zoom: toMapZoom(expanded.zoom),
                  });
                  return;
                }
                const list = document.createElement("div");
                list.className = "map-place-list vstack gap-2";
                const title = document.createElement("strong");
                title.textContent = `${p.point_count} places here`;
                list.append(title);
                for (const id of expanded.ids) {
                  const place = restaurants.get(id);
                  if (!place) continue;
                  const choice = document.createElement("button");
                  choice.type = "button";
                  choice.className = "outline small";
                  choice.textContent = label(place);
                  intent(choice, id);
                  choice.addEventListener("click", () => select(id));
                  list.append(choice);
                }
                closePopup();
                popup = new Popup({
                  maxWidth: "min(330px, var(--map-popup-width))",
                  offset: 24,
                  anchor: "bottom",
                })
                  .setLngLat([lon, lat])
                  .setDOMContent(list)
                  .addTo(map);
                popup
                  .getElement()
                  .querySelector(".maplibregl-popup-close-button")
                  ?.replaceChildren(icon("x"));
                popup.on("close", () => {
                  interaction++;
                });
                const openedPopup = popup;
                // MapLibre anchors popups but does not pan to reveal overflow.
                popupFrame = requestAnimationFrame(() => {
                  if (
                    disposed ||
                    popup !== openedPopup ||
                    !openedPopup.isOpen()
                  )
                    return;
                  const viewport = element.getBoundingClientRect();
                  const box = openedPopup.getElement().getBoundingClientRect();
                  const shift = (
                    start: number,
                    end: number,
                    min: number,
                    max: number,
                  ) => (start < min ? start - min : end > max ? end - max : 0);
                  const dx = shift(
                    box.left,
                    box.right,
                    viewport.left + 8,
                    viewport.right - 8,
                  );
                  const dy = shift(
                    box.top,
                    box.bottom,
                    viewport.top + 8,
                    viewport.bottom - 8,
                  );
                  if (dx || dy) map.panBy([dx, dy], { duration: 0 });
                });
              })
              .catch(fail);
          });
          marker.addTo(map);
          markers.set(key, marker);
        } else {
          const restaurant = restaurants.get(p.id);
          if (!restaurant) continue;
          button.setAttribute("aria-label", label(restaurant));
          button.append(gradeImage(restaurant.grade));
          intent(button, restaurant.id);
          const markerElement = document.createElement("div");
          markerElement.className = "map-restaurant";
          markerElement.title = label(restaurant);
          markerElement.append(button);
          button.addEventListener("click", (event) => {
            event.stopPropagation();
            select(restaurant.id);
          });
          const marker = new Marker({ element: markerElement })
            .setLngLat([lon, lat])
            .addTo(map);
          markers.set(key, marker);
        }
      }
      for (const [key, marker] of markers) {
        if (!visible.has(key)) {
          marker.remove();
          markers.delete(key);
        }
      }
    };
    const update = () => {
      if (
        !initialized ||
        disposed ||
        moving ||
        zooming ||
        !hasSize() ||
        appliedCameraKey !== props.cameraRequest.key
      )
        return;
      const revision = props.result.revision;
      const requestCameraKey = appliedCameraKey;
      const b = map.getBounds();
      const bounds = {
        west: b.getWest(),
        south: b.getSouth(),
        east: b.getEast(),
        north: b.getNorth(),
      };
      const center = map.getCenter();
      const cameraKey = `${appliedCameraKey}:${center.lat}:${center.lng}:${map.getZoom()}:${Object.values(bounds).join(":")}`;
      if (reportedCamera !== cameraKey) {
        reportedCamera = cameraKey;
        props.onCamera(
          {
            lat: center.lat,
            lon: center.lng,
            zoom: fromMapZoom(map.getZoom()),
          },
          bounds,
        );
      }
      const key = `${revision}:${map.getZoom()}:${Object.values(bounds)
        .map((v) => v.toFixed(9))
        .join(":")}`;
      if (requestedView === key) return;
      requestedView = key;
      const sequence = ++viewSequence;
      void explorer
        .viewport(revision, bounds, fromMapZoom(map.getZoom()))
        .then((value) => {
          if (
            disposed ||
            moving ||
            zooming ||
            !hasSize() ||
            sequence !== viewSequence ||
            revision !== props.result.revision ||
            requestCameraKey !== props.cameraRequest.key
          )
            return;
          if (!value) {
            requestedView = "";
            return;
          }
          render(value.features, revision);
          props.onViewport(value, requestCameraKey);
        })
        .catch((error) => {
          if (disposed || sequence !== viewSequence) return;
          if (requestedView === key) requestedView = "";
          fail(error);
        });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      if (disposed || !hasSize()) return;
      frame = requestAnimationFrame(update);
    };
    const fit = () => {
      const bounds = props.result.bounds;
      if (bounds) {
        if (bounds.west === bounds.east && bounds.north === bounds.south)
          map.jumpTo({
            center: [bounds.west, bounds.south],
            zoom: toMapZoom(16),
          });
        else
          map.fitBounds(
            [
              [bounds.west, bounds.south],
              [bounds.east, bounds.north],
            ],
            fitOptions(),
          );
      } else map.fitBounds(cityBounds, fitOptions());
    };
    const reconcileSize = () => {
      // Preserve the current center when the inline details panel changes width.
      const size = `${viewportWidth}:${viewportHeight}`;
      if (size === measuredSize) return;
      measuredSize = size;
      // MapLibre measures its container when resizing. Finish those reads before
      // changing inherited popup variables, which would invalidate its styles.
      map.resize();
      updateMinimumZoom();
      element.style.setProperty(
        "--map-popup-width",
        `${Math.max(100, viewportWidth - 24)}px`,
      );
      element.style.setProperty(
        "--map-popup-height",
        `${Math.max(40, Math.min(280, viewportHeight - 100))}px`,
      );
    };
    const applyCameraRequest = () => {
      if (disposed || !hasSize()) return;
      reconcileSize();
      const { cameraRequest: request, selectedId: id } = props;
      if (appliedCameraKey === request.key) return;
      const selected = id ? restaurants.get(id) : null;
      if (request.view) {
        const { lat, lon, zoom } = request.view;
        map.jumpTo({ center: [lon, lat], zoom: toMapZoom(zoom) });
      } else if (selected && hasCoordinates(selected)) {
        map.jumpTo({
          center: [selected.lon!, selected.lat!],
          zoom: initialized
            ? Math.max(toMapZoom(17), map.getZoom())
            : toMapZoom(17),
        });
      } else if (!selected || !initialized) {
        fit();
      }
      // A selected record without coordinates leaves an existing view intact.
      appliedCameraKey = request.key;
      renderSelection();
      requestedView = "";
      if (initialized) schedule();
    };
    const controls = {
      navigate() {
        interaction++;
        invalidateViewport();
        closePopup();
        cancelAnimationFrame(cameraFrame);
        if (!initialized || !hasSize()) return;
        map.stop();
        // Allow the new panel layout and resize
        // observers to settle before centering in the map's new dimensions.
        cameraFrame = requestAnimationFrame(() => {
          cameraFrame = requestAnimationFrame(applyCameraRequest);
        });
      },
      refresh() {
        interaction++;
        closePopup();
        if (!initialized || !hasSize()) return;
        schedule();
      },
    };
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    let currentStyle = "";
    const applyStyle = () => {
      const style = colorScheme.matches ? mapStyles.dark : mapStyles.light;
      if (style === currentStyle) return;
      currentStyle = style;
      tileError = false;
      renderStatus();
      map.setStyle(style, {
        transformStyle: (_previous, next) => ({
          ...next,
          layers: next.layers.map((layer) => {
            // Bright's data includes POI classes absent from its sprite sheet.
            // Keep their labels and use its generic symbol when an icon is missing.
            if (layer.type !== "symbol" || !layer.id.startsWith("poi"))
              return layer;
            const image = layer.layout?.["icon-image"];
            if (!Array.isArray(image)) return layer;
            return {
              ...layer,
              layout: {
                ...layer.layout,
                "icon-image": [
                  "coalesce",
                  ["image", image],
                  ["image", "circle"],
                ],
              },
            };
          }),
        }),
      });
    };
    const themeChanged = () => {
      if (!disposed && initialized) applyStyle();
    };
    colorScheme.addEventListener("change", themeChanged);
    map.on("error", () => {
      if (disposed) return;
      tileError = true;
      renderStatus();
    });
    map.on("style.load", () => {
      if (disposed) return;
      tileError = false;
      renderStatus();
    });
    const resume = () => {
      // A hidden initial mount waits for the observer, without polling frames.
      if (disposed || !hasSize()) return;
      applyCameraRequest();
      if (initialized) {
        renderSelection();
        schedule();
        return;
      }
      // Fit the data first, then request only the visible vector basemap.
      applyStyle();
      initialized = true;
      // Discard work for the previous view as soon as movement starts. Keep
      // its markers until a response for the settled camera is ready.
      map.on("zoomstart", () => {
        zooming = true;
        invalidateViewport();
      });
      map.on("movestart", () => {
        moving = true;
        interaction++;
        invalidateViewport();
      });
      map.on("zoomend", () => {
        zooming = false;
        schedule();
      });
      map.on("moveend", () => {
        moving = false;
        schedule();
      });
      map.on("resize", schedule);
      map.on("click", () => {
        interaction++;
      });
      update();
    };
    const firstFrame = requestAnimationFrame(resume);
    const observer = new ResizeObserver((entries) => {
      if (disposed) return;
      const entry = entries.find((value) => value.target === element);
      if (!entry) return;
      // The map has no padding or border, so its content box is its viewport.
      viewportWidth = Math.round(entry.contentRect.width);
      viewportHeight = Math.round(entry.contentRect.height);
      if (!hasSize()) {
        invalidateViewport();
        cancelAnimationFrame(cameraFrame);
        return;
      }
      resume();
    });
    observer.observe(element);
    return {
      ...controls,
      selection() {
        if (!initialized || !hasSize()) return;
        renderSelection();
        requestedView = "";
        schedule();
      },
      destroy() {
        disposed = true;
        cancelAnimationFrame(firstFrame);
        cancelAnimationFrame(frame);
        cancelAnimationFrame(cameraFrame);
        observer.disconnect();
        colorScheme.removeEventListener("change", themeChanged);
        closePopup();
        selectedMarker?.remove();
        for (const marker of markers.values()) marker.remove();
        markers.clear();
        map.remove();
      },
    };
  }

  let controls = mountMap();
  renderStatus();
  return {
    update(next: MapProps) {
      if (destroyed) return;
      const previous = props;
      props = next;
      if (
        next.explorer !== previous.explorer ||
        next.restaurants !== previous.restaurants
      ) {
        controls.destroy();
        tileError = false;
        controls = mountMap();
      } else {
        if (next.cameraRequest.key !== previous.cameraRequest.key)
          controls.navigate();
        if (next.selectedId !== previous.selectedId) controls.selection();
        if (next.result !== previous.result) controls.refresh();
      }
      renderStatus();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      controls.destroy();
      wrap.remove();
    },
  };
}
