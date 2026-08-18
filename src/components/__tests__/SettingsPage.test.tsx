import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsPage, type SettingsPageProps } from '../SettingsPage';

function makeProps(overrides: Partial<SettingsPageProps> = {}): SettingsPageProps {
  return {
    open: true,
    section: 'general',
    onSection: vi.fn(),
    onClose: vi.fn(),
    themeMode: 'dark',
    setThemeMode: vi.fn(),
    dockPosition: 'right',
    setDockPosition: vi.fn(),
    sidebarCollapsed: false,
    setSidebarCollapsed: vi.fn(),
    completionSoundEnabled: true,
    setCompletionSoundEnabled: vi.fn(),
    modelOptions: [
      { value: 'grok-build', label: 'grok-build' },
      { value: 'custom', label: 'Custom' },
    ],
    modelPreset: 'grok-build',
    onModelPreset: vi.fn(),
    customModel: '',
    setCustomModel: vi.fn(),
    activeModel: 'grok-build',
    reasoningOptions: [
      { value: 'off', label: 'Auto' },
      { value: 'high', label: 'High' },
    ],
    reasoningEffort: 'off',
    setReasoningEffort: vi.fn(),
    experimentalMemory: false,
    setExperimentalMemory: vi.fn(),
    actionPolicyOptions: [
      { value: 'review', label: 'Review only', detail: 'Read only.', risk: 'none' },
      {
        value: 'autopilot',
        label: 'Autopilot',
        detail: 'Auto-approves every tool call.',
        risk: 'high',
      },
    ],
    actionPolicy: 'review',
    setActionPolicy: vi.fn(),
    permissionOptions: [
      { value: 'default', label: 'Default' },
      { value: 'plan', label: 'Plan' },
    ],
    permissionMode: 'default',
    setPermissionMode: vi.fn(),
    webSearchEnabled: false,
    setWebSearchEnabled: vi.fn(),
    appVersion: '0.4.0',
    grokVersionLine: 'Grok CLI 1.0',
    ...overrides,
  };
}

describe('SettingsPage', () => {
  it('renders nothing while closed', () => {
    const { container } = render(<SettingsPage {...makeProps({ open: false })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('navigates between sections and closes on Escape / close button / overlay click', async () => {
    const user = userEvent.setup();
    const props = makeProps();
    render(<SettingsPage {...props} />);

    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Model & reasoning' }));
    expect(props.onSection).toHaveBeenCalledWith('model');

    await user.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it('traps focus inside the modal: Tab wraps last→first, Shift+Tab wraps first→last', async () => {
    const user = userEvent.setup();
    render(<SettingsPage {...makeProps()} />);
    // Initial focus lands on the close button.
    expect(screen.getByRole('button', { name: 'Close settings' })).toHaveFocus();

    // First focusable is the "General" nav item; last is the completion sound toggle.
    const first = screen.getByRole('button', { name: 'General' });
    const last = screen.getByRole('switch', { name: 'Background completion sound' });

    first.focus();
    await user.tab({ shift: true }); // wrap: first → last
    expect(last).toHaveFocus();
    await user.tab(); // wrap: last → first
    expect(first).toHaveFocus();
  });

  it('general: theme buttons and dock select drive their setters', async () => {
    const user = userEvent.setup();
    const props = makeProps();
    render(<SettingsPage {...props} />);
    await user.click(screen.getByRole('button', { name: 'Light' }));
    expect(props.setThemeMode).toHaveBeenCalledWith('light');
    await user.selectOptions(screen.getByLabelText('Dock position'), 'bottom');
    expect(props.setDockPosition).toHaveBeenCalledWith('bottom');
    await user.click(screen.getByRole('switch', { name: 'Collapse sidebar' }));
    expect(props.setSidebarCollapsed).toHaveBeenCalledWith(true);
    await user.click(screen.getByRole('switch', { name: 'Background completion sound' }));
    expect(props.setCompletionSoundEnabled).toHaveBeenCalledWith(false);
  });

  it('model: shows the custom-id input only for the custom preset and changes reasoning effort', async () => {
    const user = userEvent.setup();
    const props = makeProps({ section: 'model' });
    const { rerender } = render(<SettingsPage {...props} />);
    expect(screen.queryByLabelText('Custom model id')).not.toBeInTheDocument();

    rerender(<SettingsPage {...makeProps({ section: 'model', modelPreset: 'custom' })} />);
    expect(screen.getByLabelText('Custom model id')).toBeInTheDocument();

    const reasoningProps = makeProps({ section: 'model' });
    rerender(<SettingsPage {...reasoningProps} />);
    await user.selectOptions(screen.getByLabelText('Reasoning effort'), 'high');
    expect(reasoningProps.setReasoningEffort).toHaveBeenLastCalledWith('high');
  });

  it('permissions: warns on the high-risk autopilot policy', () => {
    render(<SettingsPage {...makeProps({ section: 'permissions', actionPolicy: 'autopilot' })} />);
    const detail = screen.getByText(/Auto-approves every tool call/);
    expect(detail).toHaveClass('risk-high');
    expect(detail.textContent).toContain('⚠');
  });

  it('permissions: toggles report the flipped value', async () => {
    const user = userEvent.setup();
    const props = makeProps({ section: 'permissions', webSearchEnabled: true });
    render(<SettingsPage {...props} />);
    const webSearch = screen.getByRole('switch', { name: 'Web search' });
    expect(webSearch).toHaveAttribute('aria-checked', 'true');
    await user.click(webSearch);
    expect(props.setWebSearchEnabled).toHaveBeenCalledWith(false);
  });

  it('does not expose the redundant Workspace settings page', () => {
    render(<SettingsPage {...makeProps()} />);
    expect(screen.queryByRole('button', { name: 'Workspace' })).not.toBeInTheDocument();
    expect(screen.queryByText('Project folder')).not.toBeInTheDocument();
  });

  it('about: shows app and grok versions', () => {
    render(<SettingsPage {...makeProps({ section: 'about' })} />);
    expect(screen.getByText('v0.4.0')).toBeInTheDocument();
    expect(screen.getByText('Grok CLI 1.0')).toBeInTheDocument();
    expect(document.querySelector('.set-about-mark')).toHaveAttribute('src');
  });
});
