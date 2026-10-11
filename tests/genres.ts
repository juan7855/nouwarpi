// Generador de canciones sintéticas con sonidos de batería creíbles y patrones de géneros reales.
// Sirve para comprobar que el seguidor de pulsos NO se engancha al contratiempo, a la caja o a
// los charleys (un fallo típico que hace que una canción suene "corrida").

export interface GenreSpec {
  name: string;
  bpm: number;
  swing: number; // 0.5 = recto; 0.6 = shuffle fuerte (retrasa las semicorcheas impares)
  kick: number[]; // pasos de semicorchea dentro del compás (0..15)
  snare: number[];
  clap: number[];
  hat: number[]; // charley cerrado
  openHat: number[]; // charley abierto (a contratiempo en house)
  bassSteps: number[]; // notas de bajo (sostenidas hasta el siguiente paso)
  hatLevel: number;
  openLevel: number;
  kickLevel: number;
  humanizeMs: number;
  tempoWobble: number; // fracción: variación lenta del tempo (batería en vivo)
  felt: number; // pulsos "sentidos" por compás de 16 pasos (4 = negras)
}

export const GENRES: GenreSpec[] = [
  {
    name: "house 124 (hat abierto a contratiempo MÁS fuerte que el bombo)",
    bpm: 124, swing: 0.5, kick: [0, 4, 8, 12], snare: [], clap: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14],
    openHat: [2, 6, 10, 14], bassSteps: [2, 6, 10, 14], hatLevel: 0.3, openLevel: 0.75, kickLevel: 0.7,
    humanizeMs: 1, tempoWobble: 0, felt: 4,
  },
  {
    name: "hip-hop 90 (swing, caja en 2 y 4)",
    bpm: 90, swing: 0.58, kick: [0, 7, 10], snare: [4, 12], clap: [], hat: [0, 2, 4, 6, 8, 10, 12, 14],
    openHat: [], bassSteps: [0, 7, 10], hatLevel: 0.5, openLevel: 0, kickLevel: 0.9,
    humanizeMs: 6, tempoWobble: 0, felt: 4,
  },
  {
    name: "trap 140 (caja a medio tiempo, bombo sincopado, hats rápidos)",
    bpm: 140, swing: 0.5, kick: [0, 7, 10], snare: [8], clap: [8], hat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    openHat: [], bassSteps: [0, 7, 10], hatLevel: 0.4, openLevel: 0, kickLevel: 0.9,
    humanizeMs: 0, tempoWobble: 0, felt: 4,
  },
  {
    name: "drum & bass 174",
    bpm: 174, swing: 0.5, kick: [0, 10], snare: [4, 12], clap: [], hat: [0, 2, 4, 6, 8, 10, 12, 14],
    openHat: [], bassSteps: [0, 3, 6, 10, 13], hatLevel: 0.45, openLevel: 0, kickLevel: 0.9,
    humanizeMs: 2, tempoWobble: 0, felt: 4,
  },
  {
    name: "rock 110 en vivo (humanizado, tempo respira)",
    bpm: 110, swing: 0.52, kick: [0, 8, 10], snare: [4, 12], clap: [], hat: [0, 2, 4, 6, 8, 10, 12, 14],
    openHat: [], bassSteps: [0, 4, 8, 12], hatLevel: 0.5, openLevel: 0, kickLevel: 0.9,
    humanizeMs: 9, tempoWobble: 0.025, felt: 4,
  },
  {
    name: "breakbeat 130 (sincopado)",
    bpm: 130, swing: 0.5, kick: [0, 3, 10], snare: [4, 11, 12], clap: [], hat: [0, 2, 4, 6, 8, 10, 12, 14],
    openHat: [14], bassSteps: [0, 3, 10], hatLevel: 0.5, openLevel: 0.5, kickLevel: 0.9,
    humanizeMs: 3, tempoWobble: 0, felt: 4,
  },
  {
    name: "pop 100 (bombo en 1 y 3, caja en 2 y 4, panderos)",
    bpm: 100, swing: 0.5, kick: [0, 8], snare: [4, 12], clap: [], hat: [0, 2, 4, 6, 8, 10, 12, 14],
    openHat: [], bassSteps: [0, 8], hatLevel: 0.55, openLevel: 0, kickLevel: 0.85,
    humanizeMs: 4, tempoWobble: 0, felt: 4,
  },
];

export interface GenreSong {
  chs: Float32Array[];
  sr: number;
  bpm: number;
  beatT: number[]; // posiciones verdaderas de cada negra (s)
  barT: number[]; // inicios de compás
  stepT: (bar: number, step: number) => number;
}

export function makeGenreSong(spec: GenreSpec, opts: { sr?: number; bars?: number; introBars?: number; startSec?: number; seed?: number } = {}): GenreSong {
  const sr = opts.sr ?? 44100;
  const bars = opts.bars ?? 28;
  const introBars = opts.introBars ?? 2;
  const start = opts.startSec ?? 0.6;
  let seed = opts.seed ?? 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const rn = () => rnd() * 2 - 1;

  // tempo con "respiración": la duración de cada compás cambia lentamente
  const barDur: number[] = [];
  for (let b = 0; b < bars + 2; b++) barDur.push((240 / spec.bpm) * (1 + spec.tempoWobble * Math.sin(b / 3.1)));
  const barStart: number[] = [start];
  for (let b = 0; b < bars + 1; b++) barStart.push(barStart[b] + barDur[b]);
  const stepT = (bar: number, step: number) => {
    const sd = barDur[bar] / 16;
    // el swing retrasa las semicorcheas impares
    const swung = step % 2 === 1 ? step - 1 + 2 * spec.swing : step;
    return barStart[bar] + swung * sd;
  };
  const beatT: number[] = [];
  const barT: number[] = [];
  for (let b = 0; b < bars; b++) {
    barT.push(barStart[b]);
    for (let q = 0; q < 4; q++) beatT.push(barStart[b] + q * (barDur[b] / 4));
  }

  const len = Math.ceil((barStart[bars] + 2) * sr);
  const L = new Float32Array(len);
  const R = new Float32Array(len);
  const add = (t: number, n: number, fn: (i: number, x: number) => number, pan = 0.5) => {
    const s0 = Math.round(t * sr);
    for (let i = 0; i < n && s0 + i < len; i++) {
      const v = fn(i, i / sr);
      L[s0 + i] += v * (1 - pan) * 1.4;
      R[s0 + i] += v * pan * 1.4;
    }
  };

  // colchón de acordes continuo desde el principio (también durante la intro)
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const v = 0.05 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277.2 * t) + Math.sin(2 * Math.PI * 329.6 * t));
    L[i] += v;
    R[i] += v;
  }

  for (let b = introBars; b < bars; b++) {
    const jit = (ms: number) => (rn() * ms) / 1000;
    for (const s of spec.kick) {
      const t = stepT(b, s) + jit(spec.humanizeMs);
      const vel = spec.kickLevel * (1 + 0.1 * rn());
      add(t, Math.round(0.4 * sr), (_i, x) => {
        const f = 48 + 120 * Math.exp(-x * 38);
        const click = x < 0.004 ? rn() * 0.5 : 0;
        return (Math.sin(2 * Math.PI * f * x) * Math.exp(-x * 9) + click) * vel;
      });
    }
    for (const s of spec.snare) {
      const t = stepT(b, s) + jit(spec.humanizeMs);
      add(t, Math.round(0.25 * sr), (_i, x) => (rn() * Math.exp(-x * 22) * 0.55 + Math.sin(2 * Math.PI * 190 * x) * Math.exp(-x * 30) * 0.4) * (1 + 0.1 * rn()));
    }
    for (const s of spec.clap) {
      const t = stepT(b, s) + jit(spec.humanizeMs);
      for (let k = 0; k < 3; k++) add(t + k * 0.011, Math.round(0.12 * sr), (_i, x) => rn() * Math.exp(-x * 35) * 0.4);
    }
    let prevN = 0;
    for (const s of spec.hat) {
      const t = stepT(b, s) + jit(spec.humanizeMs);
      add(t, Math.round(0.06 * sr), (_i, x) => {
        const n = rn();
        const hp = n - prevN;
        prevN = n;
        return hp * Math.exp(-x * 95) * spec.hatLevel * (1 + 0.2 * rn());
      }, 0.6);
    }
    for (const s of spec.openHat) {
      const t = stepT(b, s) + jit(spec.humanizeMs);
      add(t, Math.round(0.28 * sr), (_i, x) => {
        const n = rn();
        const hp = n - prevN;
        prevN = n;
        return hp * Math.exp(-x * 11) * spec.openLevel;
      }, 0.4);
    }
    // bajo: notas sostenidas hasta el siguiente paso de la lista
    const steps = spec.bassSteps.slice().sort((a, c) => a - c);
    steps.forEach((s, k) => {
      const t = stepT(b, s);
      const end = k + 1 < steps.length ? stepT(b, steps[k + 1]) : barStart[b + 1];
      const dur = Math.max(0.1, end - t);
      add(t, Math.round(dur * sr), (_i, x) => {
        const env = Math.min(1, x * 80) * Math.min(1, (dur - x) * 40);
        return (Math.sin(2 * Math.PI * 55 * x) + 0.3 * Math.sin(2 * Math.PI * 110 * x)) * env * 0.3;
      });
    });
  }
  return { chs: [L, R], sr, bpm: spec.bpm, beatT, barT, stepT };
}
