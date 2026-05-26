/**
 * Plays a completion notification sound using the Web Audio API.
 * Synthesizes a pleasant two-tone chime.
 * @param volume 0–100 (0 = silent / off, 100 = full volume)
 */
export function playCompletionSound(volume: number): void {
  if (volume <= 0) return;

  const ctx = new AudioContext();

  // Resume the context in case autoplay policy has it suspended
  // (happens when triggered from a non-user-gesture like a postMessage handler).
  const play = () => {
    const normalizedVolume = Math.min(100, Math.max(1, volume)) / 100;

    // First tone — a soft "ding"
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(880, ctx.currentTime); // A5
    gain1.gain.setValueAtTime(normalizedVolume * 0.4, ctx.currentTime);
    gain1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(ctx.currentTime);
    osc1.stop(ctx.currentTime + 0.3);

    // Second tone — slightly higher, delayed
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(1174.66, ctx.currentTime + 0.15); // D6
    gain2.gain.setValueAtTime(0.001, ctx.currentTime);
    gain2.gain.setValueAtTime(normalizedVolume * 0.3, ctx.currentTime + 0.15);
    gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(ctx.currentTime + 0.15);
    osc2.stop(ctx.currentTime + 0.5);

    // Cleanup after sound finishes
    setTimeout(() => {
      void ctx.close();
    }, 600);
  };

  if (ctx.state === 'suspended') {
    void ctx.resume().then(play);
  } else {
    play();
  }
}
