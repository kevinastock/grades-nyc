// Happy DOM has no WebGL. Replace only the rendering boundary; use MapLibre's
// real geographic utilities and drive camera events explicitly in the tests.
import {
  LngLat,
  LngLatBounds,
  MercatorCoordinate,
} from "maplibre-gl/dist/maplibre-gl.mjs";

export { LngLatBounds, MercatorCoordinate };
export const workerUrls = [];
export function setWorkerUrl(url) {
  workerUrls.push(url);
}

class Evented {
  listeners = new globalThis.Map();
  on(type, callback) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(callback);
    this.listeners.set(type, listeners);
    return this;
  }
  off(type, callback) {
    this.listeners.get(type)?.delete(callback);
    return this;
  }
  fire(type, details = {}) {
    for (const callback of [...(this.listeners.get(type) || [])])
      callback({ type, target: this, ...details });
    return this;
  }
}

export class Map extends Evented {
  static instances = [];
  markers = new Set();
  styles = [];
  styleOptions = [];
  controls = [];
  resizeCalls = 0;
  pans = [];
  removed = false;
  moving = false;
  dragRotate = { disable() {} };
  touchZoomRotate = { disableRotation() {} };
  touchPitch = { disable() {} };
  keyboard = { disableRotation() {} };
  constructor(options) {
    super();
    Map.instances.push(this);
    this.options = options;
    this.container = options.container;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "maplibregl-canvas";
    this.container.append(this.canvas);
    this.center = LngLat.convert(options.center || [0, 0]);
    this.zoom = options.zoom || 0;
    this.minZoom = options.minZoom || 0;
    this.maxZoom = options.maxZoom || 24;
    if (options.style) this.setStyle(options.style);
  }
  getContainer() {
    return this.container;
  }
  getCanvas() {
    return this.canvas;
  }
  getCenter() {
    return new LngLat(this.center.lng, this.center.lat);
  }
  getZoom() {
    return this.zoom;
  }
  getMinZoom() {
    return this.minZoom;
  }
  getMaxZoom() {
    return this.maxZoom;
  }
  isMoving() {
    return this.moving;
  }
  isZooming() {
    return this.zooming;
  }
  setMinZoom(zoom) {
    this.minZoom = zoom;
    return this;
  }
  setMaxBounds(bounds) {
    this.maxBounds = bounds;
    return this;
  }
  setStyle(style, options) {
    this.styles.push(style);
    this.styleOptions.push(options);
    this.style = style;
    return this;
  }
  addControl(control, position) {
    this.controls.push({ control, position });
    this.container.append(control.onAdd(this));
    return this;
  }
  getBounds() {
    const point = MercatorCoordinate.fromLngLat(this.center);
    const scale = 512 * 2 ** this.zoom;
    const halfWidth = this.container.clientWidth / (2 * scale);
    const halfHeight = this.container.clientHeight / (2 * scale);
    return new LngLatBounds(
      new MercatorCoordinate(
        point.x - halfWidth,
        point.y + halfHeight,
      ).toLngLat(),
      new MercatorCoordinate(
        point.x + halfWidth,
        point.y - halfHeight,
      ).toLngLat(),
    );
  }
  cameraForBounds(bounds, options = {}) {
    const box = LngLatBounds.convert(bounds);
    const nw = MercatorCoordinate.fromLngLat(box.getNorthWest());
    const se = MercatorCoordinate.fromLngLat(box.getSouthEast());
    const pad = options.padding || 0;
    const horizontal = typeof pad === "number" ? 2 * pad : pad.left + pad.right;
    const vertical = typeof pad === "number" ? 2 * pad : pad.top + pad.bottom;
    const scale = Math.min(
      (this.container.clientWidth - horizontal) / (se.x - nw.x),
      (this.container.clientHeight - vertical) / (se.y - nw.y),
    );
    return {
      center: new MercatorCoordinate(
        (nw.x + se.x) / 2,
        (nw.y + se.y) / 2,
      ).toLngLat(),
      zoom: Math.min(options.maxZoom ?? this.maxZoom, Math.log2(scale / 512)),
    };
  }
  fitBounds(bounds, options = {}) {
    return this.jumpTo(this.cameraForBounds(bounds, options));
  }
  jumpTo(options) {
    const zooming = options.zoom !== undefined && options.zoom !== this.zoom;
    this.beginMove(zooming);
    this.setCamera(options);
    this.finishMove();
    return this;
  }
  easeTo(options) {
    this.beginMove(options.zoom !== undefined && options.zoom !== this.zoom);
    this.setCamera(options);
    return this;
  }
  panBy(offset) {
    this.pans.push(offset);
    const point = MercatorCoordinate.fromLngLat(this.center);
    const scale = 512 * 2 ** this.zoom;
    return this.jumpTo({
      center: new MercatorCoordinate(
        point.x + offset[0] / scale,
        point.y + offset[1] / scale,
      ).toLngLat(),
    });
  }
  setCamera(options) {
    if (options.center) this.center = LngLat.convert(options.center);
    if (options.zoom !== undefined) this.zoom = options.zoom;
    this.fire("move");
    if (this.zooming) this.fire("zoom");
  }
  beginMove(zooming = false) {
    this.moving = true;
    this.zooming = zooming;
    this.fire("movestart");
    if (zooming) this.fire("zoomstart");
  }
  finishMove() {
    if (!this.moving) return;
    if (this.zooming) {
      this.zooming = false;
      this.fire("zoomend");
    }
    this.moving = false;
    this.fire("moveend");
  }
  stop() {
    this.finishMove();
    return this;
  }
  resize() {
    this.resizeCalls++;
    this.fire("resize");
    return this;
  }
  remove() {
    this.removed = true;
    for (const marker of [...this.markers]) marker.remove();
    this.listeners.clear();
    this.container.replaceChildren();
  }
}

export class NavigationControl {
  constructor(options) {
    this.options = options;
  }
  onAdd(map) {
    const control = document.createElement("div");
    control.className = "maplibregl-ctrl maplibregl-ctrl-group";
    for (const [direction, delta] of [
      ["in", 1],
      ["out", -1],
    ]) {
      const button = document.createElement("button");
      button.className = `maplibregl-ctrl-zoom-${direction}`;
      button.setAttribute("aria-label", `Zoom ${direction}`);
      button.addEventListener("click", () =>
        map.easeTo({ zoom: map.getZoom() + delta }),
      );
      control.append(button);
    }
    return control;
  }
}

export class Marker {
  constructor(options) {
    this.element = options.element;
    this.options = options;
  }
  setLngLat(value) {
    this.lngLat = LngLat.convert(value);
    return this;
  }
  getLngLat() {
    return this.lngLat;
  }
  getElement() {
    return this.element;
  }
  addTo(map) {
    this.map = map;
    map.markers.add(this);
    map.getContainer().append(this.element);
    return this;
  }
  remove() {
    this.map?.markers.delete(this);
    this.element.remove();
    return this;
  }
}

export class Popup extends Evented {
  static instances = [];
  constructor(options) {
    super();
    this.options = options;
    this.element = document.createElement("div");
    this.element.className = "maplibregl-popup";
    const close = document.createElement("button");
    close.className = "maplibregl-popup-close-button";
    close.addEventListener("click", () => this.remove());
    this.element.append(close);
    Popup.instances.push(this);
  }
  setLngLat(value) {
    this.lngLat = LngLat.convert(value);
    return this;
  }
  setDOMContent(element) {
    this.element.append(element);
    return this;
  }
  setMaxWidth(value) {
    this.maxWidth = value;
    return this;
  }
  getElement() {
    return this.element;
  }
  isOpen() {
    return this.element.isConnected;
  }
  addTo(map) {
    this.map = map;
    map.getContainer().append(this.element);
    this.fire("open");
    return this;
  }
  remove() {
    this.element.remove();
    this.fire("close");
    return this;
  }
}
