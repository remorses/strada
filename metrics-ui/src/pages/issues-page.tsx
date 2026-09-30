'use client'

import { BellOffIcon, CircleCheckIcon, CircleDotIcon, ExternalLinkIcon } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'spiceflow/react'
import { AppShell, DashboardPage } from '../components/app-shell.tsx'
import { TimeSeriesChart } from '../components/charts.tsx'
import { ChartCard, KpiCard, KpiRow, PageHeader, QueryBar } from '../components/chrome.tsx'
import { createAppColumnHelper, DataTable } from '../components/data-table.tsx'
import { Button } from '../components/ui/button.tsx'
import {
  DetailPanel,
  Dot,
  MetaList,
  MiniBars,
  Mono,
  PanelSection,
  Pill,
  UserAvatar,
  type Tone,
} from '../components/widgets.tsx'
import { COLORS } from '../lib/chart-colors.ts'
import { ISSUE_STACKTRACE, ISSUES, issueEvents, type Issue } from '../lib/mock-data.ts'
import { formatCompact, shortAge, timeAgo } from '../lib/utils.ts'

export const LEVEL_TONE: Record<Issue['lastLevel'], Tone> = { fatal: 'destructive', error: 'destructive', warning: 'warning' }

const GROUPS = [
  { id: 'open', label: 'Unresolved', icon: <CircleDotIcon className="size-3.5 text-destructive" /> },
  { id: 'muted', label: 'Muted', icon: <BellOffIcon className="size-3.5 text-muted-foreground" /> },
  { id: 'resolved', label: 'Resolved', icon: <CircleCheckIcon className="size-3.5 text-success" /> },
]

const helper = createAppColumnHelper<Issue>()

const columns = helper.columns([
  helper.accessor('shortId', {
    header: 'ID',
    meta: { className: 'w-[92px]' },
    cell: (info) => (
      <span className="flex items-center gap-2">
        <Dot tone={LEVEL_TONE[info.row.original.lastLevel]} />
        <Mono className="text-muted-foreground">{info.getValue()}</Mono>
      </span>
    ),
  }),
  helper.accessor('lastType', {
    header: 'Issue',
    meta: { className: 'w-full max-w-0' },
    cell: (info) => {
      const issue = info.row.original
      return (
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-medium">{issue.lastType}</span>
          <span className="truncate text-muted-foreground">{issue.lastMessage}</span>
          {issue.isNew ? <Pill tone="info">New</Pill> : null}
          {issue.isRegression ? <Pill tone="warning">Regressed</Pill> : null}
        </span>
      )
    },
  }),
  helper.accessor('lastServiceName', {
    header: 'Service',
    cell: (info) => <Pill>{info.getValue()}</Pill>,
  }),
  helper.accessor((issue) => issue.frequency.reduce((sum, value) => sum + value, 0), {
    id: 'trend',
    header: '24h',
    enableSorting: false,
    cell: (info) => (
      <MiniBars values={info.row.original.frequency} tone={info.row.original.status === 'open' ? 'destructive' : 'muted'} />
    ),
  }),
  helper.accessor('eventCount', {
    header: 'Events',
    meta: { className: 'text-right' },
    cell: (info) => <span className="tabular-nums">{formatCompact(info.getValue())}</span>,
  }),
  helper.accessor('userCount', {
    header: 'Users',
    meta: { className: 'text-right' },
    cell: (info) => <span className="text-muted-foreground tabular-nums">{formatCompact(info.getValue())}</span>,
  }),
  helper.accessor('lastSeen', {
    header: 'Seen',
    meta: { className: 'w-[96px] text-right' },
    cell: (info) => (
      <span className="text-muted-foreground tabular-nums">
        {shortAge(info.getValue())} <span className="opacity-60">/ {shortAge(info.row.original.firstSeen)}</span>
      </span>
    ),
  }),
  helper.accessor('assignee', {
    header: '',
    enableSorting: false,
    meta: { className: 'w-8' },
    cell: (info) => <UserAvatar userId={info.getValue()} />,
  }),
])

export function IssuesPage() {
  const [selectedId, setSelectedId] = useState<string | undefined>(ISSUES[0]?.fingerprintHash)
  const selected = ISSUES.find((issue) => issue.fingerprintHash === selectedId)
  const open = ISSUES.filter((issue) => issue.status === 'open')

  return (
    <AppShell>
      <DashboardPage>
        <PageHeader title="Issues" meta={`${open.length} unresolved · last 24 hours`} />
        <QueryBar
          placeholder="unresolved since last week, service api…"
          examples={['unhandled in the last hour', 'new issues this week', 'errors on /api/checkout']}
          sql="Timestamp >= now() - INTERVAL 1 HOUR AND MechanismHandled = false"
        />

        <KpiRow>
          <KpiCard label="Events" value="8.1k" delta={0.182} lowerIsBetter />
          <KpiCard label="Unhandled" value="64%" delta={0.041} lowerIsBetter />
          <KpiCard label="Users affected" value="1.1k" delta={-0.06} lowerIsBetter />
          <KpiCard label="New issues" value="2" hint="CRON-3A, API-1K9" tone="destructive" />
        </KpiRow>

        <ChartCard
          title="Error events"
          legend={[
            { color: COLORS.error, label: 'Unhandled' },
            { color: COLORS.muted, label: 'Handled' },
          ]}
        >
          <TimeSeriesChart
            data={issueEvents}
            series={[
              { key: 'unhandled', label: 'Unhandled', color: COLORS.error, kind: 'bar' },
              { key: 'handled', label: 'Handled', color: COLORS.muted, kind: 'bar' },
            ]}
            stacked
            ariaLabel="Error events"
            valueFormat={(value) => value.toFixed(0)}
            height={150}
          />
        </ChartCard>

        <div className="flex items-start gap-4">
          <DataTable
            className="min-w-0 flex-1"
            columns={columns}
            data={ISSUES}
            getRowId={(issue) => issue.fingerprintHash}
            groups={GROUPS}
            getGroupId={(issue) => issue.status}
            activeRowId={selectedId}
            onRowClick={(issue) => setSelectedId(issue.fingerprintHash)}
          />
          {selected ? <IssuePreview issue={selected} onClose={() => setSelectedId(undefined)} /> : null}
        </div>
      </DashboardPage>
    </AppShell>
  )
}

function IssuePreview({ issue, onClose }: { issue: Issue; onClose: () => void }) {
  return (
    <DetailPanel
      onClose={onClose}
      title={
        <span className="flex flex-col gap-1">
          <span>{issue.lastType}</span>
          <span className="font-normal whitespace-normal text-muted-foreground">{issue.lastMessage}</span>
        </span>
      }
    >
      <div className="flex gap-2">
        <Button size="sm" variant="outline" nativeButton={false} render={<Link href={`/issues/${issue.fingerprintHash}`} />}>
          Open issue <ExternalLinkIcon />
        </Button>
        <Button size="sm" variant="ghost">Resolve</Button>
        <Button size="sm" variant="ghost">Mute</Button>
      </div>

      <PanelSection title="Last 24 hours">
        <MiniBars values={issue.frequency} tone="destructive" className="h-12 w-full" />
      </PanelSection>

      <PanelSection title="Details">
        <MetaList
          items={[
            { label: 'Events', value: issue.eventCount.toLocaleString() },
            { label: 'Unhandled', value: issue.unhandledCount.toLocaleString() },
            { label: 'Users', value: issue.userCount.toLocaleString() },
            { label: 'First seen', value: timeAgo(issue.firstSeen) },
            { label: 'Last seen', value: timeAgo(issue.lastSeen) },
            { label: 'Service', value: issue.lastServiceName },
            ...(issue.lastHttpRoute ? [{ label: 'Route', value: <Mono>{`${issue.lastHttpMethod} ${issue.lastHttpRoute}`}</Mono> }] : []),
            { label: 'Release', value: <Mono>{issue.release}</Mono> },
            { label: 'Environment', value: issue.lastEnvironment },
            { label: 'Fingerprint', value: <Mono className="text-muted-foreground">{issue.fingerprintHash.slice(0, 16)}…</Mono> },
          ]}
        />
      </PanelSection>

      <PanelSection title="Stacktrace">
        <Stacktrace />
      </PanelSection>
    </DetailPanel>
  )
}

export function Stacktrace() {
  return <pre className="overflow-x-auto font-mono text-xs leading-5 whitespace-pre">{ISSUE_STACKTRACE}</pre>
}
