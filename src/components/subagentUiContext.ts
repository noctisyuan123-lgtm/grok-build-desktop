import { createContext, useContext } from 'react';
import type { SessionSubagent } from '../lib/sessionSubagents';

export type SubagentOpenTarget = { runId: string; key: string };

export type SubagentUiValue = {
  open: SubagentOpenTarget | null;
  setOpen: (next: SubagentOpenTarget | null) => void;
  items: SessionSubagent[];
  collapsed: boolean;
  setCollapsed: (next: boolean) => void;
  registerIgnoreNode: (id: string, node: HTMLElement | null) => void;
};

export const SubagentUiContext = createContext<SubagentUiValue | null>(null);

export function useSubagentUi(): SubagentUiValue | null {
  return useContext(SubagentUiContext);
}
