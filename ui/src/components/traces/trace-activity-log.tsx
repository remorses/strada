/**
 * Vertical activity log view of a distributed trace. Each span renders as an
 * expandable row with an icon, name, duration, and child count. Children are
 * revealed recursively with the same style — no left-padding indentation,
 * just nested expandable sections.
 *
 * Accepts the same props as TraceTimeline (rootSpans, services, etc.).
 */
"use client"

import { useState } from "react"
import type { SpanNode } from "../../lib/utils.ts"
import { cn, formatDuration } from "../../lib/utils.ts"
import {
  Eye,
  Globe,
  Server,
  Database,
  Zap,
  ArrowRight,
  Send,
  MessageSquare,
  ChevronDown,
  ChevronRight,
  CircleDot,
  type LucideIcon,
} from "lucide-react"

// ─── Props ──────────────────────────────────────────────────────

export interface TraceActivityLogProps {
  rootSpans: SpanNode[]
  totalDurationMs: number
  traceStartTime: string
  services: string[]
  selectedSpanId?: string
  onSelectSpan?: (span: SpanNode) => void
  className?: string
}

// ─── Icon resolver ──────────────────────────────────────────────

function getSpanIcon(span: SpanNode): LucideIcon {
  const name = span.spanName.toLowerCase()
  const kind = span.spanKind.toLowerCase()
  const attrs = span.spanAttributes

  // Database spans — check attributes first regardless of kind
  if (
    attrs["db.system"] ||
    name.includes("select ") ||
    name.includes("insert ") ||
    name.includes("update ") ||
    name.includes("delete ") ||
    name.includes("db.query") ||
    name.startsWith("d1:") ||
    name.startsWith("kv:")
  ) {
    return Database
  }

  // Messaging / event producers
  if (
    kind.includes("producer") ||
    attrs["messaging.system"] ||
    name.includes(" send") ||
    name.includes(" publish")
  ) {
    return Send
  }

  // Messaging consumers
  if (kind.includes("consumer")) return MessageSquare

  // Pageview / navigation / server routes with http.route
  if (
    name.includes("pageview") ||
    name.includes("page_view") ||
    name.includes("navigation") ||
    (attrs["http.route"]?.startsWith("/") && kind.includes("server"))
  ) {
    return Eye
  }

  // gRPC calls
  if (attrs["rpc.system"]) return Globe

  // External HTTP calls
  if (kind.includes("client")) return Globe
  // Server-side handlers
  if (kind.includes("server")) return Server
  // Known internal spans
  if (kind.includes("internal")) return Zap

  // Fallback for UNSPECIFIED or empty kind
  return CircleDot
}

// ─── Count all descendants ──────────────────────────────────────

function countDescendants(span: SpanNode): number {
  let count = span.children.length
  for (const child of span.children) {
    count += countDescendants(child)
  }
  return count
}

// ─── Single span row ────────────────────────────────────────────

function SpanRow({
  span,
  isFirst,
  defaultExpanded,
  selectedSpanId,
  onSelectSpan,
}: {
  span: SpanNode
  isFirst: boolean
  defaultExpanded?: boolean
  selectedSpanId?: string
  onSelectSpan?: (span: SpanNode) => void
}) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false)
  const hasChildren = span.children.length > 0
  const Icon = getSpanIcon(span)
  const isSelected = selectedSpanId === span.spanId
  const descendantCount = hasChildren ? countDescendants(span) : 0

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => {
          if (hasChildren) setExpanded((v) => !v)
          onSelectSpan?.(span)
        }}
        className={cn(
          "flex items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors",
          "hover:bg-accent/50",
          !isFirst && "border-t border-border",
          isSelected && "bg-accent",
        )}
      >
        {/* Expand chevron or spacer */}
        {hasChildren ? (
          expanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="size-3.5 shrink-0" />
        )}

        {/* Span type icon */}
        <Icon className={cn(
          "size-4 shrink-0",
          span.statusCode === "Error" ? "text-destructive" : "text-muted-foreground",
        )} />

        {/* Span name — truncated */}
        <span className={cn(
          "min-w-0 truncate text-sm font-medium",
          span.statusCode === "Error" && "text-destructive",
        )}>
          {span.spanName}
        </span>

        {/* Duration */}
        <span className="shrink-0 text-xs text-muted-foreground font-mono">
          {formatDuration(span.durationMs)}
        </span>

        {/* Child count badge */}
        {hasChildren && (
          <span className="shrink-0 inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {descendantCount}
          </span>
        )}
      </button>

      {/* Expanded children — recursive, same style, no extra indentation */}
      {expanded && hasChildren && (
        <div className="flex flex-col">
          {span.children.map((child, i) => (
            <SpanRow
              key={child.spanId}
              span={child}
              isFirst={i === 0}
              selectedSpanId={selectedSpanId}
              onSelectSpan={onSelectSpan}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main component ─────────────────────────────────────────────

export function TraceActivityLog({
  rootSpans,
  totalDurationMs,
  traceStartTime,
  services,
  selectedSpanId,
  onSelectSpan,
  className,
}: TraceActivityLogProps) {
  const endTime = new Date(
    new Date(traceStartTime).getTime() + totalDurationMs,
  )

  return (
    <div
      className={cn(
        "flex flex-col rounded-xl border border-border bg-card text-card-foreground overflow-hidden",
        className,
      )}
    >
      {/* Span rows */}
      {rootSpans.map((span, i) => (
        <SpanRow
          key={span.spanId}
          span={span}
          isFirst={i === 0}
          defaultExpanded
          selectedSpanId={selectedSpanId}
          onSelectSpan={onSelectSpan}
        />
      ))}

      {/* Footer — end time + total duration */}
      <div className="flex items-center gap-2 border-t border-border px-3.5 py-2.5 text-xs text-muted-foreground">
        <Globe className="size-3.5 shrink-0" />
        <span className="truncate font-medium">
          {services[0] ?? "unknown"}
        </span>
        <span className="font-mono">
          {endTime.toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          })}
        </span>
        <span>
          lasting {formatDuration(totalDurationMs)}
        </span>
      </div>
    </div>
  )
}
