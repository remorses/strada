/**
 * Trace timeline demo — Spiceflow RSC page rendering an interactive
 * waterfall view of a distributed trace with demo data.
 */
import './globals.css'
import { Spiceflow } from 'spiceflow'
import { Head } from 'spiceflow/react'
import { TraceViewDemo } from './components/traces/trace-view-demo'
import { ThemeToggle } from './components/traces/theme-toggle.tsx'

export const app = new Spiceflow()
  .layout('/*', async ({ children }) => {
    return (
      <html lang="en">
        <Head>
          <Head.Title>Trace Timeline Demo</Head.Title>
          <Head.Meta name="viewport" content="width=device-width, initial-scale=1" />
        </Head>
        <body className="min-h-screen bg-background font-sans antialiased">
          <main className="flex min-h-screen flex-col items-center px-6 py-8">
            {children}
          </main>
        </body>
      </html>
    )
  })
  .page('/', async function Home() {
    return (
      <div className="flex flex-col items-center gap-6 w-full max-w-6xl">
        <div className="flex items-center justify-between w-full">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-bold tracking-tight">
              Trace Timeline
            </h1>
            <p className="text-muted-foreground text-sm">
              Interactive waterfall view of a distributed trace across microservices.
            </p>
          </div>
          <ThemeToggle />
        </div>
        <TraceViewDemo />
      </div>
    )
  })

void app.listen(Number(process.env.PORT || 3456))
