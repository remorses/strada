import './globals.css'
import { Spiceflow } from 'spiceflow'
import { Head, ProgressBar } from 'spiceflow/react'
import { FunctionPage } from './pages/function-page.tsx'
import { PlansPage } from './pages/plans-page.tsx'
import { SandboxesPage } from './pages/sandboxes-page.tsx'
import { SettingsSectionPage } from './pages/settings-page.tsx'
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
    return (
      <>
        <Head>
          <Head.Title>run_one · Metrics</Head.Title>
        </Head>
        <FunctionPage />
      </>
    )
  })
  .page('/sandboxes', async () => {
    return (
      <>
        <Head>
          <Head.Title>Sandboxes · Metrics</Head.Title>
        </Head>
        <SandboxesPage />
      </>
    )
  })
  .page('/usage', async () => {
    return (
      <>
        <Head>
          <Head.Title>Usage · Metrics</Head.Title>
        </Head>
        <UsagePage />
      </>
    )
  })
  .page('/settings/:section', async ({ params }) => {
    return (
      <>
        <Head>
          <Head.Title>Settings</Head.Title>
        </Head>
        <SettingsSectionPage section={params.section} />
      </>
    )
  })
  .page('/plans', async () => {
    return (
      <>
        <Head>
          <Head.Title>Plans · Settings</Head.Title>
          <Head.Meta name="description" content="Choose the plan that best fits your store's needs." />
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
