// Análisis de audio: envolvente de onset, detección del primer golpe y del BPM.

export interface OnsetEnvelope {
  flux: Float32Array; // flujo espectral normalizado 0..1
  hop: number;
  sampleRate: number;
  rms: Float32Array; // energía por frame
}

const FFT_N = 1024;

// Envolutiva: flux espectral + RMS, hop de 512 muestras (~11.6 ms @44.1k)
export function computeOnsetEnvelope(
  channelData: Float32Array,
  sampleRate: number,
  hop = 512
): OnsetEnvelope {
  const n = FFT_N;
  const len = channelData.length;
  const frames = Math.max(1, Math.floor((len - n) / hop) + 1);
  const flux = new Float32Array(frames);
  const rms = new Float32Array(frames);

  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const prevMag = new Float32Array(n / 2 + 1);

  // tabla bit-reversal y twiddles para 1024
  const levels = 10;
  const bitRev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let j = 0; j < levels; j++) r = (r << 1) | ((i >> j) & 1);
    bitRev[i] = r;
  }
  const cosT: Float32Array[] = [];
  const sinT: Float32Array[] = [];
  for (let l = 1; l <= levels; l++) {
    const size = 1 << l;
    const half = size >> 1;
    const c = new Float32Array(half);
    const s = new Float32Array(half);
    for (let j = 0; j < half; j++) {
      const a = (-2 * Math.PI * j) / size;
      c[j] = Math.cos(a);
      s[j] = Math.sin(a);
    }
    cosT.push(c);
    sinT.push(s);
  }

  const window = new Float32Array(n);
  for (let i = 0; i < n; i++) window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));

  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const v = channelData[off + i] || 0;
      sumSq += v * v;
      re[i] = v * window[i];
      im[i] = 0;
    }
    rms[f] = Math.sqrt(sumSq / n);

    // FFT forward
    for (let i = 0; i < n; i++) {
      const j = bitRev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let l = 1; l <= levels; l++) {
      const size = 1 << l;
      const half = size >> 1;
      const ct = cosT[l - 1];
      const st = sinT[l - 1];
      for (let i = 0; i < n; i += size) {
        for (let j = 0; j < half; j++) {
          const c = ct[j];
          const s = st[j];
          const a = i + j;
          const b = i + j + half;
          const tr = re[b] * c - im[b] * s;
          const ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }

    // flux solo en bins relevantes (~80 Hz .. 8 kHz)
    const maxBin = Math.min(n / 2, Math.floor(8000 / (sampleRate / n)));
    const minBin = Math.max(1, Math.floor(60 / (sampleRate / n)));
    let fSum = 0;
    for (let k = minBin; k <= maxBin; k++) {
      const m = re[k] * re[k] + im[k] * im[k];
      const d = m - prevMag[k];
      if (d > 0) fSum += d;
      prevMag[k] = m;
    }
    flux[f] = fSum;
  }

  // normalizar flux 0..1 con suavizado ligero
  let maxF = 0;
  for (let f = 0; f < frames; f++) if (flux[f] > maxF) maxF = flux[f];
  if (maxF <= 0) maxF = 1;
  const smooth = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const a = flux[Math.max(0, f - 1)];
    const b = flux[f];
    const c = flux[Math.min(frames - 1, f + 1)];
    smooth[f] = (a + 2 * b + c) / 4 / maxF;
  }

  return { flux: smooth, hop, sampleRate, rms };
}

// Primer golpe real: primer pico de flux con energía sostenida detrás.
export function detectFirstBeat(env: OnsetEnvelope): number {
  const { flux, rms, hop, sampleRate } = env;
  const frames = flux.length;
  let maxF = 0;
  const scan = Math.min(frames, Math.floor((15 * sampleRate) / hop)); // buscar en los primeros 15 s
  for (let f = 0; f < scan; f++) if (flux[f] > maxF) maxF = flux[f];
  if (maxF <= 0) return 0;

  let maxRms = 0;
  for (let f = 0; f < frames; f++) if (rms[f] > maxRms) maxRms = rms[f];

  const threshold = Math.max(0.12 * maxF, 0.02);
  const rmsFloor = 0.04 * maxRms;
  const sustain = Math.floor((0.25 * sampleRate) / hop);

  for (let f = 2; f < scan; f++) {
    if (flux[f] > threshold && flux[f] >= flux[f - 1] && flux[f] >= flux[f + 1]) {
      // ¿hay energía sostenida después?
      let e = 0;
      let c = 0;
      for (let g = f; g < Math.min(frames, f + sustain); g++) {
        e += rms[g];
        c++;
      }
      if (c > 0 && e / c > rmsFloor) {
        return (f * hop) / sampleRate;
      }
    }
  }
  return 0;
}

export interface BpmResult {
  bpm: number;
  confidence: number; // 0..1 (altura del pico de autocorrelación)
  stable: boolean;
}

// Detección de BPM a partir del marcador (nunca desde el segundo cero).
export function detectBpmFrom(env: OnsetEnvelope, fromSec: number): BpmResult {
  const { flux, hop, sampleRate } = env;
  const frames = flux.length;
  const startFrame = Math.max(0, Math.floor((fromSec * sampleRate) / hop));
  const maxFrames = Math.min(frames - startFrame, Math.floor((45 * sampleRate) / hop));
  if (maxFrames < 60) return { bpm: 120, confidence: 0, stable: false };

  const e = new Float32Array(maxFrames);
  let mean = 0;
  for (let i = 0; i < maxFrames; i++) {
    e[i] = flux[startFrame + i];
    mean += e[i];
  }
  mean /= maxFrames;
  for (let i = 0; i < maxFrames; i++) e[i] -= mean;

  const fps = sampleRate / hop; // frames por segundo
  const minLag = Math.floor((60 / 240) * fps); // 240 BPM
  const maxLag = Math.ceil((60 / 50) * fps); // 50 BPM

  let bestLag = 0;
  let bestVal = -1;
  const ac = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag && lag < maxFrames - 1; lag++) {
    let s = 0;
    for (let i = 0; i < maxFrames - lag; i++) s += e[i] * e[i + lag];
    s /= maxFrames - lag;
    ac[lag] = s;
    if (s > bestVal) {
      bestVal = s;
      bestLag = lag;
    }
  }

  // energía total para normalizar
  let e0 = 0;
  for (let i = 0; i < maxFrames; i++) e0 += e[i] * e[i];
  e0 /= maxFrames;
  if (e0 <= 1e-12) return { bpm: 120, confidence: 0, stable: false };

  // interpolación parabólica
  let lag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const y0 = ac[bestLag - 1];
    const y1 = ac[bestLag];
    const y2 = ac[bestLag + 1];
    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) > 1e-12) {
      const off = 0.5 * (y0 - y2) / denom;
      lag = bestLag + off;
    }
  }

  const periodSec = lag / fps;
  let bpm = 60 / periodSec;

  // candidatos de octava (mitad / doble) para elegir el más musical
  const candidates: number[] = [];
  for (const mult of [0.5, 1, 2]) {
    const b = bpm * mult;
    if (b >= 50 && b <= 240) candidates.push(b);
  }
  // puntuación: autocorrelación ponderada por cercanía a 120 BPM
  let bestScore = -1;
  let chosen = bpm;
  for (const b of candidates) {
    const l = Math.round((60 / b) * fps);
    const val = l >= 0 && l < ac.length ? Math.max(0, ac[l]) / e0 : 0;
    const pref = Math.exp(-Math.pow((b - 120) / 70, 2));
    const score = val * (0.6 + 0.4 * pref);
    if (score > bestScore) {
      bestScore = score;
      chosen = b;
    }
  }
  bpm = chosen;

  const confidence = Math.max(0, Math.min(1, bestVal / e0));
  // estabilidad: pico frente a media de la autocorrelación
  let acMean = 0;
  let acCount = 0;
  for (let l = minLag; l <= maxLag && l < ac.length; l++) {
    acMean += ac[l];
    acCount++;
  }
  acMean /= Math.max(1, acCount);
  const stable = acMean > 1e-12 && bestVal / acMean > 1.45;

  return { bpm: Math.round(bpm * 10) / 10, confidence, stable };
}

/* ---------- refinado fino (resolución de ~1,5 ms) ---------- */

const FINE_B = 64;

// Fuerza de ataque: derivada positiva de la amplitud RMS por bloques de 64 muestras.
function fineOnsetEnv(x: Float32Array): Float32Array {
  const nb = Math.floor(x.length / FINE_B);
  const env = new Float32Array(nb);
  let prev = 0;
  for (let b = 0; b < nb; b++) {
    let s = 0;
    for (let i = b * FINE_B; i < (b + 1) * FINE_B; i++) s += x[i] * x[i];
    const a = Math.sqrt(s / FINE_B);
    env[b] = Math.max(0, a - prev);
    prev = a;
  }
  return env;
}

// Ajusta el primer golpe al inicio real del ataque (±40 ms alrededor de la detección gruesa).
export function refineFirstBeat(x: Float32Array, sr: number, approxSec: number): number {
  const env = fineOnsetEnv(x);
  const c = Math.floor((approxSec * sr) / FINE_B);
  const r = Math.floor((0.04 * sr) / FINE_B);
  const lo = Math.max(0, c - r);
  const hi = Math.min(env.length - 1, c + r);
  let mx = 0;
  for (let b = lo; b <= hi; b++) if (env[b] > mx) mx = env[b];
  if (mx <= 0) return approxSec;
  for (let b = lo; b <= hi; b++) {
    if (env[b] >= 0.25 * mx) return (b * FINE_B) / sr;
  }
  return approxSec;
}

// Ajusta el BPM probando una rejilla de pulsos anclada en el primer golpe:
// la rejilla correcta es la que acumula más energía de ataque. Resolución ~0,005 BPM.
export function refineBpm(x: Float32Array, sr: number, firstBeatSec: number, bpm0: number): number {
  const env = fineOnsetEnv(x);
  const sm = new Float32Array(env.length);
  for (let b = 0; b < env.length; b++) {
    sm[b] = (env[Math.max(0, b - 1)] + 2 * env[b] + env[Math.min(env.length - 1, b + 1)]) / 4;
  }
  const first = (firstBeatSec * sr) / FINE_B;
  const spanBlocks = Math.min(env.length - first - 2, (45 * sr) / FINE_B);
  const beatBlocks0 = (60 / bpm0) * (sr / FINE_B);
  const K = Math.floor(spanBlocks / beatBlocks0);
  if (K < 6) return bpm0;

  const at = (t: number) => {
    const i = Math.floor(t);
    const f = t - i;
    return sm[i] * (1 - f) + sm[i + 1] * f;
  };
  const score = (bpm: number) => {
    const bb = (60 / bpm) * (sr / FINE_B);
    let s = 0;
    for (let k = 0; k <= K; k++) {
      const t = first + k * bb;
      if (t >= sm.length - 2) break;
      s += at(t);
    }
    return s;
  };

  const step = 0.005;
  const n = Math.round((bpm0 * 0.02) / step);
  let best = bpm0;
  let bestS = -1;
  const scores: number[] = [];
  for (let i = -n; i <= n; i++) {
    const s = score(bpm0 + i * step);
    scores.push(s);
    if (s > bestS) {
      bestS = s;
      best = bpm0 + i * step;
    }
  }
  // interpolación parabólica del pico
  const bi = Math.round((best - bpm0) / step) + n;
  if (bi > 0 && bi < scores.length - 1) {
    const y0 = scores[bi - 1];
    const y1 = scores[bi];
    const y2 = scores[bi + 1];
    const d = y0 - 2 * y1 + y2;
    if (Math.abs(d) > 1e-12) best += (0.5 * (y0 - y2) / d) * step;
  }
  return best;
}
