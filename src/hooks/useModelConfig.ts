// Model / run-configuration state for App: model preset + custom id, agent
// reasoning effort, permission mode, and memory/web toggles — each
// persisted to localStorage — plus the derived
// active model, the CLI-verified model options, and the coding-mode
// auto-snap. Extracted from App.tsx unchanged.
import { useEffect, useMemo, useState } from 'react';
import {
  isGrokModelId,
  isPermissionMode,
  isReasoningEffort,
  type GrokModelId,
  type Mode,
  type PermissionMode,
  type ReasoningEffort,
} from '../app/types';
import { grokModelPresets, reasoningEfforts, storageKeys } from '../app/constants';
import { parseStoredModelIds, resolveModelOptions } from '../app/format';

export interface ModelConfigDeps {
  mode: Mode;
  /** Model ids reported by the grok CLI (empty when it reported nothing). */
  availableModels: string[];
}

export function useModelConfig({ availableModels }: ModelConfigDeps) {
  const [modelPreset, setModelPreset] = useState<GrokModelId>(() => {
    const stored = window.localStorage.getItem(storageKeys.modelPreset);
    return isGrokModelId(stored) ? stored : 'grok-4.6';
  });
  const [customModel, setCustomModel] = useState(
    () => window.localStorage.getItem(storageKeys.customModel) ?? '',
  );
  const safeRuntimeDefaultsMigrated =
    window.localStorage.getItem(storageKeys.safeRuntimeDefaults) === 'true';
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(() => {
    const stored = window.localStorage.getItem(storageKeys.reasoningEffort);
    const legacyEffort = window.localStorage.getItem(storageKeys.legacyEffortLevel);
    // Older builds stored a separate Effort value and used it whenever
    // Reasoning effort was Auto/off. Preserve that effective value once while
    // migrating to the single reasoning-effort control.
    if (safeRuntimeDefaultsMigrated && stored === 'off' && isReasoningEffort(legacyEffort)) {
      return legacyEffort;
    }
    return isReasoningEffort(stored) ? stored : grokModelPresets['grok-build'].defaultReasoning;
  });
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => {
    const stored = window.localStorage.getItem(storageKeys.permissionMode);
    return isPermissionMode(stored) ? stored : 'default';
  });
  const [experimentalMemory, setExperimentalMemory] = useState(
    () => window.localStorage.getItem(storageKeys.experimentalMemory) === 'true',
  );
  const [webSearchEnabled, setWebSearchEnabled] = useState(
    () =>
      safeRuntimeDefaultsMigrated &&
      window.localStorage.getItem(storageKeys.webSearchEnabled) === 'true',
  );
  // True only after the user explicitly picks Custom… so the <select> can
  // stay on that sentinel even when the leftover custom id is also a CLI model.
  const [pickingCustom, setPickingCustom] = useState(false);

  const activeModel = modelPreset === 'custom' ? customModel.trim() || 'grok-build' : modelPreset;
  const activeModelMeta = grokModelPresets[modelPreset];
  const activeReasoningLabel =
    reasoningEffort === 'off' ? 'auto' : reasoningEfforts[reasoningEffort].label;

  function changeModelPreset(nextModel: GrokModelId) {
    setPickingCustom(nextModel === 'custom');
    setModelPreset(nextModel);
    // Unknown / future ids can be cast into this helper from older call sites.
    // Never throw — a missing preset must not freeze the model picker.
    setReasoningEffort(grokModelPresets[nextModel]?.defaultReasoning ?? 'off');
  }

  /** Pick a CLI model id, a known preset, or the Custom… sentinel. */
  function selectModel(nextId: string) {
    if (nextId === 'custom') {
      setPickingCustom(true);
      setModelPreset('custom');
      return;
    }
    setPickingCustom(false);
    if (isGrokModelId(nextId)) {
      changeModelPreset(nextId);
      return;
    }
    setModelPreset('custom');
    setCustomModel(nextId);
  }

  useEffect(() => {
    window.localStorage.setItem(storageKeys.modelPreset, modelPreset);
  }, [modelPreset]);

  useEffect(() => {
    window.localStorage.setItem(storageKeys.customModel, customModel);
  }, [customModel]);

  useEffect(() => {
    window.localStorage.setItem(storageKeys.reasoningEffort, reasoningEffort);
    window.localStorage.removeItem(storageKeys.legacyEffortLevel);
  }, [reasoningEffort]);

  useEffect(() => {
    window.localStorage.setItem(storageKeys.permissionMode, permissionMode);
  }, [permissionMode]);

  useEffect(() => {
    window.localStorage.setItem(storageKeys.experimentalMemory, String(experimentalMemory));
  }, [experimentalMemory]);

  useEffect(() => {
    window.localStorage.setItem(storageKeys.webSearchEnabled, String(webSearchEnabled));
  }, [webSearchEnabled]);

  const storedModels = useMemo(
    () => parseStoredModelIds(window.localStorage.getItem(storageKeys.availableModels)),
    // Re-read when the live CLI list changes so a successful probe replaces
    // the last-known catalog used during the empty-list frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [availableModels],
  );
  const modelOptions = useMemo(
    () => resolveModelOptions(availableModels, storedModels),
    [availableModels, storedModels],
  );
  const modelIsVerified =
    availableModels.length === 0 ||
    availableModels.includes(activeModel) ||
    modelPreset === 'custom';

  useEffect(() => {
    const fromCli = resolveModelOptions(availableModels, []);
    if (availableModels.length === 0) return;
    if (fromCli.length === 0) return;
    window.localStorage.setItem(storageKeys.availableModels, JSON.stringify(fromCli));
  }, [availableModels]);

  // Snap a stale hardcoded preset (grok-build, grok-4.3, …) onto the first
  // catalog id so the dropdown value exists. Custom typed ids stay put.
  useEffect(() => {
    if (modelPreset === 'custom') return;
    if (modelOptions.includes(modelPreset) || modelOptions.includes(activeModel)) return;
    const fallback = modelOptions[0];
    if (!fallback) return;
    if (isGrokModelId(fallback)) {
      changeModelPreset(fallback);
    } else {
      setPickingCustom(false);
      setModelPreset('custom');
      setCustomModel(fallback);
    }
  }, [availableModels, modelOptions, modelPreset, activeModel]);

  // Bind <select> to the actual engine id when it is in the option list.
  // CLI-only ids (grok-4.6, …) live on the custom preset; showing "Custom…"
  // there made the picker look stuck after every change.
  const selectedModelValue = pickingCustom
    ? 'custom'
    : modelOptions.includes(activeModel)
      ? activeModel
      : 'custom';

  return {
    modelPreset,
    setModelPreset,
    customModel,
    setCustomModel,
    reasoningEffort,
    setReasoningEffort,
    permissionMode,
    setPermissionMode,
    experimentalMemory,
    setExperimentalMemory,
    webSearchEnabled,
    setWebSearchEnabled,
    activeModel,
    activeModelMeta,
    activeReasoningLabel,
    changeModelPreset,
    selectModel,
    selectedModelValue,
    modelOptions,
    modelIsVerified,
  };
}
