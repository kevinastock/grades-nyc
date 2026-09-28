export type Restaurant = {
  id: string;
  name: string;
  borough: string;
  address: string;
  zip: string;
  cuisine: string;
  lat: number | null;
  lon: number | null;
  grade: string | null;
  grade_date: string | null;
  grade_inspected: string | null;
  latest_date: string | null;
  latest_codes: string;
  closure: "uncertain" | "none";
  closed_date: string | null;
};
export type Violation = {
  code: string;
  description: string | null;
  critical: boolean | null;
  critical_varies: boolean;
  occurrences: number;
};
export type Finding = {
  code: string;
  description: string | null;
  critical: boolean | null;
};
export type Inspection = {
  inspected: string;
  inspection_type: string;
  action: string;
  grade: string | null;
  grade_date: string | null;
  score: number | null;
  score_variants: number;
  findings: Finding[];
};
export type DataSet = {
  restaurants: Restaurant[];
  violations: Violation[];
  snapshot: string;
  rowCount: number;
  cuisines: string[];
  boroughs: string[];
};
export type Scope = "recent" | "latest" | "history";
