export const SCHEMA_VERSION = 4;
export const MANIFEST_FILE = "manifest-v4.json";
export const LEGACY_SCHEMA_VERSION = 3;
export const LEGACY_MANIFEST_FILE = "manifest.json";
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

export function validateManifest(value, schemaVersion = SCHEMA_VERSION) {
  if (!value || value.schemaVersion !== schemaVersion)
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

const DICTIONARY_FIELDS = new Set([
  "borough",
  "zip",
  "cuisine",
  "grade",
  "closure",
]);

/** Losslessly compact repeated column values, retaining identifiers verbatim. */
export function encodeRestaurantColumns(rows, { compact = true } = {}) {
  const columns = Object.fromEntries(
    SUMMARY_FIELDS.map((field) => [field, []]),
  );
  for (const row of rows)
    for (const field of SUMMARY_FIELDS) columns[field].push(row[field]);
  if (!compact) return columns;
  const previous = new Map();
  for (const field of SUMMARY_FIELDS) {
    const values = columns[field];
    const serialized = JSON.stringify(values);
    if (field !== "id" && values.length) {
      if (previous.has(serialized)) {
        columns[field] = { ref: previous.get(serialized) };
      } else if (values.every((value) => value === values[0])) {
        const constant = { constant: values[0] };
        if (JSON.stringify(constant).length < serialized.length)
          columns[field] = constant;
      } else if (DICTIONARY_FIELDS.has(field)) {
        const dictionary = [],
          lookup = new Map();
        const indices = values.map((value) => {
          if (!lookup.has(value)) {
            lookup.set(value, dictionary.length);
            dictionary.push(value);
          }
          return lookup.get(value);
        });
        const encoded = { values: dictionary, indices };
        if (JSON.stringify(encoded).length < serialized.length)
          columns[field] = encoded;
      }
    }
    if (!previous.has(serialized)) previous.set(serialized, field);
  }
  return columns;
}

function validEncodedValue(field, value) {
  if (["lat", "lon"].includes(field))
    return value === null || Number.isFinite(value);
  if (field === "closure") return value === "none" || value === "uncertain";
  if (
    [
      "grade",
      "grade_date",
      "grade_inspected",
      "latest_date",
      "closed_date",
    ].includes(field)
  )
    return value === null || typeof value === "string";
  return typeof value === "string";
}

/** Validate compact shapes before expanding any column. Earlier-only references
 * make cycles impossible; row allocation is bounded by the plain ID column. */
function expandRestaurantColumns(columns, count) {
  const expanded = Object.create(null);
  if (
    !columns ||
    typeof columns !== "object" ||
    Array.isArray(columns) ||
    Object.keys(columns).length !== SUMMARY_FIELDS.length ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    !Array.isArray(columns.id) ||
    columns.id.length !== count
  )
    throw new Error("Invalid restaurant summary columns.");
  for (const field of SUMMARY_FIELDS) {
    if (!Object.hasOwn(columns, field))
      throw new Error("Invalid restaurant summary columns.");
    const column = columns[field];
    if (Array.isArray(column)) {
      if (column.length !== count)
        throw new Error("Invalid restaurant summary columns.");
      expanded[field] = column;
      continue;
    }
    if (!column || typeof column !== "object")
      throw new Error("Invalid restaurant summary columns.");
    const keys = Object.keys(column);
    if (keys.length === 1 && Object.hasOwn(column, "ref")) {
      if (
        typeof column.ref !== "string" ||
        !Object.hasOwn(expanded, column.ref)
      )
        throw new Error("Invalid restaurant summary column reference.");
      expanded[field] = expanded[column.ref];
    } else if (keys.length === 1 && Object.hasOwn(column, "constant")) {
      if (!validEncodedValue(field, column.constant))
        throw new Error("Invalid restaurant summary record.");
      expanded[field] = Array(count).fill(column.constant);
    } else if (
      keys.length === 2 &&
      Object.hasOwn(column, "values") &&
      Object.hasOwn(column, "indices")
    ) {
      if (
        !Array.isArray(column.values) ||
        !Array.isArray(column.indices) ||
        column.values.length > count ||
        (!column.values.length && count) ||
        column.indices.length !== count ||
        column.values.some((value) => !validEncodedValue(field, value)) ||
        column.indices.some(
          (index) =>
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= column.values.length,
        )
      )
        throw new Error("Invalid restaurant summary dictionary.");
      expanded[field] = column.indices.map((index) => column.values[index]);
    } else throw new Error("Invalid restaurant summary columns.");
  }
  return expanded;
}

/** Expand compact columns into the unchanged objects used by the UI. */
export function decodeRestaurantColumns(columns) {
  columns = expandRestaurantColumns(columns, columns?.id?.length);
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
    !Array.isArray(value.restaurants.id) ||
    value.restaurants.id.length !== manifest.summary.rows ||
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
      typeof row.id !== "string" ||
      typeof row.name !== "string" ||
      typeof row.borough !== "string" ||
      typeof row.address !== "string" ||
      typeof row.zip !== "string" ||
      typeof row.cuisine !== "string" ||
      typeof row.latest_codes !== "string" ||
      ids.has(row.id) ||
      (row.closure !== "none" && row.closure !== "uncertain") ||
      (row.lat !== null && !Number.isFinite(row.lat)) ||
      (row.lon !== null && !Number.isFinite(row.lon)) ||
      (row.grade !== null && typeof row.grade !== "string") ||
      (row.grade_date !== null && typeof row.grade_date !== "string") ||
      (row.grade_inspected !== null &&
        typeof row.grade_inspected !== "string") ||
      (row.latest_date !== null && typeof row.latest_date !== "string") ||
      (row.closed_date !== null && typeof row.closed_date !== "string")
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
