// Integration tests that probe raw Tinybird /v0/sql behavior.
// These tests document what Tinybird actually returns for different SQL inputs
// (various FORMAT clauses, trailing semicolons, etc.) so the query bridge in
// website/src/app.tsx can match that behavior exactly.
//
// Run with:
//   TEST_TINYBIRD_ENDPOINT=https://api.us-east.aws.tinybird.co \
//   TEST_TINYBIRD_TOKEN=p.ey... \
//   pnpm vitest run src/tinybird-behavior.test.ts
//
// Tests skip automatically when the env vars are missing.

import { describe, it, expect } from "vitest";

const ENDPOINT = process.env.TEST_TINYBIRD_ENDPOINT;
const TOKEN = process.env.TEST_TINYBIRD_TOKEN;
const skip = !ENDPOINT || !TOKEN;

async function query(sql: string) {
  const res = await fetch(`${ENDPOINT}/v0/sql`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: sql }),
  });

  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  return { status: res.status, contentType, text, body };
}

describe.skipIf(skip)("Tinybird /v0/sql behavior", () => {
  it("SELECT 1 — no FORMAT clause (default)", async () => {
    const r = await query("SELECT 1 AS n");
    expect(r.status).toBe(200);
    expect(r.contentType).toMatchInlineSnapshot(`"text/tab-separated-values; charset=UTF-8"`);
    expect(r.body).toMatchInlineSnapshot(`1`);
  });

  it("SELECT 1; — trailing semicolon", async () => {
    const r = await query("SELECT 1 AS n;");
    expect(r.status).toMatchInlineSnapshot(`200`);
    expect(r.contentType).toMatchInlineSnapshot(`"text/tab-separated-values; charset=UTF-8"`);
    // body or error message:
    expect(typeof r.body === "string" ? r.body.slice(0, 200) : r.body).toMatchInlineSnapshot(`1`);
  });

  it("SELECT 1 FORMAT JSON — explicit JSON format", async () => {
    const r = await query("SELECT 1 AS n FORMAT JSON");
    expect(r.status).toBe(200);
    expect(r.contentType).toMatchInlineSnapshot(`"application/json; charset=UTF-8"`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "data": [
          {
            "n": 1,
          },
        ],
        "meta": [
          {
            "name": "n",
            "type": "UInt8",
          },
        ],
        "rows": 1,
        "statistics": {
          "bytes_read": 1,
          "elapsed": 0.00159208,
          "rows_read": 1,
        },
      }
    `);
  });

  it("SELECT 1 FORMAT CSV — CSV without header", async () => {
    const r = await query("SELECT 1 AS n FORMAT CSV");
    expect(r.status).toBe(200);
    expect(r.contentType).toMatchInlineSnapshot(`"text/csv; charset=UTF-8; header=absent"`);
    expect(r.text).toMatchInlineSnapshot(`
      "1
      "
    `);
  });

  it("SELECT 1 FORMAT CSVWithNames — CSV with header", async () => {
    const r = await query("SELECT 1 AS n FORMAT CSVWithNames");
    expect(r.status).toBe(200);
    expect(r.contentType).toMatchInlineSnapshot(`"text/csv; charset=UTF-8; header=present"`);
    expect(r.text).toMatchInlineSnapshot(`
      ""n"
      1
      "
    `);
  });

  it("SELECT 1 FORMAT TSV — TSV without header", async () => {
    const r = await query("SELECT 1 AS n FORMAT TSV");
    expect(r.status).toBe(200);
    expect(r.contentType).toMatchInlineSnapshot(`"text/tab-separated-values; charset=UTF-8"`);
    expect(r.text).toMatchInlineSnapshot(`
      "1
      "
    `);
  });

  it("SELECT 1 FORMAT TSVWithNames — TSV with header", async () => {
    const r = await query("SELECT 1 AS n FORMAT TSVWithNames");
    expect(r.status).toBe(200);
    expect(r.contentType).toMatchInlineSnapshot(`"text/tab-separated-values; charset=UTF-8"`);
    expect(r.text).toMatchInlineSnapshot(`
      "n
      1
      "
    `);
  });

  it("SELECT 1 FORMAT PrettyCompact — formatted table", async () => {
    const r = await query("SELECT 1 AS n FORMAT PrettyCompact");
    expect(r.status).toBe(200);
    expect(r.contentType).toMatchInlineSnapshot(`"text/plain; charset=UTF-8"`);
    expect(r.text).toMatchInlineSnapshot(`
      "   ┌─n─┐
      1. │ 1 │
         └───┘
      "
    `);
  });

  it("SELECT 1 FORMAT JSONEachRow — NDJSON", async () => {
    const r = await query("SELECT 1 AS n FORMAT JSONEachRow");
    expect(r.status).toBe(200);
    expect(r.contentType).toMatchInlineSnapshot(`"application/x-ndjson"`);
    expect(r.text).toMatchInlineSnapshot(`
      "{"n":1}
      "
    `);
  });

  it("SELECT 1 FORMAT JSON; — FORMAT JSON with trailing semicolon", async () => {
    const r = await query("SELECT 1 AS n FORMAT JSON;");
    expect(r.status).toMatchInlineSnapshot(`200`);
    expect(typeof r.body === "string" ? r.body.slice(0, 200) : r.body).toMatchInlineSnapshot(`
      {
        "data": [
          {
            "n": 1,
          },
        ],
        "meta": [
          {
            "name": "n",
            "type": "UInt8",
          },
        ],
        "rows": 1,
        "statistics": {
          "bytes_read": 1,
          "elapsed": 0.000683658,
          "rows_read": 1,
        },
      }
    `);
  });

  it("SELECT 1\\n; — whitespace then semicolon", async () => {
    const r = await query("SELECT 1 AS n\n;");
    expect(r.status).toMatchInlineSnapshot(`200`);
    expect(typeof r.body === "string" ? r.body.slice(0, 200) : r.body).toMatchInlineSnapshot(`1`);
  });

  it("SELECT 1 FORMAT JSON   ; — FORMAT JSON then semicolon with spaces", async () => {
    const r = await query("SELECT 1 AS n FORMAT JSON   ;");
    expect(r.status).toMatchInlineSnapshot(`200`);
    expect(typeof r.body === "string" ? r.body.slice(0, 200) : r.body).toMatchInlineSnapshot(`
      {
        "data": [
          {
            "n": 1,
          },
        ],
        "meta": [
          {
            "name": "n",
            "type": "UInt8",
          },
        ],
        "rows": 1,
        "statistics": {
          "bytes_read": 1,
          "elapsed": 0.000731946,
          "rows_read": 1,
        },
      }
    `);
  });
});
