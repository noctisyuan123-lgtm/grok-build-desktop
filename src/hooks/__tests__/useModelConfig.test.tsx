import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useModelConfig, type ModelConfigDeps } from '../useModelConfig';
import { storageKeys } from '../../app/constants';

function render(initial: Partial<ModelConfigDeps> = {}) {
  return renderHook((props: ModelConfigDeps) => useModelConfig(props), {
    initialProps: {
      mode: 'coding',
      availableModels: [],
      ...initial,
    } as ModelConfigDeps,
  });
}

describe('useModelConfig defaults and persistence', () => {
  it('starts from safe defaults with empty storage', () => {
    const { result } = render();
    expect(result.current.modelPreset).toBe('grok-4.6');
    expect(result.current.activeModel).toBe('grok-4.6');
    expect(result.current.reasoningEffort).toBe('off');
    expect(result.current.webSearchEnabled).toBe(false);
  });

  it('restores persisted values (effort/web only after the safe-defaults migration)', () => {
    window.localStorage.setItem(storageKeys.safeRuntimeDefaults, 'true');
    window.localStorage.setItem(storageKeys.modelPreset, 'grok-4.5');
    window.localStorage.setItem(storageKeys.legacyEffortLevel, 'xhigh');
    window.localStorage.setItem(storageKeys.reasoningEffort, 'high');
    window.localStorage.setItem(storageKeys.permissionMode, 'plan');
    window.localStorage.setItem(storageKeys.webSearchEnabled, 'true');
    const { result } = render({
      mode: 'standard',
      availableModels: ['grok-4.6', 'grok-4.5'],
    });
    expect(result.current.modelPreset).toBe('grok-4.5');
    expect(result.current.reasoningEffort).toBe('high');
    expect(result.current.permissionMode).toBe('plan');
    expect(result.current.webSearchEnabled).toBe(true);
  });

  it('ignores persisted effort/web-search toggles before the migration flag exists', () => {
    window.localStorage.setItem(storageKeys.webSearchEnabled, 'true');
    const { result } = render();
    expect(result.current.webSearchEnabled).toBe(false);
  });

  it('rejects invalid persisted values', () => {
    window.localStorage.setItem(storageKeys.modelPreset, 'gpt-4');
    const { result } = render();
    expect(result.current.modelPreset).toBe('grok-4.6');
  });

  it('mirrors changes back to localStorage', () => {
    const { result } = render();
    act(() => result.current.setReasoningEffort('high'));
    expect(window.localStorage.getItem(storageKeys.reasoningEffort)).toBe('high');
  });
});

describe('active model derivation', () => {
  it('uses the trimmed custom id when the preset is custom, falling back to grok-build', () => {
    const { result } = render({ mode: 'standard' });
    act(() => result.current.setModelPreset('custom'));
    act(() => result.current.setCustomModel('  my-model  '));
    expect(result.current.activeModel).toBe('my-model');
    act(() => result.current.setCustomModel('   '));
    expect(result.current.activeModel).toBe('grok-build');
  });

  it('changeModelPreset snaps reasoning to the preset default', () => {
    const { result } = render({
      mode: 'standard',
      availableModels: ['grok-4.3', 'grok-build'],
    });
    act(() => result.current.changeModelPreset('grok-4.3'));
    expect(result.current.reasoningEffort).toBe('high');
    act(() => result.current.changeModelPreset('grok-build'));
    expect(result.current.reasoningEffort).toBe('off');
  });

  it('selectModel binds CLI-only ids to the dropdown value instead of Custom…', () => {
    const { result } = render({
      mode: 'coding',
      availableModels: ['grok-4.6', 'grok-4.5'],
    });
    act(() => result.current.selectModel('grok-4.5'));
    expect(result.current.modelPreset).toBe('grok-4.5');
    expect(result.current.activeModel).toBe('grok-4.5');
    expect(result.current.selectedModelValue).toBe('grok-4.5');

    act(() => result.current.selectModel('grok-4.6'));
    expect(result.current.activeModel).toBe('grok-4.6');
    expect(result.current.selectedModelValue).toBe('grok-4.6');

    act(() => result.current.selectModel('custom'));
    expect(result.current.selectedModelValue).toBe('custom');
  });
});

describe('CLI-verified model options', () => {
  it('offers ONLY the CLI-reported models when the CLI reported any', () => {
    const { result } = render({ availableModels: ['grok-build', 'grok-9-preview'] });
    expect(result.current.modelOptions).toEqual(['grok-build', 'grok-9-preview']);
  });

  it('falls back to the current grok.com catalog when the CLI is silent', () => {
    const coding = render({ mode: 'coding', availableModels: [] });
    expect(coding.result.current.modelOptions).toEqual(['grok-4.6', 'grok-4.5']);
    const chat = render({ mode: 'standard', availableModels: [] });
    expect(chat.result.current.modelOptions).toEqual(['grok-4.6', 'grok-4.5']);
    expect(chat.result.current.modelOptions).not.toContain('custom');
  });

  it('reuses the last CLI catalog after a silent probe', () => {
    window.localStorage.setItem(
      storageKeys.availableModels,
      JSON.stringify(['grok-4.6', 'grok-4.5', 'grok-4']),
    );
    const { result } = render({ mode: 'coding', availableModels: [] });
    expect(result.current.modelOptions).toEqual(['grok-4.6', 'grok-4.5', 'grok-4']);
  });

  it('filters CLI noise tokens out of the options', () => {
    const { result } = render({ availableModels: ['models', 'available', 'grok-build'] });
    expect(result.current.modelOptions).toEqual(['grok-build']);
  });

  it('treats a CLI-listed selection as verified', () => {
    const { result } = render({
      mode: 'standard',
      availableModels: ['grok-4.6', 'grok-4.5'],
    });
    act(() => result.current.selectModel('grok-4.5'));
    expect(result.current.modelIsVerified).toBe(true);
  });
});

describe('coding-mode auto-snap', () => {
  it('snaps a stale preset to the first CLI model when it is a known preset id', () => {
    window.localStorage.setItem(storageKeys.modelPreset, 'grok-4.3');
    const { result } = render({ mode: 'coding', availableModels: ['grok-build'] });
    expect(result.current.modelPreset).toBe('grok-build');
    // Auto-snap goes through changeModelPreset, so reasoning follows too.
    expect(result.current.reasoningEffort).toBe('off');
  });

  it('routes unknown CLI ids through the custom preset so --model matches the dropdown', () => {
    window.localStorage.setItem(storageKeys.modelPreset, 'grok-4.3');
    const { result } = render({ mode: 'coding', availableModels: ['grok-9-new'] });
    expect(result.current.modelPreset).toBe('custom');
    expect(result.current.customModel).toBe('grok-9-new');
    expect(result.current.activeModel).toBe('grok-9-new');
    expect(result.current.selectedModelValue).toBe('grok-9-new');
  });

  it('snaps a stale preset onto the fallback catalog when the CLI is silent', () => {
    window.localStorage.setItem(storageKeys.modelPreset, 'grok-4.3');
    const silent = render({ mode: 'coding', availableModels: [] });
    expect(silent.result.current.modelPreset).toBe('grok-4.6');
    expect(silent.result.current.selectedModelValue).toBe('grok-4.6');
  });

  it('leaves a custom id alone', () => {
    window.localStorage.setItem(storageKeys.modelPreset, 'custom');
    window.localStorage.setItem(storageKeys.customModel, 'my-model');
    const custom = render({ mode: 'coding', availableModels: ['grok-build'] });
    expect(custom.result.current.modelPreset).toBe('custom');
    expect(custom.result.current.activeModel).toBe('my-model');
  });
});
