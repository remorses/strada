'use client';

import * as React from 'react';

import { cn, useContainerSize } from '../lib/utils.ts';

function ChartSegmentedProgress({
  value,
  max = 100,
  heightClassName,
  segmentSize,
  maskImage,
}: {
  value: number;
  max?: number;
  heightClassName: string;
  segmentSize: number;
  maskImage: string;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const { width } = useContainerSize(containerRef);

  const computedProgress = React.useMemo(() => {
    const progressWidth = (value / max) * width;
    return Math.round(progressWidth / segmentSize) * segmentSize;
  }, [value, max, width, segmentSize]);

  const computedWidth = React.useMemo(() => {
    return Math.round(width / segmentSize) * segmentSize;
  }, [width, segmentSize]);

  return (
    <div ref={containerRef} className='w-full'>
      <div
        className={cn('relative w-full bg-accent', heightClassName)}
        style={{
          WebkitMaskImage: maskImage,
          maskImage,
          maskSize: `${segmentSize}px 100%`,
          maskRepeat: 'space',
          backgroundPosition: '0 0',
          width: computedWidth,
        }}
      >
        <div
          className='h-full [clip-path:inset(0)]'
          style={{
            width: `${computedProgress}px`,
          }}
        >
          <div className='absolute inset-0 bg-primary' />
        </div>
      </div>
    </div>
  );
}

export function ProgressChart({ value }: { value: number }) {
  return (
    <ChartSegmentedProgress
      value={value}
      heightClassName='h-8'
      segmentSize={9}
      maskImage='linear-gradient(90deg, #000 6px, #0000 6px)'
    />
  );
}

export function ProgressChartStockStatus({
  value,
  max = 100,
}: {
  value: number;
  max?: number;
}) {
  return (
    <ChartSegmentedProgress
      value={value}
      max={max}
      heightClassName='h-6'
      segmentSize={10}
      maskImage={`url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='7' height='24' fill='none' viewBox='0 0 7 24'%3E%3Crect width='5.625' height='24' x='.625' fill='%23000' rx='1'/%3E%3C/svg%3E")`}
    />
  );
}
