// Generador de "canciones" sintéticas para probar el seguimiento de pulsos.
export function makeSong(opts: {
  sr: number; bars: number; bpmAt: (beat: number) => number; introSec: number; jitterMs?: number; seed?: number;
}) {
  const { sr, bars, bpmAt, introSec } = opts;
  let seed = opts.seed ?? 1;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  // posición temporal de cada pulso (verdad)
  const nBeats = bars * 4;
  const beatT: number[] = [introSec];
  for (let b = 1; b <= nBeats + 4; b++) beatT.push(beatT[b - 1] + 60 / bpmAt(b - 1));
  const jit = (opts.jitterMs ?? 0) / 1000;
  const hitT = beatT.map((t, i) => (i === 0 ? t : t + (rnd() * 2 - 1) * jit));
  const len = Math.ceil((beatT[nBeats] + 1.5) * sr);
  const L = new Float32Array(len), R = new Float32Array(len);
  const add = (t: number, fn: (i: number) => number, n: number, pan = 0.5) => {
    const s0 = Math.round(t * sr);
    for (let i = 0; i < n && s0 + i < len; i++) { const v = fn(i); L[s0 + i] += v * (1 - pan) * 1.4; R[s0 + i] += v * pan * 1.4; }
  };
  // colchón armónico continuo desde t=0 (también en la intro, sin ataques marcados)
  for (let i = 0; i < len; i++) {
    const t = i / sr; const v = 0.05 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277.2 * t) + Math.sin(2 * Math.PI * 329.6 * t));
    L[i] += v; R[i] += v;
  }
  for (let b = 0; b < nBeats; b++) {
    const t = hitT[b], bar = b % 4 === 0;
    if (t < introSec + 8 * 60 / bpmAt(0) * 0 && b < 0) continue;
    if (b >= 8) { // la batería entra tras 2 compases de intro
      add(t, (i) => { const x = i / sr; return Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-x * 40)) * x) * Math.exp(-x * 14) * (bar ? 0.9 : 0.75); }, Math.round(0.3 * sr));
      if (b % 4 === 1 || b % 4 === 3) add(t, (i) => (rnd() * 2 - 1) * Math.exp(-(i / sr) * 25) * 0.5, Math.round(0.15 * sr));
      const half = (hitT[b + 1] - t) / 2;
      for (const tt of [t, t + half]) add(tt, (i) => { const w = rnd() * 2 - 1; return w * Math.exp(-(i / sr) * 90) * 0.18; }, Math.round(0.05 * sr));
    }
    if (bar) add(t, (i) => { const x = i / sr; return Math.sin(2 * Math.PI * 55 * x) * Math.exp(-x * 2.2) * Math.min(1, x * 100) * 0.4; }, Math.round(1.6 * sr));
  }
  return { chs: [L, R], beatT: hitT, sr };
}
