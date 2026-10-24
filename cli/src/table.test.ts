import { expect, test } from "vitest";
import { formatTable, parseTimestamp } from "./table.ts";
import { bold, cyan, dim, red } from "./colors.ts";

test("basic table without colors", () => {
  const result = formatTable({
    columns: [
      { key: "name", label: "NAME" },
      { key: "age", label: "AGE", align: "right" },
    ],
    rows: [
      { name: "Alice", age: "30" },
      { name: "Bob", age: "7" },
    ],
  });
  expect(result).toMatchInlineSnapshot(`
    "  NAME   AGE
      ─────  ───
      Alice   30
      Bob      7"
  `);
});

test("table with ANSI-colored cell values aligns correctly", () => {
  // This is the exact bug: pre-applying dim() to fallback values
  // like dim("—") inflates .length and breaks padding
  const result = formatTable({
    columns: [
      { key: "timestamp", label: "TIMESTAMP" },
      { key: "service", label: "SERVICE" },
      { key: "release", label: "RELEASE" },
      { key: "env", label: "ENV" },
    ],
    rows: [
      {
        timestamp: "2026-04-23 06:52:08",
        service: "example-app",
        release: dim("—"),
        env: "development",
      },
    ],
  });
  // Strip ANSI to verify alignment by character positions
  // eslint-disable-next-line no-control-regex
  const stripped = result.replace(/\x1b\[[0-9;]*m/g, "");
  expect(stripped).toMatchInlineSnapshot(`
    "  TIMESTAMP            SERVICE      RELEASE  ENV        
      ───────────────────  ───────────  ───────  ───────────
      2026-04-23 06:52:08  example-app  —        development"
  `);
});

test("table with column color functions", () => {
  const result = formatTable({
    columns: [
      { key: "count", label: "COUNT", align: "right", color: bold },
      { key: "type", label: "TYPE", color: cyan },
    ],
    rows: [
      { count: "1,247", type: "TypeError" },
      { count: "42", type: "RangeError" },
    ],
  });
  // eslint-disable-next-line no-control-regex
  const stripped = result.replace(/\x1b\[[0-9;]*m/g, "");
  expect(stripped).toMatchInlineSnapshot(`
    "  COUNT  TYPE      
      ─────  ──────────
      1,247  TypeError 
         42  RangeError"
  `);
});

test("maxWidth truncates long values", () => {
  const result = formatTable({
    columns: [
      { key: "msg", label: "MESSAGE", maxWidth: 10 },
    ],
    rows: [
      { msg: "Short" },
      { msg: "This is a very long message that should be truncated" },
    ],
  });
  // eslint-disable-next-line no-control-regex
  const stripped = result.replace(/\x1b\[[0-9;]*m/g, "");
  expect(stripped).toMatchInlineSnapshot(`
    "  MESSAGE   
      ──────────
      Short     
      This is a…"
  `);
});

test("missing cell values default to empty string", () => {
  const result = formatTable({
    columns: [
      { key: "a", label: "COL A" },
      { key: "b", label: "COL B" },
    ],
    rows: [
      { a: "hello" },
      { b: "world" },
    ],
  });
  // eslint-disable-next-line no-control-regex
  const stripped = result.replace(/\x1b\[[0-9;]*m/g, "");
  expect(stripped).toMatchInlineSnapshot(`
    "  COL A  COL B
      ─────  ─────
      hello       
             world"
  `);
});

test("mixed ANSI and plain values in same column", () => {
  // Some rows have colored values, some don't. Column width and
  // padding must be consistent regardless of ANSI codes.
  const result = formatTable({
    columns: [
      { key: "name", label: "NAME" },
      { key: "status", label: "STATUS" },
    ],
    rows: [
      { name: "alpha", status: red("error") },
      { name: "beta", status: "ok" },
      { name: "gamma", status: dim("—") },
    ],
  });
  // eslint-disable-next-line no-control-regex
  const stripped = result.replace(/\x1b\[[0-9;]*m/g, "");
  expect(stripped).toMatchInlineSnapshot(`
    "  NAME   STATUS
      ─────  ──────
      alpha  error 
      beta   ok    
      gamma  —     "
  `);
});

test("separator width matches header width per column", () => {
  const result = formatTable({
    columns: [
      { key: "x", label: "SHORT" },
      { key: "y", label: "VERY LONG HEADER" },
    ],
    rows: [{ x: "a", y: "b" }],
  });
  // eslint-disable-next-line no-control-regex
  const stripped = result.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = stripped.split("\n");
  // Header and separator should have matching column widths
  const headerCols = lines[0]!.slice(2).split(/  +/);
  const sepCols = lines[1]!.slice(2).split(/  +/);
  expect(headerCols.map((c) => c.trim().length > 0)).toEqual(
    sepCols.map((c) => c.trim().length > 0),
  );
  expect(stripped).toMatchInlineSnapshot(`
    "  SHORT  VERY LONG HEADER
      ─────  ────────────────
      a      b               "
  `);
});

test("parseTimestamp reads zone-less ClickHouse times as UTC", () => {
  expect([
    parseTimestamp("2026-10-24 12:30:00.123456789").toISOString(),
    parseTimestamp("2026-10-24 12:30:00").toISOString(),
    parseTimestamp("2026-10-24T12:30:00+02:00").toISOString(),
  ]).toMatchInlineSnapshot(`
    [
      "2026-10-24T12:30:00.123Z",
      "2026-10-24T12:30:00.000Z",
      "2026-10-24T10:30:00.000Z",
    ]
  `);
});
