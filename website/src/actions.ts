// Server actions for the Strada dashboard UI.
// Client components import these directly instead of receiving action props.
// Actions authenticate via getActionRequest() and verify org membership + role.

'use server'

import { ulid } from 'ulid'
import * as schema from 'db/src/schema.ts'
import { getActionRequest, redirect } from 'spiceflow'
import { router } from 'spiceflow/react'
import { getDb, getSession } from './db.ts'

async function requireActionSession() {
  const request = getActionRequest()
  const session = await getSession(request)
  if (!session) throw new Error('Unauthorized')
  return session
}

async function requireAdminMember(userId: string, orgId: string) {
  const db = getDb()
  const member = await db.query.orgMember.findFirst({
    where: { orgId, userId },
  })
  if (!member) throw new Error('Not a member of this organization')
  if (member.role !== 'admin') throw new Error('Admin access required')
  return member
}

export async function createOrgAction({ name }: { name: string }) {
  if (!name) throw new Error('Name is required')
  const session = await requireActionSession()
  const db = getDb()
  const orgId = ulid()
  const dbId = ulid()

  await db.batch([
    db.insert(schema.org).values({ id: orgId, name }),
    db.insert(schema.orgMember).values({ orgId, userId: session.userId, role: 'admin' }),
    db.insert(schema.database).values({ id: dbId, orgId, backend: 'tinybird' }),
  ])

  throw redirect(router.href('/dash/orgs/:orgId', { orgId }))
}

export async function createProjectAction({ name, orgId }: { name: string; orgId: string }) {
  if (!name) throw new Error('Name is required')
  if (!orgId) throw new Error('No org selected')
  const session = await requireActionSession()
  await requireAdminMember(session.userId, orgId)
  const db = getDb()

  // Derive slug from name: lowercase, replace spaces/special chars with hyphens
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  if (!slug) throw new Error('Invalid project name')

  // Need a configured database for the project
  const database = await db.query.database.findFirst({
    where: { orgId },
  })
  if (!database) throw new Error('No database configured for this org')

  // Validate that the backend has credentials configured
  if (database.backend === 'tinybird' && (!database.tinybirdEndpoint || !database.tinybirdAdminToken)) {
    throw new Error('Configure your Tinybird database before creating projects. Run `strada database create` from the CLI.')
  }
  if (database.backend === 'clickhouse' && !database.clickhouseUrl) {
    throw new Error('Configure your ClickHouse database before creating projects.')
  }

  const projectId = ulid()
  await db.insert(schema.project).values({
    id: projectId,
    slug,
    orgId,
    databaseId: database.id,
  })

  throw redirect(router.href('/dash/projects/:projectId', { projectId }))
}
