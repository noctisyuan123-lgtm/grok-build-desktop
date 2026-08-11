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
      />,
    );
    expect(screen.getByRole('button', { name: 'Choose workspace folder' })).toHaveTextContent(
      'grodex',
    );
    expect(screen.getByText('This Mac')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
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
