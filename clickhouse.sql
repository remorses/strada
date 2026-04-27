-- ClickHouse DDL for self-hosted Strada OTel schema.
--
-- This schema follows the standard OTel ClickHouse exporter column naming
-- (PascalCase) from opentelemetry-collector-contrib/exporter/clickhouseexporter.
--
-- Database: create your own or use `default`. The worker's CLICKHOUSE_DATABASE
-- env var controls which database it writes to.

-- ============================================================================
-- TRACES
-- ============================================================================

CREATE TABLE IF NOT EXISTS otel_traces
(
    `ProjectId`           LowCardinality(String) CODEC(ZSTD(1)),
    `Timestamp`           DateTime64(9)          CODEC(Delta(8), ZSTD(1)),
    `TraceId`             String                 CODEC(ZSTD(1)),
    `SpanId`              String                 CODEC(ZSTD(1)),
    `ParentSpanId`        String                 CODEC(ZSTD(1)),
    `TraceState`          String                 CODEC(ZSTD(1)),
    `TraceFlags`          UInt8                  CODEC(ZSTD(1)),
    `SpanName`            LowCardinality(String) CODEC(ZSTD(1)),
    `SpanKind`            LowCardinality(String) CODEC(ZSTD(1)),
    `ServiceName`         LowCardinality(String) CODEC(ZSTD(1)),
    `ResourceSchemaUrl`   String                 CODEC(ZSTD(1)),
    `ResourceAttributes`  Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ScopeSchemaUrl`      String                 CODEC(ZSTD(1)),
    `ScopeName`           String                 CODEC(ZSTD(1)),
    `ScopeVersion`        String                 CODEC(ZSTD(1)),
    `ScopeAttributes`     Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `Duration`            UInt64                 CODEC(ZSTD(1)),
    `StatusCode`          LowCardinality(String) CODEC(ZSTD(1)),
    `StatusMessage`       String                 CODEC(ZSTD(1)),
    `SpanAttributes`      Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `EventsTimestamp`     Array(DateTime64(9))   CODEC(ZSTD(1)),
    `EventsName`          Array(LowCardinality(String)) CODEC(ZSTD(1)),
    `EventsAttributes`    Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    `LinksTraceId`        Array(String)          CODEC(ZSTD(1)),
    `LinksSpanId`         Array(String)          CODEC(ZSTD(1)),
    `LinksTraceState`     Array(String)          CODEC(ZSTD(1)),
    `LinksAttributes`     Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),

    INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_span_attr_key mapKeys(SpanAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_span_attr_value mapValues(SpanAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_duration Duration TYPE minmax GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (ProjectId, ServiceName, SpanName, toDateTime(Timestamp))
SETTINGS index_granularity = 8192;

-- ============================================================================
-- TRACES: TraceId → timestamp range lookup (materialized view)
-- ============================================================================

CREATE TABLE IF NOT EXISTS otel_traces_trace_id_ts
(
    `ProjectId`  LowCardinality(String) CODEC(ZSTD(1)),
    `TraceId`  String,
    `Start`    AggregateFunction(min, DateTime64(9)),
    `End`      AggregateFunction(max, DateTime64(9))
)
ENGINE = AggregatingMergeTree
ORDER BY (ProjectId, TraceId);

CREATE MATERIALIZED VIEW IF NOT EXISTS otel_traces_trace_id_ts_mv
TO otel_traces_trace_id_ts
AS
SELECT
    ProjectId,
    TraceId,
    minState(Timestamp) AS Start,
    maxState(Timestamp) AS End
FROM otel_traces
WHERE TraceId != ''
GROUP BY ProjectId, TraceId;

-- ============================================================================
-- ANALYTICS: Page aggregates from browser pageview spans
-- ============================================================================

CREATE TABLE IF NOT EXISTS otel_analytics_pages
(
    `ProjectId`    LowCardinality(String) CODEC(ZSTD(1)),
    `Date`         Date,
    `ServiceName`  LowCardinality(String) CODEC(ZSTD(1)),
    `Domain`       String                 CODEC(ZSTD(1)),
    `Pathname`     String                 CODEC(ZSTD(1)),
    `Referrer`     String                 CODEC(ZSTD(1)),
    `Device`       LowCardinality(String) CODEC(ZSTD(1)),
    `Browser`      LowCardinality(String) CODEC(ZSTD(1)),
    `Country`      LowCardinality(String) CODEC(ZSTD(1)),
    `Language`     LowCardinality(String) CODEC(ZSTD(1)),
    `Visits`       AggregateFunction(uniq, String),
    `Hits`         AggregateFunction(count, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY Date
ORDER BY (ProjectId, ServiceName, Domain, Date, Device, Browser, Country, Language, Pathname, Referrer)
TTL Date + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS otel_analytics_pages_mv
TO otel_analytics_pages
AS
WITH source AS (
    SELECT
        ProjectId,
        toDate(Timestamp) AS Date,
        ServiceName,
        domainWithoutWWW(SpanAttributes['url.full']) AS Domain,
        SpanAttributes['url.path'] AS Pathname,
        concat(domainWithoutWWW(SpanAttributes['http.request.header.referer']), path(SpanAttributes['http.request.header.referer'])) AS Referrer,
        lower(coalesce(nullIf(SpanAttributes['user_agent.original'], ''), ResourceAttributes['user_agent.original'])) AS ua,
        coalesce(nullIf(SpanAttributes['geo.country'], ''), 'Unknown') AS Country,
        coalesce(nullIf(ResourceAttributes['browser.language'], ''), 'Unknown') AS Language,
        SpanAttributes['session.id'] AS SessionId
    FROM otel_traces
    WHERE
        SpanName = 'pageview'
        AND SpanAttributes['session.id'] != ''
        AND SpanAttributes['url.path'] != ''
        AND SpanAttributes['url.full'] != ''
)
SELECT
    ProjectId,
    Date,
    ServiceName,
    Domain,
    Pathname,
    Referrer,
    CASE
        WHEN match(ua, 'bot[^a-z]|crawl|spider|wget|curl|urllib|ahrefsbot|semrushbot|mj12bot|dotbot|bingbot|googlebot|yandex|baidu|bytespider|petalbot|gptbot|chatgpt|facebookexternalhit|twitterbot|linkedinbot|whatsapp|telegrambot|discordbot|slackbot|applebot|lighthouse|headless|phantom|puppeteer|python|java/|go-http|node-fetch|pingdom|uptimerobot|httrack|scrapy|feedfetcher|bitdiscovery') THEN 'bot'
        WHEN match(ua, 'android') THEN 'mobile-android'
        WHEN match(ua, 'ipad|iphone|ipod') THEN 'mobile-ios'
        ELSE 'desktop'
    END AS Device,
    CASE
        WHEN match(ua, 'firefox') THEN 'firefox'
        WHEN match(ua, 'chrome|crios') THEN 'chrome'
        WHEN match(ua, 'opera') THEN 'opera'
        WHEN match(ua, 'msie|trident') THEN 'ie'
        WHEN match(ua, 'iphone|ipad|safari') THEN 'safari'
        ELSE 'Unknown'
    END AS Browser,
    Country,
    Language,
    uniqState(SessionId) AS Visits,
    countState() AS Hits
FROM source
GROUP BY ProjectId, Date, ServiceName, Domain, Pathname, Referrer, Device, Browser, Country, Language;

-- ============================================================================
-- ANALYTICS: Session aggregates from browser pageview spans
-- ============================================================================

CREATE TABLE IF NOT EXISTS otel_analytics_sessions
(
    `ProjectId`    LowCardinality(String) CODEC(ZSTD(1)),
    `Date`         Date,
    `ServiceName`  LowCardinality(String) CODEC(ZSTD(1)),
    `Domain`       String                 CODEC(ZSTD(1)),
    `SessionId`    String                 CODEC(ZSTD(1)),
    `Device`       SimpleAggregateFunction(any, LowCardinality(String)),
    `Browser`      SimpleAggregateFunction(any, LowCardinality(String)),
    `Country`      SimpleAggregateFunction(any, LowCardinality(String)),
    `FirstHit`     SimpleAggregateFunction(min, DateTime64(9)) CODEC(Delta(8), ZSTD(1)),
    `LatestHit`    SimpleAggregateFunction(max, DateTime64(9)) CODEC(Delta(8), ZSTD(1)),
    `Hits`         AggregateFunction(count, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY Date
ORDER BY (ProjectId, ServiceName, Domain, Date, SessionId)
TTL Date + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS otel_analytics_sessions_mv
TO otel_analytics_sessions
AS
WITH source AS (
    SELECT
        ProjectId,
        toDate(Timestamp) AS Date,
        ServiceName,
        domainWithoutWWW(SpanAttributes['url.full']) AS Domain,
        SpanAttributes['session.id'] AS SessionId,
        lower(coalesce(nullIf(SpanAttributes['user_agent.original'], ''), ResourceAttributes['user_agent.original'])) AS ua,
        coalesce(nullIf(SpanAttributes['geo.country'], ''), 'Unknown') AS Country,
        Timestamp
    FROM otel_traces
    WHERE
        SpanName = 'pageview'
        AND SpanAttributes['session.id'] != ''
        AND SpanAttributes['url.full'] != ''
)
SELECT
    ProjectId,
    Date,
    ServiceName,
    Domain,
    SessionId,
    anySimpleState(
        CASE
            WHEN match(ua, 'bot[^a-z]|crawl|spider|wget|curl|urllib|ahrefsbot|semrushbot|mj12bot|dotbot|bingbot|googlebot|yandex|baidu|bytespider|petalbot|gptbot|chatgpt|facebookexternalhit|twitterbot|linkedinbot|whatsapp|telegrambot|discordbot|slackbot|applebot|lighthouse|headless|phantom|puppeteer|python|java/|go-http|node-fetch|pingdom|uptimerobot|httrack|scrapy|feedfetcher|bitdiscovery') THEN 'bot'
            WHEN match(ua, 'android') THEN 'mobile-android'
            WHEN match(ua, 'ipad|iphone|ipod') THEN 'mobile-ios'
            ELSE 'desktop'
        END
    ) AS Device,
    anySimpleState(
        CASE
            WHEN match(ua, 'firefox') THEN 'firefox'
            WHEN match(ua, 'chrome|crios') THEN 'chrome'
            WHEN match(ua, 'opera') THEN 'opera'
            WHEN match(ua, 'msie|trident') THEN 'ie'
            WHEN match(ua, 'iphone|ipad|safari') THEN 'safari'
            ELSE 'Unknown'
        END
    ) AS Browser,
    anySimpleState(Country) AS Country,
    minSimpleState(Timestamp) AS FirstHit,
    maxSimpleState(Timestamp) AS LatestHit,
    countState() AS Hits
FROM source
GROUP BY ProjectId, Date, ServiceName, Domain, SessionId;

-- ============================================================================
-- LOGS
-- ============================================================================

CREATE TABLE IF NOT EXISTS otel_logs
(
    `ProjectId`           LowCardinality(String) CODEC(ZSTD(1)),
    `Timestamp`           DateTime64(9)          CODEC(Delta(8), ZSTD(1)),
    `TimestampTime`       DateTime DEFAULT toDateTime(Timestamp),
    `TraceId`             String                 CODEC(ZSTD(1)),
    `SpanId`              String                 CODEC(ZSTD(1)),
    `TraceFlags`          UInt8                  CODEC(ZSTD(1)),
    `SeverityText`        LowCardinality(String) CODEC(ZSTD(1)),
    `SeverityNumber`      UInt8                  CODEC(ZSTD(1)),
    `ServiceName`         LowCardinality(String) CODEC(ZSTD(1)),
    `Body`                String                 CODEC(ZSTD(1)),
    `ResourceSchemaUrl`   LowCardinality(String) CODEC(ZSTD(1)),
    `ResourceAttributes`  Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ScopeSchemaUrl`      LowCardinality(String) CODEC(ZSTD(1)),
    `ScopeName`           String                 CODEC(ZSTD(1)),
    `ScopeVersion`        LowCardinality(String) CODEC(ZSTD(1)),
    `ScopeAttributes`     Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `LogAttributes`       Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `EventName`           String                 CODEC(ZSTD(1)),

    INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_log_attr_key mapKeys(LogAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_log_attr_value mapValues(LogAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_body Body TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 8
)
ENGINE = MergeTree
PARTITION BY toDate(TimestampTime)
ORDER BY (ProjectId, ServiceName, TimestampTime, Timestamp)
SETTINGS index_granularity = 8192;

-- ============================================================================
-- ERRORS (extracted from logs and traces by the worker)
-- ============================================================================

CREATE TABLE IF NOT EXISTS otel_errors
(
    `ProjectId`             LowCardinality(String) CODEC(ZSTD(1)),
    `Timestamp`             DateTime64(9)          CODEC(Delta(8), ZSTD(1)),
    `TraceId`               String                 CODEC(ZSTD(1)),
    `SpanId`                String                 CODEC(ZSTD(1)),
    `ServiceName`           LowCardinality(String) CODEC(ZSTD(1)),
    `ExceptionType`         LowCardinality(String) CODEC(ZSTD(1)),
    `ExceptionMessage`      String                 CODEC(ZSTD(1)),
    `ExceptionStacktrace`   String                 CODEC(ZSTD(1)),
    `ExceptionFrames`       String                 CODEC(ZSTD(1)),
    `Fingerprint`           Array(String)          CODEC(ZSTD(1)),
    `FingerprintHash`       String                 CODEC(ZSTD(1)),
    `MechanismType`         LowCardinality(String) CODEC(ZSTD(1)),
    `MechanismHandled`      Bool                   CODEC(ZSTD(1)),
    `DebugId`               String                 CODEC(ZSTD(1)),
    `Level`                 LowCardinality(String) CODEC(ZSTD(1)),
    `Release`               LowCardinality(String) CODEC(ZSTD(1)),
    `Environment`           LowCardinality(String) CODEC(ZSTD(1)),
    `Tags`                  Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ResourceAttributes`    Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ScopeAttributes`       Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `SourceSignal`          LowCardinality(String) CODEC(ZSTD(1)),

    INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_fingerprint_hash FingerprintHash TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_exception_type ExceptionType TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_tag_key mapKeys(Tags) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_tag_value mapValues(Tags) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (ProjectId, ServiceName, FingerprintHash, toDateTime(Timestamp))
SETTINGS index_granularity = 8192;

-- ============================================================================
-- METRICS: Gauge
-- ============================================================================

CREATE TABLE IF NOT EXISTS otel_metrics_gauge
(
    `ProjectId`                   LowCardinality(String) CODEC(ZSTD(1)),
    `ResourceAttributes`          Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ResourceSchemaUrl`           String                 CODEC(ZSTD(1)),
    `ScopeName`                   String                 CODEC(ZSTD(1)),
    `ScopeVersion`                String                 CODEC(ZSTD(1)),
    `ScopeAttributes`             Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ScopeDroppedAttrCount`       UInt32                 CODEC(ZSTD(1)),
    `ScopeSchemaUrl`              String                 CODEC(ZSTD(1)),
    `ServiceName`                 LowCardinality(String) DEFAULT 'unknown' CODEC(ZSTD(1)),
    `MetricName`                  LowCardinality(String) CODEC(ZSTD(1)),
    `MetricDescription`           String                 CODEC(ZSTD(1)),
    `MetricUnit`                  String                 CODEC(ZSTD(1)),
    `Attributes`                  Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `StartTimeUnix`               DateTime64(9)          CODEC(Delta(8), ZSTD(1)),
    `TimeUnix`                    DateTime64(9)          CODEC(Delta(8), ZSTD(1)),
    `Value`                       Float64                CODEC(ZSTD(1)),
    `Flags`                       UInt32                 CODEC(ZSTD(1)),
    `ExemplarsTraceId`            Array(String)          CODEC(ZSTD(1)),
    `ExemplarsSpanId`             Array(String)          CODEC(ZSTD(1)),
    `ExemplarsTimestamp`          Array(DateTime64(9))   CODEC(ZSTD(1)),
    `ExemplarsValue`              Array(Float64)         CODEC(ZSTD(1)),
    `ExemplarsFilteredAttributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),

    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(TimeUnix)
ORDER BY (ProjectId, ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix))
SETTINGS index_granularity = 8192;

-- ============================================================================
-- METRICS: Sum (counters)
-- ============================================================================

CREATE TABLE IF NOT EXISTS otel_metrics_sum
(
    `ProjectId`                   LowCardinality(String) CODEC(ZSTD(1)),
    `ResourceAttributes`          Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ResourceSchemaUrl`           String                 CODEC(ZSTD(1)),
    `ScopeName`                   String                 CODEC(ZSTD(1)),
    `ScopeVersion`                String                 CODEC(ZSTD(1)),
    `ScopeAttributes`             Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ScopeDroppedAttrCount`       UInt32                 CODEC(ZSTD(1)),
    `ScopeSchemaUrl`              String                 CODEC(ZSTD(1)),
    `ServiceName`                 LowCardinality(String) DEFAULT 'unknown' CODEC(ZSTD(1)),
    `MetricName`                  LowCardinality(String) CODEC(ZSTD(1)),
    `MetricDescription`           String                 CODEC(ZSTD(1)),
    `MetricUnit`                  String                 CODEC(ZSTD(1)),
    `Attributes`                  Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `StartTimeUnix`               DateTime64(9)          CODEC(Delta(8), ZSTD(1)),
    `TimeUnix`                    DateTime64(9)          CODEC(Delta(8), ZSTD(1)),
    `Value`                       Float64                CODEC(ZSTD(1)),
    `Flags`                       UInt32                 CODEC(ZSTD(1)),
    `ExemplarsTraceId`            Array(String)          CODEC(ZSTD(1)),
    `ExemplarsSpanId`             Array(String)          CODEC(ZSTD(1)),
    `ExemplarsTimestamp`          Array(DateTime64(9))   CODEC(ZSTD(1)),
    `ExemplarsValue`              Array(Float64)         CODEC(ZSTD(1)),
    `ExemplarsFilteredAttributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    `AggregationTemporality`      Int32                  CODEC(ZSTD(1)),
    `IsMonotonic`                 Bool                   CODEC(Delta, ZSTD(1)),

    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(TimeUnix)
ORDER BY (ProjectId, ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix))
SETTINGS index_granularity = 8192;

-- ============================================================================
-- METRICS: Histogram
-- ============================================================================

CREATE TABLE IF NOT EXISTS otel_metrics_histogram
(
    `ProjectId`                   LowCardinality(String) CODEC(ZSTD(1)),
    `ResourceAttributes`          Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ResourceSchemaUrl`           String                 CODEC(ZSTD(1)),
    `ScopeName`                   String                 CODEC(ZSTD(1)),
    `ScopeVersion`                String                 CODEC(ZSTD(1)),
    `ScopeAttributes`             Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ScopeDroppedAttrCount`       UInt32                 CODEC(ZSTD(1)),
    `ScopeSchemaUrl`              String                 CODEC(ZSTD(1)),
    `ServiceName`                 LowCardinality(String) DEFAULT 'unknown' CODEC(ZSTD(1)),
    `MetricName`                  LowCardinality(String) CODEC(ZSTD(1)),
    `MetricDescription`           String                 CODEC(ZSTD(1)),
    `MetricUnit`                  String                 CODEC(ZSTD(1)),
    `Attributes`                  Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `StartTimeUnix`               DateTime64(9)          CODEC(Delta(8), ZSTD(1)),
    `TimeUnix`                    DateTime64(9)          CODEC(Delta(8), ZSTD(1)),
    `Count`                       UInt64                 CODEC(Delta, ZSTD(1)),
    `Sum`                         Float64                CODEC(ZSTD(1)),
    `BucketCounts`                Array(UInt64)          CODEC(ZSTD(1)),
    `ExplicitBounds`              Array(Float64)         CODEC(ZSTD(1)),
    `ExemplarsTraceId`            Array(String)          CODEC(ZSTD(1)),
    `ExemplarsSpanId`             Array(String)          CODEC(ZSTD(1)),
    `ExemplarsTimestamp`          Array(DateTime64(9))   CODEC(ZSTD(1)),
    `ExemplarsValue`              Array(Float64)         CODEC(ZSTD(1)),
    `ExemplarsFilteredAttributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    `Flags`                       UInt32                 CODEC(ZSTD(1)),
    `Min`                         Nullable(Float64)      CODEC(ZSTD(1)),
    `Max`                         Nullable(Float64)      CODEC(ZSTD(1)),
    `AggregationTemporality`      Int32                  CODEC(ZSTD(1)),

    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(TimeUnix)
ORDER BY (ProjectId, ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix))
SETTINGS index_granularity = 8192;

-- ============================================================================
-- METRICS: Exponential Histogram
-- ============================================================================

CREATE TABLE IF NOT EXISTS otel_metrics_exponential_histogram
(
    `ProjectId`                   LowCardinality(String) CODEC(ZSTD(1)),
    `ResourceAttributes`          Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ResourceSchemaUrl`           String                 CODEC(ZSTD(1)),
    `ScopeName`                   String                 CODEC(ZSTD(1)),
    `ScopeVersion`                String                 CODEC(ZSTD(1)),
    `ScopeAttributes`             Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ScopeDroppedAttrCount`       UInt32                 CODEC(ZSTD(1)),
    `ScopeSchemaUrl`              String                 CODEC(ZSTD(1)),
    `ServiceName`                 LowCardinality(String) DEFAULT 'unknown' CODEC(ZSTD(1)),
    `MetricName`                  LowCardinality(String) CODEC(ZSTD(1)),
    `MetricDescription`           String                 CODEC(ZSTD(1)),
    `MetricUnit`                  String                 CODEC(ZSTD(1)),
    `Attributes`                  Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `StartTimeUnix`               DateTime64(9)          CODEC(Delta(8), ZSTD(1)),
    `TimeUnix`                    DateTime64(9)          CODEC(Delta(8), ZSTD(1)),
    `Count`                       UInt64                 CODEC(Delta, ZSTD(1)),
    `Sum`                         Float64                CODEC(ZSTD(1)),
    `Scale`                       Int32                  CODEC(ZSTD(1)),
    `ZeroCount`                   UInt64                 CODEC(ZSTD(1)),
    `PositiveOffset`              Int32                  CODEC(ZSTD(1)),
    `PositiveBucketCounts`        Array(UInt64)          CODEC(ZSTD(1)),
    `NegativeOffset`              Int32                  CODEC(ZSTD(1)),
    `NegativeBucketCounts`        Array(UInt64)          CODEC(ZSTD(1)),
    `ExemplarsTraceId`            Array(String)          CODEC(ZSTD(1)),
    `ExemplarsSpanId`             Array(String)          CODEC(ZSTD(1)),
    `ExemplarsTimestamp`          Array(DateTime64(9))   CODEC(ZSTD(1)),
    `ExemplarsValue`              Array(Float64)         CODEC(ZSTD(1)),
    `ExemplarsFilteredAttributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    `Flags`                       UInt32                 CODEC(ZSTD(1)),
    `Min`                         Nullable(Float64)      CODEC(ZSTD(1)),
    `Max`                         Nullable(Float64)      CODEC(ZSTD(1)),
    `AggregationTemporality`      Int32                  CODEC(ZSTD(1)),

    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(TimeUnix)
ORDER BY (ProjectId, ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix))
SETTINGS index_granularity = 8192;

-- ============================================================================
-- ISSUE STATE (ReplacingMergeTree)
-- ============================================================================
--
-- This table stores mutable triage metadata for error groups: status
-- (open/resolved/muted/ignored), assignee, and resolver info.
--
-- WHY THIS IS IN CLICKHOUSE, NOT D1:
-- D1 is Cloudflare's per-request SQLite. It works well for auth, org config,
-- and other low-frequency control-plane data. But issue state is queried on
-- every "issues list" request and joined with error aggregations. Keeping it
-- in D1 would mean two round-trips per read (ClickHouse for error counts,
-- D1 for status/assignee) and D1 cannot handle high-RPS analytical queries
-- without becoming the bottleneck. By co-locating issue state next to error
-- data in ClickHouse, the CLI and UI can join them in a single SQL query.
--
-- HOW IT WORKS:
-- ReplacingMergeTree deduplicates rows with the same ORDER BY key, keeping
-- only the row with the highest Version column. Each status or assignee
-- change INSERTs a new row with Version = Date.now() (epoch ms). ClickHouse
-- background merges eventually collapse old versions, but queries use FINAL
-- to force deduplication at read time for guaranteed consistency.
--
-- Both mutation routes (status, assignee) do a read-before-write to preserve
-- the field they are not changing. Tinybird writes use ?wait=true so the new
-- row is visible before the response returns.
--
-- SORTING KEY: (ProjectId, FingerprintHash)
-- This makes point lookups by fingerprint within a project fast, and ensures
-- deduplication merges are scoped to the right granularity.

CREATE TABLE IF NOT EXISTS otel_issue_state
(
    `ProjectId`           LowCardinality(String) CODEC(ZSTD(1)),
    `FingerprintHash`     String                 CODEC(ZSTD(1)),
    `Status`              LowCardinality(String) CODEC(ZSTD(1)),
    `AssigneeMemberId`    String                 CODEC(ZSTD(1)),
    `ResolvedAt`          Nullable(DateTime64(3)) CODEC(ZSTD(1)),
    `ResolvedByMemberId`  String                 CODEC(ZSTD(1)),
    `Version`             UInt64                 CODEC(ZSTD(1)),
    `UpdatedAt`           DateTime64(3)          CODEC(ZSTD(1))
)
ENGINE = ReplacingMergeTree(Version)
ORDER BY (ProjectId, FingerprintHash)
SETTINGS index_granularity = 8192;
