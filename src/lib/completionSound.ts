let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined' || typeof window.AudioContext === 'undefined') return null;
  audioContext ??= new window.AudioContext();
  return audioContext;
}

/** Unlock the Web Audio context from a user gesture so a later background run can chime. */
export function primeCompletionSound(): void {
  const context = getAudioContext();
  if (context?.state === 'suspended') void context.resume().catch(() => undefined);
}

/** Play a short, self-contained two-note completion chime. */
export function playCompletionSound(): void {
  const context = getAudioContext();
  if (!context) return;

  const start = context.currentTime;
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.7, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.32);
  gain.connect(context.destination);

  const oscillator = context.createOscillator();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(880, start);
  oscillator.frequency.setValueAtTime(1174.66, start + 0.11);
  oscillator.connect(gain);
  oscillator.start(start);
  oscillator.stop(start + 0.34);
  oscillator.addEventListener('ended', () => {
    oscillator.disconnect();
    gain.disconnect();
  });
  if (context.state === 'suspended') void context.resume().catch(() => undefined);
}
