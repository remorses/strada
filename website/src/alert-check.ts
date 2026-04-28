// Scheduled alert check handler. Runs every 5 minutes via cron trigger.
// Queries each org's projects for errors exceeding the configured threshold,
// cross-references with otel_issue_state to check cooldown, then sends
// notifications to all configured destinations (email/webhook).
//
// Flow:
//   1. Load orgs with alert rules + destinations from D1
//   2. For each org, load database config + projects
//   3. For each project, query otel_errors for fingerprints exceeding threshold
//   4. Cross-reference otel_issue_state for cooldown (LastAlertedAt)
//   5. For new/cooled-down alerts, send notifications + update LastAlertedAt

import * as orm from 'drizzle-orm'
import * as schema from 'db/src/schema.ts'
import { env } from 'cloudflare:workers'
import { getLogger, flush } from '@strada.sh/sdk'
import { getDb, getOrCreateProjectJwt } from './db.ts'
import { buildAlertSubject, buildAlertEmailHtml } from './alert-email.tsx'

const logger = getLogger('alert-check')

interface AlertableError {
  fingerprintHash: string
  errorCount: number
  exceptionType: string
  exceptionMessage: string
  exceptionStacktrace: string
  firstSeen: string
  serviceName: string
  usersImpacted: number
}

interface DbConfig {
  backend: string
  tinybirdEndpoint: string | null
  tinybirdAdminToken: string | null
  clickhouseUrl: string | null
  clickhouseDatabase: string | null
  clickhouseUser: string | null
  clickhousePassword: string | null
}

interface ProjectWithJwt {
  id: string
  slug: string
  tinybirdJwt: string | null
  tinybirdJwtDatasources: string | null
}

/** Main scheduled handler. Called by the cron trigger every 5 minutes. */
export async function checkAlerts(): Promise<void> {
  const db = getDb()

  // 1. Load all alert rules with destinations and org name
  const rules = await db.query.alertRule.findMany({
    with: { destinations: true, org: true },
  })

  logger.info({ message: `found ${rules.length} rules`, rulesCount: rules.length })

  if (rules.length === 0) return

  for (const rule of rules) {
    if (!rule.destinations || rule.destinations.length === 0) {
      logger.info({ message: `rule has no destinations, skipping`, ruleId: rule.id })
      continue
    }

    try {
      await checkOrgAlerts(rule)
    } catch (err) {
      logger.error({ message: `alert check failed for org`, orgId: rule.orgId, error: String(err) })
    }
  }

  // Flush SDK logs before returning. The cron handler wraps this in
  // ctx.waitUntil, so the isolate stays alive until the flush completes.
  // Without this, logs emitted near the end of the cron may be lost.
  await flush()
}

async function checkOrgAlerts(rule: {
  id: string
  orgId: string
  threshold: number
  windowMinutes: number
  cooldownMinutes: number
  destinations: Array<{ channel: string; destination: string }>
  org: { id: string; name: string } | null
}): Promise<void> {
  const db = getDb()

  // Load database config for this org
  const dbConfig = await db.query.database.findFirst({
    where: { orgId: rule.orgId },
  })
  if (!dbConfig) {
    logger.warn({ message: `no database config for org`, orgId: rule.orgId })
    return
  }

  // Load all projects for this org
  const projects = await db.query.project.findMany({
    where: { orgId: rule.orgId },
  })
  if (projects.length === 0) {
    logger.warn({ message: `no projects for org`, orgId: rule.orgId })
    return
  }
  logger.info({ message: `checking org`, orgId: rule.orgId, projectCount: projects.length, backend: dbConfig.backend })

  const orgName = rule.org?.name || 'Unknown'

  for (const project of projects) {
    try {
      await checkProjectAlerts({
        project,
        dbConfig,
        rule,
        orgName,
      })
    } catch (err) {
      logger.error({ message: `alert check failed for project`, projectSlug: project.slug, error: String(err) })
    }
  }
}

async function checkProjectAlerts(ctx: {
  project: ProjectWithJwt
  dbConfig: DbConfig
  rule: {
    threshold: number
    windowMinutes: number
    cooldownMinutes: number
    destinations: Array<{ channel: string; destination: string }>
  }
  orgName: string
}): Promise<void> {
  const { project, dbConfig, rule, orgName } = ctx

  // Query errors exceeding threshold in the window
  const errors = await queryErrorsAboveThreshold({
    project,
    dbConfig,
    threshold: rule.threshold,
    windowMinutes: rule.windowMinutes,
  })

  logger.info({ message: `error groups above threshold`, projectSlug: project.slug, errorGroupCount: errors.length, threshold: rule.threshold, windowMinutes: rule.windowMinutes })

  if (errors.length === 0) return

  // Check cooldown for each fingerprint via otel_issue_state
  const fingerprints = errors.map((e) => e.fingerprintHash)
  const issueStates = await queryIssueStates({ project, dbConfig, fingerprints })

  const cooldownMs = rule.cooldownMinutes * 60 * 1000
  const now = Date.now()

  for (const error of errors) {
    const state = issueStates.get(error.fingerprintHash)
    const lastAlertedAt = state?.lastAlertedAt
      ? new Date(state.lastAlertedAt).getTime()
      : 0

    // Skip if within cooldown
    if (lastAlertedAt > 0 && now - lastAlertedAt < cooldownMs) {
      logger.debug({ message: `skipping, within cooldown`, fingerprintHash: error.fingerprintHash, lastAlertedAt: new Date(lastAlertedAt).toISOString(), cooldownMinutes: rule.cooldownMinutes })
      continue
    }

    logger.info({ message: `sending alert for error group`, fingerprintHash: error.fingerprintHash, errorCount: error.errorCount, exceptionType: error.exceptionType, destinationCount: rule.destinations.length })
    const alertData = {
      projectSlug: project.slug,
      orgName,
      fingerprintHash: error.fingerprintHash,
      exceptionType: error.exceptionType,
      exceptionMessage: error.exceptionMessage,
      exceptionStacktrace: error.exceptionStacktrace,
      errorCount: error.errorCount,
      windowMinutes: rule.windowMinutes,
      firstSeen: error.firstSeen,
      serviceName: error.serviceName,
      usersImpacted: error.usersImpacted,
    }

    const results = await Promise.allSettled(
      rule.destinations.map((dest) => sendNotification(dest, alertData)),
    )
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('[alert-check] sendNotification rejected:', result.reason)
        logger.error({ message: 'sendNotification rejected', error: String(result.reason) })
      }
    }

    // Update LastAlertedAt in otel_issue_state
    await writeLastAlertedAt({
      project,
      dbConfig,
      fingerprintHash: error.fingerprintHash,
      currentState: state,
    })
  }
}

async function queryErrorsAboveThreshold(ctx: {
  project: ProjectWithJwt
  dbConfig: DbConfig
  threshold: number
  windowMinutes: number
}): Promise<AlertableError[]> {
  const { project, dbConfig, threshold, windowMinutes } = ctx

  const sql = [
    'SELECT',
    '    FingerprintHash,',
    '    count() AS error_count,',
    '    anyLast(ExceptionType) AS exception_type,',
    '    anyLast(ExceptionMessage) AS exception_message,',
    '    anyLast(ExceptionStacktrace) AS exception_stacktrace,',
    '    min(Timestamp) AS first_seen,',
    '    anyLast(ServiceName) AS service_name,',
    "    uniqExact(Tags['user.id']) AS users_impacted",
    'FROM otel_errors',
    `WHERE Timestamp >= now() - INTERVAL ${windowMinutes} MINUTE`,
    'GROUP BY FingerprintHash',
    `HAVING error_count >= ${threshold}`,
    'ORDER BY error_count DESC',
    'LIMIT 100',
    'FORMAT JSON',
  ].join('\n')

  const result = await executeQuery({ project, dbConfig, sql })
  const rows = result.data ?? []

  return rows.map((row) => ({
    fingerprintHash: String(row.FingerprintHash ?? ''),
    errorCount: Number(row.error_count ?? 0),
    exceptionType: String(row.exception_type ?? ''),
    exceptionMessage: String(row.exception_message ?? ''),
    exceptionStacktrace: String(row.exception_stacktrace ?? ''),
    firstSeen: String(row.first_seen ?? ''),
    serviceName: String(row.service_name ?? ''),
    usersImpacted: Number(row.users_impacted ?? 0),
  }))
}

interface IssueStateInfo {
  status: string
  lastAlertedAt: string | null
  assigneeMemberId: string
  resolvedAt: string | null
  resolvedByMemberId: string
}

async function queryIssueStates(ctx: {
  project: ProjectWithJwt
  dbConfig: DbConfig
  fingerprints: string[]
}): Promise<Map<string, IssueStateInfo>> {
  const { project, dbConfig, fingerprints } = ctx
  if (fingerprints.length === 0) return new Map()

  const inList = fingerprints.map((f) => `'${f}'`).join(', ')
  const projectFilter = dbConfig.backend === 'clickhouse'
    ? `ProjectId = '${project.id}' AND `
    : ''

  // Use argMax() deduplication instead of FINAL. Tinybird wraps JWT queries
  // in a subquery and FINAL is not supported on subqueries.
  const sql = [
    'SELECT',
    '    FingerprintHash,',
    '    argMax(Status, Version) AS Status,',
    '    argMax(LastAlertedAt, Version) AS LastAlertedAt,',
    '    argMax(AssigneeMemberId, Version) AS AssigneeMemberId,',
    '    argMax(ResolvedAt, Version) AS ResolvedAt,',
    '    argMax(ResolvedByMemberId, Version) AS ResolvedByMemberId',
    'FROM otel_issue_state',
    `WHERE ${projectFilter}FingerprintHash IN (${inList})`,
    'GROUP BY FingerprintHash',
    `LIMIT ${fingerprints.length}`,
    'FORMAT JSON',
  ].join('\n')

  try {
    const result = await executeQuery({ project, dbConfig, sql })
    const map = new Map<string, IssueStateInfo>()
    for (const row of result.data ?? []) {
      map.set(String(row.FingerprintHash), {
        status: String(row.Status ?? 'open'),
        lastAlertedAt: row.LastAlertedAt ? String(row.LastAlertedAt) : null,
        assigneeMemberId: String(row.AssigneeMemberId ?? ''),
        resolvedAt: row.ResolvedAt ? String(row.ResolvedAt) : null,
        resolvedByMemberId: String(row.ResolvedByMemberId ?? ''),
      })
    }
    return map
  } catch (err) {
    logger.error({ message: `queryIssueStates failed, proceeding without cooldown data`, error: String(err) })
    return new Map()
  }
}

async function writeLastAlertedAt(ctx: {
  project: ProjectWithJwt
  dbConfig: DbConfig
  fingerprintHash: string
  currentState: IssueStateInfo | undefined
}): Promise<void> {
  const { project, dbConfig, fingerprintHash, currentState } = ctx
  const now = Date.now()
  const nowIso = new Date(now).toISOString()

  const row = {
    project_id: project.id,
    fingerprint_hash: fingerprintHash,
    status: currentState?.status || 'open',
    assignee_member_id: currentState?.assigneeMemberId || '',
    resolved_at: currentState?.resolvedAt || null,
    resolved_by_member_id: currentState?.resolvedByMemberId || '',
    last_alerted_at: nowIso,
    version: now,
    updated_at: nowIso,
  }

  const ndjson = JSON.stringify(row)

  if (dbConfig.backend === 'tinybird') {
    if (!dbConfig.tinybirdEndpoint || !dbConfig.tinybirdAdminToken) return
    await fetch(`${dbConfig.tinybirdEndpoint}/v0/events?name=otel_issue_state&wait=true`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-ndjson',
        Authorization: `Bearer ${dbConfig.tinybirdAdminToken}`,
      },
      body: ndjson,
    })
  } else if (dbConfig.backend === 'clickhouse') {
    if (!dbConfig.clickhouseUrl) return
    const chRow = {
      ProjectId: row.project_id,
      FingerprintHash: row.fingerprint_hash,
      Status: row.status,
      AssigneeMemberId: row.assignee_member_id,
      ResolvedAt: row.resolved_at,
      ResolvedByMemberId: row.resolved_by_member_id,
      LastAlertedAt: row.last_alerted_at,
      Version: row.version,
      UpdatedAt: row.updated_at,
    }
    const insertSql = `INSERT INTO otel_issue_state FORMAT JSONEachRow`
    const endpoint = `${dbConfig.clickhouseUrl}/?database=${encodeURIComponent(dbConfig.clickhouseDatabase || 'default')}&query=${encodeURIComponent(insertSql)}`
    await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ClickHouse-User': dbConfig.clickhouseUser || 'default',
        'X-ClickHouse-Key': dbConfig.clickhousePassword || '',
      },
      body: JSON.stringify(chRow),
    })
  }
}

async function sendNotification(
  dest: { channel: string; destination: string },
  data: Parameters<typeof buildAlertEmailHtml>[0],
): Promise<void> {
  if (dest.channel === 'email') {
    const subject = buildAlertSubject(data)
    const html = buildAlertEmailHtml(data)

    try {
      console.log(`[alert-check] sending email to ${dest.destination}, subject: ${subject}`)
      logger.info({ message: `sending alert email`, to: dest.destination, subject })
      await env.EMAIL.send({
        from: { email: 'alerts@updates.strada.sh', name: 'Strada' },
        to: dest.destination,
        subject,
        html,
      })
      console.log(`[alert-check] email sent to ${dest.destination}`)
      logger.info({ message: `alert email sent`, to: dest.destination })
    } catch (err) {
      console.error(`[alert-check] email send failed:`, err)
      logger.error({ message: `failed to send alert email`, to: dest.destination, error: String(err) })
    }
  } else if (dest.channel === 'webhook') {
    try {
      console.log(`[alert-check] sending webhook to ${dest.destination}`)
      await fetch(dest.destination, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'error_alert',
          project: data.projectSlug,
          org: data.orgName,
          fingerprintHash: data.fingerprintHash,
          exceptionType: data.exceptionType,
          exceptionMessage: data.exceptionMessage,
          errorCount: data.errorCount,
          windowMinutes: data.windowMinutes,
          firstSeen: data.firstSeen,
          serviceName: data.serviceName,
        }),
      })
    } catch (err) {
      console.error(`[alert-check] webhook send failed:`, err)
      logger.error({ message: `failed to send webhook`, destination: dest.destination, error: String(err) })
    }
  } else {
    console.warn(`[alert-check] unknown channel: ${dest.channel}`)
  }
}

// ── Query helpers ──────────────────────────────────────────────────

interface QueryResult {
  data?: Record<string, unknown>[]
}

async function executeQuery(ctx: {
  project: ProjectWithJwt
  dbConfig: DbConfig
  sql: string
}): Promise<QueryResult> {
  const { project, dbConfig, sql } = ctx

  if (dbConfig.backend === 'tinybird') {
    if (!dbConfig.tinybirdEndpoint || !dbConfig.tinybirdAdminToken) {
      throw new Error('tinybird not configured')
    }
    const jwt = await getOrCreateProjectJwt({
      projectId: project.id,
      tinybirdEndpoint: dbConfig.tinybirdEndpoint,
      tinybirdAdminToken: dbConfig.tinybirdAdminToken,
      tinybirdJwt: project.tinybirdJwt,
      tinybirdJwtDatasources: project.tinybirdJwtDatasources,
    })
    const res = await fetch(`${dbConfig.tinybirdEndpoint}/v0/sql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ q: sql }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Tinybird query failed: ${res.status} ${text}`)
    }
    return await res.json()
  }

  if (dbConfig.backend === 'clickhouse') {
    if (!dbConfig.clickhouseUrl) {
      throw new Error('clickhouse not configured')
    }
    const endpoint = `${dbConfig.clickhouseUrl}/?database=${encodeURIComponent(dbConfig.clickhouseDatabase || 'default')}&query=${encodeURIComponent(sql)}`
    const res = await fetch(endpoint, {
      headers: {
        'X-ClickHouse-User': dbConfig.clickhouseUser || 'default',
        'X-ClickHouse-Key': dbConfig.clickhousePassword || '',
      },
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`ClickHouse query failed: ${res.status} ${text}`)
    }
    return await res.json()
  }

  throw new Error('unknown backend')
}
