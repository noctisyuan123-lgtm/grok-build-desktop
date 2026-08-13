// Model / run-configuration state for App: model preset + custom id, agent
// effort, reasoning effort, permission mode, best-of-N, memory/web/subagents/
// self-check toggles — each persisted to localStorage — plus the derived
// active model, the CLI-verified model options, and the coding-mode
// auto-snap. Extracted from App.tsx unchanged.
import { useEffect, useMemo, useState } from 'react';
import {
  isEffortLevel,
  isGrokModelId,
  isPermissionMode,
  isReasoningEffort,
  type EffortLevel,
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
  const [effortLevel, setEffortLevel] = useState<EffortLevel>(() => {
    const stored = window.localStorage.getItem(storageKeys.effortLevel);
    return safeRuntimeDefaultsMigrated && isEffortLevel(stored) ? stored : 'medium';
  });
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(() => {
    const stored = window.localStorage.getItem(storageKeys.reasoningEffort);
    return isReasoningEffort(stored) ? stored : grokModelPresets['grok-build'].defaultReasoning;
  });
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => {
    const stored = window.localStorage.getItem(storageKeys.permissionMode);
    return isPermissionMode(stored) ? stored : 'default';
  });
  const [bestOfN, setBestOfN] = useState(() => {
    const value = Number(window.localStorage.getItem(storageKeys.bestOfN) ?? '1');
    return Number.isInteger(value) && value >= 1 && value <= 5 ? value : 1;
  });
  const [experimentalMemory, setExperimentalMemory] = useState(
    () => window.localStorage.getItem(storageKeys.experimentalMemory) === 'true',
  );
  const [webSearchEnabled, setWebSearchEnabled] = useState(
    () =>
      safeRuntimeDefaultsMigrated &&
      window.localStorage.getItem(storageKeys.webSearchEnabled) === 'true',
  );
  const [subagentsEnabled, setSubagentsEnabled] = useState(
    () =>
      safeRuntimeDefaultsMigrated &&
      window.localStorage.getItem(storageKeys.subagentsEnabled) === 'true',
  );
  const [selfCheck, setSelfCheck] = useState(
    () => window.localStorage.getItem(storageKeys.selfCheck) === 'true',
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
    window.localStorage.setItem(storageKeys.effortLevel, effortLevel);
  }, [effortLevel]);

  useEffect(() => {
    window.localStorage.setItem(storageKeys.reasoningEffort, reasoningEffort);
  }, [reasoningEffort]);

  useEffect(() => {
    window.localStorage.setItem(storageKeys.permissionMode, permissionMode);
  }, [permissionMode]);

  useEffect(() => {
    window.localStorage.setItem(storageKeys.bestOfN, String(bestOfN));
  }, [bestOfN]);

  useEffect(() => {
    window.localStorage.setItem(storageKeys.experimentalMemory, String(experimentalMemory));
  }, [experimentalMemory]);

  useEffect(() => {
    window.localStorage.setItem(storageKeys.webSearchEnabled, String(webSearchEnabled));
  }, [webSearchEnabled]);

  useEffect(() => {
    window.localStorage.setItem(storageKeys.subagentsEnabled, String(subagentsEnabled));
  }, [subagentsEnabled]);

  useEffect(() => {
    window.localStorage.setItem(storageKeys.selfCheck, String(selfCheck));
  }, [selfCheck]);

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
    effortLevel,
    setEffortLevel,
    reasoningEffort,
    setReasoningEffort,
    permissionMode,
    setPermissionMode,
    bestOfN,
    setBestOfN,
    experimentalMemory,
    setExperimentalMemory,
    webSearchEnabled,
    setWebSearchEnabled,
    subagentsEnabled,
    setSubagentsEnabled,
    selfCheck,
    setSelfCheck,
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
