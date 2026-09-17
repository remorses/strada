import './globals.css'
import { Spiceflow } from 'spiceflow'
import { Head, ProgressBar } from 'spiceflow/react'
import { FunctionPage } from './pages/function-page.tsx'
import { SandboxesPage } from './pages/sandboxes-page.tsx'
import { UsagePage } from './pages/usage-page.tsx'

export const app = new Spiceflow()
  .layout('/*', async ({ children }) => {
    return (
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
        </head>
        <body>
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

declare module 'spiceflow/react' {
  interface SpiceflowRegister {
    app: typeof app
  }
}
