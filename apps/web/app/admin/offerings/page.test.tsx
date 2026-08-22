// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOfferingId, type Offering } from '@keki/contracts';

const { mockListOfferings, mockPublishOfferingAction, mockUnpublishOfferingAction, mockArchiveOfferingAction } =
  vi.hoisted(() => ({
    mockListOfferings: vi.fn(),
    mockPublishOfferingAction: vi.fn(),
    mockUnpublishOfferingAction: vi.fn(),
    mockArchiveOfferingAction: vi.fn(),
  }));

vi.mock('@keki/catalog-admin', () => ({ listOfferings: mockListOfferings }));
vi.mock('../actions/offering-actions', () => ({
  createOfferingAction: vi.fn(),
  updateOfferingAction: vi.fn(),
  publishOfferingAction: mockPublishOfferingAction,
  unpublishOfferingAction: mockUnpublishOfferingAction,
  archiveOfferingAction: mockArchiveOfferingAction,
}));

import { OfferingRow } from './offering-row';
import AdminOfferingsPage from './page';

function offeringFixture(overrides: Partial<Offering> = {}): Offering {
  return {
    id: createOfferingId(crypto.randomUUID()),
    slug: 'yoga-101',
    type: 'CLASS',
    status: 'DRAFT',
    name: 'Yoga 101',
    description: null,
    durationMinutes: 60,
    defaultCapacity: 10,
    priceCents: 4500,
    currency: 'USD',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('AdminOfferingsPage', () => {
  beforeEach(() => {
    mockListOfferings.mockReset();
  });

  // Test 5 — SC-13.
  it('renders every offering with its status badge', async () => {
    mockListOfferings.mockResolvedValue([
      offeringFixture({ name: 'Draft Class', status: 'DRAFT' }),
      offeringFixture({ name: 'Published Class', status: 'PUBLISHED' }),
      offeringFixture({ name: 'Archived Class', status: 'ARCHIVED' }),
    ]);

    render(await AdminOfferingsPage());

    expect(screen.getByText('Draft Class')).toBeInTheDocument();
    expect(screen.getByText('Published Class')).toBeInTheDocument();
    expect(screen.getByText('Archived Class')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Published')).toBeInTheDocument();
    expect(screen.getByText('Archived')).toBeInTheDocument();
  });

  // Test 6
  it('sorts drafts before published before archived', async () => {
    mockListOfferings.mockResolvedValue([
      offeringFixture({ name: 'Archived Class', status: 'ARCHIVED' }),
      offeringFixture({ name: 'Published Class', status: 'PUBLISHED' }),
      offeringFixture({ name: 'Draft Class', status: 'DRAFT' }),
    ]);

    render(await AdminOfferingsPage());

    const headings = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual(['Draft Class', 'Published Class', 'Archived Class']);
  });

  // Test 7
  it('renders an empty state for an empty catalog rather than a bare heading', async () => {
    mockListOfferings.mockResolvedValue([]);

    render(await AdminOfferingsPage());

    expect(screen.getByRole('status')).toHaveTextContent(/no offerings yet/i);
  });

  // Test 8
  it('renders price from cents via Price', async () => {
    mockListOfferings.mockResolvedValue([offeringFixture({ priceCents: 4500, currency: 'USD' })]);

    render(await AdminOfferingsPage());

    expect(screen.getByText('$45.00')).toBeInTheDocument();
  });

  it('does not render the placeholder panel', async () => {
    mockListOfferings.mockResolvedValue([]);

    render(await AdminOfferingsPage());

    expect(screen.queryByText(/not built yet/i)).not.toBeInTheDocument();
  });
});

describe('OfferingRow', () => {
  beforeEach(() => {
    mockPublishOfferingAction.mockReset();
    mockUnpublishOfferingAction.mockReset();
    mockArchiveOfferingAction.mockReset();
  });

  // Test 15
  it('offers Publish and Archive for a draft, and no Unpublish', () => {
    render(<OfferingRow offering={offeringFixture({ status: 'DRAFT' })} />);

    expect(screen.getByRole('button', { name: 'Publish' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unpublish' })).not.toBeInTheDocument();
  });

  // Test 16
  it('offers Unpublish and Archive for a published offering, and no Publish', () => {
    render(<OfferingRow offering={offeringFixture({ status: 'PUBLISHED' })} />);

    expect(screen.getByRole('button', { name: 'Unpublish' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
  });

  // Test 17
  it('offers no transition controls for an archived offering', () => {
    render(<OfferingRow offering={offeringFixture({ status: 'ARCHIVED' })} />);

    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unpublish' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
  });

  // Test 18
  it('calls the publish action with the offering id, and sends no status', async () => {
    const offering = offeringFixture({ status: 'DRAFT' });
    mockPublishOfferingAction.mockResolvedValue({ ok: true, data: offering });

    render(<OfferingRow offering={offering} />);
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() => {
      expect(mockPublishOfferingAction).toHaveBeenCalledWith({ offeringId: offering.id });
    });
  });

  // Test 19
  it('states next to the Publish control what publishing does', () => {
    render(<OfferingRow offering={offeringFixture({ status: 'DRAFT' })} />);

    expect(screen.getByText(/customer booking page/i)).toBeInTheDocument();
  });

  // Test 20
  it('asks for confirmation before archiving', async () => {
    const offering = offeringFixture({ status: 'DRAFT' });
    mockArchiveOfferingAction.mockResolvedValue({ ok: true, data: offering });

    render(<OfferingRow offering={offering} />);
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));

    expect(mockArchiveOfferingAction).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Confirm archive' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm archive' }));

    await waitFor(() => {
      expect(mockArchiveOfferingAction).toHaveBeenCalledWith({ offeringId: offering.id });
    });
  });

  // Test 21
  it('surfaces a CONFLICT error from a transition rather than failing silently', async () => {
    const offering = offeringFixture({ status: 'DRAFT' });
    mockPublishOfferingAction.mockResolvedValue({
      ok: false,
      error: { code: 'CONFLICT', message: 'That class was already archived.' },
    });

    render(<OfferingRow offering={offering} />);
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    expect(await screen.findByText('That class was already archived.')).toBeInTheDocument();
  });
});
