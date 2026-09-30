'use client'

import { WaypointsIcon } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'spiceflow/react'
import { AppShell, DashboardPage } from '../components/app-shell.tsx'
import { TimeSeriesChart } from '../components/charts.tsx'
import { ChartCard, PageHeader, QueryBar } from '../components/chrome.tsx'
import { createAppColumnHelper, DataTable } from '../components/data-table.tsx'
import { DetailPanel, MetaList, Mono, PanelSection, Pill, SEVERITY_TONE, SeverityLabel } from '../components/widgets.tsx'
import { COLORS } from '../lib/chart-colors.ts'
import { LOGS, logVolume, type LogRow } from '../lib/mock-data.ts'
import { formatCompact, formatLogTime } from '../lib/utils.ts'

const helper = createAppColumnHelper<LogRow>()

const columns = helper.columns([
  helper.accessor('timestamp', {
    header: 'Time',
    cell: (info) => <Mono className="text-muted-foreground">{formatLogTime(info.getValue())}</Mono>,
  }),
  helper.accessor('severityText', {
    header: 'Level',
    cell: (info) => <SeverityLabel severity={info.getValue()} />,
  }),
  helper.accessor('serviceName', {
    header: 'Service',
    cell: (info) => <Mono className="text-muted-foreground">{info.getValue()}</Mono>,
  }),
  helper.accessor('body', {
    header: 'Message',
    enableSorting: false,
    meta: { className: 'w-full max-w-0' },
    cell: (info) => <Mono className="block truncate">{info.getValue()}</Mono>,
  }),
  helper.accessor('traceId', {
    header: '',
    enableSorting: false,
    meta: { className: 'w-6' },
    cell: (info) =>
      info.getValue() ? (
        <Link href="/traces" title="Open trace" className="text-muted-foreground hover:text-foreground">
          <WaypointsIcon className="size-3.5" />
        </Link>
      ) : null,
  }),
])

const total = logVolume.reduce((sum, point) => sum + Number(point.info) + Number(point.warn) + Number(point.error), 0)

export function LogsPage() {
  const [logId, setLogId] = useState<string>()
  const log = LOGS.find((item) => item.id === logId)

  return (
    <AppShell>
      <DashboardPage>
        <PageHeader title="Logs" meta={`${formatCompact(total)} records · last 24 hours`} />
        <QueryBar
          placeholder="errors since yesterday, service worker…"
          examples={['warnings and errors in the last hour', 'logs containing timeout', 'custom events only']}
          sql="Timestamp >= now() - INTERVAL 1 HOUR AND SeverityNumber >= 13"
        />

        <ChartCard
          title="Volume by severity"
          legend={[
            { color: COLORS.secondary, label: 'Info' },
            { color: COLORS.warning, label: 'Warn' },
            { color: COLORS.error, label: 'Error' },
          ]}
        >
          <TimeSeriesChart
            data={logVolume}
            series={[
              { key: 'info', label: 'Info', color: COLORS.secondary, kind: 'bar' },
              { key: 'warn', label: 'Warn', color: COLORS.warning, kind: 'bar' },
              { key: 'error', label: 'Error', color: COLORS.error, kind: 'bar' },
            ]}
            stacked
            ariaLabel="Log volume by severity"
            yFormat={formatCompact}
            valueFormat={(value) => value.toLocaleString()}
            height={140}
          />
        </ChartCard>

        <div className="flex items-start gap-4">
          <DataTable
            className="min-w-0 flex-1"
            dense
            columns={columns}
            data={LOGS}
            getRowId={(row) => row.id}
            activeRowId={logId}
            onRowClick={(row) => setLogId(row.id)}
          />
          {log ? <LogPreview log={log} onClose={() => setLogId(undefined)} /> : null}
        </div>
      </DashboardPage>
    </AppShell>
  )
}

function LogPreview({ log, onClose }: { log: LogRow; onClose: () => void }) {
  return (
    <DetailPanel onClose={onClose} title={<Pill tone={SEVERITY_TONE[log.severityText]}>{log.severityText}</Pill>}>
      <pre className="overflow-x-auto font-mono text-xs leading-5">{log.body}</pre>
      <MetaList
        items={[
          { label: 'Timestamp', value: <Mono>{formatLogTime(log.timestamp)}</Mono> },
          { label: 'Service', value: log.serviceName },
          { label: 'TraceId', value: log.traceId ? <Mono className="text-info">{log.traceId}</Mono> : '—' },
        ]}
      />
      <PanelSection title="Attributes">
        <MetaList items={Object.entries(log.attributes).map(([key, value]) => ({ label: key, value: <Mono>{value}</Mono> }))} />
      </PanelSection>
    </DetailPanel>
  )
}
