// Public exports for the @strada.sh/ui component package.

export { TraceTimeline } from "./components/traces/trace-timeline.tsx";
export type { TraceTimelineProps } from "./components/traces/trace-timeline.tsx";
export { TraceTimelineDemo } from "./components/traces/trace-timeline-demo.tsx";
export {
  TraceTimelineConnectors,
  TraceTimelineRows,
  TraceTimelineSearch,
  TraceTimelineTimeAxis,
  TraceTimelineTooltipContent,
} from "./components/traces/trace-timeline-parts.tsx";
export type { BarSearchState } from "./components/traces/trace-timeline-parts.tsx";
export { TraceViewProvider } from "./components/traces/trace-timeline-state.tsx";
export type { TraceViewContextValue, TimelineBar, ViewportState } from "./components/traces/trace-timeline-state.tsx";
export { TraceTimelineMinimap } from "./components/traces/trace-timeline-minimap.tsx";
export { TraceActivityLog } from "./components/traces/trace-activity-log.tsx";
export type { TraceActivityLogProps } from "./components/traces/trace-activity-log.tsx";
export { TraceActivityLogDemo } from "./components/traces/trace-activity-log-demo.tsx";
export { ThemeToggle } from "./components/traces/theme-toggle.tsx";
export { Chart, ChartLegend, TimeseriesChart } from "./components/charts.tsx";
export type { ChartEvents, ChartProps, TimeseriesChartProps } from "./components/charts.tsx";
export { DataTable } from "./components/data-table.tsx";
export type {
  DataTableColumn,
  DataTableProps,
  DataTableResult,
  DataTableRow,
  TableCellFormat,
} from "./components/data-table.tsx";
export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "./components/ui/table.tsx";
export type { TableVariant } from "./components/ui/table.tsx";
export { buildTimeseriesChartOption, prepareChartOptions } from "./lib/echarts-options.ts";
export type {
  BuildTimeseriesChartOptionOptions,
  SafeTooltipOption,
  StradaChartOption,
  TimeseriesData,
} from "./lib/echarts-options.ts";
export { chartColors, getChartColor, getDefaultChartColors, resolveChartColor } from "./lib/chart-palette.ts";
export type { ChartColor, ChartColorToken } from "./lib/chart-palette.ts";
export { getHashBadgeColor, hashString } from "./lib/color.ts";
export type { HashBadgeColor } from "./lib/color.ts";
export {
  buildSpanTree,
  calculateSelfTime,
  cn,
  formatDuration,
  getHttpInfo,
  getServiceBarColors,
  getServiceLegendColor,
  useContainerSize,
  useIsDark,
} from "./lib/utils.ts";
export type { OtelTraceRow, SpanNode } from "./lib/utils.ts";
