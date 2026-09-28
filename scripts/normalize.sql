-- The converter supplies raw with validated dates/numbers and string identifiers.
CREATE VIEW records AS SELECT
  trim(CAMIS) AS id, coalesce(nullif(trim(DBA), ''), 'Unnamed restaurant') AS name,
  coalesce(nullif(nullif(trim(BORO), '0'), ''), 'Unknown') AS borough,
  trim(concat_ws(' ', BUILDING, STREET)) AS address,
  coalesce(ZIPCODE, '') AS zip, coalesce(PHONE, '') AS phone,
  coalesce("CUISINE DESCRIPTION", 'Not specified') AS cuisine,
  nullif("INSPECTION DATE", DATE '1900-01-01') AS inspected,
  coalesce("INSPECTION TYPE", 'Not specified') AS inspection_type,
  coalesce(ACTION, '') AS action, nullif(trim(GRADE), '') AS grade,
  "GRADE DATE" AS grade_date, "RECORD DATE" AS record_date, SCORE AS score,
  nullif(trim("VIOLATION CODE"), '') AS code, "VIOLATION DESCRIPTION" AS description,
  "CRITICAL FLAG" = 'Critical' AS critical, Latitude AS lat, Longitude AS lon
FROM raw WHERE CAMIS IS NOT NULL;

-- Classify from the complete history before discarding any rows. A later
-- reopening, or a same-day closure/reopening with unknown order, stays included.
-- Keep records unfiltered for the source snapshot date and row count.
CREATE VIEW retained_records AS
SELECT r.* FROM records r JOIN (
  SELECT id,
    max(inspected) FILTER (WHERE action ILIKE '%closed%') AS closed_date,
    max(inspected) FILTER (WHERE action ILIKE '%re-opened%' OR action ILIKE '%reopened%') AS reopened_date
  FROM records GROUP BY id
) s USING(id)
WHERE s.closed_date IS NULL OR s.closed_date <= s.reopened_date;

CREATE TABLE restaurants AS
SELECT id, name, borough, address, zip, phone, cuisine, lat, lon FROM retained_records
QUALIFY row_number() OVER (
  PARTITION BY id ORDER BY inspected DESC NULLS LAST, grade_date DESC NULLS LAST, name, address
) = 1;

-- Retain empty and not-yet-inspected records. Findings are optional, not visits.
CREATE TABLE inspections AS
SELECT row_number() OVER (ORDER BY restaurant_id, inspected, inspection_type, action)::UINTEGER AS inspection_id, *
FROM (
  SELECT id AS restaurant_id, inspected, inspection_type, action,
    max(grade) AS grade, max(grade_date) AS grade_date, max(score) AS score,
    count(DISTINCT score)::INTEGER AS score_variants
  FROM retained_records GROUP BY id, inspected, inspection_type, action
);

-- A code can have different historical wording or critical classifications.
CREATE TABLE violations AS
SELECT row_number() OVER (ORDER BY code, description, critical)::UINTEGER AS violation_id, *
FROM (SELECT DISTINCT code, description, critical FROM retained_records WHERE code IS NOT NULL);

CREATE TABLE findings AS
SELECT DISTINCT i.inspection_id, v.violation_id
FROM retained_records r JOIN inspections i
  ON r.id=i.restaurant_id AND r.inspected IS NOT DISTINCT FROM i.inspected
  AND r.inspection_type=i.inspection_type AND r.action=i.action
JOIN violations v ON r.code=v.code
  AND r.description IS NOT DISTINCT FROM v.description
  AND r.critical IS NOT DISTINCT FROM v.critical;
