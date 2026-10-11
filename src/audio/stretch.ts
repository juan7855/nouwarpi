// Motor de estirado de tiempo (DSP puro, sin dependencias del navegador).
// Se ejecuta dentro de un Web Worker (ver worker.ts) y también en los tests.
//
// Todos los métodos devuelven exactamente round(longitud * factor) muestras,
// a la misma frecuencia de muestreo y con los mismos canales.
//
//  - "wsola":    dominio del tiempo. Copia fragmentos REALES de la onda (no los
//                reconstruye), ideal para percusión y loops rítmicos.
//  - "pvoc":     vocoder de fase con bloqueo de fase y reinicio en transitorios.
//                Mejor para material tonal/sostenido (pads, cuerdas, voces).
//  - "resample": remuestreo sinc de alta calidad. La onda no se deforma, pero
//                cambia el tono (como un vinilo).

import { FFT, hannWindow } from "./dsp";

export type StretchMethod = "wsola" | "pvoc" | "resample";
export type ProgressFn = (frac: number) => void;

const TWO_PI = 2 * Math.PI;

export function stretchChannels(
  chs: Float32Array[],
  sr: number,
  factor: number,
  method: StretchMethod,
  onProgress: ProgressFn = () => {}
): Float32Array[] {
  if (!chs.length || !chs[0].length) return chs;
  if (!(factor > 0.05 && factor < 20)) throw new Error("Factor de tempo fuera de rango");
  if (Math.abs(factor - 1) < 0.0005) return chs.map((c) => c.slice());
  switch (method) {
    case "pvoc":
      return phaseVocoder(chs, sr, factor, onProgress);
    case "resample":
      return resampleSinc(chs, factor, onProgress);
    default:
      return wsola(chs, sr, factor, onProgress);
  }
}

/* ------------------------------------------------------------------ */
/* Remuestreo sinc con ventana Blackman-Harris                          */
/* ------------------------------------------------------------------ */

function resampleSinc(chs: Float32Array[], factor: number, onProgress: ProgressFn): Float32Array[] {
  const inLen = chs[0].length;
  const outLen = Math.max(1, Math.round(inLen * factor));
  const step = inLen / outLen; // muestras de entrada por muestra de salida
  const cutoff = Math.min(1, 1 / step); // filtro antialias al bajar la resolución
  const ZC = 16; // cruces por cero a cada lado
  const half = ZC / cutoff;
  const OS = 256; // sobremuestreo de la tabla
  const tableLen = Math.ceil(half * OS) + 2;
  const table = new Float32Array(tableLen);
  for (let i = 0; i < tableLen; i++) {
    const x = i / OS;
    const t = Math.min(1, x / half);
    const w =
      0.35875 +
      0.48829 * Math.cos(Math.PI * t) +
      0.14128 * Math.cos(2 * Math.PI * t) +
      0.01168 * Math.cos(3 * Math.PI * t);
    const a = Math.PI * cutoff * x;
    table[i] = (x === 0 ? cutoff : (Math.sin(a) / (Math.PI * x))) * w;
  }

  const out = chs.map(() => new Float32Array(outLen));
  const maxTaps = Math.ceil(half) * 2 + 2;
  const wts = new Float64Array(maxTaps);

  for (let j = 0; j < outLen; j++) {
    const pos = j * step;
    const n0 = Math.ceil(pos - half);
    const n1 = Math.floor(pos + half);
    let wsum = 0;
    let cnt = 0;
    for (let n = n0; n <= n1; n++) {
      const xi = Math.abs(pos - n) * OS;
      const i0 = xi | 0;
      const fr = xi - i0;
      const w = table[i0] * (1 - fr) + table[i0 + 1] * fr;
      wts[cnt++] = w;
      wsum += w;
    }
    const inv = wsum > 1e-9 ? 1 / wsum : 1; // ganancia DC exacta
    for (let c = 0; c < chs.length; c++) {
      const src = chs[c];
      let acc = 0;
      for (let k = 0; k < cnt; k++) {
        const n = n0 + k;
        if (n >= 0 && n < inLen) acc += src[n] * wts[k];
      }
      out[c][j] = acc * inv;
    }
    if ((j & 0x3fff) === 0) onProgress(j / outLen);
  }
  onProgress(1);
  return out;
}


// Ataques de la señal (índices de muestra de entrada). Se usan para "anclar" los
// golpes a su posición exacta (posición × factor) y que no se muevan al estirar.
function detectOnsets(chs: Float32Array[], sr: number): number[] {
  const B = 128;
  const inLen = chs[0].length;
  const nb = Math.floor(inLen / B);
  if (nb < 4) return [];
  const e = new Float64Array(nb);
  let maxE = 0;
  for (let b = 0; b < nb; b++) {
    let s = 0;
    for (const ch of chs) for (let i = b * B; i < (b + 1) * B; i++) s += ch[i] * ch[i];
    e[b] = s;
    if (s > maxE) maxE = s;
  }
  if (maxE <= 0) return [];
  const minGap = Math.round(0.03 * sr);
  const out: number[] = [];
  for (let b = 3; b < nb - 1; b++) {
    const prev = (e[b - 1] + e[b - 2] + e[b - 3]) / 3;
    if (e[b] > 4 * prev + 1e-9 && e[b] > 0.003 * maxE) {
      let pk = 0;
      for (const ch of chs) for (let i = b * B; i < (b + 2) * B && i < inLen; i++) pk = Math.max(pk, Math.abs(ch[i]));
      let pos = b * B;
      search: for (let i = b * B; i < (b + 2) * B && i < inLen; i++) {
        for (const ch of chs) {
          if (Math.abs(ch[i]) >= 0.2 * pk) {
            pos = i;
            break search;
          }
        }
      }
      if (!out.length || pos - out[out.length - 1] >= minGap) out.push(pos);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* WSOLA (solapamiento y suma sincronizado por forma de onda)           */
/* ------------------------------------------------------------------ */

function wsola(chs: Float32Array[], sr: number, factor: number, onProgress: ProgressFn): Float32Array[] {
  const nCh = chs.length;
  const inLen = chs[0].length;
  const outLen = Math.max(1, Math.round(inLen * factor));

  let W = Math.round(sr * 0.05); // ventana ≈ 50 ms
  if (W % 2) W++;
  W = Math.max(256, W);
  const Hs = W / 2;
  const tol = Math.round(sr * 0.012); // búsqueda ±12 ms
  const D = 4; // diezmado para la búsqueda gruesa
  const pad = W + tol + 16;

  const padded: Float32Array[] = chs.map((c) => {
    const p = new Float32Array(inLen + 2 * pad);
    p.set(c, pad);
    return p;
  });
  const pl = padded[0].length;

  // mezcla mono a resolución completa y diezmada
  const monoFull = new Float32Array(pl);
  for (let c = 0; c < nCh; c++) {
    const p = padded[c];
    for (let i = 0; i < pl; i++) monoFull[i] += p[i];
  }
  if (nCh > 1) for (let i = 0; i < pl; i++) monoFull[i] /= nCh;
  const dl = Math.floor(pl / D);
  const monoDec = new Float32Array(dl);
  for (let i = 0; i < dl; i++) {
    let s = 0;
    for (let d = 0; d < D; d++) s += monoFull[i * D + d];
    monoDec[i] = s / D;
  }

  // ventana de Hann periódica: con 50% de solape suma exactamente 1
  const win = new Float32Array(W);
  for (let i = 0; i < W; i++) win[i] = 0.5 * (1 - Math.cos((TWO_PI * i) / W));

  // el fotograma k cubre la salida [(k-1)·Hs, (k+1)·Hs); índice de salida = o + Hs
  const K = Math.floor(outLen / Hs) + 3;
  const outBuf = chs.map(() => new Float32Array((K + 2) * Hs + W));

  const corrLen = Math.floor(Hs / D);
  const maxStart = pl - W - 1;
  let prevC = 0;

  const onsetIn = detectOnsets(chs, sr);
  const onsetOut = onsetIn.map((o) => Math.round(o * factor));
  let oi = 0;

  for (let k = 0; k <= K; k++) {
    // inicio nominal del fragmento (índice en el array con relleno)
    const nom = Math.round((k * Hs) / factor - W / 2) + pad;
    let c = nom;
    if (k > 0) {
      const tgt = prevC + Hs; // continuación natural del fragmento anterior
      const lo = Math.max(0, nom - tol);
      const hi = Math.min(maxStart, nom + tol);
      if (hi >= lo) {
        // 1) búsqueda gruesa en la señal diezmada
        const tD = Math.floor(tgt / D);
        let bestD = Math.floor(nom / D);
        let bestScore = -Infinity;
        if (tD + corrLen < dl) {
          for (let cd = Math.ceil(lo / D); cd <= Math.floor(hi / D); cd++) {
            if (cd + corrLen >= dl) break;
            let ab = 0;
            let aa = 1e-9;
            for (let i = 0; i < corrLen; i++) {
              const a = monoDec[cd + i];
              ab += a * monoDec[tD + i];
              aa += a * a;
            }
            const score = ab / Math.sqrt(aa);
            if (score > bestScore) {
              bestScore = score;
              bestD = cd;
            }
          }
        }
        // 2) refinado a resolución completa
        const c0 = bestD * D;
        let bestC = Math.min(hi, Math.max(lo, c0));
        let bestS = -Infinity;
        const rlo = Math.max(lo, c0 - D);
        const rhi = Math.min(hi, c0 + D);
        for (let cc = rlo; cc <= rhi; cc++) {
          let ab = 0;
          let aa = 1e-9;
          for (let i = 0; i < Hs; i += 2) {
            const a = monoFull[cc + i];
            ab += a * monoFull[tgt + i];
            aa += a * a;
          }
          const s = ab / Math.sqrt(aa);
          if (s > bestS) {
            bestS = s;
            bestC = cc;
          }
        }
        c = bestC;
      } else {
        c = Math.min(maxStart, Math.max(0, nom));
      }
    }
    // anclaje de transitorios: los fotogramas que contienen un ataque lo toman
    // de su posición exacta, así el golpe cae en (posición × factor) sin deriva
    while (oi < onsetOut.length && onsetOut[oi] < (k - 1) * Hs) oi++;
    if (oi < onsetOut.length && onsetOut[oi] < (k + 1) * Hs) {
      const pinned = onsetIn[oi] + pad - (onsetOut[oi] - (k - 1) * Hs);
      if (pinned >= 0 && pinned <= maxStart) c = pinned;
    }
    prevC = c;

    const o = k * Hs;
    for (let ch = 0; ch < nCh; ch++) {
      const src = padded[ch];
      const dst = outBuf[ch];
      for (let i = 0; i < W; i++) dst[o + i] += src[c + i] * win[i];
    }
    if ((k & 63) === 0) onProgress(k / K);
  }

  onProgress(1);
  return outBuf.map((b) => b.slice(Hs, Hs + outLen));
}

/* ------------------------------------------------------------------ */
/* Vocoder de fase con bloqueo de fase y reinicio en transitorios       */
/* ------------------------------------------------------------------ */

function phaseVocoder(chs: Float32Array[], sr: number, factor: number, onProgress: ProgressFn): Float32Array[] {
  const nCh = chs.length;
  const inLen = chs[0].length;
  const outLen = Math.max(1, Math.round(inLen * factor));

  const N = inLen > 90 * sr ? 2048 : 4096;
  const half = N / 2;
  // el hop de síntesis nunca supera N/4 (solape suficiente al ralentizar mucho)
  const HA = Math.max(64, Math.floor(N / 4 / Math.max(1, factor)));
  const frames = Math.ceil(inLen / HA) + 2;

  const win = hannWindow(N);
  const fft = new FFT(N);

  const OFF = N; // margen en el buffer de salida
  const out = chs.map(() => new Float32Array(outLen + 2 * N));
  const norm = new Float32Array(outLen + 2 * N);

  const omega = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) omega[k] = (TWO_PI * k) / N;

  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const mag: Float32Array[] = [];
  const ph: Float64Array[] = [];
  const prevMag: Float32Array[] = [];
  const prevPh: Float64Array[] = [];
  const synPh: Float64Array[] = [];
  const newPh = new Float64Array(half + 1);
  const freq = new Float64Array(half + 1);
  for (let c = 0; c < nCh; c++) {
    mag.push(new Float32Array(half + 1));
    ph.push(new Float64Array(half + 1));
    prevMag.push(new Float32Array(half + 1));
    prevPh.push(new Float64Array(half + 1));
    synPh.push(new Float64Array(half + 1));
  }

  const fluxHist = new Float64Array(16);
  let fhIdx = 0;
  let fhCount = 0;
  let prevCenter = 0;

  for (let fi = 0; fi < frames; fi++) {
    const inCenter = fi * HA;
    const start = inCenter - half;
    const synCenter = Math.round(fi * HA * factor);
    const hop = fi === 0 ? HA * factor : synCenter - prevCenter;
    prevCenter = synCenter;

    // 1) análisis de todos los canales + flujo espectral conjunto
    let flux = 0;
    let prevTotal = 0;
    for (let c = 0; c < nCh; c++) {
      const src = chs[c];
      for (let i = 0; i < N; i++) {
        const p = start + i;
        re[i] = p >= 0 && p < inLen ? src[p] * win[i] : 0;
        im[i] = 0;
      }
      fft.transform(re, im, true);
      const m = mag[c];
      const p = ph[c];
      const pm = prevMag[c];
      for (let k = 0; k <= half; k++) {
        const mk = Math.hypot(re[k], im[k]);
        m[k] = mk;
        p[k] = Math.atan2(im[k], re[k]);
        const d = mk - pm[k];
        if (d > 0) flux += d;
        prevTotal += pm[k];
      }
    }
    const ratio = flux / (prevTotal + 1e-9);
    let isOnset = fi === 0;
    if (!isOnset) {
      const n = Math.min(fhCount, 16);
      let avg = 0;
      for (let i = 0; i < n; i++) avg += fluxHist[i];
      avg = n ? avg / n : 0;
      if (ratio > 0.6 && ratio > 2 * avg) isOnset = true;
    }
    fluxHist[fhIdx] = ratio;
    fhIdx = (fhIdx + 1) % 16;
    fhCount++;

    // 2) propagación de fase con bloqueo de fase (Laroche-Dolson) + síntesis
    for (let c = 0; c < nCh; c++) {
      const m = mag[c];
      const p = ph[c];
      const pp = prevPh[c];
      const sp = synPh[c];

      if (isOnset) {
        for (let k = 0; k <= half; k++) sp[k] = p[k];
      } else {
        for (let k = 0; k <= half; k++) {
          let dphi = p[k] - pp[k] - omega[k] * HA;
          dphi -= TWO_PI * Math.round(dphi / TWO_PI);
          freq[k] = omega[k] + dphi / HA;
        }
        // picos espectrales
        const peaks: number[] = [];
        for (let k = 0; k <= half; k++) {
          const v = m[k];
          if (
            v > 0 &&
            (k < 1 || v > m[k - 1]) &&
            (k < 2 || v > m[k - 2]) &&
            (k > half - 1 || v >= m[k + 1]) &&
            (k > half - 2 || v >= m[k + 2])
          ) {
            peaks.push(k);
          }
        }
        if (peaks.length === 0) {
          for (let k = 0; k <= half; k++) newPh[k] = sp[k] + freq[k] * hop;
        } else {
          for (let pi = 0; pi < peaks.length; pi++) {
            const pk = peaks[pi];
            const lo = pi === 0 ? 0 : Math.ceil((peaks[pi - 1] + pk) / 2);
            const hi = pi === peaks.length - 1 ? half : Math.floor((pk + peaks[pi + 1]) / 2);
            const peakSyn = sp[pk] + freq[pk] * hop;
            const rot = peakSyn - p[pk];
            for (let k = lo; k <= hi; k++) newPh[k] = p[k] + rot;
          }
        }
        for (let k = 0; k <= half; k++) {
          sp[k] = newPh[k] % TWO_PI;
        }
      }

      for (let k = 0; k <= half; k++) {
        pp[k] = p[k];
        prevMag[c][k] = m[k];
      }

      for (let k = 0; k <= half; k++) {
        re[k] = m[k] * Math.cos(sp[k]);
        im[k] = m[k] * Math.sin(sp[k]);
      }
      im[0] = 0;
      im[half] = 0;
      for (let k = 1; k < half; k++) {
        re[N - k] = re[k];
        im[N - k] = -im[k];
      }
      fft.transform(re, im, false);

      const dst = out[c];
      const base = OFF + synCenter - half;
      const inv = 1 / N;
      for (let i = 0; i < N; i++) dst[base + i] += re[i] * win[i] * inv;
      if (c === 0) {
        for (let i = 0; i < N; i++) norm[base + i] += win[i] * win[i];
      }
    }

    if ((fi & 31) === 0) onProgress(fi / frames);
  }

  // normalización por la suma de ventanas² y recorte a la longitud exacta
  const result = chs.map(() => new Float32Array(outLen));
  for (let i = 0; i < outLen; i++) {
    const nv = norm[OFF + i];
    const g = nv > 1e-3 ? 1 / nv : 0;
    for (let c = 0; c < nCh; c++) result[c][i] = out[c][OFF + i] * g;
  }
  onProgress(1);
  return result;
}
