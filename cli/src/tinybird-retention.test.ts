import { describe, expect, test } from "vitest";
import { loadTinybirdResources } from "./tinybird-resources.ts";
import {
  extractEngineTtl,
  renderTinybirdRetention,
  validateRetentionDays,
} from "./tinybird-retention.ts";

function retention(overrides: Partial<{
  id: string;
  tracesRetentionDays: number;
  logsRetentionDays: number;
  errorsRetentionDays: number;
  metricsRetentionDays: number;
}> = {}) {
  return {
    id: "project-a",
    tracesRetentionDays: 14,
    logsRetentionDays: 30,
    errorsRetentionDays: 90,
    metricsRetentionDays: 90,
    ...overrides,
  };
}

function renderedTtls(projects = [retention()]) {
  const resources = loadTinybirdResources();
  return renderTinybirdRetention({ datasources: resources.datasources, projects })
    .map((resource) => ({ name: resource.name, ttl: extractEngineTtl(resource.content) }))
    .filter((resource) => resource.ttl != null);
}

describe("renderTinybirdRetention", () => {
  test("keeps default TTLs and fixed tables", () => {
    expect(renderedTtls()).toMatchInlineSnapshot(`
      [
        {
          "name": "otel_analytics_pages",
          "ttl": "Date + INTERVAL 90 DAY",
        },
        {
          "name": "otel_analytics_sessions",
          "ttl": "Date + INTERVAL 90 DAY",
        },
        {
          "name": "otel_errors",
          "ttl": "toDateTime(Timestamp) + toIntervalDay(90)",
        },
        {
          "name": "otel_health_checks",
          "ttl": "toDate(Timestamp) + toIntervalDay(90)",
        },
        {
          "name": "otel_logs",
          "ttl": "TimestampTime + toIntervalDay(30)",
        },
        {
          "name": "otel_metrics_exponential_histogram",
          "ttl": "toDateTime(TimeUnix) + toIntervalDay(90)",
        },
        {
          "name": "otel_metrics_gauge",
          "ttl": "toDateTime(TimeUnix) + toIntervalDay(90)",
        },
        {
          "name": "otel_metrics_histogram",
          "ttl": "toDateTime(TimeUnix) + toIntervalDay(90)",
        },
        {
          "name": "otel_metrics_sum",
          "ttl": "toDateTime(TimeUnix) + toIntervalDay(90)",
        },
        {
          "name": "otel_traces",
          "ttl": "toDateTime(Timestamp) + toIntervalDay(14)",
        },
      ]
    `);
  });

  test("groups custom project TTLs in stable order", () => {
    expect(renderedTtls([
      retention({ id: "project-b", tracesRetentionDays: 7 }),
      retention({ id: "project-a", tracesRetentionDays: 7 }),
      retention({ id: "project-c", tracesRetentionDays: 30 }),
    ])).toMatchInlineSnapshot(`
      [
        {
          "name": "otel_analytics_pages",
          "ttl": "Date + INTERVAL 90 DAY",
        },
        {
          "name": "otel_analytics_sessions",
          "ttl": "Date + INTERVAL 90 DAY",
        },
        {
          "name": "otel_errors",
          "ttl": "toDateTime(Timestamp) + toIntervalDay(90)",
        },
        {
          "name": "otel_health_checks",
          "ttl": "toDate(Timestamp) + toIntervalDay(90)",
        },
        {
          "name": "otel_logs",
          "ttl": "TimestampTime + toIntervalDay(30)",
        },
        {
          "name": "otel_metrics_exponential_histogram",
          "ttl": "toDateTime(TimeUnix) + toIntervalDay(90)",
        },
        {
          "name": "otel_metrics_gauge",
          "ttl": "toDateTime(TimeUnix) + toIntervalDay(90)",
        },
        {
          "name": "otel_metrics_histogram",
          "ttl": "toDateTime(TimeUnix) + toIntervalDay(90)",
        },
        {
          "name": "otel_metrics_sum",
          "ttl": "toDateTime(TimeUnix) + toIntervalDay(90)",
        },
        {
          "name": "otel_traces",
          "ttl": "toDateTime(Timestamp) + toIntervalDay(7) DELETE WHERE ProjectId IN ('project-a', 'project-b'), toDateTime(Timestamp) + toIntervalDay(30) DELETE WHERE ProjectId IN ('project-c'), toDateTime(Timestamp) + toIntervalDay(14) DELETE WHERE ProjectId NOT IN ('project-a', 'project-b', 'project-c')",
        },
      ]
    `);
  });

  test("escapes ClickHouse string literals", () => {
    expect(renderedTtls([
      retention({ id: "project-'\\-a", logsRetentionDays: 7 }),
    ])).toMatchInlineSnapshot(`
      [
        {
          "name": "otel_analytics_pages",
          "ttl": "Date + INTERVAL 90 DAY",
        },
        {
          "name": "otel_analytics_sessions",
          "ttl": "Date + INTERVAL 90 DAY",
        },
        {
          "name": "otel_errors",
          "ttl": "toDateTime(Timestamp) + toIntervalDay(90)",
        },
        {
          "name": "otel_health_checks",
          "ttl": "toDate(Timestamp) + toIntervalDay(90)",
        },
        {
          "name": "otel_logs",
          "ttl": "TimestampTime + toIntervalDay(7) DELETE WHERE ProjectId IN ('project-\\'\\\\-a'), TimestampTime + toIntervalDay(30) DELETE WHERE ProjectId NOT IN ('project-\\'\\\\-a')",
        },
        {
          "name": "otel_metrics_exponential_histogram",
          "ttl": "toDateTime(TimeUnix) + toIntervalDay(90)",
        },
        {
          "name": "otel_metrics_gauge",
          "ttl": "toDateTime(TimeUnix) + toIntervalDay(90)",
        },
        {
          "name": "otel_metrics_histogram",
          "ttl": "toDateTime(TimeUnix) + toIntervalDay(90)",
        },
        {
          "name": "otel_metrics_sum",
          "ttl": "toDateTime(TimeUnix) + toIntervalDay(90)",
        },
        {
          "name": "otel_traces",
          "ttl": "toDateTime(Timestamp) + toIntervalDay(14)",
        },
      ]
    `);
  });

  test.each([0, 366, 1.5, Number.NaN])("rejects invalid retention %s", (days) => {
    expect(() => validateRetentionDays(days, "traces")).toThrow(
      "traces retention must be an integer between 1 and 365 days",
    );
  });
});
