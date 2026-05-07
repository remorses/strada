// Generic progress panel with previous/next navigation across data items.

'use client';

import * as React from 'react';
import NumberFlow from '@number-flow/react';
import { RiArrowLeftSLine, RiArrowRightSLine } from '@remixicon/react';

import { cn } from '@ui/utils/cn.ts';
import { useAnimateNumber } from '@ui/hooks/use-animate-number.ts';
import { ProgressChart } from '@ui/components/progress-chart.tsx';
import { WidgetHeader } from '@ui/components/widget-card.tsx';

export type ProgressNavPanelDataItem = {
  id: string;
  label: string;
  value: number;
  detailLabel: string;
  detailValue: string;
  change: string;
  badge?: React.ReactNode;
  description?: React.ReactNode;
};

export type ProgressNavPanelProps = Pick<
  React.ComponentProps<typeof WidgetHeader>,
  'title' | 'badgeColor' | 'tooltip' | 'actionLabel' | 'action'
> & {
  data: ProgressNavPanelDataItem[];
  defaultIndex?: number;
  valueSuffix?: string;
};

export function ProgressNavPanel({
  title,
  badgeColor,
  tooltip,
  actionLabel,
  action,
  data,
  defaultIndex = 0,
  valueSuffix = '%',
}: ProgressNavPanelProps) {
  const [currentIndex, setCurrentIndex] = React.useState(defaultIndex);
  const initialRenderRef = React.useRef(true);
  const prevValueRef = React.useRef(0);

  const activeItem = data[currentIndex]!;

  const handlePrevious = () => {
    setCurrentIndex((prev) =>
      prev === 0 ? data.length - 1 : prev - 1,
    );
  };

  const handleNext = () => {
    setCurrentIndex((prev) =>
      prev === data.length - 1 ? 0 : prev + 1,
    );
  };

  const animateNumber = useAnimateNumber({
    start: prevValueRef.current,
    end: activeItem.value,
    duration: initialRenderRef.current ? 1250 : 300,
    onComplete: () => {
      prevValueRef.current = activeItem.value;
      initialRenderRef.current = false;
    },
  });

  React.useEffect(() => {
    if (activeItem.value) {
      animateNumber.start();
    } else {
      animateNumber.reset();
    }
  }, [activeItem]);

  return (
    <>
      <WidgetHeader
        title={title}
        value={<NumberFlow value={activeItem.value} suffix={valueSuffix} />}
        badge={activeItem.badge}
        badgeColor={badgeColor}
        description={activeItem.description}
        tooltip={tooltip}
        actionLabel={actionLabel}
        action={action}
      />

      <div className='mt-3.5'>
        <ProgressChart value={animateNumber.value} />
      </div>

      <div className='mt-3 flex items-center justify-between'>
        <div className='flex items-center gap-2'>
          <div className='whitespace-nowrap text-sm font-medium text-muted-foreground'>
            {activeItem.label}
          </div>

          <div className='flex'>
            <button
              type='button'
              onClick={handlePrevious}
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-l-md bg-background ring-1 ring-inset ring-border',
                'transition duration-200 ease-out',
                'hover:bg-muted',
                'focus:outline-hidden focus-visible:bg-muted',
              )}
            >
              <RiArrowLeftSLine className='size-[18px] text-muted-foreground' />
            </button>
            <button
              type='button'
              onClick={handleNext}
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-r-md bg-background ring-1 ring-inset ring-border',
                'transition duration-200 ease-out',
                'hover:bg-muted',
                'focus:outline-hidden focus-visible:bg-muted',
              )}
            >
              <RiArrowRightSLine className='size-[18px] text-muted-foreground' />
            </button>
          </div>
        </div>

        <div className='flex items-center gap-2'>
          <div className='text-sm font-medium text-muted-foreground'>
            {activeItem.detailValue} {activeItem.detailLabel}
          </div>
          <div className='text-xs font-medium text-foreground/40'>·</div>
          <div className='text-sm font-medium text-success'>
            {activeItem.change}
          </div>
        </div>
      </div>
    </>
  );
}
