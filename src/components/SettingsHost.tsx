// Adapter that maps App-level state (model config, session, panels) onto
// SettingsPage's option-list props. Extracted from App.tsx unchanged.
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { SettingsPage, type SettingsSection, type CliUsage } from './SettingsPage';
import packageJson from '../../package.json';
import type { useModelConfig } from '../hooks/useModelConfig';
import type {
  ActionPolicy,
  DockPosition,
  GrokModelId,
  PermissionMode,
  ReasoningEffort,
  ThemeMode,
} from '../app/types';
import {
  actionPolicies,
  grokModelPresets,
  permissionModes,
  reasoningEfforts,
} from '../app/constants';

export interface SettingsHostProps {
  open: boolean;
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onClose: () => void;
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  dockPosition: DockPosition;
  setDockPosition: (position: DockPosition) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  completionSoundEnabled: boolean;
  setCompletionSoundEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  modelConfig: ReturnType<typeof useModelConfig>;
  actionPolicy: ActionPolicy;
  setActionPolicy: (policy: ActionPolicy) => void;
  grokVersionLine: string;
}

export function SettingsHost({
  open,
  section,
  onSection,
  onClose,
  themeMode,
  setThemeMode,
  dockPosition,
  setDockPosition,
  sidebarCollapsed,
  setSidebarCollapsed,
  completionSoundEnabled,
  setCompletionSoundEnabled,
  modelConfig,
  actionPolicy,
  setActionPolicy,
  grokVersionLine,
}: SettingsHostProps) {
  const {
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
    selectModel,
    selectedModelValue,
    modelOptions,
  } = modelConfig;
  const [cliUsage, setCliUsage] = useState<CliUsage | null>(null);
  const [cliUsageLoading, setCliUsageLoading] = useState(false);
  const [usageNonce, setUsageNonce] = useState(0);

  useEffect(() => {
    if (!open || section !== 'usage') return;
    let cancelled = false;
    setCliUsageLoading(true);
    void invoke<CliUsage>('get_cli_usage')
      .then((usage) => {
        if (!cancelled) setCliUsage(usage);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setCliUsage({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            creditUsagePercent: null,
            periodType: null,
            periodStart: null,
            periodEnd: null,
            onDemandCap: null,
            onDemandUsed: null,
            prepaidBalance: null,
            unifiedBilling: false,
            subscriptionTier: null,
          });
        }
      })
      .finally(() => {
        if (!cancelled) setCliUsageLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, section, usageNonce]);

  return (
    <SettingsPage
      open={open}
      section={section}
      onSection={onSection}
      onClose={onClose}
      themeMode={themeMode}
      setThemeMode={setThemeMode}
      dockPosition={dockPosition}
      setDockPosition={setDockPosition}
      sidebarCollapsed={sidebarCollapsed}
      setSidebarCollapsed={setSidebarCollapsed}
      completionSoundEnabled={completionSoundEnabled}
      setCompletionSoundEnabled={setCompletionSoundEnabled}
      modelOptions={[
        ...modelOptions.map((id) => ({
          value: id,
          label: grokModelPresets[id as GrokModelId]?.label ?? id,
        })),
        { value: 'custom', label: grokModelPresets.custom.label },
      ]}
      modelPreset={selectedModelValue}
      onModelPreset={selectModel}
      customModel={customModel}
      setCustomModel={setCustomModel}
      activeModel={activeModel}
      reasoningOptions={(Object.keys(reasoningEfforts) as ReasoningEffort[]).map((k) => ({
        value: k,
        label: reasoningEfforts[k].label,
      }))}
      reasoningEffort={reasoningEffort}
      setReasoningEffort={(v) => setReasoningEffort(v as ReasoningEffort)}
      experimentalMemory={experimentalMemory}
      setExperimentalMemory={setExperimentalMemory}
      actionPolicyOptions={(Object.keys(actionPolicies) as ActionPolicy[]).map((k) => ({
        value: k,
        label: actionPolicies[k].label,
        detail: actionPolicies[k].detail,
        risk: actionPolicies[k].risk,
      }))}
      actionPolicy={actionPolicy}
      setActionPolicy={(v) => setActionPolicy(v as ActionPolicy)}
      permissionOptions={(Object.keys(permissionModes) as PermissionMode[]).map((k) => ({
        value: k,
        label: permissionModes[k].label,
      }))}
      permissionMode={permissionMode}
      setPermissionMode={(v) => setPermissionMode(v as PermissionMode)}
      webSearchEnabled={webSearchEnabled}
      setWebSearchEnabled={setWebSearchEnabled}
      appVersion={packageJson.version}
      grokVersionLine={grokVersionLine}
      cliUsage={cliUsage}
      cliUsageLoading={cliUsageLoading}
      onRefreshUsage={() => setUsageNonce((n) => n + 1)}
    />
  );
}
