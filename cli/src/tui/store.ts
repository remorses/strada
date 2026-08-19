// TUI global state — zustand store, types, constants, and useStore hook.
// Persisted via termcast Cache (sync SQLite) so selections survive restarts.

import { Cache, Icon } from "termcast";
import { useSyncExternalStore } from "react";
import { createStore } from "zustand/vanilla";

// ── Constants ─────────────────────────────────────────────────────

// Icon and Color are Record<string, string> at the type level, so direct access
// returns string|undefined in strict mode. These aliases guarantee string values.
export const ICON = {
  bug: Icon.Bug ?? "🐛",
  terminal: Icon.Terminal ?? "📋",
  network: Icon.Network ?? "🔗",
  barChart: Icon.BarChart ?? "📊",
  circleFilled: Icon.CircleFilled ?? "●",
  circle: Icon.Circle ?? "○",
  checkCircle: Icon.CheckCircle ?? "✓",
  eye: Icon.Eye ?? "👁",
  arrowClockwise: Icon.ArrowClockwise ?? "↻",
  speakerOff: Icon.SpeakerOff ?? "🔇",
  document: Icon.Document ?? "📄",
  globe: Icon.Globe ?? "🌐",
  link: Icon.Link ?? "🔗",
  bolt: Icon.Bolt ?? "⚡",
} as const;

export type TuiView = "issues" | "analytics" | "logs" | "traces";

export const VIEW_OPTIONS: { id: TuiView; label: string; icon: string }[] = [
  { id: "issues", label: "Issues", icon: ICON.bug },
  { id: "logs", label: "Logs", icon: ICON.terminal },
  { id: "traces", label: "Traces", icon: ICON.network },
  { id: "analytics", label: "Analytics", icon: ICON.barChart },
];

// ── Zustand store ─────────────────────────────────────────────────

export interface TuiState {
  view: TuiView;
  projectId: string | null;
  projectSlug: string | null;
  service: string | null;
  /** Last SQL query execution time in ms (transient, not persisted) */
  lastQueryMs: number | null;
  /** Last AI filter generation time in ms (transient, not persisted) */
  lastAiMs: number | null;
  /** Last AI-generated SQL clause summary (transient, shown in title) */
  lastAiSql: string | null;
}

// The CLI initializes Termcast before importing this module.
const cache = new Cache({ namespace: "strada-tui" });

function loadPersistedState(): Partial<TuiState> {
  const raw = cache.get("state");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Partial<TuiState>;
  } catch {
    return {};
  }
}

const persisted = loadPersistedState();

export const store = createStore<TuiState>(() => ({
  view: persisted.view ?? "issues",
  projectId: persisted.projectId ?? null,
  projectSlug: persisted.projectSlug ?? null,
  service: persisted.service ?? null,
  lastQueryMs: null,
  lastAiMs: null,
  lastAiSql: null,
}));

// Persist every state change synchronously. Timing fields are transient
// (reset on restart) so they're excluded from the cache.
store.subscribe((state) => {
  const { lastQueryMs: _, lastAiMs: __, lastAiSql: ___, ...persisted } = state;
  cache.set("state", JSON.stringify(persisted));
});

export function useStore<T>(selector: (s: TuiState) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
  );
}
