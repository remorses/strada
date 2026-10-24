// Terminal table renderer with color support. Takes rows as plain objects,
// auto-sizes columns, and applies per-column color functions.
//
// Usage:
//   printTable(output, {
//     columns: [
//       { key: "count", label: "COUNT", align: "right", color: bold },
//       { key: "type",  label: "TYPE",  color: cyan },
//       { key: "msg",   label: "MESSAGE", maxWidth: 40 },
//     ],
//     rows: [{ count: "1,247", type: "TypeError", msg: "Cannot read..." }],
//   })

import { bold, dim, gray } from "./colors.ts";

/** Strip ANSI escape codes to get the visible character count */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Visible width of a string, ignoring ANSI escape codes */
function visibleLength(s: string): number {
  return stripAnsi(s).length;
}

export interface TableColumn {
  /** Object key to read from each row */
  key: string;
  /** Header label */
  label: string;
  /** Right-align numbers, left-align text (default: "left") */
  align?: "left" | "right";
  /** Max width before truncation. Header is never truncated. */
  maxWidth?: number;
  /** Color function applied to cell values (not headers) */
  color?: (s: string) => string;
}

export interface TableOptions {
  columns: TableColumn[];
  rows: Record<string, string>[];
  /** Gap between columns in spaces (default: 2) */
  gap?: number;
}

function truncate(s: string, max: number): string {
  const visible = stripAnsi(s);
  if (visible.length <= max) return s;
  // Truncate the visible content, not the raw string with ANSI codes
  return visible.slice(0, max - 1) + "…";
}

function pad(s: string, width: number, align: "left" | "right"): string {
  const visible = visibleLength(s);
  const diff = width - visible;
  if (diff <= 0) return s;
  const spaces = " ".repeat(diff);
  return align === "right" ? spaces + s : s + spaces;
}

export function formatTable(opts: TableOptions): string {
  const { columns, rows, gap = 2 } = opts;
  const spacer = " ".repeat(gap);

  // Compute column widths from header + all cell values (ANSI-aware)
  const widths = columns.map((col) => {
    let max = col.label.length;
    for (const row of rows) {
      const raw = row[col.key] ?? "";
      const val = col.maxWidth ? truncate(raw, col.maxWidth) : raw;
      const w = visibleLength(val);
      if (w > max) max = w;
    }
    return max;
  });

  const lines: string[] = [];

  // Header row
  const header = columns
    .map((col, i) => dim(pad(col.label, widths[i]!, col.align ?? "left")))
    .join(spacer);
  lines.push("  " + header);

  // Separator
  const sep = columns
    .map((_col, i) => gray("─".repeat(widths[i]!)))
    .join(spacer);
  lines.push("  " + sep);

  // Data rows
  for (const row of rows) {
    const cells = columns.map((col, i) => {
      const raw = row[col.key] ?? "";
      const val = col.maxWidth ? truncate(raw, col.maxWidth) : raw;
      const padded = pad(val, widths[i]!, col.align ?? "left");
      return col.color ? col.color(padded) : padded;
    });
    lines.push("  " + cells.join(spacer));
  }

  return lines.join("\n");
}

export function printTable(
  output: { log: (msg: string) => void },
  opts: TableOptions,
): void {
  output.log(formatTable(opts));
}

/** Format a number with comma separators: 1247 → "1,247" */
export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Parses a timestamp. ClickHouse returns DateTime64 as "2026-10-24 12:30:00.123456789"
 * in UTC without a zone; `new Date()` would read that as local time.
 */
export function parseTimestamp(timestamp: string): Date {
  const match = timestamp.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/);
  if (!match) return new Date(timestamp);
  const fraction = match[3] ? match[3].slice(0, 4) : "";
  return new Date(`${match[1]}T${match[2]}${fraction}Z`);
}

/** Format a timestamp string as relative time: "2m ago", "3h ago", "5d ago" */
export function timeAgo(timestamp: string): string {
  const now = Date.now();
  const then = parseTimestamp(timestamp).getTime();
  const diffMs = now - then;
  if (Number.isNaN(diffMs) || diffMs < 0) return timestamp;

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
