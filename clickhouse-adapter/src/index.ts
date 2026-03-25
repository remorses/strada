// Tinybird API-compatible adapter for generic ClickHouse.
//
// Implements two Tinybird endpoints:
//   POST /v0/events?name={table}  — Events API (ingestion)
//   POST /v0/sql                  — Query API (reads)
//   GET  /v0/sql?q={sql}          — Query API (reads, query in URL)
//
// ClickHouse credentials come from wrangler secrets, not from request headers.

import { Spiceflow } from 'spiceflow'
import { cors } from 'spiceflow/cors'
import { env } from 'cloudflare:workers'
import { remapNdjson } from './field-mapping.ts'
import { insertIntoClickHouse, queryClickHouse } from './clickhouse-client.ts'

interface Env {
  CLICKHOUSE_URL: string
  CLICKHOUSE_DATABASE: string
  CLICKHOUSE_USER: string
  CLICKHOUSE_PASSWORD: string
}

function getEnv(): Env {
  return env as unknown as Env
}

const app = new Spiceflow()
  .use(
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST'],
      allowHeaders: ['content-type'],
      maxAge: 86400,
    }),
  )

  // ── Events API: NDJSON ingestion ──
  .post('/v0/events', async ({ request }) => {
    const url = new URL(request.url)
    const tableName = url.searchParams.get('name')
    if (!tableName) {
      return new Response('Missing ?name= query parameter', { status: 400 })
    }

    const ndjson = await request.text()
    if (!ndjson.trim()) {
      return new Response('Empty body', { status: 400 })
    }

    const e = getEnv()

    // Remap snake_case NDJSON keys to PascalCase ClickHouse column names
    const remappedNdjson = remapNdjson(ndjson, tableName)

    const result = await insertIntoClickHouse(
      e.CLICKHOUSE_URL,
      e.CLICKHOUSE_DATABASE,
      tableName,
      remappedNdjson,
      e.CLICKHOUSE_USER,
      e.CLICKHOUSE_PASSWORD,
    )

    if (!result.ok) {
      console.error(result.error)
      return new Response(result.error, { status: 502 })
    }

    return Response.json({ successful_rows: ndjson.trim().split('\n').length, quarantined_rows: 0 })
  })

  // ── Query API: SQL pass-through ──
  .post('/v0/sql', async ({ request }) => {
    const e = getEnv()
    const sql = await request.text()

    const result = await queryClickHouse(
      e.CLICKHOUSE_URL,
      e.CLICKHOUSE_DATABASE,
      sql,
      e.CLICKHOUSE_USER,
      e.CLICKHOUSE_PASSWORD,
    )

    if (!result.ok) {
      return new Response(result.error, { status: 502 })
    }

    return new Response(result.data, {
      headers: { 'content-type': 'application/json' },
    })
  })
  .get('/v0/sql', async ({ request }) => {
    const url = new URL(request.url)
    const sql = url.searchParams.get('q')
    if (!sql) {
      return new Response('Missing ?q= query parameter', { status: 400 })
    }

    const e = getEnv()

    const result = await queryClickHouse(
      e.CLICKHOUSE_URL,
      e.CLICKHOUSE_DATABASE,
      sql,
      e.CLICKHOUSE_USER,
      e.CLICKHOUSE_PASSWORD,
    )

    if (!result.ok) {
      return new Response(result.error, { status: 502 })
    }

    return new Response(result.data, {
      headers: { 'content-type': 'application/json' },
    })
  })

export default {
  fetch(request: Request) {
    return app.handle(request)
  },
}

export { app }
