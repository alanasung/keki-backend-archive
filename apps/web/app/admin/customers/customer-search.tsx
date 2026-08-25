import { FormField } from '@keki/ui';

export interface CustomerSearchProps {
  readonly defaultValue?: string;
}

// A plain GET form to this same page, not a client island: the result of a
// search is a URL, which is the point — a staff member can send a colleague
// a link to a search or a selected household (see household-detail.tsx and
// apps/web/app/admin/reservations/page.tsx for the same searchParams-driven
// linkable-selection pattern).
export function CustomerSearch({ defaultValue }: CustomerSearchProps) {
  return (
    <form method="get" action="/admin/customers" className="flex items-end gap-2">
      <FormField label="Search customers" htmlFor="customer-search-q" hint="Search by email or name.">
        <input
          id="customer-search-q"
          name="q"
          type="search"
          defaultValue={defaultValue}
          placeholder="ada@example.com or Lovelace"
          className="rounded-lg border border-surface-300 px-3 py-2 text-sm text-surface-900"
        />
      </FormField>
      <button
        type="submit"
        className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-600"
      >
        Search
      </button>
    </form>
  );
}
