import { test } from "node:test";
import assert from "node:assert/strict";
import {
  groupInspections,
  relativeDate,
  sortFindings,
  titleCase,
} from "../src/data/presentation.mjs";

const inspection = (overrides = {}) => ({
  inspected: "2026-09-25",
  inspection_type: "Cycle Inspection / Initial Inspection",
  action: "Violations were cited in the following area(s).",
  grade: null,
  grade_date: null,
  score: 12,
  score_variants: 1,
  findings: [],
  ...overrides,
});

test("same-day records appear once, deduplicate codes, and retain useful finding details", () => {
  const records = [
    inspection({
      inspected: "2025-12-01",
      findings: [{ code: "02B", description: "Older finding", critical: true }],
    }),
    inspection({
      findings: [
        { code: "02B", description: null, critical: false },
        {
          code: "10F",
          description: "Surface not maintained.",
          critical: false,
        },
      ],
    }),
    inspection({
      inspection_type: "Administrative Miscellaneous / Initial Inspection",
      action: "Establishment Closed by DOHMH.",
      findings: [
        {
          code: "02B",
          description: "Food temperature was unsafe.",
          critical: true,
        },
        {
          code: "10F",
          description: "Surface not maintained.",
          critical: false,
        },
      ],
    }),
    inspection({ action: "Establishment Closed by DOHMH." }),
  ];
  const original = structuredClone(records);
  const groups = groupInspections(records, ["10F"]);
  assert.deepEqual(
    groups.map((group) => group.inspected),
    ["2026-09-25", "2025-12-01"],
  );
  assert.deepEqual(groups[0].findings, [
    { code: "10F", description: "Surface not maintained.", critical: false },
    {
      code: "02B",
      description: "Food temperature was unsafe.",
      critical: true,
    },
  ]);
  assert.deepEqual(groups[0].actions, ["Establishment Closed by DOHMH."]);
  assert.equal(groups[1].findings[0].description, "Older finding");
  assert.deepEqual(
    records,
    original,
    "presentation must not mutate the source records",
  );
});

test("grouped scores agree or are omitted, and are never added", () => {
  assert.equal(groupInspections([inspection(), inspection()])[0].score, 12);
  assert.equal(
    groupInspections([inspection(), inspection({ score: 23 })])[0].score,
    null,
  );
  assert.equal(
    groupInspections([inspection({ score_variants: 2 })])[0].score,
    null,
  );
  assert.equal(
    groupInspections([inspection({ score: null, score_variants: 0 })])[0].score,
    null,
  );
  assert.equal(
    groupInspections([
      inspection(),
      inspection({ score: null, score_variants: 0 }),
    ])[0].score,
    12,
  );
  assert.deepEqual(groupInspections([]), []);
});

test("watched findings come first with a consistent code order within both groups", () => {
  const findings = ["10F", "06A", "02B", "04L"].map((code) => ({
    code,
    description: null,
    critical: false,
  }));
  assert.deepEqual(
    sortFindings(findings, ["10F", "04L"]).map((finding) => finding.code),
    ["04L", "10F", "02B", "06A"],
  );
  assert.deepEqual(
    sortFindings(findings).map((finding) => finding.code),
    ["02B", "04L", "06A", "10F"],
  );
  assert.deepEqual(
    findings.map((finding) => finding.code),
    ["10F", "06A", "02B", "04L"],
  );
});

test("relative inspection dates cover each requested precision boundary", () => {
  const now = new Date(2026, 8, 27, 12);
  const cases = [
    ["2026-09-27", "0 days ago"],
    ["2026-09-26", "1 day ago"],
    ["2026-09-21", "6 days ago"],
    ["2026-09-20", "1 week ago"],
    ["2026-09-14", "1 week ago"],
    ["2026-09-13", "2 weeks ago"],
    ["2026-08-31", "3 weeks ago"],
    ["2026-08-30", "4 weeks ago"],
    ["2026-08-29", "4 weeks ago"],
    ["2026-08-28", "1 month ago"],
    ["2026-07-30", "1 month ago"],
    ["2026-07-29", "2 months ago"],
    ["2026-10-01", "0 days ago"],
  ];
  for (const [date, expected] of cases)
    assert.equal(relativeDate(date, now), expected, date);
  assert.equal(relativeDate(null, now), "Date unavailable");
  assert.equal(relativeDate("invalid", now), "Date unavailable");
  assert.equal(relativeDate("2026-02-30", now), "Date unavailable");
  assert.equal(
    relativeDate("2026-03-08", new Date(2026, 2, 9, 0)),
    "1 day ago",
    "use calendar days across daylight-saving changes",
  );
});

test("title case handles dataset names, addresses, acronyms, apostrophes and ordinals", () => {
  assert.equal(titleCase("  KATZ'S DELICATESSEN  "), "Katz's Delicatessen");
  assert.equal(titleCase("MCDONALD'S / O'NEILL’S"), "McDonald's / O'Neill’s");
  assert.equal(titleCase("NYC BBQ & GRILL LLC"), "NYC BBQ & Grill LLC");
  assert.equal(titleCase("205 EAST 1ST STREET"), "205 East 1st Street");
  assert.equal(titleCase("77-01 31ST AVENUE"), "77-01 31st Avenue");
  assert.equal(titleCase("CAFÉ DE L'ARTUSI"), "Café De L'Artusi");
  assert.equal(titleCase(null), "");
});
