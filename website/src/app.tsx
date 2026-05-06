/// <reference path="./globals.d.ts" />

// Strada website entry point. Renders auth pages, dashboard shell, and mounts API routes.
// Handles Google social login, device flow approval, and the Cloudflare Worker fetch entry.
//
// Two nested layouts:
// 1. /* — HTML shell (head, body)
// 2. /dash/* — Authenticated app shell with sidebar
//
// Standalone pages (no sidebar): /, /login, /device

import './globals.css'
import type { ReactNode } from 'react'
import { getActionRequest, json, parseFormData, Spiceflow, redirect } from 'spiceflow'
import { Head, Link, ProgressBar, router } from 'spiceflow/react'
import { z } from 'zod'
import { env } from 'cloudflare:workers'
import { initStrada, captureException, trace } from '@strada.sh/sdk'
import { Button } from './components/ui/button.tsx'
import { DeviceActionButtons } from './components/device-action-buttons.tsx'
import { api } from './api.ts'
import { getAuth, getDb, getSession, requireSession } from './db.ts'
import { checkAlerts } from './alert-check.ts'
import { cn } from './lib/utils.ts'

const loginQuerySchema = z.object({ callbackURL: z.string().optional() })

const devicePageQuerySchema = z.object({
  user_code: z.string().optional(),
  status: z.enum(['approved', 'denied']).optional(),
})

const deviceUserCodeSchema = z.object({ userCode: z.string().min(1) })

function safeRedirectPath(value: string | undefined | null) {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/'
  // Parse with URL to safely extract pathname + search (preserves query params)
  const url = new URL(value, 'https://strada.local')
  // Block /login as callbackURL to prevent redirect loops
  if (url.pathname === '/login') return '/'
  if (url.pathname === '/' || url.pathname === '/device' || url.pathname.startsWith('/dash/')) {
    return `${url.pathname}${url.search}`
  }
  return '/'
}

function AuthPage({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <Head>
        <Head.Title>{`${title} | Strada`}</Head.Title>
        <Head.Meta name="description" content={description} />
      </Head>
      <section className="flex w-full max-w-md flex-col gap-6 rounded-xl border bg-card p-8 text-card-foreground shadow-sm">
        {children}
      </section>
    </main>
  )
}

// ── Session helper that redirects to /login for pages ────────────
type Session = { userId: string; user: { id: string; name: string; email: string } }

async function requirePageSession(request: Request): Promise<Session> {
  const session = await getSession(request)
  if (!session) {
    const url = new URL(request.url)
    const redirectTo = url.pathname + url.search
    throw redirect(router.href('/login', { callbackURL: redirectTo }))
  }
  return session
}

async function requirePageOrgMember(userId: string, orgId: string) {
  const db = getDb()
  const member = await db.query.orgMember.findFirst({
    where: { orgId, userId },
  })
  if (!member) {
    throw redirect('/')
  }
  return member
}

// ── Grid decoration helpers ──────────────────────────────────
const gridDotPosition = {
  tl: 'top-0 left-0 -translate-x-1/2 -translate-y-1/2',
  tr: 'top-0 right-0 translate-x-1/2 -translate-y-1/2',
  bl: 'bottom-0 left-0 -translate-x-1/2 translate-y-1/2',
  br: 'bottom-0 right-0 translate-x-1/2 translate-y-1/2',
} as const

const dotClasses = cn(
  'absolute z-20 size-5 rounded-full bg-background pointer-events-none',
  'after:content-[""] after:block after:size-[2px] after:rounded-full after:bg-foreground/40 after:m-auto',
  'flex items-center justify-center',
)

function GridDot({ position, className }: { position: keyof typeof gridDotPosition; className?: string }) {
  return <div aria-hidden className={cn(dotClasses, gridDotPosition[position], className)} />
}

function GridSection({ children, grow, className, hideTop }: {
  children: React.ReactNode
  grow?: boolean
  className?: string
  hideTop?: boolean
}) {
  return (
    <div className={cn(
      'relative max-w-(--content-max-width) mx-auto w-full border-x border-border md:border-l-0',
      grow && 'grow flex flex-col',
      className,
    )}>
      {!hideTop && <GridDot position="tl" className="md:hidden" />}
      {!hideTop && <GridDot position="tr" />}
      {children}
      <GridDot position="bl" className="md:hidden" />
      <GridDot position="br" />
    </div>
  )
}

function GridDivider() {
  return (
    <div className="relative border-t border-border">
      <div aria-hidden className={cn(dotClasses, 'top-0 left-0 -translate-x-1/2 -translate-y-1/2 md:hidden')} />
    </div>
  )
}

// ── Tab bar for project pages ────────────────────────────────
function TabBar({ projectId, pathname }: { projectId: string; pathname: string }) {
  const base = `/dash/projects/${projectId}`
  const tabs = [
    { label: 'Errors', href: `${base}`, active: pathname === base || pathname === `${base}/` },
    { label: 'Issues', href: `${base}/issues`, active: pathname === `${base}/issues` },
  ] as const

  return (
    <div className="flex items-stretch gap-6 px-6 pt-9 pb-3 overflow-x-auto scrollbar-hide">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          className={cn(
            "relative flex items-center shrink-0 whitespace-nowrap text-sm no-underline transition-colors duration-150",
            tab.active
              ? "font-medium text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {tab.label}
          {tab.active && (
            <div className="absolute -bottom-3 left-0 w-full h-[2.5px] bg-primary rounded-sm" />
          )}
        </Link>
      ))}
    </div>
  )
}

// ── Footer ───────────────────────────────────────────���───────
function DashFooter() {
  return (
    <GridSection>
      <div className="flex items-center justify-end gap-4 px-6 py-5">
        <span className="text-xs text-muted-foreground">
          © {new Date().getFullYear()} Strada
        </span>
        <a
          href="https://github.com/remorses/strada"
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="size-4" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
          </svg>
        </a>
      </div>
    </GridSection>
  )
}

if (env.STRADA_PROJECT_ID) {
  initStrada({ projectId: env.STRADA_PROJECT_ID, service: 'strada-website' })
}

const tracer = trace.getTracer('strada-website')

export const app = new Spiceflow({ tracer })

  // ── Strada SDK (error capture) ────────────────────────────────
  .onError(({ error }) => {
    console.error('onError caught:', error)
    captureException(error)
    return new Response('Internal Server Error', { status: 500 })
  })

  // ── BetterAuth middleware ──────────────────────────────────────
  .use(async ({ request }, next) => {
    if (request.parsedUrl.pathname.startsWith('/api/auth')) {
      const auth = getAuth()
      const res = await auth.handler(request)
      if (res.ok || res.status !== 404) return res
    }
    return next()
  })

  // ── Layout 1: HTML shell ──────────────────────────────────────
  .layout('/*', async ({ children }) => {
    return (
      <html lang="en">
        <Head>
          <Head.Meta charSet="UTF-8" />
          <Head.Meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <Head.Title>Strada</Head.Title>
          <Head.Meta
            name="description"
            content="OpenTelemetry-native observability with traces, logs, metrics, and error tracking."
          />
        </Head>
        <body className="relative flex flex-col min-h-screen bg-background font-sans antialiased">
          <ProgressBar color="var(--primary)" />
          {children ?? (
            <AuthPage
              description="The page you requested does not exist."
              title="Page not found"
            >
              <div className="flex flex-col gap-2 text-center">
                <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
                <p className="text-sm text-muted-foreground">
                  Check the URL or go back to the app.
                </p>
              </div>
            </AuthPage>
          )}
        </body>
      </html>
    )
  })

  // ── Dashboard loaders ─────────────────────────────────────────

  .loader('/dash/*', async ({ request }) => {
    const db = getDb()
    const pathname = new URL(request.url).pathname
    const projectId = new URLPattern({ pathname: '/dash/projects/:projectId/*' })
      .exec(request.url)?.pathname.groups.projectId ?? null
    const session = await requirePageSession(request)
    const members = await db.query.orgMember.findMany({
      where: { userId: session.userId },
      with: { org: true },
    })

    const orgs = members.filter((m) => m.org != null).map((m) => ({
      id: m.org!.id!, name: m.org!.name!, role: m.role,
    }))

    return {
      orgs,
      projectId,
      pathname,
      user: { name: session.user.name || 'User', email: session.user.email || '' },
    }
  })

  .loader('/dash/orgs/:orgId', async ({ params, request }) => {
    const db = getDb()
    const session = await requirePageSession(request)
    await requirePageOrgMember(session.userId, params.orgId)

    const allProjects = await db.query.project.findMany({
      where: { orgId: params.orgId },
      orderBy: { createdAt: 'desc' },
    })

    const projects = allProjects.map((p) => ({ id: p.id, name: p.slug }))

    return {
      orgId: params.orgId,
      projectId: null,
      projects,
    }
  })

  .loader('/dash/projects/:projectId/*', async ({ params, request }) => {
    const db = getDb()
    const url = new URL(request.url)
    const { projectId } = params
    const session = await requirePageSession(request)

    const project = await db.query.project.findFirst({
      where: { id: projectId },
    })
    if (!project) throw redirect('/')

    await requirePageOrgMember(session.userId, project.orgId)

    const allProjects = await db.query.project.findMany({
      where: { orgId: project.orgId },
      orderBy: { createdAt: 'desc' },
    })

    const projects = allProjects.map((p) => ({ id: p.id, name: p.slug }))

    return {
      orgId: project.orgId,
      projectId,
      projectName: project.slug,
      pathname: url.pathname,
      projects,
    }
  })

  // ── Layout 2: Authenticated app shell with sidebar ─────────────
  .layout('/dash/*', async ({ children, loaderData }) => {
    const { Sidebar, MobileDrawer, MobileMenuButton } = await import('./components/sidebar.tsx')
    const projectId = loaderData.projectId
    return (
      <div className="isolate relative flex w-full h-screen overflow-clip">
        <Sidebar />
        <MobileDrawer />
        {/* Mobile hamburger */}
        <div className="md:hidden fixed top-3 left-3 z-30">
          <MobileMenuButton />
        </div>
        <div className="flex-1 flex flex-col min-w-0">
          {projectId && (
            <>
              <GridSection hideTop>
                <TabBar
                  projectId={projectId}
                  pathname={loaderData.pathname}
                />
              </GridSection>
              <GridDivider />
            </>
          )}
          <GridSection grow className="overflow-hidden">
            <main className="flex-1 overflow-auto p-6">
              {children}
            </main>
          </GridSection>
          <GridDivider />
          <DashFooter />
        </div>
      </div>
    )
  })

  // ── Root redirect ─────────────────────────────────────────────
  .get('/', async ({ request }) => {
    const session = await getSession(request)
    if (!session) return Response.redirect(new URL('/login', request.url).toString(), 302)
    const db = getDb()
    const base = new URL(request.url)
    try {
      const members = await db.query.orgMember.findMany({
        where: { userId: session.userId },
        with: { org: true },
      })
      const firstOrg = members.find((m) => m.org != null)
      if (firstOrg) {
        return Response.redirect(new URL(`/dash/orgs/${encodeURIComponent(firstOrg.org!.id)}`, base).toString(), 302)
      }
    } catch (err) {
      console.error('Root redirect failed:', err)
    }
    return Response.redirect(new URL('/dash/new-org', base).toString(), 302)
  })

  // ── Org page (redirect to first project, or empty state) ────────
  .page('/dash/orgs/:orgId', async ({ params, request }) => {
    const session = await requirePageSession(request)
    await requirePageOrgMember(session.userId, params.orgId)
    const db = getDb()

    const projects = await db.query.project.findMany({
      where: { orgId: params.orgId },
      orderBy: { createdAt: 'desc' },
    })

    if (projects[0]) {
      return Response.redirect(new URL(`/dash/projects/${encodeURIComponent(projects[0].id)}`, new URL(request.url)).toString(), 302)
    }

    const { NewProjectButton } = await import('./components/sidebar.tsx')

    return (
      <div className="max-w-3xl">
        <h1 className="text-2xl font-bold tracking-tight mb-2">No projects yet</h1>
        <p className="text-muted-foreground mb-6">Create your first project to start tracking errors and traces.</p>
        <NewProjectButton orgId={params.orgId} />
      </div>
    )
  })

  // ── New Organization page ──────────────────────────────────────
  .page('/dash/new-org', async () => {
    const { CreateOrgForm } = await import('./components/create-org-form.tsx')
    return (
      <div className="max-w-md mx-auto py-12">
        <h1 className="text-2xl font-bold tracking-tight mb-2">New Organization</h1>
        <p className="text-muted-foreground mb-6">
          Organizations group your projects and team members.
        </p>
        <CreateOrgForm />
      </div>
    )
  })

  // ── Project page (placeholder for Errors tab) ──────────────────
  .page('/dash/projects/:projectId', async () => {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center gap-4 py-20">
        <div className="rounded-full bg-muted p-4">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="size-8 text-muted-foreground">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
        </div>
        <div>
          <h2 className="text-lg font-semibold">Errors</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Error data will appear here once your app starts sending telemetry.
          </p>
        </div>
      </div>
    )
  })

  // ── Issues tab placeholder ─────────────────────────────────────
  .page('/dash/projects/:projectId/issues', async () => {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center gap-4 py-20">
        <div className="rounded-full bg-muted p-4">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="size-8 text-muted-foreground">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" />
          </svg>
        </div>
        <div>
          <h2 className="text-lg font-semibold">Issues</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Issue groups will appear here once errors are captured and grouped.
          </p>
        </div>
      </div>
    )
  })

  // ── Login page ─────────────────────────────────────────────────
  .page({
    path: '/login',
    query: loginQuerySchema,
    handler: async ({ request, query }) => {
      const session = await getSession(request)
      if (session) throw redirect(safeRedirectPath(query.callbackURL))
      const callbackURL = safeRedirectPath(query.callbackURL)
      const { LoginButton } = await import('./components/login-button.tsx')
      return (
        <AuthPage
          description="Sign in to manage observability projects and approve CLI logins."
          title="Sign in"
        >
          <div className="flex flex-col gap-2 text-center">
            <h1 className="text-3xl font-semibold tracking-tight">Strada</h1>
            <p className="text-sm text-muted-foreground">
              Sign in to manage your observability projects.
            </p>
          </div>
          <LoginButton callbackURL={callbackURL} />
        </AuthPage>
      )
    },
  })

  // ── Device flow verification page ─────────────────────────────
  .page({
    path: '/device',
    query: devicePageQuerySchema,
    handler: async ({ request, query }) => {
      const userCode = query.user_code ?? ''
      const status = query.status

      if (!userCode) {
        return (
          <AuthPage
            description="Open this page from the CLI login flow with a valid device code."
            title="CLI login"
          >
            <div className="flex flex-col gap-2 text-center">
              <h1 className="text-2xl font-semibold tracking-tight">Strada CLI Login</h1>
              <p className="text-sm text-muted-foreground">
                Open this page from the CLI login flow with a valid device code.
              </p>
            </div>
          </AuthPage>
        )
      }

      const auth = getAuth()
      const device = await auth.api.deviceVerify({ query: { user_code: userCode } }).catch(() => null)
      if (!device) {
        return (
          <AuthPage
            description="That CLI device code is invalid or expired."
            title="Invalid device code"
          >
            <div className="flex flex-col gap-2 text-center">
              <h1 className="text-2xl font-semibold tracking-tight">Invalid device code</h1>
              <p className="text-sm text-muted-foreground">
                That device code is invalid or expired.
              </p>
            </div>
          </AuthPage>
        )
      }

      const session = await getSession(request)
      if (!session) {
        throw redirect(
          router.href('/login', {
            callbackURL: `${request.parsedUrl.pathname}${request.parsedUrl.search}`,
          }),
        )
      }

      async function approveDevice(formData: FormData) {
        'use server'
        const actionRequest = getActionRequest()
        await requireSession(actionRequest)
        const { userCode: parsedUserCode } = parseFormData(deviceUserCodeSchema, formData)
        const actionAuth = getAuth()
        await actionAuth.api.deviceApprove({ body: { userCode: parsedUserCode }, headers: actionRequest.headers })
        throw redirect(router.href('/device', { user_code: parsedUserCode, status: 'approved' }))
      }

      async function denyDevice(formData: FormData) {
        'use server'
        const actionRequest = getActionRequest()
        await requireSession(actionRequest)
        const { userCode: parsedUserCode } = parseFormData(deviceUserCodeSchema, formData)
        const actionAuth = getAuth()
        await actionAuth.api.deviceDeny({ body: { userCode: parsedUserCode }, headers: actionRequest.headers })
        throw redirect(router.href('/device', { user_code: parsedUserCode, status: 'denied' }))
      }

      return (
        <AuthPage
          description="Approve or deny the current Strada CLI login request."
          title="CLI login"
        >
          <div className="flex flex-col gap-2 text-center">
            <h1 className="text-2xl font-semibold tracking-tight">Strada CLI Login</h1>
            {status === 'approved'
              ? (
                  <>
                    <p className="text-sm text-foreground">The CLI was approved successfully.</p>
                    <p className="text-sm text-muted-foreground">
                      You can close this page and return to the terminal.
                    </p>
                  </>
                )
              : status === 'denied'
                ? (
                    <>
                      <p className="text-sm text-foreground">The CLI login was denied.</p>
                      <p className="text-sm text-muted-foreground">
                        You can close this page and start the login flow again.
                      </p>
                    </>
                  )
                : (
                    <>
                      <p className="text-sm text-foreground">
                        A CLI is requesting access to your account.
                      </p>
                      <p className="rounded-lg border bg-muted px-3 py-2 font-mono text-lg tracking-[0.24em] uppercase">
                        {userCode}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Current status: {device.status}. Approve to let the CLI finish logging in.
                      </p>
                    </>
                  )}
          </div>
          {status == null && <DeviceActionButtons approveAction={approveDevice} denyAction={denyDevice} userCode={userCode} />}
        </AuthPage>
      )
    },
  })
  .use(api)

export type App = typeof app & typeof api

const handleFetch: ExportedHandlerFetchHandler<Env> = (request) => app.handle(request)

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}

export default {
  fetch: handleFetch,
  async scheduled(controller: ScheduledController, _env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(checkAlerts())
  },
} satisfies ExportedHandler<Env>
