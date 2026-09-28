import { hasCoordinates } from "./model.mjs";

// A restaurant without a usable pin cannot be ruled out by the map viewport.
export function inMapBounds(restaurant, bounds) {
  if (!bounds || !hasCoordinates(restaurant)) return true;
  return (
    restaurant.lon >= bounds.west &&
    restaurant.lon <= bounds.east &&
    restaurant.lat >= bounds.south &&
    restaurant.lat <= bounds.north
  );
}

/** Prefer visible pins, then other usable locations, preserving each group's order. */
export function locatedFirst(restaurants, bounds = null) {
  const visible = [],
    outside = [],
    unlocated = [];
  for (const restaurant of restaurants) {
    if (!hasCoordinates(restaurant)) unlocated.push(restaurant);
    else if (inMapBounds(restaurant, bounds)) visible.push(restaurant);
    else outside.push(restaurant);
  }
  return [...visible, ...outside, ...unlocated];
}
