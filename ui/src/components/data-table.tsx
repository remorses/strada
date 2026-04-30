// RSC-friendly data table for agent-generated SQL results. Accepts resolved rows
// or a streamed Promise, formats common observability values, and keeps display
// config serializable so MDX can safely render it from the server.
"use client";

import { use } from "react";

import { getHashBadgeColor } from "../lib/color.ts";
import { cn } from "../lib/utils.ts";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table.tsx";

export type TableCellFormat =
  | "text"
  | "code"
  | "number"
  | "compact-number"
  | "percent"
  | "datetime"
  | "relative-time"
  | "duration-ms"
  | "duration-ns"
  | "json"
  | "boolean"
  | "severity"
  | "status"
  | "trace-id"
  | "span-id"
  | "fingerprint"
  | "badge";

export type DataTablePrimitive = string | number | boolean | null | undefined | Date;
export type DataTableValue = DataTablePrimitive | DataTablePrimitive[] | Record<string, DataTablePrimitive>;
export type DataTableRow = Record<string, DataTableValue>;

export interface DataTableResult {
  rows?: DataTableRow[];
  data?: DataTableRow[];
  meta?: { name: string; type?: string }[];
}

export interface DataTableColumn {
  key: string;
  label?: string;
  format?: TableCellFormat;
  align?: "left" | "center" | "right";
  maxWidth?: number;
  truncate?: boolean;
}

export interface DataTableProps {
  data: DataTableRow[] | DataTableResult | Promise<DataTableRow[] | DataTableResult>;
  columns?: DataTableColumn[];
  title?: string;
  description?: string;
  emptyState?: string;
  maxRows?: number;
  className?: string;
}

const numberFormatter = new Intl.NumberFormat("en-US");
const compactNumberFormatter = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function DataTable({
  data,
  columns,
  title,
  description,
  emptyState = "No rows returned",
  maxRows = 500,
  className,
}: DataTableProps) {
  const result = data instanceof Promise ? use(data) : data;
  const rows = (Array.isArray(result) ? result : (result.data ?? result.rows ?? [])).slice(0, maxRows);
  const resolvedColumns = columns ?? inferColumns(rows, Array.isArray(result) ? undefined : result.meta);

  return (
    <section className={cn("flex w-full flex-col gap-3", className)}>
      {(title || description) && (
        <div className="flex flex-col gap-1">
          {title && <h2 className="text-sm font-medium tracking-tight">{title}</h2>}
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded-lg border px-4 py-8 text-center text-sm text-muted-foreground">{emptyState}</div>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {resolvedColumns.map((column) => (
                  <TableHead key={column.key} className={alignClass(column.align)}>
                    {column.label ?? prettifyLabel(column.key)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, index) => (
                <TableRow key={index}>
                  {resolvedColumns.map((column) => (
                    <TableCell
                      key={column.key}
                      className={cn(alignClass(column.align), column.truncate !== false && "max-w-80 truncate")}
                      style={column.maxWidth ? { maxWidth: column.maxWidth } : undefined}
                    >
                      <FormattedValue column={column} value={row[column.key]} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function FormattedValue({ value, column }: { value: DataTableValue; column: DataTableColumn }) {
  const format = column.format ?? inferFormat(column.key);
  if (value == null || value === "") return <span className="text-muted-foreground">—</span>;

  if (format === "badge") return <HashBadge value={String(value)} />;
  if (format === "severity") return <Pill value={String(value)} tone={severityTone(String(value))} />;
  if (format === "status") return <Pill value={String(value)} tone={statusTone(String(value))} />;
  if (format === "code" || format === "trace-id" || format === "span-id" || format === "fingerprint") {
    return <code className="font-mono text-xs text-muted-foreground">{shorten(String(value), format)}</code>;
  }
  if (format === "number") return numberFormatter.format(Number(value));
  if (format === "compact-number") return compactNumberFormatter.format(Number(value));
  if (format === "percent") return `${(Number(value) * 100).toFixed(1)}%`;
  if (format === "datetime") return dateTimeFormatter.format(toDate(value));
  if (format === "relative-time") return formatRelativeTime(toDate(value));
  if (format === "duration-ms") return formatDurationMs(Number(value));
  if (format === "duration-ns") return formatDurationMs(Number(value) / 1_000_000);
  if (format === "boolean") return String(Boolean(value));
  if (format === "json") return <code className="font-mono text-xs text-muted-foreground">{stringifyJson(value)}</code>;

  return String(value);
}

function HashBadge({ value }: { value: string }) {
  const color = getHashBadgeColor(value);
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-input bg-background px-1.5 py-0.5 text-xs font-medium text-foreground">
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: color.dot }} />
      <span className="truncate">{value}</span>
    </span>
  );
}

function Pill({ value, tone }: { value: string; tone: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium", tone)}>
      {value}
    </span>
  );
}

function inferColumns(rows: DataTableRow[], meta?: { name: string; type?: string }[]): DataTableColumn[] {
  const names = meta?.map((field) => field.name) ?? Object.keys(rows[0] ?? {});
  return names.map((name) => ({
    key: name,
    label: prettifyLabel(name),
    format: inferFormat(name, meta?.find((field) => field.name === name)?.type),
  }));
}

function inferFormat(key: string, type = ""): TableCellFormat {
  const lower = key.toLowerCase();
  if (lower.includes("traceid") || lower === "trace") return "trace-id";
  if (lower.includes("spanid")) return "span-id";
  if (lower.includes("fingerprint")) return "fingerprint";
  if (lower.includes("severity") || lower === "level") return "severity";
  if (lower.includes("status")) return "status";
  if (lower.includes("duration")) return lower.includes("ns") || lower === "duration" ? "duration-ns" : "duration-ms";
  if (lower.includes("time") || lower.endsWith("_at") || type.startsWith("DateTime")) return "relative-time";
  if (type.includes("Int") || type.includes("Float") || type.includes("Decimal")) return "compact-number";
  return "text";
}

function alignClass(align: DataTableColumn["align"]) {
  if (align === "right") return "text-right";
  if (align === "center") return "text-center";
  return "text-left";
}

function prettifyLabel(key: string) {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function toDate(value: DataTableValue) {
  if (value instanceof Date) return value;
  return new Date(typeof value === "number" && value < 10_000_000_000 ? value * 1000 : String(value));
}

function formatRelativeTime(date: Date) {
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return dateTimeFormatter.format(date);
}

function formatDurationMs(ms: number) {
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function shorten(value: string, format: TableCellFormat) {
  if (format === "trace-id" || format === "fingerprint")
    return value.length > 16 ? `${value.slice(0, 12)}…${value.slice(-4)}` : value;
  if (format === "span-id") return value.length > 12 ? `${value.slice(0, 8)}…` : value;
  return value;
}

function stringifyJson(value: DataTableValue) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function severityTone(value: string) {
  const lower = value.toLowerCase();
  if (lower.includes("fatal") || lower.includes("error"))
    return "border-destructive/20 bg-destructive/10 text-destructive";
  if (lower.includes("warn")) return "border-warning/20 bg-warning/10 text-warning-foreground";
  if (lower.includes("info")) return "border-info/20 bg-info/10 text-info-foreground";
  return "border-border bg-muted text-muted-foreground";
}

function statusTone(value: string) {
  const lower = value.toLowerCase();
  if (lower.includes("ok") || lower.includes("resolved") || lower.includes("success"))
    return "border-info/20 bg-info/10 text-info-foreground";
  if (lower.includes("error") || lower.includes("open") || lower.includes("failed"))
    return "border-destructive/20 bg-destructive/10 text-destructive";
  if (lower.includes("muted") || lower.includes("ignored")) return "border-border bg-muted text-muted-foreground";
  return "border-border bg-muted text-muted-foreground";
}
