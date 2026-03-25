// Self-hosted Tinybird setup command.
//
// Tinybird browser auth lives in tinybird-browser-login.ts because the local
// callback server is easier to reason about as a small isolated module.

import * as clack from '@clack/prompts'
import picocolors from 'picocolors'
import { loadTinybirdResources } from './tinybird-resources.ts'
import { browserLogin } from './tinybird-browser-login.ts'

// ── Types ──

interface DeployResponse {
  result: 'success' | 'failed' | 'no_changes'
  deployment?: {
    id: string
    status: string
    new_datasource_names?: string[]
    new_pipe_names?: string[]
    errors?: Array<{ filename?: string; error: string }>
  }
  error?: string
  errors?: Array<{ filename?: string; error: string }>
}

interface DeploymentStatusResponse {
  result: string
  deployment: { id: string; status: string; live?: boolean }
}

export interface SelfhostOptions {
  token?: string
  baseUrl?: string
}

// ── Workspace info ──

interface WorkspaceInfo {
  name: string
  userEmail: string
}

async function fetchWorkspaceInfo(baseUrl: string, token: string): Promise<WorkspaceInfo> {
  const resp = await fetch(new URL('/v1/workspace', baseUrl).toString(), {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!resp.ok) {
    throw new Error(`Failed to fetch workspace info: ${resp.status} ${resp.statusText}`)
  }
  const data = (await resp.json()) as { name?: string; user_email?: string }
  return {
    name: data.name || 'unknown',
    userEmail: data.user_email || 'unknown',
  }
}

// ── Deploy ──

interface ResourceFile {
  name: string
  content: string
}

async function deployResources(
  baseUrl: string,
  token: string,
  datasources: ResourceFile[],
  pipes: ResourceFile[],
): Promise<{ success: boolean; error?: string; errors?: Array<{ filename?: string; error: string }> }> {
  const base = baseUrl.replace(/\/$/, '')

  // Clean up stale non-live deployments
  try {
    const resp = await fetch(`${base}/v1/deployments`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (resp.ok) {
      const body = (await resp.json()) as {
        deployments: Array<{ id: string; status: string; live?: boolean }>
      }
      for (const d of body.deployments) {
        if (!d.live && d.status !== 'live') {
          await fetch(`${base}/v1/deployments/${d.id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          })
        }
      }
    }
  } catch {
    // ignore cleanup errors
  }

  // Build multipart form
  const formData = new FormData()
  for (const ds of datasources) {
    formData.append(
      'data_project://',
      new Blob([ds.content], { type: 'text/plain' }),
      `${ds.name}.datasource`,
    )
  }
  for (const pipe of pipes) {
    formData.append(
      'data_project://',
      new Blob([pipe.content], { type: 'text/plain' }),
      `${pipe.name}.pipe`,
    )
  }

  // Create deployment
  const deployResp = await fetch(`${base}/v1/deploy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  })

  const deployBody = (await deployResp.json()) as DeployResponse

  if (deployBody.result === 'failed') {
    return {
      success: false,
      error: deployBody.error,
      errors: deployBody.errors ?? deployBody.deployment?.errors,
    }
  }

  if (deployBody.result === 'no_changes') {
    return { success: true }
  }

  const deploymentId = deployBody.deployment?.id
  if (!deploymentId) {
    return { success: false, error: 'No deployment ID in response' }
  }

  // Poll until ready
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000))

    const statusResp = await fetch(`${base}/v1/deployments/${deploymentId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const statusBody = (await statusResp.json()) as DeploymentStatusResponse

    if (statusBody.deployment.status === 'data_ready') {
      break
    }
    if (statusBody.deployment.status === 'failed') {
      return { success: false, error: 'Deployment failed during data migration' }
    }
  }

  // Promote to live
  const promoteResp = await fetch(`${base}/v1/deployments/${deploymentId}/set-live`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!promoteResp.ok) {
    const text = await promoteResp.text()
    return { success: false, error: `Failed to promote deployment: ${text}` }
  }

  return { success: true }
}

// ── Command action ──

export async function selfhostAction(options: SelfhostOptions) {
  clack.intro(picocolors.bold('Strada — Self-hosted Tinybird setup'))

  let token = options.token
  let baseUrl = options.baseUrl

  // ── Auth ──
  if (token && baseUrl) {
    clack.log.info(`Using provided token for ${baseUrl}`)
  } else if (token && !baseUrl) {
    clack.log.error('--base-url is required when using --token')
    process.exit(1)
  } else {
    clack.log.info('Opening browser to authenticate with Tinybird...')

    try {
      const auth = await browserLogin()
      token = auth.token
      baseUrl = auth.baseUrl

      // Fetch workspace info (the OAuth callback doesn't always include it)
      const workspace = await fetchWorkspaceInfo(baseUrl, token)

      clack.log.success(
        `Authenticated as ${picocolors.cyan(workspace.userEmail)} ` +
          `in workspace ${picocolors.cyan(workspace.name)}`,
      )
    } catch (err) {
      clack.log.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  }

  // ── Load resources ──
  const spinner = clack.spinner()
  spinner.start('Loading Tinybird resource files...')

  let resources
  try {
    resources = loadTinybirdResources()
  } catch (err) {
    spinner.stop('Failed to load resources')
    clack.log.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }

  spinner.message(
    `Found ${resources.datasources.length} datasources, ${resources.pipes.length} pipes`,
  )

  // ── Deploy ──
  spinner.message('Deploying to Tinybird...')

  try {
    const result = await deployResources(
      baseUrl,
      token,
      resources.datasources,
      resources.pipes,
    )

    if (!result.success) {
      spinner.stop('Deployment failed')
      if (result.error) clack.log.error(result.error)
      if (result.errors?.length) {
        for (const e of result.errors) {
          clack.log.error(`  ${e.filename || ''}: ${e.error}`)
        }
      }
      process.exit(1)
    }

    spinner.stop('Deployed successfully')
  } catch (err) {
    spinner.stop('Deployment failed')
    clack.log.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }

  // ── Output ──
  clack.log.success('Strada is deployed to your Tinybird workspace!')

  console.log('')
  console.log(picocolors.bold('Add these environment variables to your otel-collector:'))
  console.log('')
  console.log(`  ${picocolors.cyan('TINYBIRD_ENDPOINT')}=${baseUrl}`)
  console.log(`  ${picocolors.cyan('TINYBIRD_TOKEN')}=${token}`)
  console.log('')
  console.log(picocolors.dim('TenantId is always empty string for self-hosted — no row-level filtering needed.'))
  console.log(picocolors.dim('For reads, use this same workspace admin token with Tinybird /v0/sql queries.'))

  clack.outro('Done')
}
