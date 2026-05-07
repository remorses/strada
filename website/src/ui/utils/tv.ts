import { createTV } from 'tailwind-variants';

import { twMergeConfig } from '@ui/utils/cn.ts';

export type { VariantProps, ClassValue } from 'tailwind-variants';

export const tv = createTV({
  twMergeConfig,
});
