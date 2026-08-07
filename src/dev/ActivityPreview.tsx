import { useEffect } from 'react';
import { MessageItem } from '../components/MessageItem';
import { applyRunEvent, applyStateChange, streamStore } from '../lib/streamStore';

const RUN_ID = 'activity-preview';

/** Zero-credit visual fixture, available only from Vite with ?activity-preview. */
export function ActivityPreview() {
  useEffect(() => {
    applyStateChange(RUN_ID, { state: 'Running', startedAt: Date.now() - 18_400 });
    streamStore.patchRun(RUN_ID, {
      text: 'I’m checking the event path and the interface together.',
      textChars: 56,
      lastEventType: 'text',
    });
    streamStore.setHtml(
      RUN_ID,
      '<p>I’m checking the event path and the interface together.</p><p>The workflow stays visible without taking over the response.</p>',
    );
    applyRunEvent(
      RUN_ID,
      { type: 'unknown' },
      {
        type: 'plan',
        entries: [
          { content: 'Inspect the event schema', status: 'completed' },
          { content: 'Build the activity rail', status: 'completed' },
          { content: 'Verify long-task states', status: 'in_progress' },
        ],
      },
    );
    applyRunEvent(
      RUN_ID,
      { type: 'unknown' },
      {
        type: 'tool_call',
        toolCallId: 'read-1',
        title: 'Read src/lib/streamStore.ts',
        status: 'in_progress',
        rawInput: { path: 'src/lib/streamStore.ts' },
      },
    );
    applyRunEvent(
      RUN_ID,
      { type: 'unknown' },
      {
        type: 'tool_call_update',
        toolCallId: 'read-1',
        title: 'Read src/lib/streamStore.ts',
        status: 'completed',
        rawOutput: { lines: 287 },
      },
    );
    applyRunEvent(
      RUN_ID,
      { type: 'unknown' },
      {
        type: 'subagent_spawned',
        subagent_id: 'ui-review',
        description: 'Review long-task UI',
        parent_session_id: 'preview',
      },
    );
    applyRunEvent(
      RUN_ID,
      { type: 'unknown' },
      {
        type: 'subagent_spawned',
        subagent_id: 'protocol-review',
        description: 'Check event lifecycle',
        parent_session_id: 'preview',
      },
    );
    applyRunEvent(
      RUN_ID,
      { type: 'unknown' },
      {
        type: 'tool_call',
        toolCallId: 'tests-1',
        title: 'Running unit tests',
        status: 'in_progress',
        rawInput: { command: 'npm run test:unit' },
      },
    );
    applyRunEvent(
      RUN_ID,
      { type: 'unknown' },
      {
        type: 'usage',
        usage: { input_tokens: 8_420, output_tokens: 1_230, cache_read_input_tokens: 9_800 },
        num_turns: 4,
      },
    );
    return undefined;
  }, []);

  return (
    <main className="activity-preview-shell">
      <div className="message message-assistant activity-preview-message">
        <MessageItem runId={RUN_ID} />
      </div>
    </main>
  );
}
