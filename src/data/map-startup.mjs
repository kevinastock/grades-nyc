import { hasCoordinates } from "./model.mjs";

const fallbackBounds = [-74.2492, 40.4995, -73.7009, 40.9129];

/** The same unpadded bounds are used for the initial and loaded city overview. */
export function restaurantBounds(restaurants) {
  let west = Infinity,
    south = Infinity,
    east = -Infinity,
    north = -Infinity;
  for (const restaurant of restaurants) {
    if (!hasCoordinates(restaurant)) continue;
    west = Math.min(west, restaurant.lon);
    south = Math.min(south, restaurant.lat);
    east = Math.max(east, restaurant.lon);
    north = Math.max(north, restaurant.lat);
  }
  return Number.isFinite(west)
    ? [west, south, east, north]
    : [...fallbackBounds];
}

export function startupMapBounds() {
  const startup = globalThis.__gradesMapBounds;
  const bounds = startup?.bounds;
  return /^summary-[a-f0-9]{64}\.json$/.test(startup?.summary || "") &&
    Array.isArray(bounds) &&
    bounds.length === 4 &&
    bounds.every(Number.isFinite) &&
    bounds[0] >= -180 &&
    bounds[2] <= 180 &&
    bounds[1] >= -90 &&
    bounds[3] <= 90 &&
    bounds[0] <= bounds[2] &&
    bounds[1] <= bounds[3]
    ? [...bounds]
    : [...fallbackBounds];
}
