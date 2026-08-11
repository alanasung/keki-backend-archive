import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ParticipantChecklist, type ParticipantChecklistOption } from './participant-checklist';

const OPTIONS: readonly ParticipantChecklistOption[] = [
  { id: 'CUSTOMER:1', displayName: 'Ada Lovelace' },
  { id: 'CHILD:2', displayName: 'Grace Hopper Jr.' },
  { id: 'CHILD:3', displayName: 'Alan Kay Jr.' },
];

describe('ParticipantChecklist', () => {
  it('renders exactly the given options and none other', () => {
    render(<ParticipantChecklist options={OPTIONS} selectedIds={[]} onToggle={vi.fn()} />);

    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('Grace Hopper Jr.')).toBeInTheDocument();
    expect(screen.getByText('Alan Kay Jr.')).toBeInTheDocument();
  });

  it('renders a single account-holder option rather than an empty state when there are no children', () => {
    render(
      <ParticipantChecklist
        options={[{ id: 'CUSTOMER:1', displayName: 'Ada Lovelace' }]}
        selectedIds={[]}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('derives the seat count from the selection and never renders a quantity input', () => {
    render(<ParticipantChecklist options={OPTIONS} selectedIds={['CUSTOMER:1', 'CHILD:2']} onToggle={vi.fn()} />);

    expect(screen.getByText('2 seats selected')).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('checks the boxes matching selectedIds', () => {
    render(<ParticipantChecklist options={OPTIONS} selectedIds={['CHILD:2']} onToggle={vi.fn()} />);

    expect(screen.getByRole('checkbox', { name: 'Ada Lovelace' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Grace Hopper Jr.' })).toBeChecked();
  });

  it('calls onToggle with the option id when clicked', () => {
    const onToggle = vi.fn();
    render(<ParticipantChecklist options={OPTIONS} selectedIds={[]} onToggle={onToggle} />);

    screen.getByRole('checkbox', { name: 'Ada Lovelace' }).click();

    expect(onToggle).toHaveBeenCalledWith('CUSTOMER:1');
  });

  it('disables unselected options once maxSelectable is reached, but not the selected ones', () => {
    render(
      <ParticipantChecklist
        options={OPTIONS}
        selectedIds={['CUSTOMER:1', 'CHILD:2']}
        onToggle={vi.fn()}
        maxSelectable={2}
      />,
    );

    expect(screen.getByRole('checkbox', { name: 'Ada Lovelace' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: 'Grace Hopper Jr.' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: 'Alan Kay Jr.' })).toBeDisabled();
  });
});
