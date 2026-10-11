// Seguimiento de pulsos de una canción completa (DSP puro, sin dependencias del navegador).
//
//  1. Fuerza de ataque por bandas (flujo espectral en escala logarítmica).
//  2. Tempo global por autocorrelación de TODA la canción, con prior perceptual.
//  3. Pulsos por programación dinámica (Ellis 2007): cada pulso se coloca donde hay
//     un ataque, manteniendo el intervalo cercano al tempo.
//  4. Refinado de cada pulso con una envolvente fina (~1,5 ms).
//  5. Ajuste de tempo por mínimos cuadrados (precisión < 0,01 BPM en tempo estable) y
//     medición de la deriva para saber si basta un tempo constante.
//  6. Tiempo fuerte (compás) por la energía de graves en cada fase del compás.

import { FFT, hannWindow } from "./dsp";

export interface BeatTrack {
  beats: number[]; // segundos, cubren toda la canción (extrapolados donde no hay ataques)
  beatGood: boolean[]; // por pulso: true si cae sobre un ataque real detectado (false = extrapolado)
  bpm: number; // tempo medio (ajuste de mínimos cuadrados)
  period: number; // segundos por pulso (ajuste)
  rmsMs: number; // desvío cuadrático medio de los pulsos respecto a la rejilla constante
  driftMs: number; // desvío máximo de la tendencia lenta (con tempo variable crece)
  constantOk: boolean; // true si un tempo constante basta
  confidence: number; // 0..1
  downbeatPhase: number; // 0..beatsPerBar-1: índice de pulso (módulo) que más pesa
  downbeatMargin: number; // 0..1: cuánto destaca esa fase (poco = ambiguo: todos los pulsos suenan igual)
  firstSoundSec: number; // primer instante con sonido real
  contentEnd: number; // último instante con sonido real (s)
  goodBeats: number; // pulsos con ataque real y coherente (pocos = sin pulso claro)
  onsets: OnsetEvent[]; // ataques detectados con su fuerza (los usa Estefa)
}

export interface OnsetEvent {
  t: number; // segundos
  s: number; // fuerza 0..1
}

interface Onset {
  env: Float32Array; // fuerza de ataque normalizada
  low: Float32Array; // fuerza en graves (bombo/bajo)
  body: Float32Array; // fuerza sin los agudos (bombo, caja, bajo, voces): los charleys no deciden el pulso
  hop: number;
  sr: number;
  N: number; // tamaño de FFT
}

/* ---------------- 1. fuerza de ataque ---------------- */

function onsetStrength(x: Float32Array, sr: number): Onset {
  let N = 1024;
  while (N < sr * 0.046) N <<= 1;
  const hop = Math.round(sr * 0.0116);
  const frames = Math.max(1, Math.floor((x.length - N) / hop) + 1);
  const fft = new FFT(N);
  const win = hannWindow(N);
  const re = new Float32Array(N);
  const im = new Float32Array(N);

  const nBands = 20;
  const fLo = 30;
  const fHi = Math.min(11000, sr * 0.45);
  const binHz = sr / N;
  const edges: number[] = [];
  for (let b = 0; b <= nBands; b++) edges.push(Math.max(1, Math.round((fLo * Math.pow(fHi / fLo, b / nBands)) / binHz)));
  for (let b = 1; b <= nBands; b++) if (edges[b] <= edges[b - 1]) edges[b] = edges[b - 1] + 1;

  const mags = new Float32Array(frames * nBands);
  let ref = 1e-9;
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < N; i++) {
      re[i] = (x[off + i] || 0) * win[i];
      im[i] = 0;
    }
    fft.transform(re, im, true);
    for (let b = 0; b < nBands; b++) {
      let s = 0;
      for (let k = edges[b]; k < edges[b + 1]; k++) s += Math.hypot(re[k], im[k]);
      s /= edges[b + 1] - edges[b];
      mags[f * nBands + b] = s;
      if (s > ref) ref = s;
    }
  }

  // compresión logarítmica (dB relativos al máximo) → ataques de cualquier nivel cuentan
  const c = 1000 / ref;
  const env = new Float32Array(frames);
  const low = new Float32Array(frames);
  const body = new Float32Array(frames);
  const lowBands = 5; // ~30-170 Hz
  const bodyBands = 16; // hasta ~3,5 kHz
  const prev = new Float32Array(nBands);
  for (let b = 0; b < nBands; b++) prev[b] = Math.log1p(c * mags[b]);
  for (let f = 1; f < frames; f++) {
    let fl = 0;
    let lw = 0;
    let bw = 0;
    for (let b = 0; b < nBands; b++) {
      const v = Math.log1p(c * mags[f * nBands + b]);
      const d = v - prev[b];
      if (d > 0) {
        fl += d;
        if (b < lowBands) lw += d;
        if (b < bodyBands) bw += d;
      }
      prev[b] = v;
    }
    env[f] = fl;
    low[f] = lw;
    body[f] = bw;
  }

  normalizeEnv(env, Math.round(1 / (hop / sr)));
  normalizeEnv(low, Math.round(1 / (hop / sr)));
  normalizeEnv(body, Math.round(1 / (hop / sr)));
  return { env, low, body, hop, sr, N };
}

// resta la media local (~1 s) y normaliza por la desviación: ataques comparables en toda la canción
function normalizeEnv(e: Float32Array, win: number) {
  const n = e.length;
  const cs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + e[i];
  const out = new Float32Array(n);
  let sd = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - win);
    const b = Math.min(n, i + win + 1);
    const m = (cs[b] - cs[a]) / (b - a);
    const v = Math.max(0, e[i] - m);
    out[i] = v;
    sd += v * v;
  }
  sd = Math.sqrt(sd / Math.max(1, n)) || 1;
  for (let i = 0; i < n; i++) e[i] = out[i] / sd;
}

/* ---------------- 2. tempo global ---------------- */

// Candidatos de periodo (en fotogramas): picos de la autocorrelación de TODA la canción, más sus
// octavas (×2, ÷2) y relaciones 3:2. No se decide aquí: cada candidato se prueba con el seguidor
// de pulsos y gana el que mejor cae sobre golpes fuertes (ver trackBeats).
function periodCandidates(o: Onset): number[] {
  const { env, hop, sr } = o;
  const fps = sr / hop;
  const n = env.length;
  const minLag = Math.max(2, Math.floor((60 / 215) * fps));
  const maxLag = Math.min(n - 2, Math.ceil((60 / 55) * fps));
  if (maxLag <= minLag) return [(60 / 120) * fps];

  const ac = new Float64Array(maxLag * 2 + 4);
  let e0 = 0;
  for (let i = 0; i < n; i++) e0 += env[i] * env[i];
  e0 = e0 / n || 1;
  const top = Math.min(ac.length - 1, maxLag * 2 + 2);
  for (let lag = minLag; lag <= top; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += env[i] * env[i + lag];
    ac[lag] = n - lag > 0 ? s / (n - lag) / e0 : 0;
  }
  // refuerzo armónico (un pulso real también repite a 2× y 4× su periodo)
  const score = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let v = ac[lag];
    if (2 * lag < ac.length) v += 0.5 * ac[2 * lag];
    if (4 * lag < ac.length) v += 0.25 * ac[4 * lag];
    score[lag] = v;
  }
  const peaks: { lag: number; v: number }[] = [];
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (score[lag] > score[lag - 1] && score[lag] >= score[lag + 1]) {
      const y0 = score[lag - 1];
      const y1 = score[lag];
      const y2 = score[lag + 1];
      const d = y0 - 2 * y1 + y2;
      peaks.push({ lag: Math.abs(d) > 1e-12 ? lag + (0.5 * (y0 - y2)) / d : lag, v: y1 });
    }
  }
  peaks.sort((a, b) => b.v - a.v);
  const out: number[] = [];
  const push = (l: number) => {
    if (l < minLag || l > maxLag) return;
    if (out.some((x) => Math.abs(Math.log2(x / l)) < 0.03)) return;
    out.push(l);
  };
  for (const pk of peaks.slice(0, 5)) {
    push(pk.lag);
    push(pk.lag * 2);
    push(pk.lag / 2);
    push(pk.lag * 1.5);
    push(pk.lag / 1.5);
  }
  return out.length ? out : [(60 / 120) * fps];
}

// Preferencia suave por los tempos habituales (centrada hacia ~115 BPM, muy ancha: solo desempata).
const tempoPrior = (bpm: number) => Math.exp(-0.5 * Math.pow(Math.log2(bpm / 115) / 1.2, 2));

// Calidad de una cadena de pulsos: fuerza media del ataque en los pulsos, penalizando los que
// caen en el vacío. Un tempo demasiado rápido deja pulsos vacíos; uno demasiado lento solo
// aprovecha los golpes más fuertes (lo equilibra la preferencia por tempos habituales).
function chainQuality(o: Onset, frames: number[], strongPeaks: number[]): number {
  if (frames.length < 4) return 0;
  let s = 0;
  let hit = 0;
  for (const f of frames) {
    let m = 0;
    for (let d = -2; d <= 2; d++) {
      const j = f + d;
      if (j >= 0 && j < o.env.length && o.env[j] > m) m = o.env[j];
    }
    s += m;
    if (m > 0.5) hit++;
  }
  // rejilla de pulsos y medios pulsos de la cadena: los golpes fuertes deben caer en ella.
  // Castiga a la vez el tempo equivocado y la fase equivocada (p. ej. enganchar la síncopa).
  const lat: number[] = [];
  for (let i = 0; i < frames.length; i++) {
    lat.push(frames[i]);
    if (i + 1 < frames.length) lat.push((frames[i] + frames[i + 1]) / 2);
  }
  let on = 0;
  let total = 0;
  const tol = 3;
  for (const pk of strongPeaks) {
    if (pk < lat[0] - tol || pk > lat[lat.length - 1] + tol) continue;
    total++;
    let lo = 0;
    let hi = lat.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lat[mid] < pk) lo = mid + 1;
      else hi = mid;
    }
    const d = Math.min(Math.abs(lat[lo] - pk), lo > 0 ? Math.abs(lat[lo - 1] - pk) : 1e9);
    if (d <= tol) on++;
  }
  const lattice = total ? on / total : 0.5;
  return (s / frames.length) * (0.4 + 0.6 * (hit / frames.length)) * (0.4 + 0.6 * lattice);
}

/* ---------------- 3. programación dinámica ---------------- */

function dpBeats(o: Onset, periodFrames: number): number[] {
  const { env } = o;
  const n = env.length;
  const alpha = 120;
  const cum = new Float64Array(n);
  const prev = new Int32Array(n).fill(-1);
  const lo = Math.max(1, Math.round(periodFrames / 2));
  const hi = Math.round(periodFrames * 2);
  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let arg = -1;
    for (let tau = Math.max(0, t - hi); tau <= t - lo; tau++) {
      const dlt = t - tau;
      const l = Math.log(dlt / periodFrames);
      const sc = cum[tau] - alpha * l * l;
      if (sc > best) {
        best = sc;
        arg = tau;
      }
    }
    if (arg >= 0 && best > 0) {
      cum[t] = env[t] + best;
      prev[t] = arg;
    } else {
      cum[t] = env[t];
    }
  }
  // el final de la mejor cadena debe estar en el último periodo y medio
  let end = n - 1;
  let bestC = -Infinity;
  for (let t = Math.max(0, n - 1 - Math.round(periodFrames * 1.5)); t < n; t++) {
    if (cum[t] > bestC) {
      bestC = cum[t];
      end = t;
    }
  }
  const out: number[] = [];
  for (let t = end; t >= 0; t = prev[t]) {
    out.push(t);
    if (prev[t] < 0) break;
  }
  return out.reverse();
}

/* ---------------- 4. refinado fino ---------------- */

// Flujo espectral log por bandas con ventana de ~11 ms y salto de ~3 ms: localiza el
// ataque con ~3 ms de precisión y distingue un golpe encima de un bajo sostenido
// (la envolvente RMS oscila con los graves y daba ataques falsos).
export interface FineEnv {
  env: Float32Array;
  hop: number;
  sr: number;
  delay: number; // segundos entre el inicio de la ventana y el ataque que dispara el flujo
}

const FINE_DELAY_FRAC = 0.77; // calibrado con ataques sintéticos de posición conocida

export function fineFlux(x: Float32Array, sr: number): FineEnv {
  const N = sr > 60000 ? 1024 : 512;
  const hop = N / 4;
  const frames = Math.max(1, Math.floor((x.length - N) / hop) + 1);
  const fft = new FFT(N);
  const win = hannWindow(N);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const nBands = 12;
  const edges: number[] = [];
  const hiBin = Math.floor((N / 2) * 0.85);
  for (let b = 0; b <= nBands; b++) edges.push(Math.max(1, Math.round(Math.pow(hiBin, b / nBands))));
  for (let b = 1; b <= nBands; b++) if (edges[b] <= edges[b - 1]) edges[b] = edges[b - 1] + 1;

  const mags = new Float32Array(frames * nBands);
  let ref = 1e-9;
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < N; i++) {
      re[i] = x[off + i] * win[i];
      im[i] = 0;
    }
    fft.transform(re, im, true);
    for (let b = 0; b < nBands; b++) {
      let s = 0;
      for (let k = edges[b]; k < edges[b + 1]; k++) s += Math.hypot(re[k], im[k]);
      s /= edges[b + 1] - edges[b];
      mags[f * nBands + b] = s;
      if (s > ref) ref = s;
    }
  }
  const c = 1000 / ref;
  const env = new Float32Array(frames);
  const prev = new Float32Array(nBands);
  for (let b = 0; b < nBands; b++) prev[b] = Math.log1p(c * mags[b]);
  for (let f = 1; f < frames; f++) {
    let fl = 0;
    for (let b = 0; b < nBands; b++) {
      const v = Math.log1p(c * mags[f * nBands + b]);
      const d = v - prev[b];
      if (d > 0) fl += d;
      prev[b] = v;
    }
    env[f] = fl;
  }
  return { env, hop, sr, delay: (FINE_DELAY_FRAC * N) / sr };
}

// Ataques con su fuerza (0..1, relativa a los más fuertes de la señal).
export function onsetEvents(fine: FineEnv): OnsetEvent[] {
  const { env, hop, sr, delay } = fine;
  const nf = env.length;
  if (nf < 16) return [];
  const sample: number[] = [];
  for (let i = 0; i < nf; i += 3) sample.push(env[i]);
  sample.sort((a, b) => a - b);
  const scale = sample[Math.floor(sample.length * 0.99)];
  if (!(scale > 0)) return [];
  const thr = Math.max(0.25 * scale, 1.5); // umbral absoluto: sin ataques reales no hay nada
  const R = 6; // máximo local en ±6 fotogramas (~17 ms)
  const minGap = 0.02;
  const out: OnsetEvent[] = [];
  for (let f = R; f < nf - R; f++) {
    const v = env[f];
    if (v < thr) continue;
    let isMax = true;
    for (let d = -R; d <= R; d++) {
      if (env[f + d] > v || (env[f + d] === v && d < 0)) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;
    let st = f;
    while (st > f - 10 && st > 1 && env[st - 1] >= 0.35 * v) st--;
    const t = (st * hop) / sr + delay;
    if (!out.length || t - out[out.length - 1].t >= minGap) out.push({ t, s: Math.min(1, v / scale) });
  }
  return out;
}

// Un ataque real SUBE la energía respecto a los ~40 ms anteriores; un "bache" dentro de la
// cola de un golpe grave (flujo espectral que oscila mientras la señal decae) no. Se descartan
// los segundos.
export function validateOnsets(x: Float32Array, sr: number, ev: OnsetEvent[]): OnsetEvent[] {
  const rms = (a: number, b: number) => {
    const i0 = Math.max(0, Math.floor(a * sr));
    const i1 = Math.min(x.length, Math.floor(b * sr));
    if (i1 <= i0) return 0;
    let s = 0;
    for (let i = i0; i < i1; i++) s += x[i] * x[i];
    return Math.sqrt(s / (i1 - i0));
  };
  const kept: { e: OnsetEvent; loud: number }[] = [];
  for (const e of ev) {
    const after = rms(e.t, e.t + 0.03);
    const before = rms(e.t - 0.045, e.t - 0.005);
    if (after >= 1.25 * before || before < 1e-4) kept.push({ e, loud: after });
  }
  if (!kept.length) return [];
  // la fuerza espectral satura casi siempre en 1; la sonoridad conserva los acentos
  const sorted = kept.map((k) => k.loud).sort((a, b) => a - b);
  const ref = Math.max(1e-9, sorted[Math.floor(sorted.length * 0.9)]);
  return kept.map(({ e, loud }) => ({ t: e.t, s: Math.min(1, 0.7 * Math.min(1, loud / ref) + 0.3 * e.s) }));
}

// Inicio real del ataque cerca de approxSec (±winSec). null si no hay ataque claro.
export function refineOnset(fine: FineEnv, approxSec: number, winSec = 0.04): { t: number; peak: number } | null {
  const { env, hop, sr, delay } = fine;
  const c = Math.round(((approxSec - delay) * sr) / hop);
  const r = Math.round((winSec * sr) / hop);
  const lo = Math.max(1, c - r);
  const hi = Math.min(env.length - 1, c + r);
  let mx = 0;
  for (let f = lo; f <= hi; f++) if (env[f] > mx) mx = env[f];
  if (mx <= 0) return null;
  for (let f = lo; f <= hi; f++) if (env[f] >= 0.35 * mx) return { t: (f * hop) / sr + delay, peak: mx };
  return null;
}

/* ---------------- 5. ajuste por mínimos cuadrados ---------------- */

function fitLine(idx: number[], t: number[]): { t0: number; T: number } {
  const n = idx.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += idx[i];
    sy += t[i];
    sxx += idx[i] * idx[i];
    sxy += idx[i] * t[i];
  }
  const den = n * sxx - sx * sx;
  const T = den ? (n * sxy - sx * sy) / den : 0;
  return { T, t0: (sy - T * sx) / n };
}

export function fitTempo(beats: number[]): { t0: number; T: number; rms: number; drift: number } {
  const idx = beats.map((_, i) => i);
  let use = idx.slice();
  let fit = fitLine(use, use.map((i) => beats[i]));
  for (let pass = 0; pass < 2; pass++) {
    const res = idx.map((i) => beats[i] - (fit.t0 + fit.T * i));
    const abs = res.map(Math.abs).sort((a, b) => a - b);
    const mad = abs[Math.floor(abs.length / 2)] || 1e-4;
    use = idx.filter((i) => Math.abs(res[i]) < Math.max(0.012, 4 * mad));
    if (use.length < 4) break;
    fit = fitLine(use, use.map((i) => beats[i]));
  }
  const res = idx.map((i) => beats[i] - (fit.t0 + fit.T * i));
  let ss = 0;
  for (const i of use) ss += res[i] * res[i];
  const rms = Math.sqrt(ss / Math.max(1, use.length));
  // tendencia lenta: media móvil de 8 pulsos del residuo (la variación de tempo real)
  const w = 8;
  let drift = 0;
  for (let i = 0; i + w <= res.length; i += 2) {
    let m = 0;
    for (let k = 0; k < w; k++) m += res[i + k];
    drift = Math.max(drift, Math.abs(m / w));
  }
  return { t0: fit.t0, T: fit.T, rms, drift };
}

/* ---------------- principal ---------------- */

export function trackBeats(
  x: Float32Array,
  sr: number,
  beatsPerBar = 4,
  onProgress: (f: number) => void = () => {}
): BeatTrack {
  const dur = x.length / sr;
  onProgress(0.05);
  const o0 = onsetStrength(x, sr);
  // el tempo y los pulsos se deciden sobre todo con el CUERPO de la música; los charleys en
  // corcheas hacen que el pulso 'rápido' parezca el real (error de octava) y atraen al contratiempo
  const mixed = new Float32Array(o0.env.length);
  for (let i = 0; i < mixed.length; i++) mixed[i] = 0.75 * o0.body[i] + 0.25 * o0.env[i];
  const o: Onset = { ...o0, env: mixed };
  onProgress(0.5);
  // cada tempo candidato se prueba con el seguidor de pulsos; gana el que mejor cae sobre golpes
  const strongPeaks: number[] = [];
  {
    let mx = 0;
    for (const v of o.env) if (v > mx) mx = v;
    for (let i = 2; i < o.env.length - 2; i++) {
      const v = o.env[i];
      if (v > 0.35 * mx && v >= o.env[i - 1] && v > o.env[i + 1] && v >= o.env[i - 2] && v > o.env[i + 2]) strongPeaks.push(i);
    }
  }
  let periodFrames = 0;
  let frames: number[] = [];
  let bestScore = -1;
  let secondScore = -1;
  for (const cand of periodCandidates(o)) {
    const fr = dpBeats(o, cand);
    const bpmC = (60 * o.sr) / (cand * o.hop);
    const sc = chainQuality(o, fr, strongPeaks) * tempoPrior(bpmC);
    if (sc > bestScore) {
      secondScore = bestScore;
      bestScore = sc;
      periodFrames = cand;
      frames = fr;
    } else if (sc > secondScore) secondScore = sc;
  }
  const confidence = bestScore > 0 ? Math.max(0, Math.min(1, 1 - Math.max(0, secondScore) / bestScore)) : 0;
  const period0 = (periodFrames * o.hop) / sr;

  onProgress(0.8);
  const fine = fineFlux(x, sr);
  const onsets = validateOnsets(x, sr, onsetEvents(fine));
  const contentEnd = lastSound(x, sr);

  // pulsos del DP (solo sirven para elegir tempo/octava): se afinan con los ataques reales
  const dpTimes = frames.map((f) => (f * o.hop + o.N * 0.7) / sr);
  const dpDiffs: number[] = [];
  for (let i = 1; i < dpTimes.length; i++) dpDiffs.push(dpTimes[i] - dpTimes[i - 1]);
  dpDiffs.sort((a, b) => a - b);
  const dpT = dpDiffs.length ? dpDiffs[Math.floor(dpDiffs.length / 2)] : period0;

  const empty = (T: number): BeatTrack => ({
    beats: gridBeats(0, T, dur),
    beatGood: gridBeats(0, T, dur).map(() => false),
    bpm: 60 / T,
    period: T,
    rmsMs: 0,
    driftMs: 0,
    constantOk: true,
    confidence: 0,
    downbeatPhase: 0,
    downbeatMargin: 0,
    firstSoundSec: firstSound(x, sr),
    contentEnd,
    goodBeats: 0,
    onsets,
  });
  if (onsets.length < 8 || !(dpT > 0)) return empty(period0);

  // 5a. tempo fino: coherencia de fase de los ataques reales (el pulso es lo que más se repite).
  //     Alrededor del tempo del DP (±8 %) se busca el periodo con el que los ataques se alinean mejor.
  const coh = (T: number) => {
    let c = 0;
    let s = 0;
    let w = 0;
    for (const e of onsets) {
      const a = (2 * Math.PI * e.t) / T;
      c += e.s * Math.cos(a);
      s += e.s * Math.sin(a);
      w += e.s;
    }
    return { R: w > 0 ? Math.hypot(c, s) / w : 0, ang: Math.atan2(s, c) };
  };
  let T = dpT;
  {
    const bpm0 = 60 / dpT;
    let bestR = -1;
    for (let bpm = bpm0 * 0.92; bpm <= bpm0 * 1.08; bpm += 0.01) {
      const r = coh(60 / bpm).R;
      if (r > bestR) {
        bestR = r;
        T = 60 / bpm;
      }
    }
  }
  const cg = coh(T);
  const t0 = ((((cg.ang / (2 * Math.PI)) * T) % T) + T) % T;

  // 5b. seguimiento local de fase: cada pulso se coloca donde se agrupan los ataques cercanos
  //     (ventana gaussiana de ~2,5 pulsos). Sigue la deriva del tempo de una grabación en vivo sin
  //     pegar cada pulso a un golpe suelto (se conserva el groove y el swing). Arranca de la cadena
  //     del DP, que ya sigue los cambios de tempo.
  const kmin = -Math.floor(t0 / T) - 4;
  const kmax = Math.floor((dur - t0) / T) + 4;
  const nb = kmax - kmin + 1;
  if (nb < 4) return empty(T);
  const delta = new Float64Array(nb);
  const have = new Uint8Array(nb);
  const gridT = (k: number) => t0 + (k + kmin) * T;
  const fillGaps = () => {
    let last = -1;
    for (let k = 0; k < nb; k++) {
      if (!have[k]) continue;
      if (last < 0) for (let j = 0; j < k; j++) delta[j] = delta[k];
      else if (k - last > 1) for (let j = last + 1; j < k; j++) delta[j] = delta[last] + ((delta[k] - delta[last]) * (j - last)) / (k - last);
      last = k;
    }
    if (last >= 0) for (let j = last + 1; j < nb; j++) delta[j] = delta[last];
  };
  {
    // índice entero de cada pulso del DP respecto a la rejilla
    let kk = Math.round((dpTimes[0] - t0) / T) - kmin;
    for (let j = 0; j < dpTimes.length; j++) {
      if (j > 0) kk += Math.max(1, Math.round((dpTimes[j] - dpTimes[j - 1]) / dpT));
      if (kk < 0 || kk >= nb) continue;
      delta[kk] = dpTimes[j] - gridT(kk);
      have[kk] = 1;
    }
    fillGaps();
    // los extremos de la cadena del DP a veces caen en un charles: mediana de ±3 vecinos
    const med = new Float64Array(nb);
    for (let k = 0; k < nb; k++) {
      const v: number[] = [];
      for (let j = Math.max(0, k - 3); j <= Math.min(nb - 1, k + 3); j++) v.push(delta[j]);
      v.sort((a, b) => a - b);
      med[k] = v[v.length >> 1];
    }
    for (let k = 0; k < nb; k++) delta[k] = med[k];
  }
  const pos = (k: number) => gridT(k) + delta[k];
  const nearestBeat = (t: number) => {
    let lo = 0;
    let hi = nb - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pos(mid) <= t) lo = mid;
      else hi = mid;
    }
    return Math.abs(pos(lo) - t) <= Math.abs(pos(hi) - t) ? lo : hi;
  };
  const sigma = 2.5;
  const W = 8;
  // por pulso: lista de (residuo, peso) de los ataques que caen cerca; el desplazamiento nuevo es el
  // PICO de densidad de esos residuos (el golpe que se repite en el pulso), no su media: una síncopa o
  // un charles suelto no arrastran el pulso
  const track = (iters: number) => {
    for (let it = 0; it < iters; it++) {
      const rs: number[][] = Array.from({ length: nb }, () => []);
      const ws: number[][] = Array.from({ length: nb }, () => []);
      for (const e of onsets) {
        const k = nearestBeat(e.t);
        const r = e.t - pos(k);
        const loc = k > 0 && k < nb - 1 ? Math.min(pos(k + 1) - pos(k), pos(k) - pos(k - 1)) : T;
        if (Math.abs(r) > 0.25 * loc) continue; // contratiempos y subdivisiones no deciden el pulso
        rs[k].push(r);
        ws[k].push(e.s);
      }
      const upd = new Float64Array(nb);
      have.fill(0);
      const sr2 = 0.012;
      for (let k = 0; k < nb; k++) {
        const cr: number[] = [];
        const cw: number[] = [];
        let wsum = 0;
        for (let j = Math.max(0, k - W); j <= Math.min(nb - 1, k + W); j++) {
          const g = Math.exp(-0.5 * Math.pow((j - k) / sigma, 2));
          for (let q = 0; q < rs[j].length; q++) {
            cr.push(rs[j][q]); // residuo respecto a su propio pulso
            cw.push(g * ws[j][q]);
            wsum += g * ws[j][q];
          }
        }
        if (wsum <= 0.6) continue;
        const lim = 0.25 * T;
        let bestX = 0;
        let bestD = -1;
        for (let x = -lim; x <= lim; x += 0.002) {
          let d = 0;
          for (let q = 0; q < cr.length; q++) {
            const z = (cr[q] - x) / sr2;
            if (z > -3.5 && z < 3.5) d += cw[q] * Math.exp(-0.5 * z * z);
          }
          d *= Math.exp(-0.5 * Math.pow(x / 0.045, 2)); // preferencia por quedarse donde ya estaba el pulso
          if (d > bestD) {
            bestD = d;
            bestX = x;
          }
        }
        // media local alrededor del pico (precisión por debajo de 2 ms)
        let ns = 0;
        let ds = 0;
        for (let q = 0; q < cr.length; q++) {
          if (Math.abs(cr[q] - bestX) <= 0.015) {
            ns += cw[q] * cr[q];
            ds += cw[q];
          }
        }
        // con poca evidencia (bordes, colas) el pulso apenas se mueve: no se fía de un par de golpes sueltos
        upd[k] = (ds > 0 ? ns / ds : bestX) * (wsum / (wsum + 1.5));
        have[k] = 1;
      }
      for (let k = 0; k < nb; k++) if (have[k]) delta[k] += upd[k];
      fillGaps(); // sin ataques cerca (intros, colas, huecos) se interpola/mantiene el desplazamiento
      // un pulso que salta solo (enganchado a un charles) se corrige con la mediana de sus vecinos
      const med = new Float64Array(nb);
      for (let k = 0; k < nb; k++) {
        const v: number[] = [];
        for (let j = Math.max(0, k - 2); j <= Math.min(nb - 1, k + 2); j++) v.push(delta[j]);
        v.sort((a, b) => a - b);
        med[k] = v[v.length >> 1];
      }
      for (let k = 0; k < nb; k++) delta[k] = med[k];
    }
  };
  track(4);
  // ¿pulso o contratiempo? gana la fase donde caen más golpes de cuerpo (bombo, caja, bajo)
  {
    const sc = (shift: number) => {
      let s = 0;
      for (let k = 0; k < nb; k++) {
        const t = pos(k) + shift;
        if (t < 0 || t > dur) continue;
        const fr = Math.round((t * sr - o.N * 0.7) / o.hop);
        let m = 0;
        for (let d = -3; d <= 3; d++) if (fr + d >= 0 && fr + d < o0.body.length) m = Math.max(m, o0.body[fr + d]);
        s += m;
      }
      return s;
    };
    if (sc(T / 2) > 1.15 * sc(0)) {
      for (let k = 0; k < nb; k++) delta[k] += T / 2;
      track(3);
    }
  }
  const full: number[] = [];
  let kStartIdx = -1;
  for (let k = 0; k < nb; k++) {
    const b = pos(k);
    if (b < 0 || b >= dur) continue;
    if (kStartIdx < 0) kStartIdx = k;
    full.push(b);
  }
  if (full.length < 4) return empty(T);
  const kStartAbs = kStartIdx + kmin;

  // un pulso es "bueno" si cae sobre un ataque real y su vecindad está bien cubierta
  const fullGood: boolean[] = full.map((b) => {
    if (b < firstSound(x, sr) - 0.1 || b > contentEnd + 0.1) return false;
    for (const e of onsets) {
      if (e.t < b - 0.045) continue;
      if (e.t > b + 0.045) break;
      if (e.s >= 0.25) return true;
    }
    return false;
  });
  // recorte de extremos: un pulso del borde solo vale si encaja con la recta de los vecinos buenos
  // (un golpe suelto en una intro o una cola no arrastra la extrapolación)
  {
    const trimTol = Math.max(0.02, 0.1 * T);
    const edgeTrim = (fromStart: boolean) => {
      for (;;) {
        const idx: number[] = [];
        fullGood.forEach((g, i) => g && idx.push(i));
        if (idx.length < 10) return;
        const edge = fromStart ? idx[0] : idx[idx.length - 1];
        const inner = fromStart ? idx.slice(1, 9) : idx.slice(-9, -1);
        const f = fitLine(inner, inner.map((i) => full[i]));
        if (Math.abs(full[edge] - (f.t0 + f.T * edge)) > trimTol) fullGood[edge] = false;
        else return;
      }
    };
    edgeTrim(true);
    edgeTrim(false);
    // fuera de los pulsos buenos: extrapolación con la pendiente local (no se arrastra el desvío del borde)
    const gI: number[] = [];
    fullGood.forEach((g, i) => g && gI.push(i));
    if (gI.length >= 6) {
      const m = Math.min(16, gI.length);
      const head = gI.slice(0, m);
      const tail = gI.slice(-m);
      const fh = fitLine(head, head.map((i) => full[i]));
      const ft = fitLine(tail, tail.map((i) => full[i]));
      for (let i = 0; i < gI[0]; i++) full[i] = full[gI[0]] + (i - gI[0]) * fh.T;
      for (let i = gI[gI.length - 1] + 1; i < full.length; i++) full[i] = full[gI[gI.length - 1]] + (i - gI[gI.length - 1]) * ft.T;
    }
  }
  const goodN = fullGood.filter(Boolean).length;
  if (goodN < 6) return empty(T);

  // tempo medio y desvío respecto a una recta (cuánto se mueve el tempo)
  const gIdx: number[] = [];
  const gT: number[] = [];
  full.forEach((b, k) => {
    if (fullGood[k]) {
      gIdx.push(k);
      gT.push(b);
    }
  });
  const fit = fitLine(gIdx, gT);
  const resid = gIdx.map((k, i) => gT[i] - (fit.t0 + fit.T * k));
  let drift = 0;
  let ss = 0;
  for (let i = 0; i < resid.length; i++) {
    ss += resid[i] * resid[i];
    const a0 = Math.max(0, i - 4);
    const a1 = Math.min(resid.length, i + 4);
    let m = 0;
    for (let k = a0; k < a1; k++) m += resid[k];
    drift = Math.max(drift, Math.abs(m / (a1 - a0)));
  }
  const rms = Math.sqrt(ss / resid.length);

  // si un tempo constante explica los pulsos (deriva < 8 ms), la recta de mínimos cuadrados es más
  // precisa que cualquier pulso suelto: se usa para TODOS los pulsos
  const constantOk = drift < 0.008 && rms < 0.008;
  const bpmOut = 60 / fit.T;
  const periodOut = fit.T;
  if (constantOk) {
    // k de cada pulso de `full` respecto a la recta ajustada
    for (let k = 0; k < full.length; k++) full[k] = fit.t0 + fit.T * k;
  }

  // tiempo fuerte: la fase del compás con más ataque grave
  const phaseScore = new Array(beatsPerBar).fill(0);
  full.forEach((b, i) => {
    const fr = Math.round((b * sr - o.N * 0.7) / o.hop);
    let s = 0;
    for (let d = -2; d <= 2; d++) {
      const j = fr + d;
      if (j >= 0 && j < o.env.length) s += o.low[j] * 1.0 + o.env[j] * 0.35;
    }
    phaseScore[(((i + kStartAbs) % beatsPerBar) + beatsPerBar) % beatsPerBar] += s;
  });
  let phase = 0;
  for (let p = 1; p < beatsPerBar; p++) if (phaseScore[p] > phaseScore[phase]) phase = p;
  const downbeatPhase = (((phase - kStartAbs) % beatsPerBar) + beatsPerBar) % beatsPerBar;
  const sortedPh = phaseScore.slice().sort((a, b) => b - a);
  const downbeatMargin = sortedPh[0] > 0 ? (sortedPh[0] - sortedPh[1]) / sortedPh[0] : 0;

  onProgress(1);
  return {
    beats: full,
    beatGood: fullGood,
    bpm: bpmOut,
    period: periodOut,
    rmsMs: rms * 1000,
    driftMs: drift * 1000,
    constantOk,
    confidence: Math.max(confidence, Math.min(1, cg.R * 2)),
    downbeatPhase,
    downbeatMargin,
    firstSoundSec: firstSound(x, sr),
    contentEnd,
    goodBeats: goodN,
    onsets,
  };
}

function gridBeats(t0: number, T: number, dur: number): number[] {
  const out: number[] = [];
  for (let t = t0; t < dur; t += T) out.push(t);
  return out;
}

// primer instante con sonido real (por encima de ~-48 dB del máximo)
export function firstSound(x: Float32Array, sr: number): number {
  let mx = 0;
  for (let i = 0; i < x.length; i += 16) mx = Math.max(mx, Math.abs(x[i]));
  const thr = mx * 0.004;
  const step = 32;
  for (let i = 0; i < x.length; i += step) {
    if (Math.abs(x[i]) > thr) return Math.max(0, i - 256) / sr;
  }
  return 0;
}

// último instante con sonido real (por encima de ~-48 dB del máximo)
export function lastSound(x: Float32Array, sr: number): number {
  let mx = 0;
  for (let i = 0; i < x.length; i += 16) mx = Math.max(mx, Math.abs(x[i]));
  const thr = mx * 0.004;
  for (let i = x.length - 1; i >= 0; i -= 32) {
    if (Math.abs(x[i]) > thr) return Math.min(x.length, i + 256) / sr;
  }
  return x.length / sr;
}
