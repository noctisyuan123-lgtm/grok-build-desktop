import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmptyState } from '../EmptyState';

describe('EmptyState', () => {
  afterEach(() => vi.useRealTimers());

  it('shows the current workspace and local runtime without starter cards', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 9, 12));
    render(
      <EmptyState
        codingCwd="/Users/untitled/Projects/grodex"
        folderPickerBusy={false}
        onPickWorkspace={() => {}}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Happy Wednesday, Noctis' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose workspace folder' })).toHaveTextContent(
      'grodex',
    );
    expect(screen.getByText('This Mac')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('refreshes the greeting after local midnight', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 9, 23, 59, 59, 500));
    render(
      <EmptyState
        codingCwd=""
        folderPickerBusy={false}
        onPickWorkspace={() => {}}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Happy Wednesday, Noctis' })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole('heading', { name: 'Happy Thursday, Noctis' })).toBeInTheDocument();
  });

  it('opens the native workspace picker from the project control', async () => {
    const onPickWorkspace = vi.fn();
    const user = userEvent.setup();
    render(
      <EmptyState codingCwd="" folderPickerBusy={false} onPickWorkspace={onPickWorkspace} />,
    );
    await user.click(screen.getByRole('button', { name: 'Choose workspace folder' }));
    expect(onPickWorkspace).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Choose workspace')).toBeInTheDocument();
  });
});
