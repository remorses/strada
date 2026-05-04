// Demo page for the compound Grid component and page-level grid line extensions.

import { Activity, Bug, Clock, Database, Globe, Server, ShieldCheck } from "lucide-react";
import type * as React from "react";

import { Grid } from "./grid.tsx";
import { ThemeToggle } from "./traces-graph/theme-toggle.tsx";
import { cn } from "../lib/utils.ts";

export function GridDemoPage() {
  return (
    <div className="flex w-full flex-col items-center gap-10 overflow-hidden">
      <div className="flex w-full max-w-6xl items-center justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-bold tracking-tight">Grid</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            Compound bento layout with CSS grid tracks, border-colored lattice lines, and foreground vertex dots.
          </p>
        </div>
        <ThemeToggle />
      </div>

      <div className="relative w-full max-w-6xl">
        <div aria-hidden className="absolute left-1/2 top-0 h-px w-screen -translate-x-1/2 bg-border" />
        <div aria-hidden className="absolute bottom-0 left-1/2 h-px w-screen -translate-x-1/2 bg-border" />
        <div aria-hidden className="absolute left-0 top-0 h-10 w-px -translate-y-full bg-border" />
        <div aria-hidden className="absolute right-0 top-0 h-10 w-px -translate-y-full bg-border" />
        <div aria-hidden className="absolute bottom-0 left-0 h-10 w-px translate-y-full bg-border" />
        <div aria-hidden className="absolute bottom-0 right-0 h-10 w-px translate-y-full bg-border" />
        <Grid columns={12} rows={4} rowHeight={112} cellPadding={32} lines>
          <Grid.Item columnSpan={5} rowSpan={2}>
            <DemoPanel className="h-full justify-between">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Globe className="size-4" />
                Browser analytics
              </div>
              <div className="flex flex-col gap-3">
                <div className="text-4xl font-semibold tracking-tight">18.4k</div>
                <p className="text-sm leading-6 text-muted-foreground">Pageviews grouped by route, referrer, country, and session.</p>
              </div>
            </DemoPanel>
          </Grid.Item>

          <Grid.Item columnSpan={3}>
            <MetricPanel icon={<Bug className="size-4" />} label="Open issues" value="12" />
          </Grid.Item>

          <Grid.Item columnSpan={4} rowSpan={2}>
            <DemoPanel className="h-full">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Activity className="size-4" />
                Latency shape
              </div>
              <div className="mt-auto flex h-24 items-end gap-2">
                {[32, 58, 46, 78, 52, 88, 64, 40].map((height, index) => (
                  <div key={index} className="flex-1 rounded-t-sm bg-foreground/80" style={{ height }} />
                ))}
              </div>
            </DemoPanel>
          </Grid.Item>

          <Grid.Item columnSpan={3}>
            <MetricPanel icon={<Clock className="size-4" />} label="p95 latency" value="184ms" />
          </Grid.Item>

          <Grid.Item columnSpan={4} rowSpan={2}>
            <DemoPanel className="h-full">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Server className="size-4" />
                Services
              </div>
              <div className="grid gap-3 text-sm">
                {['web', 'api', 'worker'].map((service) => (
                  <div key={service} className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2">
                    <span>{service}</span>
                    <span className="text-muted-foreground">healthy</span>
                  </div>
                ))}
              </div>
            </DemoPanel>
          </Grid.Item>

          <Grid.Item columnSpan={4} rowSpan={2}>
            <DemoPanel className="h-full">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Database className="size-4" />
                Recent logs
              </div>
              <div className="font-mono text-xs leading-6 text-muted-foreground">
                <div>INFO ingest accepted 128 rows</div>
                <div>WARN checkout retry attempt=2</div>
                <div>INFO alert window evaluated</div>
              </div>
            </DemoPanel>
          </Grid.Item>

          <Grid.Item columnSpan={4} rowSpan={2}>
            <MetricPanel icon={<ShieldCheck className="size-4" />} label="Error budget" value="99.94%" />
          </Grid.Item>
        </Grid>
      </div>
    </div>
  );
}

function DemoPanel({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-4 rounded-2xl", className)} {...props} />;
}

function MetricPanel({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <DemoPanel className="h-full justify-between">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="text-2xl font-semibold tracking-tight">{value}</div>
    </DemoPanel>
  );
}
