import L from "leaflet";
import "leaflet/dist/leaflet.css";
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
import { titleCase } from "../data/presentation.mjs";
import { gradeImage, icon } from "./shared";

export type MapCamera = { lat: number; lon: number; zoom: number };
export type CameraRequest = { key: string; view: MapCamera | null };

export type MapProps = {
  explorer: ExplorerClient;
  result: QueryResult;
  restaurants: Map<string, Restaurant>;
  selectedId: string | null;
  cameraRequest: CameraRequest;
  onCamera: (
    camera: MapCamera,
    bounds: { west: number; south: number; east: number; north: number },
  ) => void;
  onSelect: (id: string) => void;
  onViewport: (value: ViewportResult, cameraKey: string) => void;
  onError: (error: Error) => void;
};

/** Mount one map; update its inputs without replacing Leaflet or its DOM. */
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
  const fitButton = document.createElement("button");
  fitButton.type = "button";
  fitButton.className = "icon";
  fitButton.setAttribute("aria-label", "Fit results");
  fitButton.title = "Fit results";
  fitButton.dataset.variant = "secondary";
  fitButton.append(icon("maximize"));
  const message = document.createElement("div");
  message.className = "map-message";
  message.setAttribute("role", "alert");
  message.dataset.variant = "warning";
  toolbar.append(fitButton);
  wrap.append(element, toolbar, message);
  host.replaceChildren(wrap);

  function renderStatus() {
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
    // No default view or tiles: fit the actual data before starting tile requests.
    const map = L.map(element, {
      maxZoom: 19,
      maxBoundsViscosity: 1,
      bounceAtZoomLimits: false,
      // ResizeObserver handles sizing and can ignore hidden containers.
      trackResize: false,
    });
    const zoomControls = map.zoomControl.getContainer();
    zoomControls
      ?.querySelector(".leaflet-control-zoom-in")
      ?.replaceChildren(icon("plus"));
    zoomControls
      ?.querySelector(".leaflet-control-zoom-out")
      ?.replaceChildren(icon("minus"));
    map.on("popupopen", (event: L.PopupEvent) => {
      event.popup
        .getElement()
        ?.querySelector(".leaflet-popup-close-button")
        ?.replaceChildren(icon("x"));
    });
    // Search results must not change the citywide navigation limits.
    const cityBounds = L.latLngBounds(
      [...restaurants.values()]
        .filter(hasCoordinates)
        .map((r) => [r.lat!, r.lon!] as L.LatLngTuple),
    );
    if (!cityBounds.isValid())
      cityBounds.extend([40.4995, -74.2492]).extend([40.9129, -73.7009]);
    // Leave room to reach edge restaurants without clipping their markers.
    const navigationBounds = cityBounds.pad(0.05);
    const hasSize = () => element.clientWidth > 0 && element.clientHeight > 0;
    const fitOptions = () => ({
      padding: L.point(
        Math.min(35, (element.clientWidth - 1) / 2),
        Math.min(35, (element.clientHeight - 1) / 2),
      ),
      maxZoom: 16,
      animate: false,
    });
    const constrainPan = () => {
      if (!hasSize()) return;
      const zoom = map.getZoom();
      const northWest = map.project(navigationBounds.getNorthWest(), zoom);
      const southEast = map.project(navigationBounds.getSouthEast(), zoom);
      const center = northWest.add(southEast).divideBy(2);
      const halfView = map.getSize().divideBy(2);
      // At the overview, the viewport can be wider than NYC. Expand only those
      // axes enough to fit it, avoiding reversed Leaflet drag limits. As users
      // zoom in, the permitted extent contracts to the city's bounds.
      const limits = L.bounds(northWest, southEast)
        .extend(center.subtract(halfView).subtract([1, 1]))
        .extend(center.add(halfView).add([1, 1]));
      const bounds = L.latLngBounds(
        map.unproject(limits.min!),
        map.unproject(limits.max!),
      );
      map.setMaxBounds(bounds);
      // Complete any edge correction before the first tile layer is attached.
      map.panInsideBounds(bounds, { animate: false });
    };
    const updateMinimumZoom = () => {
      // getBoundsZoom otherwise clamps to the previous minimum on a resize.
      map.setMinZoom(0);
      map.setMinZoom(
        Math.min(
          16,
          map.getBoundsZoom(
            cityBounds,
            false,
            fitOptions().padding.multiplyBy(2),
          ),
        ),
      );
    };
    const layer = L.layerGroup().addTo(map);
    const markers = new Map<string, L.Layer>();
    let disposed = false;
    let initialized = false;
    let measuredSize = L.point(0, 0);
    let frame = 0;
    let cameraFrame = 0;
    let appliedCameraKey: string | null = null;
    let reportedCamera = "";
    let selectedMarker: L.Marker | null = null;
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
      map.closePopup();
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
      if (selectedMarker) map.removeLayer(selectedMarker);
      selectedMarker = null;
      if (!id) return;
      const restaurant = restaurants.get(id);
      if (!restaurant || !hasCoordinates(restaurant)) return;
      // Selected places remain visible independently of the cluster index.
      const ordinary = markers.get(`restaurant-${id}`);
      if (ordinary) {
        layer.removeLayer(ordinary);
        markers.delete(`restaurant-${id}`);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.append(gradeImage(restaurant.grade));
      button.setAttribute("aria-label", `Selected: ${label(restaurant)}`);
      button.setAttribute("aria-pressed", "true");
      const tooltip = document.createElement("span");
      tooltip.textContent = titleCase(restaurant.name);
      selectedMarker = L.marker([restaurant.lat!, restaurant.lon!], {
        title: `Selected: ${label(restaurant)}`,
        keyboard: false,
        zIndexOffset: 1000,
        icon: L.divIcon({
          className: "map-selected",
          html: button,
          iconSize: [38, 38],
          iconAnchor: [19, 19],
        }),
      })
        .bindTooltip(tooltip, {
          permanent: true,
          direction: "top",
          offset: [0, -20],
          className: "map-selected-tooltip",
        })
        .on("click", () => select(restaurant.id))
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
          button.textContent = p.point_count.toLocaleString();
          button.setAttribute("aria-label", `${p.point_count} restaurants`);
          const marker = L.marker([lat, lon], {
            keyboard: false,
            icon: L.divIcon({
              className: "map-cluster",
              html: button,
              iconSize: [44, 44],
              iconAnchor: [22, 22],
            }),
          });
          marker.on("click", () => {
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
                if (expanded.zoom <= 17) {
                  map.setView([lat, lon], expanded.zoom);
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
                L.popup({ maxWidth: 330, maxHeight: 280 })
                  .setLatLng([lat, lon])
                  .setContent(list)
                  .openOn(map);
              })
              .catch(fail);
          });
          marker.addTo(layer);
          markers.set(key, marker);
        } else {
          const restaurant = restaurants.get(p.id);
          if (!restaurant) continue;
          button.setAttribute("aria-label", label(restaurant));
          button.append(gradeImage(restaurant.grade));
          intent(button, restaurant.id);
          const marker = L.marker([lat, lon], {
            title: label(restaurant),
            keyboard: false,
            icon: L.divIcon({
              className: "map-restaurant",
              html: button,
              iconSize: [28, 28],
              iconAnchor: [14, 14],
            }),
          });
          const tooltip = document.createElement("span");
          tooltip.textContent = label(restaurant);
          marker
            .bindTooltip(tooltip)
            .on("click", () => select(restaurant.id))
            .addTo(layer);
          markers.set(key, marker);
        }
      }
      for (const [key, marker] of markers) {
        if (!visible.has(key)) {
          layer.removeLayer(marker);
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
          { lat: center.lat, lon: center.lng, zoom: map.getZoom() },
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
        .viewport(revision, bounds, map.getZoom())
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
          map.setView([bounds.south, bounds.west], 16, { animate: false });
        else
          map.fitBounds(
            [
              [bounds.south, bounds.west],
              [bounds.north, bounds.east],
            ],
            fitOptions(),
          );
      } else map.fitBounds(cityBounds, fitOptions());
    };
    const reconcileSize = () => {
      // Preserve the current center when the inline details panel changes width.
      map.invalidateSize({ pan: true, animate: false });
      const size = map.getSize();
      if (size.equals(measuredSize)) return;
      measuredSize = size;
      updateMinimumZoom();
      if (initialized) constrainPan();
    };
    const applyCameraRequest = () => {
      if (disposed || !hasSize()) return;
      reconcileSize();
      const { cameraRequest: request, selectedId: id } = props;
      if (appliedCameraKey === request.key) return;
      const selected = id ? restaurants.get(id) : null;
      if (request.view) {
        const { lat, lon, zoom } = request.view;
        map.setView([lat, lon], zoom, { animate: false });
      } else if (selected && hasCoordinates(selected)) {
        map.setView(
          [selected.lat!, selected.lon!],
          initialized ? Math.max(17, map.getZoom()) : 17,
          { animate: false },
        );
      } else if (!selected || !initialized) {
        fit();
      }
      // A selected record without coordinates leaves an existing view intact.
      constrainPan();
      appliedCameraKey = request.key;
      renderSelection();
      requestedView = "";
      if (initialized) schedule();
    };
    const controls = {
      navigate() {
        interaction++;
        invalidateViewport();
        map.closePopup();
        cancelAnimationFrame(cameraFrame);
        if (!initialized || !hasSize()) return;
        map.stop();
        // Allow the new panel layout and resize
        // observers to settle before centering in the map's new dimensions.
        cameraFrame = requestAnimationFrame(() => {
          cameraFrame = requestAnimationFrame(applyCameraRequest);
        });
      },
      refresh(shouldFit: boolean) {
        interaction++;
        map.closePopup();
        if (!initialized || !hasSize()) return;
        if (shouldFit) {
          fit();
          constrainPan();
        }
        schedule();
      },
    };
    const resume = () => {
      // A hidden initial mount waits for the observer, without polling frames.
      if (disposed || !hasSize()) return;
      applyCameraRequest();
      if (initialized) {
        renderSelection();
        schedule();
        return;
      }
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
      })
        .on("tileerror", () => {
          if (!disposed) {
            tileError = true;
            renderStatus();
          }
        })
        .addTo(map);
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
        constrainPan();
        schedule();
      });
      map.on("moveend", () => {
        moving = false;
        schedule();
      });
      map.on("resize", schedule);
      map.on("popupclose click", () => {
        interaction++;
      });
      update();
    };
    const firstFrame = requestAnimationFrame(resume);
    const observer = new ResizeObserver(() => {
      if (disposed) return;
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
        map.remove();
      },
    };
  }

  let controls = mountMap();
  fitButton.addEventListener("click", () => controls.refresh(true));
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
        if (next.result !== previous.result) controls.refresh(false);
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
