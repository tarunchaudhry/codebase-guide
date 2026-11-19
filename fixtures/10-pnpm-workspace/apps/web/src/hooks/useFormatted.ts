import { formatPrice } from '@acme/shared';
import { toCents } from '@acme/shared/money';

export function useFormatted(cents: number): string {
  return formatPrice(cents + toCents(0));
}
