// Canonical build-time queries, exercised by generated CSV regression fixtures.
// The converter registers the four normalized tables with source_* names.
export const MODEL_SQL = `
CREATE VIEW finding_records AS
SELECT i.inspection_id, i.restaurant_id AS id, i.inspected, v.code, v.description, v.critical
FROM source_findings f JOIN source_inspections i USING(inspection_id)
JOIN source_violations v USING(violation_id);

CREATE TABLE inspections AS
SELECT i.inspection_id, i.restaurant_id AS id, i.inspected, i.inspection_type, i.action,
  i.grade, i.grade_date, i.score, i.score_variants,
  coalesce(c.codes, '') AS codes, coalesce(c.violation_count, 0)::INTEGER AS violation_count,
  coalesce(c.critical_count, 0)::INTEGER AS critical_count
FROM source_inspections i LEFT JOIN (
  SELECT inspection_id, string_agg(DISTINCT code, ',' ORDER BY code) AS codes,
    count(DISTINCT code)::INTEGER AS violation_count,
    count(DISTINCT code) FILTER (WHERE critical)::INTEGER AS critical_count
  FROM finding_records GROUP BY inspection_id
) c USING(inspection_id)
WHERE i.inspected IS NOT NULL;

CREATE TABLE current_grades AS SELECT * FROM inspections
WHERE grade IN ('A','B','C','P','Z') AND (
  inspection_type IN ('Cycle Inspection / Re-inspection', 'Pre-permit (Operational) / Re-inspection',
    'Cycle Inspection / Reopening Inspection', 'Pre-permit (Operational) / Reopening Inspection')
  OR (inspection_type IN ('Cycle Inspection / Initial Inspection', 'Pre-permit (Operational) / Initial Inspection') AND score <= 13)
)
QUALIFY row_number() OVER (PARTITION BY id ORDER BY inspected DESC, grade_date DESC NULLS LAST, inspection_type, action) = 1;

CREATE TABLE restaurants AS WITH latest AS (
  SELECT id, max(inspected) AS latest_date, count(*)::INTEGER AS inspection_count FROM inspections GROUP BY id
), latest_codes AS (
  SELECT f.id, string_agg(DISTINCT f.code, ',' ORDER BY f.code) AS latest_codes
  FROM finding_records f JOIN latest l ON f.id=l.id AND f.inspected=l.latest_date GROUP BY f.id
), history_codes AS (
  SELECT id, string_agg(DISTINCT code, ',' ORDER BY code) AS history_codes
  FROM finding_records GROUP BY id
), closures AS (
  SELECT restaurant_id AS id,
    max(inspected) FILTER (WHERE action ILIKE '%closed%') AS closed_date,
    max(inspected) FILTER (WHERE action ILIKE '%re-opened%' OR action ILIKE '%reopened%') AS reopened_date
  FROM source_inspections GROUP BY restaurant_id
)
SELECT i.*, g.grade, cast(g.grade_date AS VARCHAR) AS grade_date, cast(g.inspected AS VARCHAR) AS grade_inspected,
  g.inspection_type AS grade_type, g.action AS grade_action, g.score AS grade_score,
  coalesce(g.codes, '') AS grade_codes, cast(l.latest_date AS VARCHAR) AS latest_date,
  coalesce(l.inspection_count, 0)::INTEGER AS inspection_count,
  coalesce(c.latest_codes, '') AS latest_codes, coalesce(h.history_codes, '') AS history_codes,
  cast(s.closed_date AS VARCHAR) AS closed_date, cast(s.reopened_date AS VARCHAR) AS reopened_date,
  CASE WHEN s.closed_date IS NOT NULL AND (s.reopened_date IS NULL OR s.closed_date > s.reopened_date) THEN 'closed'
    WHEN s.closed_date = s.reopened_date THEN 'uncertain' ELSE 'none' END AS closure
FROM source_restaurants i LEFT JOIN current_grades g USING(id) LEFT JOIN latest l USING(id)
LEFT JOIN latest_codes c USING(id) LEFT JOIN history_codes h USING(id) LEFT JOIN closures s USING(id);
`;

export const sqlString = (value) =>
  "'" + String(value).replaceAll("'", "''") + "'";

export const CATALOG_SQL = `
  WITH dates AS (
    SELECT code, max(inspected) AS inspected, count(DISTINCT id)::INTEGER AS occurrences
    FROM finding_records GROUP BY code
  ) SELECT f.code, max(f.description) AS description, bool_or(f.critical) AS critical,
      count(DISTINCT f.critical) > 1 AS critical_varies, max(d.occurrences) AS occurrences
    FROM finding_records f JOIN dates d ON f.code=d.code AND f.inspected IS NOT DISTINCT FROM d.inspected
    GROUP BY f.code ORDER BY f.code
`;

export const inspectionQuery = (id) => `
  SELECT cast(i.inspected AS VARCHAR) AS inspected, i.inspection_type, i.action, i.grade,
    cast(i.grade_date AS VARCHAR) AS grade_date, i.score, i.score_variants,
    coalesce((SELECT to_json(list({'code': f.code, 'description': f.description, 'critical': f.critical}
      ORDER BY f.code, f.description, f.critical))
      FROM finding_records f WHERE f.inspection_id=i.inspection_id), '[]') AS findings
  FROM inspections i WHERE i.id=${sqlString(id)} ORDER BY i.inspected DESC, i.inspection_type, i.action
`;
