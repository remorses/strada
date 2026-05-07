'use client';

import * as React from 'react';

interface UseAnimateNumberProps {
  start: number;
  end: number;
  duration: number;
  onComplete?: () => void;
}

export const useAnimateNumber = ({
  start,
  end,
  duration,
  onComplete,
}: UseAnimateNumberProps) => {
  const [value, setValue] = React.useState(start);
  const animationFrameRef = React.useRef<number | null>(null);
  const startTimeRef = React.useRef<number | null>(null);
  const isAnimatingRef = React.useRef(false);

  const animate = (timestamp: number) => {
    if (!startTimeRef.current) {
      startTimeRef.current = timestamp;
    }

    const progress = Math.min((timestamp - startTimeRef.current) / duration, 1);
    const newValue = Math.floor(progress * (end - start) + start);
    setValue(newValue);

    if (progress < 1) {
      animationFrameRef.current = requestAnimationFrame(animate);
    } else {
      stop();
      onComplete && onComplete();
    }
  };

  const startAnimation = () => {
    if (!isAnimatingRef.current) {
      isAnimatingRef.current = true;
      startTimeRef.current = null;
      animationFrameRef.current = requestAnimationFrame(animate);
    }
  };

  const stop = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      isAnimatingRef.current = false;
    }
  };

  const reset = () => {
    stop();
    setValue(start);
  };

  React.useEffect(() => {
    return () => {
      stop();
    };
  }, [start, end, duration]);

  return {
    value,
    start: startAnimation,
    stop,
    reset,
  };
};
