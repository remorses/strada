// Demo page for dashboard widgets in a bento grid layout.

"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import {
  RiFacebookCircleLine,
  RiFocus2Line,
  RiInstagramLine,
  RiStore2Line,
  RiTimeLine,
  RiUser6Line,
} from '@remixicon/react';
import { Grid } from "./grid.tsx";
import { ThemeToggle } from "./traces-graph/theme-toggle.tsx";
import { SplitColumnsPanel } from "./widgets/split-columns-panel.tsx";
import { MetricRowsPanel } from "./widgets/metric-rows-panel.tsx";
import { BarRankingPanel } from "./widgets/bar-ranking-panel.tsx";
import { BubblePanel } from "./widgets/bubble-panel.tsx";
import { SparkAreaPanel } from "./widgets/spark-area-panel.tsx";
import { DonutPanel } from "./widgets/donut-panel.tsx";
import { ProportionPanel } from "./widgets/proportion-panel.tsx";
import { HeatmapPanel } from "./widgets/heatmap-panel.tsx";
import { ProgressNavPanel } from "./widgets/progress-nav-panel.tsx";
import { SparklinePanel } from "./widgets/sparkline-panel.tsx";
import { GeographyPanel } from "./widgets/geography-panel.tsx";

const demoMonthDate = (startMonthIndex: number, offset: number) =>
  new Date(Date.UTC(2023, startMonthIndex + offset, 1)).toISOString().slice(0, 10);

const sparklineData = Array.from({ length: 40 }, (_, index) => ({
  date: `2024-${String(Math.floor(index / 4) + 1).padStart(2, '0')}-${String((index % 4) * 7 + 1).padStart(2, '0')}`,
  value: 8200 + ((index * 719) % 3900),
}));

const sparklineMetrics = [
  { label: 'Online Store', value: '$52.12', change: '+4.5%', direction: 'up' as const, icon: RiStore2Line },
  { label: 'Facebook', value: '$38.45', change: '-2.8%', direction: 'down' as const, icon: RiFacebookCircleLine },
  { label: 'Instagram', value: '$37.75', change: '+3.2%', direction: 'up' as const, icon: RiInstagramLine },
];

const splitColumnsData = [
  { label: 'Desktop', value: '27%', numericValue: 27, change: '-3.2%', direction: 'down' as const, colorClassName: 'bg-yellow-500' },
  { label: 'Tablet', value: '12%', numericValue: 12, change: '-6.4%', direction: 'down' as const, colorClassName: 'bg-sky-500' },
  { label: 'Mobile', value: '61%', numericValue: 61, change: '+0.8%', direction: 'up' as const, colorClassName: 'bg-purple-500' },
];

const metricRowsData = [
  { label: 'Added to Cart', value: '3,842', change: '+1.8%', direction: 'up' as const },
  { label: 'Reached Checkout', value: '1,256', change: '-1.2%', direction: 'down' as const },
  { label: 'Purchased', value: '649', change: '+2.4%', direction: 'up' as const },
];

const metricRowsChartData = Array.from({ length: 18 }, (_, index) => {
  const value1 = 10 + ((index * 17) % 46);
  const value2 = value1 + 18 + (index % 5) * 3;
  return {
    date: demoMonthDate(5, index),
    value1,
    value2,
    value2Background: value2,
  };
});

const barRankingData = {
  '1d': [
    { value: 50, label: 'A' },
    { value: 80, label: 'B' },
    { value: 100, label: 'C' },
    { value: 60, label: 'D' },
    { value: 40, label: 'E' },
  ],
  '1w': [
    { value: 30, label: 'A' },
    { value: 70, label: 'B' },
    { value: 80, label: 'C' },
    { value: 20, label: 'D' },
    { value: 60, label: 'E' },
  ],
  '1m': [
    { value: 70, label: 'A' },
    { value: 10, label: 'B' },
    { value: 100, label: 'C' },
    { value: 80, label: 'D' },
    { value: 0, label: 'E' },
  ],
  '3m': [
    { value: 25, label: 'A' },
    { value: 45, label: 'B' },
    { value: 60, label: 'C' },
    { value: 80, label: 'D' },
    { value: 40, label: 'E' },
  ],
  '1y': [
    { value: 50, label: 'A' },
    { value: 80, label: 'B' },
    { value: 70, label: 'C' },
    { value: 88, label: 'D' },
    { value: 55, label: 'E' },
  ],
};

const barRankingStats = [
  { label: 'Avg. Rating', value: '4.7' },
  { label: 'Satisfaction', value: '92%' },
  { label: 'Return Rate', value: '4.2%' },
];

const proportionData = [
  { label: 'Organic Search', value: 45 },
  { label: 'Social Media', value: 40 },
  { label: 'Direct', value: 15 },
];

const proportionRows = [
  { label: 'Acquisition', value: '$38.25', change: '+5.2%', direction: 'up' as const, icon: RiUser6Line },
  { label: 'Conversion', value: '4.2 days', change: '+3.8%', direction: 'down' as const, icon: RiTimeLine },
  { label: 'ROI', value: '324%', change: '+4.5%', direction: 'up' as const, icon: RiFocus2Line },
];

const bubbleData = [
  {
    category: 'Europe',
    label: 'Europe',
    percentage: 48,
    value: '15.8M',
    change: '+4.7%',
    direction: 'up' as const,
    color: 'color-mix(in srgb, var(--color-primary) 24%, transparent)',
    textColor: '#71330a',
    dotClassName: 'bg-primary',
  },
  {
    category: 'Asia',
    label: 'Asia',
    percentage: 32,
    value: '10.2M',
    change: '-6.2%',
    direction: 'down' as const,
    color: 'color-mix(in srgb, var(--color-warning) 24%, transparent)',
    textColor: 'var(--color-yellow-950)',
    dotClassName: 'bg-yellow-500',
  },
  {
    category: 'Americas',
    label: 'Americas',
    percentage: 20,
    value: '6.6M',
    change: '+3.8%',
    direction: 'up' as const,
    color: 'color-mix(in srgb, var(--color-success) 24%, transparent)',
    textColor: '#0b4627',
    dotClassName: 'bg-success',
  },
];

const donutData = [
  { id: 'premium', label: 'Premium', fillClassName: 'fill-primary', dotClassName: 'bg-primary', value: 6450 },
  { id: 'regular', label: 'Regular', fillClassName: 'fill-yellow-500', dotClassName: 'bg-yellow-500', value: 5320 },
  { id: 'new', label: 'New', fillClassName: 'fill-success', dotClassName: 'bg-success', value: 3280 },
  { id: 'others', label: 'Others', fillClassName: 'fill-muted', dotClassName: 'bg-muted', value: 2880, hiddenFromLegend: true },
];

const progressNavData = [
  { id: '70d9', label: 'Accessories', value: 58, detailLabel: 'products', detailValue: '45', change: '+3.2%', badge: '+2.1%', description: 'vs last week' },
  { id: '477b', label: 'Wearables', value: 40, detailLabel: 'products', detailValue: '32', change: '+2.8%', badge: '+1.5%', description: 'vs last week' },
  { id: '9cf3', label: 'Smart Home', value: 15, detailLabel: 'products', detailValue: '18', change: '+4.5%', badge: '+3.2%', description: 'vs last week' },
];

const sparkAreaData = Array.from({ length: 18 }, (_, index) => ({
  date: demoMonthDate(5, index),
  value: 22 + ((index * 13) % 29),
}));

const heatmapData = Array.from({ length: 12 }, (_, rowIndex) =>
  Array.from({ length: 12 - rowIndex }, (_, colIndex) =>
    Math.max(42, 96 - rowIndex * 4 - colIndex * 3),
  ),
);

const geographyData = [
  { id: 1, lat: 41.0082, lng: 28.9784, value: 1500, label: 'Turkey', icon: '🇹🇷', demographics: [{ label: 'Men', value: 32 }, { label: 'Women', value: 60 }, { label: 'Other', value: 8 }] },
  { id: 2, lat: 48.8566, lng: 2.3522, value: 800, label: 'France', icon: '🇫🇷', demographics: [{ label: 'Men', value: 45 }, { label: 'Women', value: 50 }, { label: 'Other', value: 5 }] },
  { id: 3, lat: 51.5074, lng: -0.1278, value: 1200, label: 'United Kingdom', icon: '🇬🇧', demographics: [{ label: 'Men', value: 48 }, { label: 'Women', value: 47 }, { label: 'Other', value: 5 }] },
  { id: 4, lat: 52.52, lng: 13.405, value: 900, label: 'Germany', icon: '🇩🇪', demographics: [{ label: 'Men', value: 42 }, { label: 'Women', value: 53 }, { label: 'Other', value: 5 }] },
  { id: 5, lat: 45.4642, lng: 9.19, value: 600, label: 'Italy', icon: '🇮🇹', demographics: [{ label: 'Men', value: 38 }, { label: 'Women', value: 55 }, { label: 'Other', value: 7 }] },
];

export function WidgetsGridDemoPage() {
  return (
    <TooltipPrimitive.Provider>
    <div className="flex w-full flex-col items-center gap-10 overflow-x-clip">
      <div className="flex w-full max-w-[1300px] items-center justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-bold tracking-tight">Widgets</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            Dashboard widget components in a bento grid. Each widget is a generic building block with data passed as props.
          </p>
        </div>
        <ThemeToggle />
      </div>

      <div className="relative w-full max-w-[1300px] pb-10">
        <div aria-hidden className="absolute left-1/2 top-0 h-px w-screen -translate-x-1/2 bg-border" />
        <Grid columns={12} rows={8} rowHeight={200} cellPadding={34} lines>
          <Grid.LineExtensions />

          <Grid.Item columnSpan={8} rowSpan={2}>
            <WidgetPanel>
              <SparklinePanel
                title='Total Sales'
                value='$128.32'
                badge='+2%'
                actionLabel='Report'
                data={sparklineData}
                metrics={sparklineMetrics}
              />
            </WidgetPanel>
          </Grid.Item>

          <Grid.Item columnSpan={4} rowSpan={2}>
            <WidgetPanel>
              <SplitColumnsPanel
                title='Total Visitors'
                value='237,456'
                badge='-1.4%'
                badgeColor='red'
                actionLabel='Report'
                data={splitColumnsData}
              />
            </WidgetPanel>
          </Grid.Item>

          <Grid.Item columnSpan={4} rowSpan={2}>
            <WidgetPanel>
              <MetricRowsPanel
                title='Conversion Rate'
                value='16.9%'
                badge='+2.1%'
                actionLabel='Details'
                data={metricRowsData}
                chartData={metricRowsChartData}
              />
            </WidgetPanel>
          </Grid.Item>

          <Grid.Item columnSpan={4} rowSpan={2}>
            <WidgetPanel>
              <BarRankingPanel
                title='Product Performance'
                value='22.8%'
                badge='+8.4%'
                actionLabel='Details'
                data={barRankingData}
                stats={barRankingStats}
              />
            </WidgetPanel>
          </Grid.Item>

          <Grid.Item columnSpan={4} rowSpan={2}>
            <WidgetPanel>
              <ProportionPanel
                title='Marketing Channels'
                value='82%'
                badge='+2.1%'
                description='vs last week'
                tooltip={
                  <>
                    Overview of your marketing channel performance metrics,
                    including customer acquisition cost, conversion time and ROI.
                  </>
                }
                actionLabel='Details'
                data={proportionData}
                rows={proportionRows}
                footerActionLabel='View reports'
                categoryBarClassName='h-3'
                dashedDividerClassName='h-1'
              />
            </WidgetPanel>
          </Grid.Item>

          <Grid.Item columnSpan={4} rowSpan={2}>
            <WidgetPanel>
              <BubblePanel
                title='Real-time Visitors'
                value='32.6M'
                badge='+8.4%'
                actionLabel='Details'
                data={bubbleData}
              />
            </WidgetPanel>
          </Grid.Item>

          <Grid.Item columnSpan={4} rowSpan={2}>
            <WidgetPanel>
              <DonutPanel
                title='Customer Segments'
                badge='+5.8%'
                description='vs last week'
                tooltip={
                  <>
                    Overview of customer types based on their purchasing behavior
                    and value to the business.
                  </>
                }
                data={donutData}
              />
              <div className="h-px w-full bg-border" />
              <ProgressNavPanel
                title='Product Categories'
                actionLabel='Details'
                tooltip={
                  <>
                    Distribution of your store&apos;s product inventory across
                    different categories, showing total products and growth rate per
                    category.
                  </>
                }
                data={progressNavData}
              />
            </WidgetPanel>
          </Grid.Item>

          <Grid.Item columnSpan={4} rowSpan={1}>
            <WidgetPanel>
              <SparkAreaPanel
                title='Campaign Data'
                value='$1,750'
                badge='Last 15 days'
                actionLabel='Details'
                tooltip={
                  <>
                    Monitor your campaign&apos;s budget spending. Track remaining budget and
                    ensure efficient allocation for optimal campaign performance.
                  </>
                }
                data={sparkAreaData}
                usageValue='45%'
                usageLabel='$32.9K used'
              />
            </WidgetPanel>
          </Grid.Item>

          <Grid.Item columnSpan={4} rowSpan={2}>
            <WidgetPanel>
              <HeatmapPanel
                title='User Retention'
                value='24%'
                badge='+2.0%'
                actionLabel='Details'
                data={heatmapData}
                labels={Array.from({ length: 12 }, (_, i) => i + 1)}
                caption='Last 12 months data updated at 1:51 PM.'
              />
            </WidgetPanel>
          </Grid.Item>

          <Grid.Item columnSpan={4} rowSpan={2}>
            <WidgetPanel>
              <GeographyPanel
                title='Geography'
                actionLabel='Details'
                data={geographyData}
                initialHighlightedId={1}
              />
            </WidgetPanel>
          </Grid.Item>
        </Grid>
      </div>
    </div>
    </TooltipPrimitive.Provider>
  );
}

function WidgetPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col gap-4">
      {children}
    </div>
  );
}
