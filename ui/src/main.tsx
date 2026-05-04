/**
 * UI component demo app for @strada.sh/ui. Renders links to component demos
 * and mounts each interactive demo on its own Spiceflow page.
 */
import './globals.css'
import { trace } from '@strada.sh/sdk'
import { Spiceflow } from 'spiceflow'
import { Head, Link } from 'spiceflow/react'
import { ChartsDemoPage } from './components/charts-demo.tsx'
import { GridDemoPage } from './components/grid-demo.tsx'
import { TraceTimelineDemo } from './components/traces-graph/trace-timeline-demo.tsx'
import { TraceActivityLogDemo } from './components/traces/trace-activity-log-demo.tsx'
import { ThemeToggle } from './components/traces-graph/theme-toggle.tsx'

const tracer = trace.getTracer('strada-ui')

const demos = [
  {
    href: '/traces',
    title: 'Trace Timeline',
    description: 'Interactive waterfall view of a distributed trace across microservices.',
  },
  {
    href: '/activity-log',
    title: 'Activity Log',
    description: 'Vertical expandable trace view with icons, durations, and nested spans.',
  },
  {
    href: '/charts',
    title: 'Charts',
    description: 'Reusable ECharts-powered timeseries charts for dashboards.',
  },
  {
    href: '/grid',
    title: 'Grid',
    description: 'Compound bento grid with lattice lines and vertex dots.',
  },
  {
    href: '/charts#tables',
    title: 'Tables',
    description: 'SQL result tables with observability formatters and hashed badges.',
  },
]

export const app = new Spiceflow({ tracer })
  .layout('/*', async ({ children }) => {
    return (
      <html lang="en">
        <Head>
          <Head.Title>Strada UI Demos</Head.Title>
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
      <div className="flex w-full max-w-4xl flex-col gap-8">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-2">
            <h1 className="text-3xl font-bold tracking-tight">Strada UI</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Reusable observability components for Strada apps and demos.
            </p>
          </div>
          <ThemeToggle />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {demos.map((demo) => (
            <Link
              key={demo.href}
              href={demo.href}
              className="group flex flex-col gap-2 rounded-xl border border-border bg-card p-5 text-card-foreground transition-colors hover:bg-accent"
            >
              <span className="text-base font-semibold tracking-tight group-hover:text-accent-foreground">
                {demo.title}
              </span>
              <span className="text-sm text-muted-foreground">{demo.description}</span>
            </Link>
          ))}
        </div>
      </div>
    )
  })
  .page('/traces', async function TracesDemo() {
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
        <TraceTimelineDemo />
      </div>
    )
  })
  .page('/activity-log', async function ActivityLogDemo() {
    return (
      <div className="flex flex-col items-center gap-6 w-full max-w-6xl">
        <div className="flex items-center justify-between w-full">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-bold tracking-tight">
              Activity Log
            </h1>
            <p className="text-muted-foreground text-sm">
              Vertical expandable trace view with icons, durations, and nested spans.
            </p>
          </div>
          <ThemeToggle />
        </div>
        <TraceActivityLogDemo />
      </div>
    )
  })
  .page('/charts', async function ChartsDemo() {
    return <ChartsDemoPage />
  })
  .page('/grid', async function GridDemo() {
    return <GridDemoPage />
  })

void app.listen(Number(process.env.PORT || 3456))
