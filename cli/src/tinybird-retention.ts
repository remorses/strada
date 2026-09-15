// Render per-project Tinybird ENGINE_TTL from D1 project settings.
//
// Tinybird applies TTL-only datasource changes as ALTER after promotion.
// Conditional DELETE WHERE is the documented per-tenant form:
// https://www.tinybird.co/docs/changelog/2026-07-31-july-week-five
//
// Raw datasource files keep the default TTL so database create, tb deploy,
// and empty-org upgrades stay valid without this renderer. Custom groups
// replace that one ENGINE_TTL line.

export const RETENTION_MIN_DAYS = 1
export const RETENTION_MAX_DAYS = 365

export const DEFAULT_RETENTION_DAYS = {
  traces: 14,
  logs: 30,
  errors: 90,
  metrics: 90,
} as const

export type RetentionSignal = keyof typeof DEFAULT_RETENTION_DAYS

export interface ProjectRetention {
  id: string
  tracesRetentionDays: number
  logsRetentionDays: number
  errorsRetentionDays: number
  metricsRetentionDays: number
}

export interface TinybirdResourceFile {
  name: string
  content: string
}

const SIGNAL_TABLES: Record<RetentionSignal, { names: string[]; timeExpression: string }> = {
  traces: { names: ['otel_traces'], timeExpression: 'toDateTime(Timestamp)' },
  logs: { names: ['otel_logs'], timeExpression: 'TimestampTime' },
  errors: { names: ['otel_errors'], timeExpression: 'toDateTime(Timestamp)' },
  metrics: {
    names: [
      'otel_metrics_gauge',
      'otel_metrics_sum',
      'otel_metrics_histogram',
      'otel_metrics_exponential_histogram',
    ],
    timeExpression: 'toDateTime(TimeUnix)',
  },
}

export function validateRetentionDays(days: number, signal: RetentionSignal): number {
  if (!Number.isInteger(days) || days < RETENTION_MIN_DAYS || days > RETENTION_MAX_DAYS) {
    throw new Error(
      `${signal} retention must be an integer between ${RETENTION_MIN_DAYS} and ${RETENTION_MAX_DAYS} days`,
    )
  }
  return days
}

export function isDefaultRetention(project: ProjectRetention): boolean {
  return (
    project.tracesRetentionDays === DEFAULT_RETENTION_DAYS.traces
    && project.logsRetentionDays === DEFAULT_RETENTION_DAYS.logs
    && project.errorsRetentionDays === DEFAULT_RETENTION_DAYS.errors
    && project.metricsRetentionDays === DEFAULT_RETENTION_DAYS.metrics
  )
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

function ttlExpression(timeExpression: string, days: number): string {
  return `${timeExpression} + toIntervalDay(${days})`
}

function buildEngineTtl(timeExpression: string, defaultDays: number, projects: ProjectRetention[], signal: RetentionSignal): string {
  const groups = new Map<number, string[]>()
  for (const project of projects) {
    const days = project[`${signal}RetentionDays`]
    if (days === defaultDays) continue
    const ids = groups.get(days) ?? []
    ids.push(project.id)
    groups.set(days, ids)
  }

  if (groups.size === 0) {
    return `ENGINE_TTL "${ttlExpression(timeExpression, defaultDays)}"`
  }

  const customIds = [...groups.values()].flat().sort()
  const rules = [...groups.entries()]
    .sort(([leftDays], [rightDays]) => leftDays - rightDays)
    .map(([days, ids]) => {
      const sortedIds = [...ids].sort()
      return `${ttlExpression(timeExpression, days)} DELETE WHERE ProjectId IN (${inList(sortedIds)})`
    })
  rules.push(
    `${ttlExpression(timeExpression, defaultDays)} DELETE WHERE ProjectId NOT IN (${inList(customIds)})`,
  )
  return `ENGINE_TTL "${rules.join(', ')}"`
}

function replaceEngineTtl(content: string, engineTtl: string): string {
  if (!/^ENGINE_TTL\s+"/m.test(content)) {
    throw new Error('datasource is missing an ENGINE_TTL line')
  }
  return content.replace(/^ENGINE_TTL\s+".*"$/m, engineTtl)
}

export function renderTinybirdRetention({
  datasources,
  projects,
}: {
  datasources: TinybirdResourceFile[]
  projects: ProjectRetention[]
}): TinybirdResourceFile[] {
  const normalized = projects.map(normalizeProjectRetention)
  const byName = new Map(
    Object.entries(SIGNAL_TABLES).flatMap(([signal, table]) =>
      table.names.map((name) => [name, { signal: signal as RetentionSignal, timeExpression: table.timeExpression }]),
    ),
  )

  return datasources.map((datasource) => {
    const managed = byName.get(datasource.name)
    if (!managed) return datasource
    const engineTtl = buildEngineTtl(
      managed.timeExpression,
      DEFAULT_RETENTION_DAYS[managed.signal],
      normalized,
      managed.signal,
    )
    return {
      name: datasource.name,
      content: replaceEngineTtl(datasource.content, engineTtl),
    }
  })
}

export function extractEngineTtl(content: string): string | null {
  const match = content.match(/^ENGINE_TTL\s+"(.*)"$/m)
  return match?.[1] ?? null
}

