'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';

import * as Button from '@/components/alignui/button';
import { WidgetCard } from '@/components/widget-card';

if (typeof window !== 'undefined') {
  void import('leaflet/dist/leaflet.css');
}

const GeographyMap = dynamic(() => import('./widget-geography-map'), {
  ssr: false,
});

export interface LocationData {
  id: number;
  lat: number;
  lng: number;
  count: number;
  country: {
    name: string;
    flag: string;
  };
  demographics: {
    men: number;
    women: number;
    other: number;
  };
}

const geographyData: LocationData[] = [
  {
    id: 1,
    lat: 41.0082,
    lng: 28.9784,
    count: 1500,
    country: {
      name: 'Turkey',
      flag: '/flags/TR.svg',
    },
    demographics: {
      men: 32,
      women: 60,
      other: 8,
    },
  },
  {
    id: 2,
    lat: 48.8566,
    lng: 2.3522,
    count: 800,
    country: {
      name: 'France',
      flag: '/flags/FR.svg',
    },
    demographics: {
      men: 45,
      women: 50,
      other: 5,
    },
  },
  {
    id: 3,
    lat: 51.5074,
    lng: -0.1278,
    count: 1200,
    country: {
      name: 'United Kingdom',
      flag: '/flags/GB.svg',
    },
    demographics: {
      men: 48,
      women: 47,
      other: 5,
    },
  },
  {
    id: 4,
    lat: 52.52,
    lng: 13.405,
    count: 900,
    country: {
      name: 'Germany',
      flag: '/flags/DE.svg',
    },
    demographics: {
      men: 42,
      women: 53,
      other: 5,
    },
  },
  {
    id: 5,
    lat: 45.4642,
    lng: 9.19,
    count: 600,
    country: {
      name: 'Italy',
      flag: '/flags/IT.svg',
    },
    demographics: {
      men: 38,
      women: 55,
      other: 7,
    },
  },
];

const initialHighlightedId = 1;

export function WidgetGeography() {
  const [highlightedId, setHighlightedId] = React.useState<number>(
    initialHighlightedId ?? geographyData[0].id,
  );
  const highlightedLocation = geographyData.find(
    (location) => location.id === highlightedId,
  )!;

  return (
    <WidgetCard className='h-full gap-4'>
      <div className='flex items-start gap-2'>
        <div className='flex-1'>
          <div className='text-sm font-medium text-muted-foreground'>Geography</div>
          <div className='mt-1 flex items-center gap-2'>
            <div className='text-2xl font-medium text-foreground'>
              {highlightedLocation.count.toLocaleString()}
            </div>
            <div className='flex h-6 items-center gap-1 rounded-md bg-background pl-1 pr-2 ring-1 ring-inset ring-border'>
              <img
                src={highlightedLocation.country.flag}
                alt=''
                className='size-4 shrink-0'
                width={16}
                height={16}
              />
              <span className='text-xs font-medium text-muted-foreground'>
                {highlightedLocation.country.name}
              </span>
            </div>
          </div>
        </div>
        <Button.Root variant='neutral' mode='stroke' size='xxsmall'>
          Details
        </Button.Root>
      </div>

      <div className='flex h-7 w-full items-center gap-[3px] rounded-lg bg-background px-1.5 shadow-xs ring-1 ring-inset ring-border'>
        <div className='flex-1 text-center text-xs font-medium text-foreground/40'>
          Men{' '}
          <span className='text-muted-foreground'>
            {highlightedLocation.demographics.men}%
          </span>
        </div>
        <div className='text-xs font-medium text-foreground/25'>·</div>
        <div className='flex-1 text-center text-xs font-medium text-foreground/40'>
          Women{' '}
          <span className='text-muted-foreground'>
            {highlightedLocation.demographics.women}%
          </span>
        </div>
        <div className='text-xs font-medium text-foreground/25'>·</div>
        <div className='flex-1 text-center text-xs font-medium text-foreground/40'>
          Other{' '}
          <span className='text-muted-foreground'>
            {highlightedLocation.demographics.other}%
          </span>
        </div>
      </div>

      <div className='relative min-h-[224px] flex-1'>
        <GeographyMap
          highlightedId={highlightedId}
          setHighlightedId={setHighlightedId}
          data={geographyData}
        />
      </div>
    </WidgetCard>
  );
}
