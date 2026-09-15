// Render per-project Tinybird ENGINE_TTL from D1 project settings.
//
// Tinybird applies TTL-only datasource changes as ALTER after promotion.
// Conditional DELETE WHERE is the documented per-tenant form:
// https://www.tinybird.co/docs/changelog/2026-07-31-july-week-five
//
// Raw traces, logs, errors, and metrics keep all rows by default. The renderer
// adds ENGINE_TTL only for projects that set a custom day count. Analytics and
// health-check tables keep their independent 90-day TTL.

export const RETENTION_MIN_DAYS = 1
export const RETENTION_MAX_DAYS = 365

export type RetentionSignal = 'traces' | 'logs' | 'errors' | 'metrics'

export interface ProjectRetention {
  id: string
  tracesRetentionDays: number | null
  logsRetentionDays: number | null
  errorsRetentionDays: number | null
  metricsRetentionDays: number | null
}

export interface TinybirdResourceFile {
  name: string
  content: string
}

const MANAGED_DATASOURCES: Array<{
  name: string
  signal: RetentionSignal
  timeExpression: string
}> = [
  { name: 'otel_traces', signal: 'traces', timeExpression: 'toDateTime(Timestamp)' },
  { name: 'otel_logs', signal: 'logs', timeExpression: 'TimestampTime' },
  { name: 'otel_errors', signal: 'errors', timeExpression: 'toDateTime(Timestamp)' },
  { name: 'otel_metrics_gauge', signal: 'metrics', timeExpression: 'toDateTime(TimeUnix)' },
  { name: 'otel_metrics_sum', signal: 'metrics', timeExpression: 'toDateTime(TimeUnix)' },
  { name: 'otel_metrics_histogram', signal: 'metrics', timeExpression: 'toDateTime(TimeUnix)' },
  { name: 'otel_metrics_exponential_histogram', signal: 'metrics', timeExpression: 'toDateTime(TimeUnix)' },
]

export function validateRetentionDays(days: number | null, signal: RetentionSignal): number | null {
  if (days == null) return null
  if (!Number.isInteger(days) || days < RETENTION_MIN_DAYS || days > RETENTION_MAX_DAYS) {
    throw new Error(
      `${signal} retention must be an integer between ${RETENTION_MIN_DAYS} and ${RETENTION_MAX_DAYS} days`,
    )
  }
  return days
}

export function hasCustomRetention(project: ProjectRetention): boolean {
  return (
    project.tracesRetentionDays != null
    || project.logsRetentionDays != null
    || project.errorsRetentionDays != null
    || project.metricsRetentionDays != null
  )
}

export function mergeProjectRetention({
  current,
  update,
}: {
  current: ProjectRetention
  update: {
    tracesDays?: number | null
    logsDays?: number | null
    errorsDays?: number | null
    metricsDays?: number | null
  }
}): ProjectRetention {
  return {
    id: current.id,
    tracesRetentionDays: update.tracesDays === undefined ? current.tracesRetentionDays : update.tracesDays,
    logsRetentionDays: update.logsDays === undefined ? current.logsRetentionDays : update.logsDays,
    errorsRetentionDays: update.errorsDays === undefined ? current.errorsRetentionDays : update.errorsDays,
    metricsRetentionDays: update.metricsDays === undefined ? current.metricsRetentionDays : update.metricsDays,
  }
}

function normalizeProjectRetention(project: ProjectRetention): ProjectRetention {
  return {
    id: project.id,
    tracesRetentionDays: validateRetentionDays(project.tracesRetentionDays, 'traces'),
    logsRetentionDays: validateRetentionDays(project.logsRetentionDays, 'logs'),
    errorsRetentionDays: validateRetentionDays(project.errorsRetentionDays, 'errors'),
    metricsRetentionDays: validateRetentionDays(project.metricsRetentionDays, 'metrics'),
  }
}

function escapeClickHouseString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")
}

function quoteProjectId(id: string): string {
  return `'${escapeClickHouseString(id)}'`
}

function inList(ids: string[]): string {
  return ids.map(quoteProjectId).join(', ')
}

function buildEngineTtl({
  timeExpression,
  projects,
  signal,
}: {
  timeExpression: string
  projects: ProjectRetention[]
  signal: RetentionSignal
}): string | null {
  const groups = new Map<number, string[]>()
  for (const project of projects) {
    const days = project[`${signal}RetentionDays`]
    if (days == null) continue
    const ids = groups.get(days) ?? []
    ids.push(project.id)
    groups.set(days, ids)
  }

  if (groups.size === 0) return null

  const rules = [...groups.entries()]
    .sort(([leftDays], [rightDays]) => leftDays - rightDays)
    .map(([days, ids]) => {
      const sortedIds = [...ids].sort()
      return `${timeExpression} + toIntervalDay(${days}) DELETE WHERE ProjectId IN (${inList(sortedIds)})`
    })
  return `ENGINE_TTL "${rules.join(', ')}"`
}

function applyEngineTtl(content: string, engineTtl: string | null): string {
  if (engineTtl) {
    if (/^ENGINE_TTL\s+"/m.test(content)) {
      return content.replace(/^ENGINE_TTL\s+".*"$/m, engineTtl)
    }
    if (/^ENGINE_SORTING_KEY\s+".*"$/m.test(content)) {
      return content.replace(/^(ENGINE_SORTING_KEY\s+".*")$/m, `$1\n${engineTtl}`)
    }
    throw new Error('datasource is missing ENGINE_SORTING_KEY; cannot insert ENGINE_TTL')
  }
  return content.replace(/\nENGINE_TTL\s+".*"/, '')
}

export function renderTinybirdRetention({
  datasources,
  projects,
}: {
  datasources: TinybirdResourceFile[]
  projects: ProjectRetention[]
}): TinybirdResourceFile[] {
  const normalized = projects.map(normalizeProjectRetention)
  const byName = new Map(MANAGED_DATASOURCES.map((table) => [table.name, table]))

  return datasources.map((datasource) => {
    const managed = byName.get(datasource.name)
    if (!managed) return datasource
    return {
      name: datasource.name,
      content: applyEngineTtl(
        datasource.content,
        buildEngineTtl({
          timeExpression: managed.timeExpression,
          projects: normalized,
          signal: managed.signal,
        }),
      ),
    }
  })
}

export function extractEngineTtl(content: string): string | null {
  const match = content.match(/^ENGINE_TTL\s+"(.*)"$/m)
  return match?.[1] ?? null
}
