/// <reference path="./globals.d.ts" />

// Strada website entry point. Renders auth pages and mounts API routes from api.ts.
// Handles Google social login, device flow approval, and the Cloudflare Worker fetch entry.

import './globals.css'
import type { ReactNode } from 'react'
import { getActionRequest, json, parseFormData, Spiceflow, redirect } from 'spiceflow'
import { Head, router } from 'spiceflow/react'
import { z } from 'zod'
import { env } from 'cloudflare:workers'
import { initStrada, captureException, trace } from '@strada.sh/sdk'
import { Button } from './components/ui/button.tsx'
import { DeviceActionButtons } from './components/device-action-buttons.tsx'
import { api } from './api.ts'
import { getAuth, getSession, requireSession } from './db.ts'
import { checkAlerts } from './alert-check.ts'

const loginQuerySchema = z.object({ callbackURL: z.string().optional() })

const devicePageQuerySchema = z.object({
  user_code: z.string().optional(),
  status: z.enum(['approved', 'denied']).optional(),
})

const deviceUserCodeSchema = z.object({ userCode: z.string().min(1) })

function safeRedirectPath(value: string | undefined) {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/'
  return value
}

async function createGoogleSignInRedirect(request: Pick<Request, 'headers'>, callbackURL: string) {
  const auth = getAuth()
  const { response, headers } = await auth.api.signInSocial({
    body: { provider: 'google', callbackURL },
    headers: request.headers,
    returnHeaders: true,
  })
  if (!response?.url) {
    throw json({ error: 'failed to start google sign-in' }, { status: 500 })
  }

  const redirectResponse = new Response(null, {
    status: 302,
    headers: { Location: response.url },
  })
  for (const cookie of headers.getSetCookie()) {
    redirectResponse.headers.append('Set-Cookie', cookie)
  }
  return redirectResponse
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

if (env.STRADA_PROJECT_ID) {
  initStrada({ projectId: env.STRADA_PROJECT_ID, service: 'strada-website' })
}

const tracer = trace.getTracer('strada-website')

export const app = new Spiceflow({ tracer })

  // ── Strada SDK (error capture) ────────────────────────────────
  .onError(({ error }) => {
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

  .layout('/*', async ({ children }) => {
    return (
      <html lang="en" className="h-full">
        <Head>
          <Head.Meta charSet="UTF-8" />
          <Head.Meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <Head.Title>Strada</Head.Title>
          <Head.Meta
            name="description"
            content="OpenTelemetry-native observability with traces, logs, metrics, and error tracking."
          />
        </Head>
        <body>
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

  // ── Root ──────────────────────────────────────────────────────
  .get('/', () => {
    throw redirect('https://github.com/remorses/strada')
  })

  // ── Login page (minimal, for device flow approval) ────────────
  .page({
    path: '/login',
    query: loginQuerySchema,
    handler: async ({ request, query }) => {
      const session = await getSession(request)
      if (session) throw redirect('/')
      const callbackURL = safeRedirectPath(query.callbackURL)
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
          <Button asChild className="w-full" size="lg">
            <a href={router.href('/login/google', { callbackURL })}>Sign in with Google</a>
          </Button>
        </AuthPage>
      )
    },
  })

  .route({
    method: 'GET',
    path: '/login/google',
    query: loginQuerySchema,
    async handler({ request, query }) {
      return createGoogleSignInRedirect(request, safeRedirectPath(query.callbackURL))
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
