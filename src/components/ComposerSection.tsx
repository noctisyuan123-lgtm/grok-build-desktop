// The composer block below the chat: autopilot risk banner, the Composer
// itself, and the footer selects (mode / model / workflow / action policy /
// reasoning) plus the inline Stop button. Extracted
// from App.tsx unchanged; run-config state rides in as the grouped
// useModelConfig result.
import { useCallback, useState } from 'react';
import { AlertTriangle, SlidersHorizontal } from 'lucide-react';
import { Composer, type ComposerHandle } from './Composer';
import { ContextUsageRing } from './ContextUsageRing';
import { SubagentFloat } from './SubagentFloat';
import {
  ComposerChoiceList,
  ComposerDropdownField,
  ComposerMenuButton,
  ComposerMenuSurface,
  useComposerMenu,
} from './ComposerPickers';
import type { useModelConfig } from '../hooks/useModelConfig';
import { type ActionPolicy, type ChatMessage, type Mode, type ReasoningEffort } from '../app/types';
import { actionPolicies, defaultDrafts, modeCopy, reasoningEfforts } from '../app/constants';
import { t } from '../i18n';
import type { ComposerAttachment } from '../lib/attachments';

export interface ComposerSectionProps {
  composerRef: React.RefObject<ComposerHandle | null>;
  codingCwd: string;
  messages: readonly ChatMessage[];
  buildRunArgs: () => string[];
  drafts: Record<Mode, string>;
  mode: Mode;
  setDrafts: React.Dispatch<React.SetStateAction<Record<Mode, string>>>;
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
  onHostSlash?: (raw: string) => boolean | Promise<boolean>;
  locked?: boolean;
  grokIsRunning: boolean;
  activeRunId: string | null;
  /** UI session / tab id for concurrent lane scheduling. */
  laneId: string;
  stopRun: (runId: string) => void;
}

export function ComposerSection({
  composerRef,
  codingCwd,
  messages,
  buildRunArgs,
  drafts,
  mode,
  setDrafts,
  handleEnqueued,
  setSessionNotice,
  modelConfig,
  availableModels,
  actionPolicy,
  setActionPolicy,
  onHostSlash,
  locked = false,
  grokIsRunning,
  activeRunId,
  laneId,
  stopRun,
}: ComposerSectionProps) {
  const {
    reasoningEffort,
    setReasoningEffort,
    activeModel,
    selectModel,
    selectedModelValue,
    modelOptions,
    activeModelMeta,
  } = modelConfig;
  const [openMenu, setOpenMenu] = useState<'model' | 'run' | null>(null);
  const [runField, setRunField] = useState<'policy' | 'effort' | null>(null);
  const closeMenus = useCallback(() => {
    setOpenMenu(null);
    setRunField(null);
  }, []);
  const menuRef = useComposerMenu(openMenu !== null, closeMenus);
  const hasCustomRunConfig =
    actionPolicy !== 'patch' || reasoningEffort !== activeModelMeta.defaultReasoning;
  const modelChoices = [
    ...modelOptions.map((id) => ({
      value: id,
      label:
        availableModels.length === 0 || availableModels.includes(id)
          ? id
          : t('composerSection.modelNotInCli', { id }),
    })),
    { value: 'custom', label: t('composerSection.customOption') },
  ];
  const effortChoices = (Object.keys(reasoningEfforts) as ReasoningEffort[]).map((key) => ({
    value: key,
    label: key === 'off' ? 'Auto' : reasoningEfforts[key].label,
    detail: reasoningEfforts[key].detail,
  }));
  const policyChoices = (Object.keys(actionPolicies) as ActionPolicy[]).map((policy) => ({
    value: policy,
    label: actionPolicies[policy].label,
    detail: actionPolicies[policy].detail,
  }));
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
      <SubagentFloat
        sessionRunIds={messages
          .map((message) => message.runId)
          .filter((id): id is string => Boolean(id))}
      />
      <Composer
        ref={composerRef}
        cwd={codingCwd}
        argsBuilder={buildRunArgs}
        parentRunId={activeRunId ?? undefined}
        laneId={laneId}
        sessionRunIds={messages
          .map((message) => message.runId)
          .filter((id): id is string => Boolean(id))}
        initialValue={drafts[mode] || defaultDrafts[mode]}
        locked={locked}
        placeholder={modeCopy[mode].placeholder}
        onTextChange={(text) => {
          setDrafts((current) => ({ ...current, [mode]: text }));
        }}
        onEnqueued={handleEnqueued}
        onError={(message) => setSessionNotice(t('composerSection.sendFailed', { message }))}
        onStop={grokIsRunning && activeRunId ? () => stopRun(activeRunId) : undefined}
        onHostSlash={onHostSlash}
        controls={
          <div className="composer-compact-controls" ref={menuRef}>
            <div className="cmp-wrap">
              <ComposerMenuButton
                label={t('composerSection.grokModel')}
                open={openMenu === 'model'}
                onToggle={() => setOpenMenu((current) => (current === 'model' ? null : 'model'))}
              >
                {selectedModelValue === 'custom' ? t('composerSection.customOption') : activeModel}
              </ComposerMenuButton>
              <ComposerMenuSurface
                id="composer-model-menu"
                label={t('composerSection.grokModel')}
                open={openMenu === 'model'}
                anchorRef={menuRef}
              >
                <ComposerChoiceList
                  value={selectedModelValue}
                  items={modelChoices}
                  onChange={(value) => {
                    selectModel(value);
                    if (value !== 'custom') setOpenMenu(null);
                  }}
                />
                {selectedModelValue === 'custom' ? (
                  <label className="cmp-field">
                    <span className="cmp-kicker">{t('settings.customModelId')}</span>
                    <input
                      aria-label={t('settings.customModelId')}
                      value={modelConfig.customModel}
                      placeholder={t('settings.customModelIdPlaceholder')}
                      onChange={(event) => modelConfig.setCustomModel(event.currentTarget.value)}
                    />
                  </label>
                ) : null}
              </ComposerMenuSurface>
            </div>
            <div className="cmp-wrap">
              <button
                className={
                  openMenu === 'run'
                    ? 'composer-advanced-trigger is-open'
                    : 'composer-advanced-trigger'
                }
                type="button"
                aria-label={t('composerSection.runSettings')}
                aria-expanded={openMenu === 'run'}
                aria-controls="composer-run-settings"
                title={t('composerSection.runSettings')}
                onClick={() => {
                  setOpenMenu((current) => {
                    if (current === 'run') {
                      setRunField(null);
                      return null;
                    }
                    setRunField(null);
                    return 'run';
                  });
                }}
              >
                <SlidersHorizontal size={14} />
                {hasCustomRunConfig ? <span className="composer-config-dot" /> : null}
              </button>
              <ComposerMenuSurface
                id="composer-run-settings"
                label={t('composerSection.runSettings')}
                open={openMenu === 'run'}
                anchorRef={menuRef}
              >
                <ComposerDropdownField
                  label={t('composerSection.actionPolicy')}
                  value={actionPolicy}
                  items={policyChoices.map(({ value, label }) => ({ value, label }))}
                  open={runField === 'policy'}
                  onToggle={() =>
                    setRunField((current) => (current === 'policy' ? null : 'policy'))
                  }
                  onChange={(value) => {
                    setActionPolicy(value as ActionPolicy);
                    setRunField(null);
                  }}
                />
                <ComposerDropdownField
                  label={t('composerSection.reasoningEffort')}
                  value={reasoningEffort}
                  items={effortChoices.map(({ value, label }) => ({ value, label }))}
                  open={runField === 'effort'}
                  onToggle={() =>
                    setRunField((current) => (current === 'effort' ? null : 'effort'))
                  }
                  onChange={(value) => {
                    setReasoningEffort(value as ReasoningEffort);
                    setRunField(null);
                  }}
                />
              </ComposerMenuSurface>
            </div>
          </div>
        }
      />
      <div className="composer-context-footer">
        <ContextUsageRing messages={messages} cwd={codingCwd} />
      </div>
    </div>
  );
}
