// Type-safe environment variable access and project config resolution.
//
// The collector resolves project config from a shared D1 database.
// Project ID is extracted from the hostname, then looked up in D1
// to get the database credentials (Tinybird or ClickHouse).

/** Standard OTel table names. */
export const datasources = {
  traces: "otel_traces",
  logs: "otel_logs",
  errors: "otel_errors",
  gauge: "otel_metrics_gauge",
  sum: "otel_metrics_sum",
  histogram: "otel_metrics_histogram",
  exponentialHistogram: "otel_metrics_exponential_histogram",
} as const;

/** Resolved database config for a project, fetched from D1. */
export interface ProjectConfig {
  projectId: string;
  backend: "tinybird" | "clickhouse";
  tinybirdEndpoint: string | null;
  tinybirdAdminToken: string | null;
  clickhouseUrl: string | null;
  clickhouseDatabase: string | null;
  clickhouseUser: string | null;
  clickhousePassword: string | null;
}
