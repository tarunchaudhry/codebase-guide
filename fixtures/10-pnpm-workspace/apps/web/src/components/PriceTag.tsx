import { useFormatted } from '../hooks/useFormatted';

export function PriceTag({ cents }: { cents: number }) {
  const label = useFormatted(cents);
  return <span>{label}</span>;
}
