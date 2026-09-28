import {
  validateManifest,
  validateSummary,
  decodeInspections,
  detailBucket,
} from "./manifest.mjs";

async function fetchJson(url, asset, signal) {
  const response = await fetch(url, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
      : AbortSignal.timeout(60_000),
    ...(asset ? {} : { cache: "no-cache" }),
  });
  if (!response.ok) {
    const error = new Error(
      `Inspection data could not be loaded (${response.status}). Please try again.`,
    );
    error.status = response.status;
    throw error;
  }
  const bytes = await response.arrayBuffer();
  if (asset && bytes.byteLength !== asset.bytes)
    throw new Error("Inspection data is incomplete. Please try again.");
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Inspection data is invalid. Please try again.");
  }
}

function remember(cache, key, value, limit) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) cache.delete(cache.keys().next().value);
  return value;
}

/** One manifest pins the summary and every subsequent history request. */
export async function loadDataFiles(baseUrl, signal, initialRestaurantId) {
  const manifest = validateManifest(
    await fetchJson(`${baseUrl}manifest.json`, null, signal),
  );
  const buckets = new Map();
  const details = new Map();
  const pendingBuckets = new Map();
  const bucket = (index) => {
    if (buckets.has(index))
      return Promise.resolve(remember(buckets, index, buckets.get(index), 16));
    if (pendingBuckets.has(index)) return pendingBuckets.get(index);
    const asset = manifest.details[index];
    const promise = fetchJson(`${baseUrl}${asset.file}`, asset, signal)
      .then((value) => {
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Object.values(value).some((rows) => !Array.isArray(rows)) ||
          Object.values(value).reduce((n, rows) => n + rows.length, 0) !==
            asset.rows ||
          Object.keys(value).some((id) => detailBucket(id) !== index)
        )
          throw new Error("Invalid inspection history file.");
        return remember(buckets, index, value, 16);
      })
      .catch(async (error) => {
        if (error.status === 404 || error.status === 410) {
          // A deployment may prune older shards. Never mix their replacement into
          // this snapshot: offer a reload instead of retrying a dead URL forever.
          let current;
          try {
            current = validateManifest(
              await fetchJson(`${baseUrl}manifest.json`, null, signal),
            );
          } catch {
            /* Preserve the original, retryable request error. */
          }
          if (
            current &&
            (current.summary.file !== manifest.summary.file ||
              current.details[index].file !== asset.file)
          ) {
            const expired = new Error(
              "A newer inspection snapshot is available. Reload to see this restaurant’s history.",
            );
            expired.code = "SNAPSHOT_EXPIRED";
            throw expired;
          }
        }
        throw error;
      })
      .finally(() => pendingBuckets.delete(index));
    pendingBuckets.set(index, promise);
    return promise;
  };
  // Shared links can fetch their small history shard alongside the summary.
  if (initialRestaurantId)
    void bucket(detailBucket(initialRestaurantId)).catch(() => {});
  const summary = validateSummary(
    await fetchJson(
      `${baseUrl}${manifest.summary.file}`,
      manifest.summary,
      signal,
    ),
    manifest,
  );
  const restaurants = new Map(summary.restaurants.map((row) => [row.id, row]));
  return {
    manifest,
    data: {
      restaurants: summary.restaurants,
      violations: summary.violations,
      cuisines: summary.cuisines,
      boroughs: summary.boroughs,
      snapshot: manifest.snapshot,
      rowCount: manifest.rowCount,
    },
    async getInspections(id) {
      if (details.has(id)) return remember(details, id, details.get(id), 128);
      const restaurant = restaurants.get(id);
      if (!restaurant) throw new Error("Restaurant is not in this snapshot.");
      if (!restaurant.latest_date) return [];
      const index = detailBucket(id);
      const file = await bucket(index);
      try {
        if (!Object.hasOwn(file, id) || !file[id].length)
          throw new Error(
            "Restaurant inspection history is missing. Please try again.",
          );
        return remember(
          details,
          id,
          decodeInspections(file[id], summary.definitions),
          128,
        );
      } catch (error) {
        // Bad data must be retryable, just like failed HTTP requests.
        buckets.delete(index);
        throw error;
      }
    },
  };
}
