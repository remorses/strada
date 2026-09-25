/**
 * `@strada.sh/instrumentation`: OpenTelemetry interop for `@strada.sh/sdk`.
 *
 * - `registerOpenTelemetry()` makes the Strada providers the global
 *   `@opentelemetry/api` tracer, meter, logger, context manager, and
 *   propagator, so libraries that emit through the OTel API (Vercel AI SDK,
 *   Prisma, instrumentations) export through Strada.
 * - `getInstrumentations()` returns a curated instrumentation set, close to
 *   Sentry's Node defaults: HTTP, fetch, frameworks, databases, queues,
 *   runtime metrics. No `fs`, `dns`, or `net` spans (one span per file or
 *   socket is noise), and logger instrumentations only add trace ids to log
 *   lines instead of forwarding every log to Strada.
 * - `@strada.sh/instrumentation/register` is the `--import` preload.
 * - `@strada.sh/instrumentation/otel` exports only `registerOpenTelemetry()`,
 *   without the Node instrumentations, for browsers and Workers.
 *
 * The SDK stays dependency-free; this package owns every OTel dependency so
 * users install one package instead of thirty.
 */

import type { Instrumentation } from "@opentelemetry/instrumentation";
import { AmqplibInstrumentation } from "@opentelemetry/instrumentation-amqplib";
import { BunyanInstrumentation } from "@opentelemetry/instrumentation-bunyan";
import { ConnectInstrumentation } from "@opentelemetry/instrumentation-connect";
import { DataloaderInstrumentation } from "@opentelemetry/instrumentation-dataloader";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { GenericPoolInstrumentation } from "@opentelemetry/instrumentation-generic-pool";
import { GraphQLInstrumentation } from "@opentelemetry/instrumentation-graphql";
import { HapiInstrumentation } from "@opentelemetry/instrumentation-hapi";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis";
import { KafkaJsInstrumentation } from "@opentelemetry/instrumentation-kafkajs";
import { KnexInstrumentation } from "@opentelemetry/instrumentation-knex";
import { KoaInstrumentation } from "@opentelemetry/instrumentation-koa";
import { LruMemoizerInstrumentation } from "@opentelemetry/instrumentation-lru-memoizer";
import { MongoDBInstrumentation } from "@opentelemetry/instrumentation-mongodb";
import { MongooseInstrumentation } from "@opentelemetry/instrumentation-mongoose";
import { MySQLInstrumentation } from "@opentelemetry/instrumentation-mysql";
import { MySQL2Instrumentation } from "@opentelemetry/instrumentation-mysql2";
import { NestInstrumentation } from "@opentelemetry/instrumentation-nestjs-core";
import { OpenAIInstrumentation } from "@opentelemetry/instrumentation-openai";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino";
import { RedisInstrumentation } from "@opentelemetry/instrumentation-redis";
import { RouterInstrumentation } from "@opentelemetry/instrumentation-router";
import { RuntimeNodeInstrumentation } from "@opentelemetry/instrumentation-runtime-node";
import { TediousInstrumentation } from "@opentelemetry/instrumentation-tedious";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { WinstonInstrumentation } from "@opentelemetry/instrumentation-winston";

export { registerOpenTelemetry } from "./otel.ts";

/** Short names, the same as `@opentelemetry/instrumentation-<name>`. */
export type InstrumentationName =
  | "http"
  | "undici"
  | "express"
  | "koa"
  | "hapi"
  | "connect"
  | "router"
  | "nestjs-core"
  | "graphql"
  | "pg"
  | "mysql"
  | "mysql2"
  | "mongodb"
  | "mongoose"
  | "redis"
  | "ioredis"
  | "knex"
  | "tedious"
  | "kafkajs"
  | "amqplib"
  | "dataloader"
  | "generic-pool"
  | "lru-memoizer"
  | "runtime-node"
  | "pino"
  | "winston"
  | "bunyan"
  | "openai";

// Logger instrumentations: inject trace_id/span_id into log lines, but do not
// forward every log to Strada. Use getLogger() for logs you want stored.
const logCorrelationOnly = { disableLogSending: true };

const FACTORIES: Record<InstrumentationName, () => Instrumentation> = {
  http: () => new HttpInstrumentation(),
  undici: () => new UndiciInstrumentation(),
  express: () => new ExpressInstrumentation(),
  koa: () => new KoaInstrumentation(),
  hapi: () => new HapiInstrumentation(),
  connect: () => new ConnectInstrumentation(),
  router: () => new RouterInstrumentation(),
  "nestjs-core": () => new NestInstrumentation(),
  graphql: () => new GraphQLInstrumentation(),
  pg: () => new PgInstrumentation(),
  mysql: () => new MySQLInstrumentation(),
  mysql2: () => new MySQL2Instrumentation(),
  mongodb: () => new MongoDBInstrumentation(),
  mongoose: () => new MongooseInstrumentation(),
  redis: () => new RedisInstrumentation(),
  ioredis: () => new IORedisInstrumentation(),
  knex: () => new KnexInstrumentation(),
  tedious: () => new TediousInstrumentation(),
  kafkajs: () => new KafkaJsInstrumentation(),
  amqplib: () => new AmqplibInstrumentation(),
  dataloader: () => new DataloaderInstrumentation(),
  "generic-pool": () => new GenericPoolInstrumentation(),
  "lru-memoizer": () => new LruMemoizerInstrumentation(),
  "runtime-node": () => new RuntimeNodeInstrumentation(),
  pino: () => new PinoInstrumentation(logCorrelationOnly),
  winston: () => new WinstonInstrumentation(logCorrelationOnly),
  bunyan: () => new BunyanInstrumentation(logCorrelationOnly),
  openai: () => new OpenAIInstrumentation(),
};

export const INSTRUMENTATION_NAMES = Object.keys(FACTORIES) as InstrumentationName[];

function parseNames(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((name) => name.trim().replace(/^@opentelemetry\/instrumentation-/, ""))
    .filter(Boolean);
}

/**
 * The curated instrumentations. Narrow them with `enabled` / `disabled`, or
 * with the standard env vars `OTEL_NODE_ENABLED_INSTRUMENTATIONS` and
 * `OTEL_NODE_DISABLED_INSTRUMENTATIONS` (comma-separated short names).
 */
export function getInstrumentations({
  enabled = parseNames(process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS),
  disabled = parseNames(process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS),
}: { enabled?: string[]; disabled?: string[] } = {}): Instrumentation[] {
  return INSTRUMENTATION_NAMES.filter((name) => {
    return (enabled.length === 0 || enabled.includes(name)) && !disabled.includes(name);
  }).map((name) => FACTORIES[name]());
}
