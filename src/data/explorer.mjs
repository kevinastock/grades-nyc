import Supercluster from "supercluster";
import {
  createScoredRestaurantSearch,
  rankRestaurantSearch,
} from "./search.mjs";
import { hasCoordinates } from "./model.mjs";
import { inMapBounds, locatedFirst, MAX_MAP_ZOOM } from "./map.mjs";

/** All dataset-wide interactive work stays here, outside the browser UI thread. */
export function createExplorer(restaurants) {
  const defaultRestaurants = locatedFirst(restaurants);
  let search;
  let lastTerm = "";
  let searched = defaultRestaurants;
  let scored = [];
  let filteredScores = [];
  let filtered = defaultRestaurants;
  let revision = -1;
  let cluster;
  const codes = new Map(
    restaurants.map((r) => [
      r.id,
      new Set(r.latest_codes.split(",").filter(Boolean)),
    ]),
  );
  return {
    query(nextRevision, criteria) {
      const term = criteria.search.trim();
      if (term !== lastTerm) {
        search ??= createScoredRestaurantSearch(restaurants);
        scored = term ? search(term) : [];
        searched = term ? rankRestaurantSearch(scored) : defaultRestaurants;
        lastTerm = term;
      }
      const selected = criteria.selected || [];
      filtered = searched.filter(
        (r) =>
          (!criteria.borough || r.borough === criteria.borough) &&
          (!criteria.cuisine || r.cuisine === criteria.cuisine) &&
          (!criteria.grade ||
            (criteria.grade === "pending"
              ? ["P", "Z"].includes(r.grade)
              : criteria.grade === "none"
                ? !r.grade
                : r.grade === criteria.grade)) &&
          (!criteria.watchFilter ||
            !selected.length ||
            selected.some((code) => codes.get(r.id).has(code)) ===
              (criteria.watchFilter === "flagged")),
      );
      if (term) {
        const ids = new Set(filtered.map((r) => r.id));
        filteredScores = scored.filter(({ restaurant }) =>
          ids.has(restaurant.id),
        );
      } else filteredScores = [];
      const points = filtered.filter(hasCoordinates);
      // A 24px radius keeps adjacent 28px restaurant pins separate sooner.
      // Continue clustering at the closest zoom so coincident pins stay selectable.
      cluster = new Supercluster({
        radius: 24,
        extent: 256,
        maxZoom: MAX_MAP_ZOOM,
      });
      cluster.load(
        points.map((r) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [r.lon, r.lat] },
          properties: { id: r.id },
        })),
      );
      revision = nextRevision;
      const bounds = points.length
        ? {
            west: Infinity,
            south: Infinity,
            east: -Infinity,
            north: -Infinity,
          }
        : null;
      for (const r of points) {
        bounds.west = Math.min(bounds.west, r.lon);
        bounds.east = Math.max(bounds.east, r.lon);
        bounds.south = Math.min(bounds.south, r.lat);
        bounds.north = Math.max(bounds.north, r.lat);
      }
      return {
        revision,
        ids: filtered.map((r) => r.id),
        mapped: points.length,
        unmapped: filtered.length - points.length,
        bounds,
      };
    },
    viewport(expectedRevision, bounds, zoom) {
      if (!cluster || revision !== expectedRevision) return null;
      const ranked = lastTerm
        ? rankRestaurantSearch(filteredScores, bounds)
        : locatedFirst(filtered, bounds);
      let visibleMapped = 0;
      for (const restaurant of filtered) {
        if (hasCoordinates(restaurant) && inMapBounds(restaurant, bounds))
          visibleMapped++;
      }
      return {
        revision,
        ids: ranked.map((r) => r.id),
        visibleMapped,
        features: cluster.getClusters(
          [bounds.west, bounds.south, bounds.east, bounds.north],
          Math.floor(zoom),
        ),
      };
    },
    expand(expectedRevision, clusterId) {
      if (!cluster || revision !== expectedRevision) return null;
      const zoom = cluster.getClusterExpansionZoom(clusterId);
      return {
        revision,
        zoom,
        ids:
          zoom > MAX_MAP_ZOOM
            ? cluster
                .getLeaves(clusterId, Infinity)
                .map((point) => point.properties.id)
            : [],
      };
    },
  };
}
