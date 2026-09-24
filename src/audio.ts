// Synthesized UI sounds; no audio files. The context starts on the Start AR click.
let ctx: AudioContext | null = null;

export function unlockAudio() {
  ctx ??= new AudioContext();
  void ctx.resume();
}

function blip(freq: number, dur: number, gain: number, type: OscillatorType = 'sine', delay = 0) {
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  o.frequency.exponentialRampToValueAtTime(freq * 0.6, t + dur);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + dur);
}

/** A short filtered noise burst: the plastic click of a layer. */
function click(gain: number, delay = 0) {
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const len = Math.floor(ctx.sampleRate * 0.03);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 4);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = 2800;
  f.Q.value = 1.2;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(ctx.destination);
  src.start(t);
}

export const sfx = {
  turnStart: () => click(0.5),
  turnEnd: () => click(0.8),
  grab: () => blip(520, 0.07, 0.15),
  release: () => blip(360, 0.08, 0.12),
  hover: () => blip(1200, 0.025, 0.04),
  button: () => { blip(880, 0.05, 0.15, 'triangle'); },
  land: (v: number) => click(Math.min(1, v * 0.6)),
  spawn: () => { blip(440, 0.12, 0.1); blip(660, 0.12, 0.1, 'sine', 0.08); },
  solved: () => [523, 659, 784, 1047].forEach((f, i) => blip(f, 0.25, 0.14, 'triangle', i * 0.1)),
};
