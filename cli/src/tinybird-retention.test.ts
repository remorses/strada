import { describe, expect, test } from "vitest";
import { loadTinybirdResources } from "./tinybird-resources.ts";
import {
  extractEngineTtl,
  mergeProjectRetention,
  renderTinybirdRetention,
  validateRetentionDays,
} from "./tinybird-retention.ts";

function retention(overrides: Partial<{
  id: string;
  tracesRetentionDays: number | null;
  logsRetentionDays: number | null;
  errorsRetentionDays: number | null;
  metricsRetentionDays: number | null;
}> = {}) {
  return {
    id: "project-a",
    tracesRetentionDays: null,
    logsRetentionDays: null,
    errorsRetentionDays: null,
    metricsRetentionDays: null,
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
  test("keeps all raw telemetry by default", () => {
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
          "name": "otel_health_checks",
          "ttl": "toDate(Timestamp) + toIntervalDay(90)",
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
          "name": "otel_health_checks",
          "ttl": "toDate(Timestamp) + toIntervalDay(90)",
        },
        {
          "name": "otel_traces",
          "ttl": "toDateTime(Timestamp) + toIntervalDay(7) DELETE WHERE ProjectId IN ('project-a', 'project-b'), toDateTime(Timestamp) + toIntervalDay(30) DELETE WHERE ProjectId IN ('project-c')",
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
          "name": "otel_health_checks",
          "ttl": "toDate(Timestamp) + toIntervalDay(90)",
        },
        {
          "name": "otel_logs",
          "ttl": "TimestampTime + toIntervalDay(7) DELETE WHERE ProjectId IN ('project-\\'\\\\-a')",
        },
      ]
    `);
  });

  test("applies custom TTL to all seven raw tables", () => {
    expect(renderedTtls([
      retention({
        tracesRetentionDays: 7,
        logsRetentionDays: 14,
        errorsRetentionDays: 21,
        metricsRetentionDays: 28,
      }),
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
          "ttl": "toDateTime(Timestamp) + toIntervalDay(21) DELETE WHERE ProjectId IN ('project-a')",
        },
        {
          "name": "otel_health_checks",
          "ttl": "toDate(Timestamp) + toIntervalDay(90)",
        },
        {
          "name": "otel_logs",
          "ttl": "TimestampTime + toIntervalDay(14) DELETE WHERE ProjectId IN ('project-a')",
        },
        {
          "name": "otel_metrics_exponential_histogram",
          "ttl": "toDateTime(TimeUnix) + toIntervalDay(28) DELETE WHERE ProjectId IN ('project-a')",
        },
        {
          "name": "otel_metrics_gauge",
          "ttl": "toDateTime(TimeUnix) + toIntervalDay(28) DELETE WHERE ProjectId IN ('project-a')",
        },
        {
          "name": "otel_metrics_histogram",
          "ttl": "toDateTime(TimeUnix) + toIntervalDay(28) DELETE WHERE ProjectId IN ('project-a')",
        },
        {
          "name": "otel_metrics_sum",
          "ttl": "toDateTime(TimeUnix) + toIntervalDay(28) DELETE WHERE ProjectId IN ('project-a')",
        },
        {
          "name": "otel_traces",
          "ttl": "toDateTime(Timestamp) + toIntervalDay(7) DELETE WHERE ProjectId IN ('project-a')",
        },
      ]
    `);
  });

  test("removes an existing raw ENGINE_TTL when keep-all is configured", () => {
    const rendered = renderTinybirdRetention({
      datasources: [{
        name: "otel_traces",
        content: 'ENGINE_SORTING_KEY "ProjectId"\nENGINE_TTL "toDateTime(Timestamp) + toIntervalDay(14)"\nENGINE_SETTINGS index_granularity=8192',
      }],
      projects: [retention()],
    });
    expect(extractEngineTtl(rendered[0]!.content)).toBeNull();
    expect(rendered[0]!.content).toContain('ENGINE_SORTING_KEY "ProjectId"');
    expect(rendered[0]!.content).toContain("ENGINE_SETTINGS index_granularity=8192");
  });

  test("clears only the signals that are explicitly set to keep", () => {
    expect(mergeProjectRetention({
      current: retention({
        tracesRetentionDays: 7,
        logsRetentionDays: 14,
        errorsRetentionDays: 21,
        metricsRetentionDays: 28,
      }),
      update: { tracesDays: null },
    })).toEqual(retention({
      tracesRetentionDays: null,
      logsRetentionDays: 14,
      errorsRetentionDays: 21,
      metricsRetentionDays: 28,
    }))
    expect(mergeProjectRetention({
      current: retention({ tracesRetentionDays: 7 }),
      update: { tracesDays: null, logsDays: null, errorsDays: null, metricsDays: null },
    })).toEqual(retention())
  })

  test.each([0, 366, 1.5, Number.NaN])("rejects invalid retention %s", (days) => {
    expect(() => validateRetentionDays(days, "traces")).toThrow(
      "traces retention must be an integer between 1 and 365 days",
    );
  });
});
