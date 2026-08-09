import { invoke } from '@tauri-apps/api/core';
import type { ToolRun } from './grok';
import { hasTauriRuntime } from './runtime';

export type CustomizeKind = 'rule' | 'command' | 'skill' | 'agent' | 'hook';
export type CustomizeScope = 'user' | 'workspace';

export interface CustomizeEntry {
  kind: CustomizeKind;
  scope: CustomizeScope;
  name: string;
  path: string;
  content: string;
  enabled: boolean;
  modifiedAt: number;
}

export async function listCustomizations(
  kind: CustomizeKind,
  scope: CustomizeScope,
  cwd?: string,
): Promise<CustomizeEntry[]> {
  if (!hasTauriRuntime()) return [];
  return invoke<CustomizeEntry[]>('list_customizations', { kind, scope, cwd: cwd || null });
}

export async function saveCustomization(input: {
  kind: CustomizeKind;
  scope: CustomizeScope;
  name: string;
  content: string;
  enabled: boolean;
  cwd?: string;
}): Promise<CustomizeEntry> {
  return invoke<CustomizeEntry>('save_customization', {
    ...input,
    cwd: input.cwd || null,
  });
}

export async function setCustomizationEnabled(input: {
  kind: CustomizeKind;
  scope: CustomizeScope;
  name: string;
  enabled: boolean;
  cwd?: string;
}): Promise<void> {
  return invoke('set_customization_enabled', { ...input, cwd: input.cwd || null });
}

export async function deleteCustomization(input: {
  kind: CustomizeKind;
  scope: CustomizeScope;
  name: string;
  cwd?: string;
}): Promise<void> {
  return invoke('delete_customization', { ...input, cwd: input.cwd || null });
}

export async function listCustomizePlugins(cwd?: string): Promise<ToolRun | null> {
  if (!hasTauriRuntime()) return null;
  return invoke<ToolRun>('list_customize_plugins', { cwd: cwd || null });
}

export async function runPluginAction(
  action: 'install' | 'uninstall' | 'enable' | 'disable' | 'update' | 'details',
  value: string | null,
  cwd?: string,
): Promise<ToolRun | null> {
  if (!hasTauriRuntime()) return null;
  return invoke<ToolRun>('grok_plugin_action', { action, value, cwd: cwd || null });
}

export async function setMcpEnabled(
  name: string,
  enabled: boolean,
  cwd?: string,
): Promise<ToolRun | null> {
  if (!hasTauriRuntime()) return null;
  return invoke<ToolRun>('grok_mcp_set_enabled', { name, enabled, cwd: cwd || null });
}

export const CUSTOMIZE_TEMPLATES: Record<CustomizeKind, (name: string) => string> = {
  rule: (name) => `# ${name}\n\n- Add project or personal instructions here.\n`,
  command: (name) =>
    `# /${name}\n\nDescribe the task this slash command should perform and the output it should return.\n`,
  skill: (name) =>
    `---\nname: ${name}\ndescription: Describe what this skill does and when Grok should use it.\n---\n\n# ${name}\n\nAdd the repeatable workflow and verification steps here.\n`,
  agent: (name) =>
    `---\nname: ${name}\ndescription: Describe this subagent's specialty.\ntools: Read, Grep, Glob, Bash\n---\n\nYou are a focused ${name} subagent. Define its responsibilities and output contract here.\n`,
  hook: () =>
    `{\n  "hooks": {\n    "PostToolUse": [\n      {\n        "hooks": [\n          { "type": "command", "command": "echo tool-complete" }\n        ]\n      }\n    ]\n  }\n}\n`,
};
