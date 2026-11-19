/** Format an amount in cents as a currency string. */
export function formatPrice(cents: number, currency = 'USD'): string {
  const locale = process.env.DEFAULT_LOCALE ?? 'en-US';
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
}
