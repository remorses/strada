// Color helpers for stable string-to-color mappings in low-cardinality UI
// values such as services, routes, browsers, and statuses.

export interface HashBadgeColor {
  dot: string;
}

const HASH_BADGE_COLORS: HashBadgeColor[] = [
  { dot: "#2563eb" },
  { dot: "#0d9488" },
  { dot: "#059669" },
  { dot: "#ca8a04" },
  { dot: "#ea580c" },
  { dot: "#e11d48" },
  { dot: "#9333ea" },
  { dot: "#4f46e5" },
  { dot: "#0284c7" },
  { dot: "#65a30d" },
];

export function getHashBadgeColor(value: string): HashBadgeColor {
  return HASH_BADGE_COLORS[hashString(value) % HASH_BADGE_COLORS.length]!;
}

export function hashString(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
