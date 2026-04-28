// Parse human-readable duration strings like "1h", "24h", "7d" into
// ClickHouse SQL INTERVAL expressions, or ISO date strings into ClickHouse
// datetime literals. Used by CLI commands that accept --since/--until flags.
//
// Duration units: s (seconds), m (minutes), h (hours), d (days), w (weeks).
// Examples: "30m" → "30 MINUTE", "24h" → "24 HOUR", "7d" → "7 DAY"
//
// ISO dates: "2026-04-28", "2026-04-28T10:30:00Z" → parsed as absolute time.

const UNIT_MAP: Record<string, string> = {
  s: "SECOND",
  m: "MINUTE",
  h: "HOUR",
  d: "DAY",
  w: "WEEK",
};

const DURATION_RE = /^(\d+)([smhdw])$/;

/** Returns true if the input looks like an ISO date (starts with YYYY-MM) */
export function isIsoDate(input: string): boolean {
  return /^\d{4}-\d{2}/.test(input);
}

/**
 * Parse a duration string into a ClickHouse INTERVAL expression.
 * Throws if the input is not a valid duration (use isIsoDate to check first).
 */
export function parseDuration(input: string): string {
  const match = input.match(DURATION_RE);
  if (!match) {
    throw new Error(
      `Invalid duration "${input}". Use a number followed by s, m, h, d, or w (e.g. "24h", "7d"), or an ISO date like "2026-04-28".`,
    );
  }
  const amount = match[1]!;
  const unit = UNIT_MAP[match[2]!]!;
  return `${amount} ${unit}`;
}

/**
 * Parse a time boundary (--since or --until) into a ClickHouse SQL expression.
 * Accepts either a relative duration ("1h", "7d") or an ISO date string.
 *
 * For --since: duration → "now() - INTERVAL 1 HOUR", ISO → "'2026-04-28T10:30:00'"
 * For --until: duration → "now() - INTERVAL 1 HOUR", ISO → "'2026-04-28T10:30:00'"
 */
export function parseTimeBoundary(input: string): string {
  if (isIsoDate(input)) {
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`Invalid ISO date "${input}".`);
    }
    // Format as ClickHouse DateTime string (UTC)
    return `'${d.toISOString().replace("T", " ").replace("Z", "")}'`;
  }
  const interval = parseDuration(input);
  return `now() - INTERVAL ${interval}`;
}
