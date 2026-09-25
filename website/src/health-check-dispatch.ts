// Health check dispatch. Called by the cron trigger every 5 minutes.
// Loads enabled health_check rule IDs from D1 and spawns a single
// HealthCheckWorkflow instance with minimal params (just IDs).
// The workflow resolves all config, state, destinations, and DB
// credentials from D1 inside each step.

import { env } from 'cloudflare:workers'
import { getLogger, flush } from '@strada.sh/sdk'
import { getDb } from './db.ts'
import type { HealthCheckWorkflowParams, CheckRef } from './health-check-workflow.ts'

const logger = getLogger('health-check-dispatch')

export async function dispatchHealthChecks(scheduledTime: number): Promise<void> {
  const db = getDb()

  // Load just IDs and orgId for enabled health_check rules
  const rules = await db.query.alertRule.findMany({
    where: { type: 'health_check', enabled: true },
  })

  if (rules.length === 0) return

  const checks: CheckRef[] = rules
    .filter((r) => r.checkUrl)
    .map((r) => ({ checkId: r.id, orgId: r.orgId }))

  if (checks.length === 0) return

  const orgIds = [...new Set(checks.map((c) => c.orgId))]
  logger.info({ message: 'dispatching health check workflow', orgCount: orgIds.length, totalChecks: checks.length })

  try {
    await env.HEALTH_CHECK_WORKFLOW.create({
      id: `health-${Date.now()}`,
      params: { checks, scheduledTime } satisfies HealthCheckWorkflowParams,
    })
  } catch (err) {
    logger.error({ message: 'failed to create health check workflow instance', error: String(err) })
  }

  await flush()
}
