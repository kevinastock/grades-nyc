import Fuse from "fuse.js";
import { hasCoordinates } from "./model.mjs";
import { inMapBounds } from "./map.mjs";

const UNLOCATED_SCORE_PENALTY = 0.02;
const VIEWPORT_SCORE_BONUS = 0.04;

// Normalize once when indexing, so punctuation and accents do not penalize names.
const normalize = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Cache these scored matches so panning never needs to run Fuse again. */
export function createScoredRestaurantSearch(restaurants) {
  const entries = restaurants.map((restaurant) => ({
    restaurant,
    name: normalize(restaurant.name),
    address: normalize(restaurant.address),
    id: restaurant.id,
    locationPenalty: hasCoordinates(restaurant) ? 0 : UNLOCATED_SCORE_PENALTY,
  }));
  const index = new Fuse(entries, {
    keys: [
      { name: "name", weight: 0.85 },
      { name: "address", weight: 0.1 },
      { name: "id", weight: 0.05 },
    ],
    threshold: 0.32,
    ignoreLocation: true,
    includeScore: true,
  });
  return (query) => {
    const term = normalize(query);
    if (!term) return [];
    const priority = (item) =>
      item.name === term || item.id === term
        ? 0
        : item.name.startsWith(term)
          ? 1
          : item.name.includes(term)
            ? 2
            : item.address.includes(term)
              ? 3
              : 4;
    return index.search(term).map(({ item, score }) => ({
      restaurant: item.restaurant,
      priority: priority(item),
      score: (score ?? 1) + item.locationPenalty,
    }));
  };
}

/** Geography only breaks close relevance contests within a name-match class. */
export function rankRestaurantSearch(matches, bounds = null) {
  const score = ({ restaurant, score }) =>
    score -
    (bounds && hasCoordinates(restaurant) && inMapBounds(restaurant, bounds)
      ? VIEWPORT_SCORE_BONUS
      : 0);
  return [...matches]
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        score(a) - score(b) ||
        (b.restaurant.latest_date || "").localeCompare(
          a.restaurant.latest_date || "",
        ) ||
        a.restaurant.id.localeCompare(b.restaurant.id),
    )
    .map(({ restaurant }) => restaurant);
}

export function createRestaurantSearch(restaurants) {
  const search = createScoredRestaurantSearch(restaurants);
  return (query, bounds = null) => rankRestaurantSearch(search(query), bounds);
}
