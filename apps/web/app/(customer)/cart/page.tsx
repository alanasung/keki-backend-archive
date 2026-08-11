import { CartSummary, PageShell, type CartSummaryLine } from '@keki/ui';
import { getSessionResult } from '../../auth/require-session';
import { resolveCart } from './resolve-cart';
import { RemoveLineButton } from './remove-line-button';

// The reviewed subtotal must always reflect the current catalog, never a
// route-cache snapshot — the same reasoning as WS-08's `/book` page.
export const dynamic = 'force-dynamic';

export default async function CartPage() {
  const sessionResult = await getSessionResult();
  const householdId = sessionResult.kind === 'authenticated' ? sessionResult.session.profile.householdId : null;
  const resolved = await resolveCart(householdId);

  const lines: CartSummaryLine[] = resolved.lines.map((resolvedLine) => ({
    id: resolvedLine.id,
    name: resolvedLine.name,
    quantity: resolvedLine.quantity,
    unitPriceCents: resolvedLine.unitPriceCents,
    currency: resolvedLine.currency,
    lineTotalCents: resolvedLine.lineTotalCents,
    available: resolvedLine.available,
    ...(resolvedLine.participantNames !== undefined ? { participantNames: resolvedLine.participantNames } : {}),
    ...(resolvedLine.unavailableReason !== undefined ? { unavailableReason: resolvedLine.unavailableReason } : {}),
    ...(resolvedLine.kind === 'CATALOG_ITEM' && resolvedLine.catalogItemId !== undefined
      ? { action: <RemoveLineButton kind="CATALOG_ITEM" catalogItemId={resolvedLine.catalogItemId} /> }
      : {}),
    ...(resolvedLine.kind === 'OCCURRENCE' && resolvedLine.occurrenceId !== undefined
      ? { action: <RemoveLineButton kind="OCCURRENCE" occurrenceId={resolvedLine.occurrenceId} /> }
      : {}),
  }));

  return (
    <PageShell title="Review your order" description="Confirm your items before checkout.">
      <CartSummary lines={lines} subtotalCents={resolved.subtotalCents} currency={resolved.currency} />
    </PageShell>
  );
}
