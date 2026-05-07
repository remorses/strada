// Errors dashboard page with widget grid.
// Uses 4 chart component types: SparklinePanel, DonutPanel, ProgressNavPanel, SparkAreaPanel.
// Demo data mirrors real otel_errors query shapes for easy swap to live SQL.

"use client";

import {
  RiCodeLine,
  RiServerLine,
  RiWindow2Line,
} from "@remixicon/react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { LineChart } from "echarts/charts";
import {
  AriaComponent,
  GridComponent,
  TooltipComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { Grid } from "@ui/components/grid.tsx";
import { SparkAreaPanel } from "@ui/components/widgets/spark-area-panel.tsx";
import { DonutPanel } from "@ui/components/widgets/donut-panel.tsx";
import { ProgressNavPanel } from "@ui/components/widgets/progress-nav-panel.tsx";
import { SparklinePanel } from "@ui/components/widgets/sparkline-panel.tsx";

echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  CanvasRenderer,
  AriaComponent,
]);

// ── Demo data ────────────────────────────────────────────────────

const demoMonthDate = (startMonthIndex: number, offset: number) =>
  new Date(Date.UTC(2025, startMonthIndex + offset, 1))
    .toISOString()
    .slice(0, 10);

const formatErrorCount = (value: number) =>
  new Intl.NumberFormat("en-US").format(value);

// ── 1. Errors by Service (SparklinePanel, ECharts multi-line) ────
// SQL: SELECT ServiceName, toStartOfDay(Timestamp) AS day, count() AS c
//      FROM otel_errors WHERE Timestamp >= now() - INTERVAL 7 DAY
//      GROUP BY ServiceName, day ORDER BY day
const errorsByServiceData = (() => {
  const base = Date.UTC(2025, 4, 1);
  const day = 86_400_000;
  const points = 30;
  return [
    {
      name: "api-service",
      data: Array.from({ length: points }, (_, i): [number, number] => [
        base + i * day,
        120 + Math.round(Math.sin(i * 0.4) * 40 + ((i * 17) % 30)),
      ]),
    },
    {
      name: "web-frontend",
      data: Array.from({ length: points }, (_, i): [number, number] => [
        base + i * day,
        80 + Math.round(Math.cos(i * 0.3) * 25 + ((i * 13) % 20)),
      ]),
    },
    {
      name: "worker",
      data: Array.from({ length: points }, (_, i): [number, number] => [
        base + i * day,
        25 + Math.round(Math.sin(i * 0.6) * 15 + ((i * 7) % 12)),
      ]),
    },
  ];
})();

const errorsByServiceMetrics = [
  {
    label: "api-service",
    value: "4,520",
    change: "+12.3%",
    direction: "up" as const,
    icon: RiServerLine,
  },
  {
    label: "web-frontend",
    value: "2,847",
    change: "-4.1%",
    direction: "down" as const,
    icon: RiWindow2Line,
  },
  {
    label: "worker",
    value: "891",
    change: "+2.7%",
    direction: "up" as const,
    icon: RiCodeLine,
  },
  {
    label: "auth-service",
    value: "612",
    change: "+8.1%",
    direction: "up" as const,
    icon: RiServerLine,
  },
  {
    label: "payments-api",
    value: "445",
    change: "-2.3%",
    direction: "down" as const,
    icon: RiServerLine,
  },
  {
    label: "notifications",
    value: "318",
    change: "+1.5%",
    direction: "up" as const,
    icon: RiCodeLine,
  },
  {
    label: "search-worker",
    value: "204",
    change: "-5.8%",
    direction: "down" as const,
    icon: RiCodeLine,
  },
];

// ── 3. Error Sources (DonutPanel) — 12-item test ─────────────────
// SQL: SELECT ExceptionType, count() AS c FROM otel_errors GROUP BY ExceptionType
const errorSourcesData = [
  { id: "type-error", label: "TypeError", fillClassName: "fill-primary", dotClassName: "bg-primary", value: 2410 },
  { id: "http-error", label: "HttpError", fillClassName: "fill-destructive", dotClassName: "bg-destructive", value: 1735 },
  { id: "ref-error", label: "ReferenceError", fillClassName: "fill-yellow-500", dotClassName: "bg-yellow-500", value: 1084 },
  { id: "timeout-error", label: "TimeoutError", fillClassName: "fill-purple-500", dotClassName: "bg-purple-500", value: 722 },
  { id: "syntax-error", label: "SyntaxError", fillClassName: "fill-success", dotClassName: "bg-success", value: 433 },
  { id: "chunk-error", label: "ChunkLoadError", fillClassName: "fill-orange-500", dotClassName: "bg-orange-500", value: 312 },
  { id: "abort-error", label: "AbortError", fillClassName: "fill-teal-500", dotClassName: "bg-teal-500", value: 245 },
  { id: "range-error", label: "RangeError", fillClassName: "fill-pink-500", dotClassName: "bg-pink-500", value: 198 },
  { id: "conn-error", label: "ConnectionError", fillClassName: "fill-indigo-500", dotClassName: "bg-indigo-500", value: 156 },
  { id: "eval-error", label: "EvalError", fillClassName: "fill-amber-500", dotClassName: "bg-amber-500", value: 98 },
  { id: "uri-error", label: "URIError", fillClassName: "fill-cyan-500", dotClassName: "bg-cyan-500", value: 52 },
  { id: "internal-error", label: "InternalError", fillClassName: "fill-rose-500", dotClassName: "bg-rose-500", value: 31 },
];

// ── 4. Handled vs Unhandled (DonutPanel) ─────────────────────────
// SQL: SELECT MechanismHandled, count() AS c FROM otel_errors GROUP BY MechanismHandled
const handledData = [
  {
    id: "unhandled",
    label: "Unhandled",
    fillClassName: "fill-destructive",
    dotClassName: "bg-destructive",
    value: 3842,
  },
  {
    id: "handled",
    label: "Handled",
    fillClassName: "fill-primary",
    dotClassName: "bg-primary",
    value: 1256,
  },
  {
    id: "resolved",
    label: "Resolved",
    fillClassName: "fill-success",
    dotClassName: "bg-success",
    value: 649,
  },
];

// ── 5. By Severity (DonutPanel) ──────────────────────────────────
// SQL: SELECT Level, count() AS c FROM otel_errors GROUP BY Level
const bySeverityData = [
  {
    id: "fatal",
    label: "Fatal",
    fillClassName: "fill-destructive",
    dotClassName: "bg-destructive",
    value: 245,
  },
  {
    id: "error",
    label: "Error",
    fillClassName: "fill-primary",
    dotClassName: "bg-primary",
    value: 6180,
  },
  {
    id: "warning",
    label: "Warning",
    fillClassName: "fill-yellow-500",
    dotClassName: "bg-yellow-500",
    value: 1520,
  },
  {
    id: "info",
    label: "Info",
    fillClassName: "fill-muted",
    dotClassName: "bg-muted",
    value: 313,
    hiddenFromLegend: true,
  },
];

// ── 6. By Environment (DonutPanel) ───────────────────────────────
// SQL: SELECT Environment, count() AS c FROM otel_errors GROUP BY Environment
const byEnvironmentData = [
  {
    id: "production",
    label: "Production",
    fillClassName: "fill-destructive",
    dotClassName: "bg-destructive",
    value: 5940,
  },
  {
    id: "staging",
    label: "Staging",
    fillClassName: "fill-yellow-500",
    dotClassName: "bg-yellow-500",
    value: 1814,
  },
  {
    id: "development",
    label: "Development",
    fillClassName: "fill-success",
    dotClassName: "bg-success",
    value: 504,
  },
];

// ── 7. Services Error Share (DonutPanel) ─────────────────────────
// SQL: SELECT ServiceName, count() AS c FROM otel_errors
//      GROUP BY ServiceName ORDER BY c DESC LIMIT 5
const servicesData = [
  {
    id: "api",
    label: "api-service",
    fillClassName: "fill-primary",
    dotClassName: "bg-primary",
    value: 4520,
  },
  {
    id: "web",
    label: "web-frontend",
    fillClassName: "fill-yellow-500",
    dotClassName: "bg-yellow-500",
    value: 2847,
  },
  {
    id: "worker",
    label: "worker",
    fillClassName: "fill-success",
    dotClassName: "bg-success",
    value: 891,
  },
];

// ── 8. Top Error Types (ProgressNavPanel) ────────────────────────
// SQL: SELECT ExceptionType, count() AS c FROM otel_errors
//      GROUP BY ExceptionType ORDER BY c DESC LIMIT 5
const topErrorTypesData = [
  {
    id: "type-error",
    label: "TypeError",
    value: 100,
    detailLabel: "occurrences",
    detailValue: "2,410",
    change: "+4.5%",
    badge: "TypeError",
    description: "last 7 days",
  },
  {
    id: "http-error",
    label: "HttpError",
    value: 72,
    detailLabel: "occurrences",
    detailValue: "1,735",
    change: "+18.2%",
    badge: "HttpError",
    description: "last 7 days",
  },
  {
    id: "ref-error",
    label: "ReferenceError",
    value: 45,
    detailLabel: "occurrences",
    detailValue: "1,084",
    change: "-6.3%",
    badge: "ReferenceError",
    description: "last 7 days",
  },
  {
    id: "timeout-error",
    label: "TimeoutError",
    value: 30,
    detailLabel: "occurrences",
    detailValue: "722",
    change: "+2.1%",
    badge: "TimeoutError",
    description: "last 7 days",
  },
  {
    id: "syntax-error",
    label: "SyntaxError",
    value: 18,
    detailLabel: "occurrences",
    detailValue: "433",
    change: "-12.8%",
    badge: "SyntaxError",
    description: "last 7 days",
  },
];

// ── 9. By Service nav (ProgressNavPanel) ─────────────────────────
const serviceProgressData = [
  {
    id: "api",
    label: "api-service",
    value: 55,
    detailLabel: "errors",
    detailValue: "4,520",
    change: "+12.3%",
    badge: "+12.3%",
    description: "vs last week",
  },
  {
    id: "web",
    label: "web-frontend",
    value: 34,
    detailLabel: "errors",
    detailValue: "2,847",
    change: "-4.1%",
    badge: "-4.1%",
    description: "vs last week",
  },
  {
    id: "worker",
    label: "worker",
    value: 11,
    detailLabel: "errors",
    detailValue: "891",
    change: "+2.7%",
    badge: "+2.7%",
    description: "vs last week",
  },
];

// ── 10. Browser Errors (SparkAreaPanel) ──────────────────────────
// SQL: SELECT toStartOfDay(Timestamp) AS day, count() AS c
//      FROM otel_errors WHERE mapContains(Tags, 'url.path') GROUP BY day
const browserErrorsChartData = Array.from({ length: 18 }, (_, index) => ({
  date: demoMonthDate(0, index),
  value: 45 + ((index * 19) % 35),
}));

// ── 11. Errors by Release (ProgressNavPanel) ─────────────────────
// SQL: SELECT Release, count() AS c FROM otel_errors
//      GROUP BY Release ORDER BY c DESC LIMIT 5
const errorsByReleaseData = [
  {
    id: "v1.11",
    label: "v1.11",
    value: 82,
    detailLabel: "errors",
    detailValue: "1,842",
    change: "+24.5%",
    badge: "latest",
    description: "last 7 days",
  },
  {
    id: "v1.10",
    label: "v1.10",
    value: 58,
    detailLabel: "errors",
    detailValue: "1,304",
    change: "-8.2%",
    badge: "v1.10",
    description: "last 7 days",
  },
  {
    id: "v1.9",
    label: "v1.9",
    value: 35,
    detailLabel: "errors",
    detailValue: "786",
    change: "-42.1%",
    badge: "v1.9",
    description: "last 7 days",
  },
  {
    id: "v1.8",
    label: "v1.8",
    value: 15,
    detailLabel: "errors",
    detailValue: "337",
    change: "-65.3%",
    badge: "v1.8",
    description: "last 7 days",
  },
];

// ── 12. Most Common Errors (ProgressNavPanel) ────────────────────
// SQL: SELECT FingerprintHash, anyLast(ExceptionType) AS type,
//             anyLast(ExceptionMessage) AS msg, count() AS c
//      FROM otel_errors GROUP BY FingerprintHash ORDER BY c DESC LIMIT 5
const mostCommonErrorsData = [
  {
    id: "fp-001",
    label: "Cannot read property 'map' of undefined",
    value: 82,
    detailLabel: "occurrences",
    detailValue: "1,204",
    change: "+4.5%",
    badge: "TypeError",
    description: "last 7 days",
  },
  {
    id: "fp-002",
    label: "Network request failed: /api/users",
    value: 58,
    detailLabel: "occurrences",
    detailValue: "842",
    change: "+18.2%",
    badge: "HttpError",
    description: "last 7 days",
  },
  {
    id: "fp-003",
    label: "ECONNREFUSED 127.0.0.1:5432",
    value: 35,
    detailLabel: "occurrences",
    detailValue: "512",
    change: "-6.3%",
    badge: "ConnectionError",
    description: "last 7 days",
  },
  {
    id: "fp-004",
    label: "Unexpected token < in JSON at position 0",
    value: 22,
    detailLabel: "occurrences",
    detailValue: "315",
    change: "+2.1%",
    badge: "SyntaxError",
    description: "last 7 days",
  },
  {
    id: "fp-005",
    label: "Request timeout after 30000ms",
    value: 14,
    detailLabel: "occurrences",
    detailValue: "198",
    change: "-12.8%",
    badge: "TimeoutError",
    description: "last 7 days",
  },
];

// ── Component ────────────────────────────────────────────────────

function WidgetPanel({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-full flex-col gap-4">{children}</div>;
}

export function ErrorsDashboard() {
  return (
    <TooltipPrimitive.Provider>
      <div className="relative flex flex-col gap-6 w-full pb-10">
        <div>
          <h1 className="text-2xl font-medium">Errors</h1>
        </div>
        <Grid columns={12} rows={10} rowHeight={200} cellPadding={34} lines>
          {/* Row 1-2: Errors by Service (SparklinePanel 8 cols) + Browser Errors (SparkAreaPanel 4 cols) */}
          <Grid.Item columnSpan={8} rowSpan={2}>
            <WidgetPanel>
              <SparklinePanel
                title="Total Errors"
                value="8,258"
                badge="+6.4%"
                badgeColor="red"
                actionLabel="Report"
                echarts={echarts}
                data={errorsByServiceData}
                gradient
                metrics={errorsByServiceMetrics}
              />
            </WidgetPanel>
          </Grid.Item>

          <Grid.Item columnSpan={4} rowSpan={1}>
            <WidgetPanel>
              <SparkAreaPanel
                title="Browser Errors"
                value="2,847"
                badge="Last 30 days"
                actionLabel="Details"
                tooltip={<>Errors from browser pages where url.path is present in Tags.</>}
                data={browserErrorsChartData}
                usageValue="/checkout"
                usageLabel="842 errors (top page)"
              />
            </WidgetPanel>
          </Grid.Item>

          {/* Row 3-4: Error Sources + Handled vs Unhandled + By Severity (all Donut, 4x2 each) */}
          <Grid.Item columnSpan={4} rowSpan={2}>
            <WidgetPanel>
              <DonutPanel
                title="Error Sources"
                badge="+6.4%"
                badgeColor="red"
                description="vs last week"
                tooltip={<>Server vs Browser vs Worker split by SourceSignal.</>}
                data={errorSourcesData}
                formatValue={formatErrorCount}
              />
            </WidgetPanel>
          </Grid.Item>

          <Grid.Item columnSpan={4} rowSpan={2}>
            <WidgetPanel>
              <DonutPanel
                title="Handled vs Unhandled"
                badge="+8.2%"
                badgeColor="red"
                description="unhandled rate"
                tooltip={<>Groups by MechanismHandled. Unhandled = onerror, unhandledrejection. Handled = captureException.</>}
                data={handledData}
                formatValue={formatErrorCount}
              />
            </WidgetPanel>
          </Grid.Item>

          <Grid.Item columnSpan={4} rowSpan={2}>
            <WidgetPanel>
              <DonutPanel
                title="By Severity"
                badge="+5.8%"
                badgeColor="red"
                description="vs last week"
                tooltip={<>Error severity breakdown from the Level column.</>}
                data={bySeverityData}
                formatValue={formatErrorCount}
              />
            </WidgetPanel>
          </Grid.Item>

          {/* Row 4-5: By Environment + Services + Severity/Service combo (Donut + ProgressNav) */}
          <Grid.Item columnSpan={4} rowSpan={2}>
            <WidgetPanel>
              <DonutPanel
                title="By Environment"
                badge="+4.2%"
                badgeColor="red"
                description="production errors"
                tooltip={<>Error distribution by Environment column (production, staging, development).</>}
                data={byEnvironmentData}
                formatValue={formatErrorCount}
              />
            </WidgetPanel>
          </Grid.Item>

          <Grid.Item columnSpan={4} rowSpan={2}>
            <WidgetPanel>
              <DonutPanel
                title="By Service"
                badge="+6.4%"
                badgeColor="red"
                description="total errors"
                tooltip={<>Error distribution across services.</>}
                data={servicesData}
                formatValue={formatErrorCount}
              />
              <div className="h-px w-full bg-border" />
              <ProgressNavPanel
                title="Service Details"
                actionLabel="Details"
                tooltip={<>Error share per service as percentage of total.</>}
                data={serviceProgressData}
              />
            </WidgetPanel>
          </Grid.Item>

          <Grid.Item columnSpan={4} rowSpan={2}>
            <WidgetPanel>
              <ProgressNavPanel
                title="Top Error Types"
                actionLabel="View all"
                tooltip={<>Most frequent ExceptionType values across all services.</>}
                data={topErrorTypesData}
              />
            </WidgetPanel>
          </Grid.Item>

          {/* Row 6-7: Releases + Most Common Errors + (empty or future widget) */}
          <Grid.Item columnSpan={4} rowSpan={2}>
            <WidgetPanel>
              <ProgressNavPanel
                title="By Release"
                actionLabel="Details"
                tooltip={<>Error count by Release (service.version). Shows which releases produce the most errors.</>}
                data={errorsByReleaseData}
              />
            </WidgetPanel>
          </Grid.Item>

          <Grid.Item columnSpan={4} rowSpan={2}>
            <WidgetPanel>
              <ProgressNavPanel
                title="Most Common Errors"
                actionLabel="View all"
                tooltip={<>Top error groups by FingerprintHash, showing the most frequent issues across all services.</>}
                data={mostCommonErrorsData}
              />
            </WidgetPanel>
          </Grid.Item>
        </Grid>
      </div>
    </TooltipPrimitive.Provider>
  );
}
