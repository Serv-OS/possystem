// v5.5.122 — louder, longer, doubled-up new-order chime.
// Plays a major-triad arpeggio (E5 → G5 → B5) twice with a short gap so
// it cuts through restaurant ambient noise. Gain 0.95 (just below clipping).
// If the AudioContext is in a browser-suspended state (autoplay policy)
// we resume it on first call.

let ctx = null;

export function playOrderChime() {
  try {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume?.();

    const notes = [659.25, 783.99, 987.77]; // E5 G5 B5 — major triad
    const playTriad = (startOffset) => {
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle'; // richer than sine, less harsh than square
        osc.frequency.value = freq;
        const t = ctx.currentTime + startOffset + i * 0.13;
        gain.gain.setValueAtTime(0.95, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.55);
      });
    };
    playTriad(0);     // first triad
    playTriad(0.85);  // doubled up — same triad again 0.85s later
  } catch (e) {
    console.warn('[orderChime] audio failed:', e?.message);
  }
}
