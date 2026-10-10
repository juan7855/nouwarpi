// Vocoder de fase con preservación de transitorios (reset de fase en onsets).
// Calidad prioritaria sobre velocidad: FFT 2048, solapamiento 75%,
// ambos canales estirados frame a frame (misma alineación → imagen estéreo intacta).

import { FFT, hannWindow } from "./dsp";

const N = 2048; // tamaño de FFT
const HA = 512; // hop de análisis (N/4)
const CHUNK_FRAMES = 40; // frames por bloque (para actualizar progreso)

export interface StretchProgress {
  label: string;
  frac: number; // 0..1
}

export async function phaseVocoderStretch(
  input: AudioBuffer,
  factor: number, // >1 alarga (más lento), <1 acorta
  onProgress: (p: StretchProgress) => void
): Promise<AudioBuffer> {
  const sr = input.sampleRate;
  const ch = input.numberOfChannels;
  const len = input.length;

  if (Math.abs(factor - 1) < 0.002) {
    return input; // nada que hacer
  }

  const Hs = HA * factor;
  const framesTotal = Math.max(1, Math.floor((len - N) / HA) + 2);
  const outLen = Math.ceil((framesTotal - 1) * Hs) + N;

  const out = new AudioBuffer({ length: outLen, sampleRate: sr, numberOfChannels: ch });
  const outCh: Float32Array[] = [];
  for (let c = 0; c < ch; c++) outCh.push(out.getChannelData(c));

  const inCh: Float32Array[] = [];
  for (let c = 0; c < ch; c++) inCh.push(input.getChannelData(c));

  const win = hannWindow(N);
  const winSq = new Float32Array(N);
  for (let i = 0; i < N; i++) winSq[i] = win[i] * win[i];

  const fft = new FFT(N);

  // buffers de trabajo por canal
  const reArr: Float32Array[] = [];
  const imArr: Float32Array[] = [];
  const prevPhase: Float32Array[] = [];
  const synthPhase: Float32Array[] = [];
  const prevMag: Float32Array[] = [];
  const magS: Float32Array[] = [];
  const phS: Float32Array[] = [];
  for (let c = 0; c < ch; c++) {
    reArr.push(new Float32Array(N));
    imArr.push(new Float32Array(N));
    prevPhase.push(new Float32Array(N / 2 + 1));
    synthPhase.push(new Float32Array(N / 2 + 1));
    prevMag.push(new Float32Array(N / 2 + 1));
    magS.push(new Float32Array(N / 2 + 1));
    phS.push(new Float32Array(N / 2 + 1));
  }

  // cola de solapamiento (OLA) + normalización por ventana²
  const tailSize = (CHUNK_FRAMES - 1) * Hs + N + 8;
  const tail: Float32Array[] = [];
  for (let c = 0; c < ch; c++) tail.push(new Float32Array(tailSize));
  const tailNorm = new Float32Array(tailSize);
  let tailValid = 0;

  // detección de onsets adaptativa (flux entre frames consecutivos)
  const fluxHist = new Float32Array(32);
  let fluxHistIdx = 0;
  let fluxHistSum = 0;
  let fluxCount = 0;

  const omega = new Float32Array(N / 2 + 1);
  for (let k = 0; k <= N / 2; k++) omega[k] = (2 * Math.PI * k) / N;

  let written = 0;
  const yieldFrame = () => new Promise<void>((res) => setTimeout(res, 0));

  for (let base = 0; base < framesTotal; base += CHUNK_FRAMES) {
    const cf = Math.min(CHUNK_FRAMES, framesTotal - base);
    const needed = (cf - 1) * Hs + N;

    // limpiar la zona nueva de la cola (el resto anterior queda en [0, tailValid))
    tailNorm.fill(0, tailValid, needed);
    for (let c = 0; c < ch; c++) tail[c].fill(0, tailValid, needed);

    for (let fi = base; fi < base + cf; fi++) {
      const off = fi * HA;
      const rel = fi * Hs - base * Hs;

      // 1) FFT de análisis por canal + flux acumulado
      let fluxSum = 0;
      for (let c = 0; c < ch; c++) {
        const src = inCh[c];
        const reC = reArr[c];
        const imC = imArr[c];
        for (let i = 0; i < N; i++) {
          const v = off + i < len ? src[off + i] : 0;
          reC[i] = v * win[i];
          imC[i] = 0;
        }
        fft.transform(reC, imC, true);
        const pm = prevMag[c];
        const mS = magS[c];
        const pS = phS[c];
        for (let k = 0; k <= N / 2; k++) {
          const m = Math.hypot(reC[k], imC[k]);
          const ph = Math.atan2(imC[k], reC[k]);
          mS[k] = m;
          pS[k] = ph;
          const d = m * m - pm[k];
          if (d > 0) fluxSum += d;
        }
      }

      // 2) ¿onset?
      let isOnset = fi === 0;
      if (!isOnset) {
        fluxHist[fluxHistIdx] = fluxSum;
        fluxHistSum += fluxSum - fluxHist[(fluxHistIdx + 31) % 32];
        fluxHistIdx = (fluxHistIdx + 1) % 32;
        fluxCount++;
        const avg = fluxHistSum / Math.min(fluxCount, 32);
        if (fluxSum > Math.max(0.05, 1.35 * avg) && fluxSum > 1e-6) isOnset = true;
      }

      // 3) propagación de fase + síntesis + OLA
      for (let c = 0; c < ch; c++) {
        const pp = prevPhase[c];
        const sp = synthPhase[c];
        const pm = prevMag[c];
        const mS = magS[c];
        const pS = phS[c];
        const reC = reArr[c];
        const imC = imArr[c];

        for (let k = 0; k <= N / 2; k++) {
          const m = mS[k];
          const ph = pS[k];
          if (isOnset) {
            sp[k] = ph; // reset de fase → ataque definido
          } else if (fi > 0) {
            let dphi = ph - pp[k] - omega[k] * HA;
            dphi -= 2 * Math.PI * Math.round(dphi / (2 * Math.PI));
            const freq = omega[k] + dphi / HA;
            sp[k] += freq * Hs;
          }
          pp[k] = ph;
          pm[k] = m;
          reC[k] = m * Math.cos(sp[k]);
          imC[k] = m * Math.sin(sp[k]);
          if (k > 0 && k < N / 2) {
            reC[N - k] = reC[k];
            imC[N - k] = -imC[k];
          }
        }
        fft.transform(reC, imC, false);

        const t = tail[c];
        const inv = 1 / N;
        for (let i = 0; i < N; i++) {
          t[rel + i] += reC[i] * win[i] * inv;
        }
        if (c === 0) {
          for (let i = 0; i < N; i++) tailNorm[rel + i] += winSq[i];
        }
      }
    }

    // escribir muestras finales del bloque
    const writeLen = Math.min(cf * Hs, outLen - written);
    for (let i = 0; i < writeLen; i++) {
      const nv = tailNorm[i];
      const g = nv > 1e-4 ? 1 / nv : 0;
      for (let c = 0; c < ch; c++) outCh[c][written + i] = tail[c][i] * g;
    }
    written += writeLen;

    // desplazar el resto al inicio de la cola
    const remain = Math.min(tailSize, (cf - 1) * Hs + N - writeLen);
    if (remain > 0) {
      for (let c = 0; c < ch; c++) tail[c].copyWithin(0, writeLen, writeLen + remain);
      tailNorm.copyWithin(0, writeLen, writeLen + remain);
    }
    tailValid = remain;

    onProgress({ label: "Estirando con vocoder de fase…", frac: written / outLen });
    await yieldFrame();
  }

  // vaciar la cola final (decaimiento del último frame)
  const remainEnd = Math.min(tailSize, (framesTotal - 1) * Hs + N - written);
  const w2 = Math.min(remainEnd, outLen - written);
  for (let i = 0; i < w2; i++) {
    const nv = tailNorm[i];
    const g = nv > 1e-4 ? 1 / nv : 0;
    for (let c = 0; c < ch; c++) outCh[c][written + i] = tail[c][i] * g;
  }

  onProgress({ label: "Estirando con vocoder de fase…", frac: 1 });
  return out;
}
