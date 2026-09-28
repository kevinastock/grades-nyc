export const SCHEMA_VERSION = 3;
export const DETAIL_BUCKETS = 256;
export const SUMMARY_FIELDS = [
  "id",
  "name",
  "borough",
  "address",
  "zip",
  "cuisine",
  "lat",
  "lon",
  "grade",
  "grade_date",
  "grade_inspected",
  "latest_date",
  "latest_codes",
  "closure",
  "closed_date",
];

/** Hash the string, not its numeric value: identifiers may have leading zeroes. */
export function detailBucket(id) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++)
    hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return (hash >>> 0) % DETAIL_BUCKETS;
}
export const bucketName = (index) =>
  `details-${index.toString(16).padStart(2, "0")}`;

export function validateManifest(value) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION)
    throw new Error("Unsupported data format. Regenerate the inspection data.");
  if (
    typeof value.snapshot !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.snapshot) ||
    !Number.isSafeInteger(value.rowCount) ||
    value.rowCount < 1 ||
    !Array.isArray(value.details) ||
    value.details.length !== DETAIL_BUCKETS
  )
    throw new Error("Invalid inspection data manifest.");
  for (const [name, asset] of [
    ["summary", value.summary],
    ...value.details.map((asset, index) => [bucketName(index), asset]),
  ]) {
    if (
      !asset ||
      typeof asset.file !== "string" ||
      !new RegExp(`^${name}-[a-f0-9]{64}\\.json$`).test(asset.file) ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes <= 0 ||
      !Number.isSafeInteger(asset.rows) ||
      asset.rows < 0
    )
      throw new Error(`Invalid ${name} data entry.`);
  }
  return value;
}

export const snapshotAssets = (manifest) => [
  manifest.summary,
  ...manifest.details,
];

/** Serialize each restaurant field once, preserving row order and null values. */
export function encodeRestaurantColumns(rows) {
  const columns = Object.fromEntries(
    SUMMARY_FIELDS.map((field) => [field, []]),
  );
  for (const row of rows)
    for (const field of SUMMARY_FIELDS) columns[field].push(row[field]);
  return columns;
}

/** Expand already shape-checked columns into the objects used by the UI. */
export function decodeRestaurantColumns(columns) {
  const rows = new Array(columns.id.length);
  for (let i = 0; i < rows.length; i++) {
    rows[i] = {
      id: columns.id[i],
      name: columns.name[i],
      borough: columns.borough[i],
      address: columns.address[i],
      zip: columns.zip[i],
      cuisine: columns.cuisine[i],
      lat: columns.lat[i],
      lon: columns.lon[i],
      grade: columns.grade[i],
      grade_date: columns.grade_date[i],
      grade_inspected: columns.grade_inspected[i],
      latest_date: columns.latest_date[i],
      latest_codes: columns.latest_codes[i],
      closure: columns.closure[i],
      closed_date: columns.closed_date[i],
    };
  }
  return rows;
}

export function validateSummary(value, manifest) {
  if (
    !value ||
    !value.restaurants ||
    typeof value.restaurants !== "object" ||
    Array.isArray(value.restaurants) ||
    Object.keys(value.restaurants).length !== SUMMARY_FIELDS.length ||
    SUMMARY_FIELDS.some(
      (field) =>
        !Object.hasOwn(value.restaurants, field) ||
        !Array.isArray(value.restaurants[field]) ||
        value.restaurants[field].length !== manifest.summary.rows,
    ) ||
    !Array.isArray(value.violations) ||
    !Array.isArray(value.definitions) ||
    !Array.isArray(value.cuisines) ||
    !Array.isArray(value.boroughs)
  )
    throw new Error("Invalid restaurant summary.");
  const restaurants = decodeRestaurantColumns(value.restaurants);
  const ids = new Set();
  for (const row of restaurants) {
    if (
      [
        "id",
        "name",
        "borough",
        "address",
        "zip",
        "cuisine",
        "latest_codes",
      ].some((key) => typeof row[key] !== "string") ||
      ids.has(row.id) ||
      !["none", "uncertain"].includes(row.closure) ||
      ["lat", "lon"].some(
        (key) => row[key] !== null && !Number.isFinite(row[key]),
      ) ||
      [
        "grade",
        "grade_date",
        "grade_inspected",
        "latest_date",
        "closed_date",
      ].some((key) => row[key] !== null && typeof row[key] !== "string")
    )
      throw new Error("Invalid restaurant summary record.");
    ids.add(row.id);
  }
  for (const definition of [...value.definitions, ...value.violations]) {
    if (
      !definition ||
      typeof definition.code !== "string" ||
      (definition.description !== null &&
        typeof definition.description !== "string") ||
      ![true, false, null].includes(definition.critical)
    )
      throw new Error("Invalid violation definition.");
  }
  if (
    value.violations.some(
      (v) =>
        !Number.isSafeInteger(v.occurrences) ||
        v.occurrences < 0 ||
        typeof v.critical_varies !== "boolean",
    ) ||
    [...value.cuisines, ...value.boroughs].some((s) => typeof s !== "string")
  )
    throw new Error("Invalid restaurant catalog.");
  return { ...value, restaurants };
}

/** Expand immutable, ordered tuples, retaining nulls and historical variants. */
export function decodeInspections(rows, definitions) {
  if (!Array.isArray(rows)) throw new Error("Invalid inspection history.");
  return rows.map((row) => {
    if (
      !Array.isArray(row) ||
      row.length !== 8 ||
      row.slice(0, 3).some((s) => typeof s !== "string") ||
      row.slice(3, 5).some((s) => s !== null && typeof s !== "string") ||
      (row[5] !== null && !Number.isFinite(row[5])) ||
      !Number.isSafeInteger(row[6]) ||
      row[6] < 0 ||
      !Array.isArray(row[7])
    )
      throw new Error("Invalid inspection history record.");
    return {
      inspected: row[0],
      inspection_type: row[1],
      action: row[2],
      grade: row[3],
      grade_date: row[4],
      score: row[5],
      score_variants: row[6],
      findings: row[7].map((id) => {
        if (!Number.isSafeInteger(id) || id < 1 || id > definitions.length)
          throw new Error("Invalid historical violation reference.");
        return definitions[id - 1];
      }),
    };
  });
}
