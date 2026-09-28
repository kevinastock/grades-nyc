// Guard against truncated exports or an upstream schema/population change.
export const DATA_MINIMUMS = Object.freeze({
  restaurants: 10_000,
  violationTypes: 100,
});

export function validateDataHealth(summary, minimums = DATA_MINIMUMS) {
  const ids = Array.isArray(summary.restaurants)
    ? summary.restaurants.map((restaurant) => restaurant.id)
    : summary.restaurants.id;
  const counts = {
    restaurants: new Set(ids).size,
    violationTypes: new Set(
      summary.violations.map((violation) => violation.code),
    ).size,
  };
  for (const [key, label] of [
    ["restaurants", "restaurants"],
    ["violationTypes", "violation types"],
  ]) {
    if (!Number.isSafeInteger(minimums[key]) || minimums[key] < 0)
      throw new Error(`Invalid minimum for ${label}.`);
    if (counts[key] < minimums[key])
      throw new Error(
        `Data check failed: found ${counts[key].toLocaleString()} ${label}; expected at least ${minimums[key].toLocaleString()}. The previous snapshot has been preserved.`,
      );
  }
  return counts;
}
