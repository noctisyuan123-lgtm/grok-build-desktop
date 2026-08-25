import appIcon from '../../src-tauri/icons/icon.png';

export function CompletionPopup() {
  return (
    <div className="completion-popup-shell" role="status" aria-live="polite">
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
