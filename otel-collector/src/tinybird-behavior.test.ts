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

/**
 * Strip dynamic values from Tinybird responses so snapshots are stable:
 * - query_id in error messages (changes every request)
 * - statistics.elapsed in JSON format responses (timing varies)
 */
function stabilize(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\s*\(query_id=[^)]+\)/g, "");
  }
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const rec = obj as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
      if (k === "statistics" && v && typeof v === "object") {
        const stats = { ...(v as Record<string, unknown>) };
        delete stats.elapsed;
        out[k] = stats;
      } else if (typeof v === "string") {
        out[k] = v.replace(/\s*\(query_id=[^)]+\)/g, "");
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  return obj;
}

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

  return { status: res.status, contentType, text, body: stabilize(body) };
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
          "rows_read": 1,
        },
      }
    `);
  });
});

// ---------------------------------------------------------------------------
// Error cases — document Tinybird /v0/sql error response shapes so agents
// can parse and surface rich error messages when generating SQL that fails.
// ---------------------------------------------------------------------------

describe.skipIf(skip)("Tinybird /v0/sql error responses", () => {
  // --- Non-existent tables ---

  it("SELECT from a table that does not exist", async () => {
    const r = await query("SELECT * FROM nonexistent_table_xyz LIMIT 1");
    expect(r.status).toMatchInlineSnapshot(`403`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/api-reference/query-api.html",
        "error": "Resource 'nonexistent_table_xyz' not found",
      }
    `);
  });

  it("SELECT from a table that does not exist — FORMAT JSON", async () => {
    const r = await query(
      "SELECT * FROM nonexistent_table_xyz LIMIT 1 FORMAT JSON",
    );
    expect(r.status).toMatchInlineSnapshot(`403`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/api-reference/query-api.html",
        "error": "Resource 'nonexistent_table_xyz' not found",
      }
    `);
  });

  // --- SQL syntax errors ---

  it("garbage SQL — completely invalid", async () => {
    const r = await query("THIS IS NOT SQL");
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/query/query-parameters.html",
        "error": "DB::Exception: Syntax error: failed at position 1 (THIS): THIS IS NOT SQL. Expected one of: Query, Query with output, EXPLAIN, EXPLAIN, SELECT query, possibly with UNION, list of union elements, SELECT query, subquery, possibly with UNION, SELECT subquery, SELECT query, WITH, FROM, SELECT, SHOW CREATE QUOTA query, SHOW CREATE, SHOW [FULL] [TEMPORARY] TABLES|DATABASES|CLUSTERS|CLUSTER|MERGES 'name' [[NOT] [I]LIKE 'str'] [LIMIT expr], SHOW, SHOW COLUMNS query, SHOW ENGINES query, SHOW ENGINES, SHOW FUNCTIONS query, SHOW FUNCTIONS, SHOW INDEXES query, SHOW SETTING query, SHOW SETTING, EXISTS or SHOW CREATE query, EXISTS, DESCRIBE FILESYSTEM CACHE query, DESCRIBE, DESC, DESCRIBE query, SHOW PROCESSLIST query, SHOW PROCESSLIST, CREATE TABLE or ATTACH TABLE query, CREATE, ATTACH, REPLACE, CREATE DATABASE query, CREATE VIEW query, CREATE STREAMING QUERY query, CREATE DICTIONARY, CREATE LIVE VIEW query, CREATE WINDOW VIEW query, ALTER query, ALTER TABLE, ALTER TEMPORARY TABLE, ALTER DATABASE, RENAME query, RENAME DATABASE, RENAME TABLE, EXCHANGE TABLES, RENAME DICTIONARY, EXCHANGE DICTIONARIES, RENAME, DROP query, DROP, DETACH, TRUNCATE, UNDROP query, UNDROP, CHECK ALL TABLES, CHECK TABLE, KILL QUERY query, KILL, OPTIMIZE query, OPTIMIZE TABLE, WATCH query, WATCH, SHOW ACCESS query, SHOW ACCESS, ShowAccessEntitiesQuery, SHOW GRANTS query, SHOW GRANTS, SHOW PRIVILEGES query, SHOW PRIVILEGES, BACKUP or RESTORE query, BACKUP, RESTORE, INSERT query, INSERT INTO, USE query, USE, SET ROLE or SET DEFAULT ROLE query, SET ROLE DEFAULT, SET ROLE, SET DEFAULT ROLE, SET query, SET, SYSTEM query, SYSTEM, CREATE USER or ALTER USER query, ALTER USER, CREATE USER, CREATE ROLE or ALTER ROLE query, ALTER ROLE, CREATE ROLE, CREATE QUOTA or ALTER QUOTA query, ALTER QUOTA, CREATE QUOTA, CREATE ROW POLICY or ALTER ROW POLICY query, ALTER POLICY, ALTER ROW POLICY, CREATE POLICY, CREATE ROW POLICY, CREATE SETTINGS PROFILE or ALTER SETTINGS PROFILE query, ALTER SETTINGS PROFILE, ALTER PROFILE, CREATE SETTINGS PROFILE, CREATE PROFILE, CREATE FUNCTION query, DROP FUNCTION query, CREATE WORKLOAD query, DROP WORKLOAD query, CREATE RESOURCE query, DROP RESOURCE query, CREATE NAMED COLLECTION, DROP NAMED COLLECTION query, Alter NAMED COLLECTION query, ALTER, CREATE INDEX query, DROP INDEX query, DROP access entity query, MOVE access entity query, MOVE, GRANT or REVOKE query, REVOKE, GRANT, CHECK GRANT, CHECK GRANT, EXTERNAL DDL query, EXTERNAL DDL FROM, TCL query, BEGIN TRANSACTION, START TRANSACTION, COMMIT, ROLLBACK, SET TRANSACTION SNAPSHOT, Delete query, DELETE",
      }
    `);
  });

  it("missing FROM clause", async () => {
    const r = await query("SELECT *");
    expect(r.status).toMatchInlineSnapshot(`200`);
    expect(r.body).toMatchInlineSnapshot(`0`);
  });

  it("unclosed string literal", async () => {
    const r = await query("SELECT 'hello");
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/query/query-parameters.html",
        "error": "DB::Exception: Single quoted string is not closed: Syntax error: failed at position 8 ('hello): 'hello. ",
      }
    `);
  });

  it("unclosed parenthesis", async () => {
    const r = await query("SELECT (1 + 2");
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/query/query-parameters.html",
        "error": "DB::Exception: Syntax error: failed at position 8 ((): (1 + 2. Unmatched parentheses: (",
      }
    `);
  });

  it("double semicolons", async () => {
    const r = await query("SELECT 1;;");
    expect(r.status).toMatchInlineSnapshot(`200`);
    expect(r.body).toMatchInlineSnapshot(`1`);
  });

  it("multiple statements (injection attempt)", async () => {
    const r = await query("SELECT 1; SELECT 2");
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/query/query-parameters.html",
        "error": "DB::Exception: Syntax error (Multi-statements are not allowed): failed at position 9 (end of query): ; SELECT 2. ",
      }
    `);
  });

  // --- Non-existent columns on real tables ---

  it("SELECT non-existent column from otel_traces", async () => {
    const r = await query(
      "SELECT FakeColumn FROM otel_traces LIMIT 1",
    );
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/api-reference/query-api.html#post--v0-sql",
        "error": "[Error] Missing columns: 'FakeColumn' while processing query: 'SELECT FakeColumn FROM otel_traces LIMIT 1', required_columns: 'FakeColumn'. (UNKNOWN_IDENTIFIER)",
      }
    `);
  });

  it("WHERE on non-existent column", async () => {
    const r = await query(
      "SELECT TraceId FROM otel_traces WHERE FakeColumn = 'x' LIMIT 1",
    );
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/api-reference/query-api.html#post--v0-sql",
        "error": "[Error] Missing columns: 'FakeColumn' while processing query: 'SELECT TraceId FROM otel_traces WHERE FakeColumn = 'x' LIMIT 1', required_columns: 'FakeColumn'. (UNKNOWN_IDENTIFIER)",
      }
    `);
  });

  it("ORDER BY non-existent column", async () => {
    const r = await query(
      "SELECT TraceId FROM otel_traces ORDER BY NonExistent LIMIT 1",
    );
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/api-reference/query-api.html#post--v0-sql",
        "error": "[Error] Missing columns: 'NonExistent' while processing query: 'SELECT TraceId FROM otel_traces ORDER BY NonExistent LIMIT 1', required_columns: 'NonExistent'. (UNKNOWN_IDENTIFIER)",
      }
    `);
  });

  it("GROUP BY non-existent column", async () => {
    const r = await query(
      "SELECT count() FROM otel_traces GROUP BY BogusColumn LIMIT 1",
    );
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/api-reference/query-api.html#post--v0-sql",
        "error": "[Error] Missing columns: 'BogusColumn' while processing query: 'SELECT count() FROM otel_traces GROUP BY BogusColumn LIMIT 1', required_columns: 'BogusColumn'. (UNKNOWN_IDENTIFIER)",
      }
    `);
  });

  // --- Type mismatches ---

  it("compare String column to Int — TraceId = 123", async () => {
    const r = await query(
      "SELECT TraceId FROM otel_traces WHERE TraceId = 123 LIMIT 1",
    );
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/api-reference/query-api.html#post--v0-sql",
        "error": "[Error] There is no supertype for types String, UInt8 because some of them are String/FixedString/Enum and some of them are not(NO_COMMON_TYPE)",
      }
    `);
  });

  it("compare UInt64 column to String — Duration = 'hello'", async () => {
    const r = await query(
      "SELECT Duration FROM otel_traces WHERE Duration = 'hello' LIMIT 1",
    );
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/api-reference/query-api.html#post--v0-sql",
        "error": "[Error] Cannot convert string 'hello' to type UInt64(TYPE_MISMATCH)",
      }
    `);
  });

  it("arithmetic on String column — SpanName + 1", async () => {
    const r = await query(
      "SELECT SpanName + 1 FROM otel_traces LIMIT 1",
    );
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/api-reference/query-api.html#post--v0-sql",
        "error": "[Error] Illegal types String and UInt8 of arguments of function plus: While processing SpanName + 1. (ILLEGAL_TYPE_OF_ARGUMENT)",
      }
    `);
  });

  it("cast to wrong type — CAST(SpanName AS UInt64)", async () => {
    const r = await query(
      "SELECT CAST(SpanName AS UInt64) FROM otel_traces LIMIT 1",
    );
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/api-reference/query-api.html#post--v0-sql",
        "error": "[Error] Cannot parse string 'api.call' as UInt64: syntax error at begin of string. Note: there are toUInt64OrZero and toUInt64OrNull functions, which returns zero/NULL instead of throwing exception.",
      }
    `);
  });

  // --- Invalid function usage ---

  it("call function with wrong arg count — count(1, 2, 3)", async () => {
    const r = await query("SELECT count(1, 2, 3)");
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/api-reference/query-api.html#post--v0-sql",
        "error": "[Error] Aggregate function count requires zero or one argument. (NUMBER_OF_ARGUMENTS_DOESNT_MATCH)",
      }
    `);
  });

  it("non-existent function — foobar()", async () => {
    const r = await query("SELECT foobar()");
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/query/query-parameters.html",
        "error": "DB::Exception: Unknown function foobar. Contact support@tinybird.co if you require access to this feature",
      }
    `);
  });

  it("aggregate without GROUP BY — mix aggregate and non-aggregate", async () => {
    const r = await query(
      "SELECT TraceId, count() FROM otel_traces LIMIT 1",
    );
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/api-reference/query-api.html#post--v0-sql",
        "error": "[Error] Column \`TraceId\` is not under aggregate function and not in GROUP BY. Have columns: ['count()']: While processing TraceId, count(). (NOT_AN_AGGREGATE)",
      }
    `);
  });

  // --- Map column access errors ---

  it("bracket access on non-Map column — TraceId['key']", async () => {
    const r = await query(
      "SELECT TraceId['key'] FROM otel_traces LIMIT 1",
    );
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/api-reference/query-api.html#post--v0-sql",
        "error": "[Error] First argument for function 'arrayElement' must be array, got 'String' instead: While processing TraceId['key']. (ILLEGAL_TYPE_OF_ARGUMENT)",
      }
    `);
  });

  it("mapContains on non-Map column", async () => {
    const r = await query(
      "SELECT mapContains(TraceId, 'key') FROM otel_traces LIMIT 1",
    );
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/api-reference/query-api.html#post--v0-sql",
        "error": "[Error] Function mapContains requires at least one argument of type Map: While processing mapContains(TraceId, 'key'). (ILLEGAL_TYPE_OF_ARGUMENT)",
      }
    `);
  });

  // --- Write operations (should be blocked) ---

  it("INSERT — should be rejected", async () => {
    const r = await query(
      "INSERT INTO otel_traces (TraceId) VALUES ('test')",
    );
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/query/query-parameters.html",
        "error": "DB::Exception: Only SELECT or DESCRIBE queries are supported. Got: InsertQuery",
      }
    `);
  });

  it("DROP TABLE — should be rejected", async () => {
    const r = await query("DROP TABLE otel_traces");
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/query/query-parameters.html",
        "error": "DB::Exception: Only SELECT or DESCRIBE queries are supported. Got: DropQuery",
      }
    `);
  });

  it("CREATE TABLE — should be rejected", async () => {
    const r = await query(
      "CREATE TABLE test_injection (id UInt64) ENGINE = MergeTree() ORDER BY id",
    );
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/query/query-parameters.html",
        "error": "DB::Exception: Only SELECT or DESCRIBE queries are supported. Got: CreateQuery",
      }
    `);
  });

  it("ALTER TABLE — should be rejected", async () => {
    const r = await query(
      "ALTER TABLE otel_traces ADD COLUMN injected String",
    );
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/query/query-parameters.html",
        "error": "DB::Exception: Only SELECT or DESCRIBE queries are supported. Got: AlterQuery",
      }
    `);
  });

  it("TRUNCATE — should be rejected", async () => {
    const r = await query("TRUNCATE TABLE otel_traces");
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/query/query-parameters.html",
        "error": "DB::Exception: Only SELECT or DESCRIBE queries are supported. Got: DropQuery",
      }
    `);
  });

  // --- Invalid FORMAT ---

  it("invalid FORMAT name", async () => {
    const r = await query("SELECT 1 FORMAT BogusFormat");
    expect(r.status).toMatchInlineSnapshot(`403`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/api-reference/overview#authentication",
        "error": "invalid format BogusFormat, available ones: JSON, CSV, CSVWithNames, TSV, TSVWithNames, PrettyCompact, JSONEachRow, Parquet, JSONStrings, Prometheus, Native, RowBinaryWithNamesAndTypes, TabSeparated, JSONCompactEachRowWithNamesAndTypes, TabSeparatedWithNamesAndTypes, JSONCompactEachRow, JSONCompact, JSONStringsEachRowWithProgress, ODBCDriver2",
      }
    `);
  });

  // --- Empty and whitespace queries ---

  it("empty string query", async () => {
    const r = await query("");
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/api-reference/query-api.html#post--v0-sql",
        "error": "The request body should contain a query",
      }
    `);
  });

  it("whitespace-only query", async () => {
    const r = await query("   \n\t  ");
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/query/query-parameters.html",
        "error": "DB::Exception: Empty query",
      }
    `);
  });

  // --- LIMIT / edge cases ---

  it("negative LIMIT", async () => {
    const r = await query("SELECT 1 AS n LIMIT -1");
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/api-reference/query-api.html#post--v0-sql",
        "error": "[Error] The value -1 of LIMIT expression is not representable as UInt64. (INVALID_LIMIT_EXPRESSION)",
      }
    `);
  });

  it("LIMIT with non-integer", async () => {
    const r = await query("SELECT 1 AS n LIMIT 1.5");
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/api-reference/query-api.html#post--v0-sql",
        "error": "[Error] The value 1.5 of LIMIT expression is not representable as UInt64. (INVALID_LIMIT_EXPRESSION)",
      }
    `);
  });

  // --- DateTime type errors ---

  it("invalid DateTime literal", async () => {
    const r = await query(
      "SELECT * FROM otel_traces WHERE Timestamp = 'not-a-date' LIMIT 1",
    );
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/api-reference/query-api.html#post--v0-sql",
        "error": "[Error] Cannot parse DateTime: while converting 'not-a-date' to DateTime64(9)(CANNOT_PARSE_DATETIME)",
      }
    `);
  });

  it("invalid INTERVAL syntax", async () => {
    const r = await query(
      "SELECT * FROM otel_traces WHERE Timestamp > now() - INTERVAL 'abc' HOUR LIMIT 1",
    );
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/query/query-parameters.html",
        "error": "DB::Exception: Syntax error: failed at position 68 (HOUR): HOUR LIMIT 1. Expected end of query",
      }
    `);
  });

  // --- Subquery and JOIN errors ---

  it("subquery referencing non-existent table", async () => {
    const r = await query(
      "SELECT * FROM (SELECT * FROM ghost_table) LIMIT 1",
    );
    expect(r.status).toMatchInlineSnapshot(`403`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/api-reference/query-api.html",
        "error": "Resource 'ghost_table' not found",
      }
    `);
  });

  it("JOIN with non-existent table", async () => {
    const r = await query(
      "SELECT t.TraceId FROM otel_traces t JOIN missing_table m ON t.TraceId = m.TraceId LIMIT 1",
    );
    expect(r.status).toMatchInlineSnapshot(`403`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/api-reference/query-api.html",
        "error": "Resource 'missing_table' not found",
      }
    `);
  });

  it("ambiguous column in JOIN", async () => {
    const r = await query(
      "SELECT TraceId FROM otel_traces a JOIN otel_logs b ON a.TraceId = b.TraceId LIMIT 1",
    );
    expect(r.status).toMatchInlineSnapshot(`200`);
    expect(r.body).toMatchInlineSnapshot(`
      "a63e37cb6950c3af1cf211244d16e71a
      "
    `);
  });

  // --- System tables and information_schema access ---

  it("SELECT from system.tables — should be blocked or limited", async () => {
    const r = await query("SELECT * FROM system.tables LIMIT 1");
    expect(r.status).toMatchInlineSnapshot(`200`);
    expect(r.body).toMatchInlineSnapshot(`
      "strada2	otel_traces_quarantine	2d8d1041-9d68-42f9-b06a-25ee4a7c77d3	MergeTree	0	[]		2026-04-23 06:54:33	0	[]	[]		MergeTree		toYear(insertion_date)	insertion_date	insertion_date			4	3171	11588	\\N	\\N		1
      "
    `);
  });

  it("SHOW TABLES", async () => {
    const r = await query("SHOW TABLES");
    expect(r.status).toMatchInlineSnapshot(`200`);
    expect(r.body).toMatchInlineSnapshot(`
      "otel_traces_quarantine
      otel_traces
      otel_traces_quarantine
      otel_metrics_exponential_histogram
      otel_errors
      otel_errors_quarantine
      otel_traces_trace_id_ts
      otel_logs
      otel_logs_quarantine
      otel_analytics_pages
      otel_metrics_gauge
      otel_metrics_gauge_quarantine
      otel_metrics_sum
      otel_analytics_sessions
      otel_metrics_histogram
      otel_analytics_pages_mv
      otel_analytics_sessions_mv
      otel_traces_trace_id_ts_mv
      "
    `);
  });

  it("SHOW CREATE TABLE", async () => {
    const r = await query("SHOW CREATE TABLE otel_traces");
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/query/query-parameters.html",
        "error": "DB::Exception: Only SELECT or DESCRIBE queries are supported. Got: ShowCreateTableQueryIDAndQueryNames",
      }
    `);
  });

  // --- Aggregation edge cases ---

  it("HAVING without GROUP BY", async () => {
    const r = await query(
      "SELECT TraceId FROM otel_traces HAVING count() > 1 LIMIT 1",
    );
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/api-reference/query-api.html#post--v0-sql",
        "error": "[Error] Column \`TraceId\` is not under aggregate function and not in GROUP BY. Have columns: ['greater(count(), 1)','1','count()']: While processing TraceId. (NOT_AN_AGGREGATE)",
      }
    `);
  });

  it("nested aggregate — max(count())", async () => {
    const r = await query(
      "SELECT max(count()) FROM otel_traces",
    );
    expect(r.status).toMatchInlineSnapshot(`400`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://www.tinybird.co/docs/concepts/data-sources.html#partitioning",
        "error": "[Error] You cannot use the aggregate function 'count()' or its alias inside another aggregate function.",
      }
    `);
  });

  // --- Division by zero ---

  it("division by zero", async () => {
    const r = await query("SELECT 1 / 0");
    expect(r.status).toMatchInlineSnapshot(`200`);
    expect(r.body).toMatchInlineSnapshot(`
      "inf
      "
    `);
  });

  // --- Very large LIMIT ---

  it("extremely large LIMIT — 999999999", async () => {
    const r = await query("SELECT 1 AS n LIMIT 999999999");
    expect(r.status).toMatchInlineSnapshot(`200`);
    expect(r.body).toMatchInlineSnapshot(`1`);
  });

  // --- AggregatingMergeTree tables without Merge combinators ---

  it("SELECT raw aggregate column without -Merge from analytics MV", async () => {
    const r = await query(
      "SELECT Visits FROM otel_analytics_pages LIMIT 1",
    );
    expect(r.status).toMatchInlineSnapshot(`200`);
    expect(r.body).toMatchInlineSnapshot(`
      "\\0��8Bg��2
      "
    `);
  });

  // --- otel_issue_state without FINAL ---

  it("SELECT from ReplacingMergeTree without FINAL", async () => {
    const r = await query(
      "SELECT FingerprintHash, Status FROM otel_issue_state LIMIT 1",
    );
    expect(r.status).toMatchInlineSnapshot(`403`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/api-reference/query-api.html",
        "error": "Resource 'otel_issue_state' not found",
      }
    `);
  });

  it("SELECT from ReplacingMergeTree with FINAL", async () => {
    const r = await query(
      "SELECT FingerprintHash, Status FROM otel_issue_state FINAL LIMIT 1",
    );
    expect(r.status).toMatchInlineSnapshot(`403`);
    expect(r.body).toMatchInlineSnapshot(`
      {
        "documentation": "https://docs.tinybird.co/api-reference/query-api.html",
        "error": "Resource 'otel_issue_state' not found",
      }
    `);
  });
});
