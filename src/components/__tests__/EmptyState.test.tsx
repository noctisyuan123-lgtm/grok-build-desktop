import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmptyState } from '../EmptyState';

describe('EmptyState', () => {
  it('shows the current workspace and local runtime without starter cards', () => {
    render(
      <EmptyState
        codingCwd="/Users/untitled/Projects/grodex"
        folderPickerBusy={false}
        onPickWorkspace={() => {}}
        now={new Date('2026-08-26T09:15:00')}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Good morning' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose workspace folder' })).toHaveTextContent(
      'grodex',
    );
    expect(screen.getByText('This Mac')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('switches the greeting with the local clock', () => {
    const { rerender } = render(
      <EmptyState
        codingCwd="/tmp"
        folderPickerBusy={false}
        onPickWorkspace={() => {}}
        now={new Date('2026-08-29T06:12:00')}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Early bird' })).toBeInTheDocument();
    rerender(
      <EmptyState
        codingCwd="/tmp"
        folderPickerBusy={false}
        onPickWorkspace={() => {}}
        now={new Date('2026-08-29T23:10:00')}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Night owl' })).toBeInTheDocument();
  });

  it('opens the native workspace picker from the project control', async () => {
    const onPickWorkspace = vi.fn();
    const user = userEvent.setup();
    render(<EmptyState codingCwd="" folderPickerBusy={false} onPickWorkspace={onPickWorkspace} />);
    await user.click(screen.getByRole('button', { name: 'Choose workspace folder' }));
    expect(onPickWorkspace).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Choose workspace')).toBeInTheDocument();
  });
});
