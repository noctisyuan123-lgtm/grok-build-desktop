import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import appIcon from '../../src-tauri/icons/icon.png';
import { tabIdFromPayload } from '../lib/completionPopup';

export function CompletionPopup() {
  const [tabId, setTabId] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<unknown>('grok-desktop://completion-popup', (event) => {
      const id = tabIdFromPayload(event.payload);
      if (id) setTabId(id);
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => unlisten?.();
  }, []);

  const openSession = async () => {
    try {
      await invoke('open_completion_session', tabId ? { tabId } : {});
    } catch (error) {
      console.error('Failed to open completed session', error);
    }
  };

  return (
    <div
      className="completion-popup-shell"
      role="button"
      tabIndex={0}
      aria-label="Open completed session"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        void openSession();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          void openSession();
        }
      }}
    >
      <div className="completion-popup-card">
        <img className="completion-popup-mark" src={appIcon} alt="" />
        <div className="completion-popup-copy">
          <div className="completion-popup-title">Grok Build Desktop</div>
          <div className="completion-popup-message">A response has finished.</div>
        </div>
      </div>
    </div>
  );
}
