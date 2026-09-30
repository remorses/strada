import './globals.css'
import { redirect, Spiceflow } from 'spiceflow'
import { Head, ProgressBar } from 'spiceflow/react'
import { AnalyticsPage } from './pages/analytics-page.tsx'
import { HealthChecksPage } from './pages/health-checks-page.tsx'
import { IssueDetailPage } from './pages/issue-detail-page.tsx'
import { IssuesPage } from './pages/issues-page.tsx'
import { LogsPage } from './pages/logs-page.tsx'
import { PlansPage } from './pages/plans-page.tsx'
import { TracesPage } from './pages/traces-page.tsx'
import { UsagePage } from './pages/usage-page.tsx'

export const app = new Spiceflow()
  .layout('/*', async ({ children }) => {
    return (
      <html lang="en" suppressHydrationWarning>
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
        </head>
        <body>
          <script
            dangerouslySetInnerHTML={{
              __html:
                '(function(){try{var t=localStorage.getItem("metrics-ui-theme");var d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d)}catch(e){}})()',
            }}
          />
          <ProgressBar />
          {children}
        </body>
      </html>
    )
  })
  .page('/', async () => {
    throw redirect('/issues')
  })
  .page('/issues', async () => {
    return (
      <>
        <Head>
          <Head.Title>Issues · Strada</Head.Title>
        </Head>
        <IssuesPage />
      </>
    )
  })
  .page('/issues/:fingerprint', async ({ params }) => {
    return (
      <>
        <Head>
          <Head.Title>Issue · Strada</Head.Title>
        </Head>
        <IssueDetailPage fingerprint={params.fingerprint} />
      </>
    )
  })
  .page('/traces', async () => {
    return (
      <>
        <Head>
          <Head.Title>Traces · Strada</Head.Title>
        </Head>
        <TracesPage />
      </>
    )
  })
  .page('/logs', async () => {
    return (
      <>
        <Head>
          <Head.Title>Logs · Strada</Head.Title>
        </Head>
        <LogsPage />
      </>
    )
  })
  .page('/health-checks', async () => {
    return (
      <>
        <Head>
          <Head.Title>Health checks · Strada</Head.Title>
        </Head>
        <HealthChecksPage />
      </>
    )
  })
  .page('/analytics', async () => {
    return (
      <>
        <Head>
          <Head.Title>Analytics · Strada</Head.Title>
        </Head>
        <AnalyticsPage />
      </>
    )
  })
  .page('/usage', async () => {
    return (
      <>
        <Head>
          <Head.Title>Usage · Strada</Head.Title>
        </Head>
        <UsagePage />
      </>
    )
  })
  .page('/plans', async () => {
    return (
      <>
        <Head>
          <Head.Title>Plans · Strada</Head.Title>
        </Head>
        <PlansPage />
      </>
    )
  })

declare module 'spiceflow/react' {
  interface SpiceflowRegister {
    app: typeof app
  }
}
