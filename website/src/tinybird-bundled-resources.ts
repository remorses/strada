// Bundled Tinybird resources for the website worker.
// Imports datasource and materialization definitions as raw strings so the
// migrate API can deploy the latest schema without filesystem access.

import otelAnalyticsPages from '../../tinybird/datasources/otel_analytics_pages.datasource?raw'
import otelAnalyticsSessions from '../../tinybird/datasources/otel_analytics_sessions.datasource?raw'
import otelErrors from '../../tinybird/datasources/otel_errors.datasource?raw'
import otelLogs from '../../tinybird/datasources/otel_logs.datasource?raw'
import otelMetricsExponentialHistogram from '../../tinybird/datasources/otel_metrics_exponential_histogram.datasource?raw'
import otelMetricsGauge from '../../tinybird/datasources/otel_metrics_gauge.datasource?raw'
import otelMetricsHistogram from '../../tinybird/datasources/otel_metrics_histogram.datasource?raw'
import otelMetricsSum from '../../tinybird/datasources/otel_metrics_sum.datasource?raw'
import otelTraces from '../../tinybird/datasources/otel_traces.datasource?raw'
import otelTracesTraceIdTs from '../../tinybird/datasources/otel_traces_trace_id_ts.datasource?raw'
import otelIssueState from '../../tinybird/datasources/otel_issue_state.datasource?raw'
import otelAnalyticsPagesMv from '../../tinybird/materializations/otel_analytics_pages_mv.pipe?raw'
import otelAnalyticsSessionsMv from '../../tinybird/materializations/otel_analytics_sessions_mv.pipe?raw'
import otelTracesTraceIdTsMv from '../../tinybird/materializations/otel_traces_trace_id_ts_mv.pipe?raw'

export const bundledTinybirdResources = {
  datasources: [
    { name: 'otel_analytics_pages', content: otelAnalyticsPages },
    { name: 'otel_analytics_sessions', content: otelAnalyticsSessions },
    { name: 'otel_errors', content: otelErrors },
    { name: 'otel_logs', content: otelLogs },
    { name: 'otel_metrics_exponential_histogram', content: otelMetricsExponentialHistogram },
    { name: 'otel_metrics_gauge', content: otelMetricsGauge },
    { name: 'otel_metrics_histogram', content: otelMetricsHistogram },
    { name: 'otel_metrics_sum', content: otelMetricsSum },
    { name: 'otel_traces', content: otelTraces },
    { name: 'otel_traces_trace_id_ts', content: otelTracesTraceIdTs },
    { name: 'otel_issue_state', content: otelIssueState },
  ],
  pipes: [
    { name: 'otel_analytics_pages_mv', content: otelAnalyticsPagesMv },
    { name: 'otel_analytics_sessions_mv', content: otelAnalyticsSessionsMv },
    { name: 'otel_traces_trace_id_ts_mv', content: otelTracesTraceIdTsMv },
  ],
} as const
