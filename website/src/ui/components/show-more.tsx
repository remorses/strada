// Collapsible wrapper with gradient mask. Collapses content to a max height
// and shows a "Show more" / "Show less" toggle. The gradient fade hints that
// content continues below the fold.

'use client';

import * as React from 'react';
import { RiArrowDownSLine } from '@remixicon/react';

import { cn } from '../lib/utils.ts';

export type ShowMoreProps = {
  /** Max collapsed height in px. Content taller than this gets a fade + toggle. */
  maxHeight?: number;
  children: React.ReactNode;
  className?: string;
};

export function ShowMore({
  maxHeight = 120,
  children,
  className,
}: ShowMoreProps) {
  const [expanded, setExpanded] = React.useState(false);
  const [needsToggle, setNeedsToggle] = React.useState(false);
  const contentRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (contentRef.current) {
      setNeedsToggle(contentRef.current.scrollHeight > maxHeight);
    }
  }, [maxHeight, children]);

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div
        ref={contentRef}
        className='relative overflow-hidden transition-[max-height] duration-300 ease-in-out'
        style={{
          maxHeight: expanded || !needsToggle ? 'none' : `${maxHeight}px`,
          cursor: !expanded && needsToggle ? 'pointer' : undefined,
        }}
        onClick={() => {
          if (!expanded && needsToggle) setExpanded(true);
        }}
      >
        {children}
        {!expanded && needsToggle && (
          <div
            className='pointer-events-none absolute inset-x-0 bottom-0 h-16'
            style={{
              background:
                'linear-gradient(to top, var(--color-background), transparent)',
            }}
          />
        )}
      </div>
      {needsToggle && (
        <button
          onClick={() => setExpanded(!expanded)}
          className='mx-auto flex cursor-pointer items-center gap-0.5 border-none bg-none px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground'
        >
          <span>{expanded ? 'Show less' : 'Show more'}</span>
          <RiArrowDownSLine
            className={cn(
              'size-4 transition-transform duration-200',
              expanded && 'rotate-180',
            )}
          />
        </button>
      )}
    </div>
  );
}
