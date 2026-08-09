// The composer block below the chat: autopilot risk banner, the Composer
// itself, and the footer selects (mode / model / workflow / action policy /
// effort / reasoning / best-of-N) plus the inline Stop button. Extracted
// from App.tsx unchanged; run-config state rides in as the grouped
// useModelConfig result.
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, SlidersHorizontal } from 'lucide-react';
import { Composer, type ComposerHandle } from './Composer';
import type { useModelConfig } from '../hooks/useModelConfig';
import {
  isGrokModelId,
  type ActionPolicy,
  type EffortLevel,
  type Mode,
  type ReasoningEffort,
} from '../app/types';
import {
  actionPolicies,
  codingPresets,
  defaultDrafts,
  effortLevels,
  modeCopy,
  reasoningEfforts,
} from '../app/constants';
import { t } from '../i18n';
import type { ComposerAttachment } from '../lib/attachments';

export interface ComposerSectionProps {
  composerRef: React.RefObject<ComposerHandle | null>;
  codingCwd: string;
  buildRunArgs: () => string[];
  drafts: Record<Mode, string>;
  mode: Mode;
  setDrafts: React.Dispatch<React.SetStateAction<Record<Mode, string>>>;
  switchMode: (mode: Mode) => void;
  handleEnqueued: (info: {
    runId: string;
    position: number;
    prompt: string;
    rawText?: string;
    attachments: ComposerAttachment[];
  }) => void;
  setSessionNotice: (notice: string | null) => void;
  modelConfig: ReturnType<typeof useModelConfig>;
  availableModels: string[];
  actionPolicy: ActionPolicy;
  setActionPolicy: (policy: ActionPolicy) => void;
  codingWorkflow: string;
  applyCodingPreset: (preset: (typeof codingPresets)[number]) => void;
  grokIsRunning: boolean;
  activeRunId: string | null;
  stopRun: (runId: string) => void;
}

export function ComposerSection({
  composerRef,
  codingCwd,
  buildRunArgs,
  drafts,
  mode,
  setDrafts,
  switchMode,
  handleEnqueued,
  setSessionNotice,
  modelConfig,
  availableModels,
  actionPolicy,
  setActionPolicy,
  codingWorkflow,
  applyCodingPreset,
  grokIsRunning,
  activeRunId,
  stopRun,
}: ComposerSectionProps) {
  const {
    modelPreset,
    setModelPreset,
    setCustomModel,
    effortLevel,
    setEffortLevel,
    reasoningEffort,
    setReasoningEffort,
    bestOfN,
    setBestOfN,
    activeModel,
    changeModelPreset,
    modelOptions,
    modelIsVerified,
    activeModelMeta,
  } = modelConfig;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedRef = useRef<HTMLDivElement>(null);
  const hasCustomRunConfig =
    codingWorkflow !== 'analyze' ||
    actionPolicy !== 'patch' ||
    effortLevel !== 'medium' ||
    reasoningEffort !== activeModelMeta.defaultReasoning ||
    bestOfN !== 1;

  useEffect(() => {
    if (!advancedOpen) return;
    const closeOnPointer = (event: PointerEvent) => {
      if (!advancedRef.current?.contains(event.target as Node)) setAdvancedOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAdvancedOpen(false);
    };
    document.addEventListener('pointerdown', closeOnPointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [advancedOpen]);
  return (
    <div className="composer-row">
      {actionPolicy === 'autopilot' ? (
        <div className="autopilot-warning" role="alert">
          <AlertTriangle size={15} />
          <div>
            <strong>{t('composerSection.autopilotTitle')}</strong>
            <span>
              It can edit files and run shell commands with <code>--always-approve</code>, no
              confirmation. Only use this in a sandbox or a disposable git checkout.
            </span>
          </div>
          <button
            type="button"
            className="autopilot-warning-dismiss"
            onClick={() => setActionPolicy('patch')}
            title={t('composerSection.autopilotSwitchTitle')}
          >
            {t('composerSection.autopilotSwitch')}
          </button>
        </div>
      ) : null}
      <Composer
        ref={composerRef}
        cwd={codingCwd}
        argsBuilder={buildRunArgs}
        initialValue={drafts[mode] || defaultDrafts[mode]}
        placeholder={modeCopy[mode].placeholder}
        onTextChange={(text) => {
          setDrafts((current) => ({ ...current, [mode]: text }));
        }}
        onEnqueued={handleEnqueued}
        onError={(message) => setSessionNotice(t('composerSection.sendFailed', { message }))}
        onStop={
          grokIsRunning && activeRunId ? () => stopRun(activeRunId) : undefined
        }
        controls={
          <div className="composer-compact-controls">
            <select
              aria-label={t('composerSection.interactionMode')}
              className="mode-select"
              onChange={(event) => switchMode(event.currentTarget.value as Mode)}
              value={mode}
            >
              {(Object.keys(modeCopy) as Mode[]).map((item) => (
                <option key={item} value={item}>
                  {modeCopy[item].title}
                </option>
              ))}
            </select>
            <select
              aria-label={t('composerSection.grokModel')}
              className="model-select-footer"
              title={
                modelIsVerified
                  ? t('composerSection.modelTitle', { model: activeModel })
                  : t('composerSection.modelUnverifiedTitle', { model: activeModel })
              }
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (isGrokModelId(value)) {
                  changeModelPreset(value);
                } else {
                  setModelPreset('custom');
                  setCustomModel(value);
                }
              }}
              value={modelPreset === 'custom' ? 'custom' : modelPreset}
            >
              {modelOptions.map((id) => {
                const verified = availableModels.length === 0 || availableModels.includes(id);
                return (
                  <option key={id} value={id}>
                    {verified ? id : t('composerSection.modelNotInCli', { id })}
                  </option>
                );
              })}
              <option value="custom">{t('composerSection.customOption')}</option>
            </select>
            <div className="composer-advanced-wrap" ref={advancedRef}>
              <button
                className="composer-advanced-trigger"
                type="button"
                aria-label={t('composerSection.runSettings')}
                aria-expanded={advancedOpen}
                aria-controls="composer-run-settings"
                title={t('composerSection.runSettings')}
                onClick={() => setAdvancedOpen((open) => !open)}
              >
                <SlidersHorizontal size={14} />
                {hasCustomRunConfig ? <span className="composer-config-dot" /> : null}
              </button>
              {advancedOpen ? (
                <div
                  className="composer-advanced-popover"
                  id="composer-run-settings"
                  role="group"
                  aria-label={t('composerSection.runSettings')}
                >
                  <strong>{t('composerSection.runSettings')}</strong>
                  <label>
                    <span>{t('composerSection.codingWorkflow')}</span>
                    <select
                      aria-label={t('composerSection.codingWorkflow')}
                      onChange={(event) => {
                        const preset = codingPresets.find(
                          (item) => item.id === event.currentTarget.value,
                        );
                        if (preset) applyCodingPreset(preset);
                      }}
                      value={codingWorkflow}
                    >
                      {codingPresets.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>{t('composerSection.actionPolicy')}</span>
                    <select
                      aria-label={t('composerSection.actionPolicy')}
                      onChange={(event) =>
                        setActionPolicy(event.currentTarget.value as ActionPolicy)
                      }
                      value={actionPolicy}
                    >
                      {(Object.keys(actionPolicies) as ActionPolicy[]).map((policy) => (
                        <option key={policy} value={policy}>
                          {actionPolicies[policy].label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>{t('composerSection.agentEffort')}</span>
                    <select
                      aria-label={t('composerSection.agentEffort')}
                      value={effortLevel}
                      onChange={(event) =>
                        setEffortLevel(event.currentTarget.value as EffortLevel)
                      }
                    >
                      {(Object.keys(effortLevels) as EffortLevel[]).map((key) => (
                        <option key={key} value={key}>
                          {effortLevels[key].label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>{t('composerSection.reasoningEffort')}</span>
                    <select
                      aria-label={t('composerSection.reasoningEffort')}
                      value={reasoningEffort}
                      onChange={(event) =>
                        setReasoningEffort(event.currentTarget.value as ReasoningEffort)
                      }
                    >
                      {(Object.keys(reasoningEfforts) as ReasoningEffort[]).map((key) => (
                        <option key={key} value={key}>
                          {key === 'off' ? 'Auto' : reasoningEfforts[key].label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>{t('composerSection.bestOfN')}</span>
                    <select
                      aria-label={t('composerSection.bestOfN')}
                      value={bestOfN}
                      onChange={(event) => setBestOfN(Number(event.currentTarget.value))}
                    >
                      {[1, 2, 3, 4, 5].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              ) : null}
            </div>
          </div>
        }
      />
    </div>
  );
}
