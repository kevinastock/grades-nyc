const ACRONYMS = new Set([
  "NYC",
  "NY",
  "USA",
  "BBQ",
  "BLT",
  "BQE",
  "JFK",
  "LGA",
  "LLC",
  "LP",
  "II",
  "III",
  "IV",
  "VI",
  "VII",
  "VIII",
  "IX",
  "XI",
  "XII",
]);

/** Make the city's capitalized names and addresses easier to read. */
export function titleCase(value) {
  return String(value ?? "")
    .trim()
    .replace(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu, (word) => {
      if (ACRONYMS.has(word.toUpperCase())) return word.toUpperCase();
      if (/^\d+(?:st|nd|rd|th)$/i.test(word)) return word.toLowerCase();
      return word
        .toLowerCase()
        .split(/(['’])/)
        .map((part, index) => {
          if (index % 2 || (index > 0 && /^(s|d|t|re|ll|ve)$/.test(part))) {
            return part;
          }
          return (part.charAt(0).toUpperCase() + part.slice(1)).replace(
            /^Mc([a-z])/,
            (_, letter) => `Mc${letter.toUpperCase()}`,
          );
        })
        .join("");
    });
}

const DAY_MS = 24 * 60 * 60 * 1000;
function calendarDay(value) {
  if (value instanceof Date) {
    return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  }
  if (!value) return NaN;
  const date = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(parsed) &&
    new Date(parsed).toISOString().startsWith(date)
    ? parsed
    : NaN;
}

/** Calendar-day age: 0–6 days, 1–4 weeks, then whole 30-day months. */
export function relativeDate(value, now = new Date()) {
  const elapsed = calendarDay(now) - calendarDay(value);
  if (!Number.isFinite(elapsed)) return "Date unavailable";
  const days = Math.max(0, Math.floor(elapsed / DAY_MS));
  const [count, unit] =
    days < 7
      ? [days, "day"]
      : days < 30
        ? [Math.floor(days / 7), "week"]
        : [Math.floor(days / 30), "month"];
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/**
 * @param {import("./types").Finding[]} findings
 * @param {string[]} selected
 */
export function sortFindings(findings, selected = []) {
  const watched = new Set(selected);
  return [...findings].sort(
    (a, b) =>
      Number(watched.has(b.code)) - Number(watched.has(a.code)) ||
      a.code.localeCompare(b.code, "en", { numeric: true }),
  );
}

/**
 * Combine the city's same-day records into the inspection a person sees.
 * A score is shown only when all recorded scores agree; scores are never added.
 * @param {import("./types").Inspection[]} inspections
 * @param {string[]} selected
 */
export function groupInspections(inspections, selected = []) {
  /** @type {Map<string, import("./types").Inspection[]>} */
  const dates = new Map();
  for (const inspection of inspections) {
    if (!dates.has(inspection.inspected)) dates.set(inspection.inspected, []);
    dates.get(inspection.inspected).push(inspection);
  }
  return [...dates]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([inspected, records]) => {
      /** @type {Map<string, import("./types").Finding>} */
      const findings = new Map();
      for (const record of records) {
        for (const finding of record.findings) {
          const existing = findings.get(finding.code);
          findings.set(finding.code, {
            code: finding.code,
            description:
              existing?.description?.trim() ||
              finding.description?.trim() ||
              null,
            critical: Boolean(existing?.critical || finding.critical),
          });
        }
      }
      const scores = new Set(
        records.map((record) => record.score).filter((score) => score != null),
      );
      return {
        inspected,
        score:
          scores.size === 1 &&
          records.every((record) => record.score_variants <= 1)
            ? [...scores][0]
            : null,
        actions: [
          ...new Set(
            records
              .map((record) => record.action.trim())
              .filter(
                (action) =>
                  action &&
                  !/^(Violations were cited|No violations were recorded)/i.test(
                    action,
                  ),
              ),
          ),
        ],
        findings: sortFindings([...findings.values()], selected),
      };
    });
}
