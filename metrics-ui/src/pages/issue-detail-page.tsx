'use client'

import { ChevronLeftIcon } from 'lucide-react'
import { Link } from 'spiceflow/react'
import { AppShell, DashboardPage } from '../components/app-shell.tsx'
import { TimeSeriesChart } from '../components/charts.tsx'
import { ChartCard, KpiCard, KpiRow, SectionTitle } from '../components/chrome.tsx'
import { createAppColumnHelper, DataTable } from '../components/data-table.tsx'
import { Button } from '../components/ui/button.tsx'
import { Dot, MetaList, Mono, Pill, ShareBar, UserAvatar } from '../components/widgets.tsx'
import { COLORS } from '../lib/chart-colors.ts'
import { ISSUE_EVENTS, ISSUE_TAGS, ISSUES, issueEvents } from '../lib/mock-data.ts'
import { formatCompact, formatPercent, timeAgo } from '../lib/utils.ts'
import { LEVEL_TONE, Stacktrace } from './issues-page.tsx'

const helper = createAppColumnHelper<(typeof ISSUE_EVENTS)[number]>()

const eventColumns = helper.columns([
  helper.accessor('timestamp', {
    header: 'Time',
    cell: (info) => <span className="text-muted-foreground tabular-nums">{timeAgo(info.getValue())}</span>,
  }),
  helper.accessor('httpRoute', {
    header: 'Route',
    meta: { className: 'w-full' },
    cell: (info) => <Mono>{`${info.row.original.httpMethod} ${info.getValue()}`}</Mono>,
  }),
  helper.accessor('userId', { header: 'User', cell: (info) => <Mono className="text-muted-foreground">{info.getValue()}</Mono> }),
  helper.accessor('browser', { header: 'Browser', cell: (info) => <span className="text-muted-foreground">{info.getValue()}</span> }),
  helper.accessor('traceId', {
    header: 'Trace',
    enableSorting: false,
    cell: (info) => (
      <Link href="/traces" className="font-mono text-xs text-info hover:underline">
        {info.getValue().slice(0, 12)}
      </Link>
    ),
  }),
])

// Per-issue histogram reuses the global shape, scaled down.
const singleIssueEvents = issueEvents.map((point, index) => ({
  time: point.time,
  events: index > 84 ? Number(point.unhandled) : 0,
}))

export function IssueDetailPage({ fingerprint }: { fingerprint: string }) {
  const issue = ISSUES.find((item) => item.fingerprintHash === fingerprint) ?? ISSUES[0]!

  return (
    <AppShell>
      <DashboardPage>
        <div className="flex flex-col gap-3">
          <Link href="/issues" className="flex w-fit items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">
            <ChevronLeftIcon className="size-3.5" /> Issues
          </Link>
          <div className="flex items-start gap-4">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <Dot tone={LEVEL_TONE[issue.lastLevel]} />
                <Mono className="text-muted-foreground">{issue.shortId}</Mono>
              </div>
              <h1 className="text-[22px] font-semibold tracking-tight">{issue.lastType}</h1>
              <p className="text-[15px] text-muted-foreground">{issue.lastMessage}</p>
              <p className="font-mono text-xs text-muted-foreground">{issue.culprit}</p>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline">Resolve</Button>
              <Button size="sm" variant="outline">Mute</Button>
              <Button size="sm" variant="ghost" className="gap-2">
                <UserAvatar userId={issue.assignee} /> Assign
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Pill tone={issue.status === 'open' ? 'destructive' : issue.status === 'resolved' ? 'success' : 'muted'}>{issue.status}</Pill>
            <Pill tone={issue.unhandledCount > 0 ? 'destructive' : 'success'}>{issue.unhandledCount > 0 ? 'unhandled' : 'handled'}</Pill>
            <Pill>{issue.lastServiceName}</Pill>
            <Pill>{issue.release}</Pill>
            <Pill>{issue.lastEnvironment}</Pill>
          </div>
        </div>

        <KpiRow>
          <KpiCard label="Events" value={formatCompact(issue.eventCount)} />
          <KpiCard label="Users" value={formatCompact(issue.userCount)} />
          <KpiCard label="First seen" value={timeAgo(issue.firstSeen)} hint={issue.release} />
          <KpiCard label="Last seen" value={timeAgo(issue.lastSeen)} live />
        </KpiRow>

        <ChartCard title="Events" legend={[{ color: COLORS.error, label: 'Events' }]}>
          <TimeSeriesChart
            data={singleIssueEvents}
            series={[{ key: 'events', label: 'Events', color: COLORS.error, kind: 'bar' }]}
            ariaLabel="Issue events"
            valueFormat={(value) => value.toFixed(0)}
            height={130}
          />
        </ChartCard>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
          <div className="flex min-w-0 flex-col gap-6">
            <section className="flex flex-col gap-3">
              <SectionTitle meta="most recent event">Stacktrace</SectionTitle>
              <Stacktrace />
            </section>
            <section className="flex flex-col gap-2">
              <SectionTitle meta={`${ISSUE_EVENTS.length} shown`}>Recent events</SectionTitle>
              <DataTable columns={eventColumns} data={ISSUE_EVENTS} getRowId={(event) => event.timestamp} />
            </section>
          </div>

          <div className="flex flex-col gap-6">
            <section className="flex flex-col gap-3">
              <SectionTitle>Tags</SectionTitle>
              {ISSUE_TAGS.map((tag) => (
                <div key={tag.key} className="flex flex-col gap-1.5">
                  <Mono className="text-muted-foreground">{tag.key}</Mono>
                  {tag.values.map((value) => (
                    <div key={value.name} className="flex items-center gap-2 text-[13px]">
                      <span className="min-w-0 flex-1 truncate">{value.name}</span>
                      <ShareBar value={value.share} />
                      <span className="w-10 text-right text-muted-foreground tabular-nums">{formatPercent(value.share, 0)}</span>
                    </div>
                  ))}
                </div>
              ))}
            </section>
            <section className="flex flex-col gap-3">
              <SectionTitle>Context</SectionTitle>
              <MetaList
                items={[
                  { label: 'Mechanism', value: issue.unhandledCount > 0 ? 'onerror' : 'generic' },
                  { label: 'Route', value: <Mono>{issue.lastHttpRoute || '—'}</Mono> },
                  { label: 'Fingerprint', value: <Mono className="text-muted-foreground">{issue.fingerprintHash.slice(0, 16)}…</Mono> },
                ]}
              />
            </section>
          </div>
        </div>
      </DashboardPage>
    </AppShell>
  )
}
