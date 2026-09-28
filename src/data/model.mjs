export function codesFor(restaurant, scope = "recent") {
  const codes =
    scope === "history"
      ? restaurant.history_codes
      : scope === "latest"
        ? restaurant.latest_codes
        : [restaurant.latest_codes, restaurant.grade_codes]
            .filter(Boolean)
            .join(",");
  return new Set((codes || "").split(",").filter(Boolean));
}
export function matchingCodes(restaurant, selected, scope = "recent") {
  const codes = codesFor(restaurant, scope);
  return selected.filter((code) => codes.has(code));
}
export function hasCoordinates(restaurant) {
  return (
    Number.isFinite(restaurant.lat) &&
    Number.isFinite(restaurant.lon) &&
    restaurant.lat > 40.4 &&
    restaurant.lat < 41.0 &&
    restaurant.lon > -74.3 &&
    restaurant.lon < -73.6
  );
}
export function restaurantLinks(restaurant) {
  const address = [restaurant.address, restaurant.borough, "NY", restaurant.zip]
    .filter(Boolean)
    .join(", ");
  const query = encodeURIComponent(`${restaurant.name} ${address}`);
  const addressQuery = encodeURIComponent(address);
  return {
    abcEats: `https://a816-health.nyc.gov/ABCEatsRestaurants/#!/Search/${encodeURIComponent(restaurant.id)}`,
    googleSearch: `https://www.google.com/search?q=${query}`,
    googleAddress: `https://www.google.com/maps/search/?api=1&query=${addressQuery}`,
    appleAddress: `https://maps.apple.com/?q=${addressQuery}`,
  };
}
