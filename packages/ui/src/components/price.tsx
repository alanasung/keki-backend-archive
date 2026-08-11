export interface PriceProps {
  readonly cents: number;
  readonly currency: string;
}

// The only place integer cents are divided by 100. Every caller passes
// cents straight through from the database/contracts layer so there is
// exactly one division, done once, at render time — never accumulated or
// summed as a float.
export function Price({ cents, currency }: PriceProps) {
  const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency });
  return <span>{formatter.format(cents / 100)}</span>;
}
