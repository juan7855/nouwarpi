// Codificación WAV sin pérdida: 24 bits PCM o 32 bits flotante,
// a la misma frecuencia de muestreo y canales del original.
// Opcionalmente incrusta el chunk "acid" (tempo y nº de pulsos), que leen
// muchos DAWs y samplers para saber el BPM de un loop.

export interface WavTempoMeta {
  bpm: number;
  beats: number; // pulsos totales del loop
  beatsPerBar: number;
}

export function encodeWav(
  channels: Float32Array[],
  sampleRate: number,
  bitDepth: 24 | 32,
  meta?: WavTempoMeta
): Blob {
  const numCh = channels.length;
  const numSamples = channels[0].length;
  const isFloat = bitDepth === 32;
  const blockAlign = numCh * (bitDepth / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;

  const fmtSize = isFloat ? 18 : 16;
  const factSize = isFloat ? 12 : 0; // el formato float exige chunk "fact"
  const acidSize = meta ? 8 + 24 : 0;
  const headerSize = 12 + 8 + fmtSize + factSize + acidSize + 8;
  const total = headerSize + dataSize + (dataSize & 1);

  const buffer = new ArrayBuffer(total);
  const dv = new DataView(buffer);
  let p = 0;
  const str = (s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(p++, s.charCodeAt(i));
  };
  const u32 = (v: number) => {
    dv.setUint32(p, v, true);
    p += 4;
  };
  const u16 = (v: number) => {
    dv.setUint16(p, v, true);
    p += 2;
  };
  const f32 = (v: number) => {
    dv.setFloat32(p, v, true);
    p += 4;
  };

  str("RIFF");
  u32(total - 8);
  str("WAVE");
  str("fmt ");
  u32(fmtSize);
  u16(isFloat ? 3 : 1);
  u16(numCh);
  u32(sampleRate);
  u32(byteRate);
  u16(blockAlign);
  u16(bitDepth);
  if (isFloat) u16(0); // cbSize
  if (isFloat) {
    str("fact");
    u32(4);
    u32(numSamples);
  }
  if (meta) {
    str("acid");
    u32(24);
    u32(0); // flags: loop (no one-shot)
    u16(60); // nota raíz (sin uso)
    u16(0x8000);
    f32(0);
    u32(Math.max(1, Math.round(meta.beats)));
    u16(4); // denominador del compás
    u16(meta.beatsPerBar);
    f32(meta.bpm);
  }
  str("data");
  u32(dataSize);

  let off = p;
  for (let i = 0; i < numSamples; i++) {
    for (let c = 0; c < numCh; c++) {
      let v = channels[c][i];
      if (!isFloat) {
        v = v > 1 ? 1 : v < -1 ? -1 : v;
        const iv = v < 0 ? Math.round(v * 8388608) : Math.round(v * 8388607);
        dv.setUint8(off, iv & 0xff);
        dv.setUint8(off + 1, (iv >> 8) & 0xff);
        dv.setUint8(off + 2, (iv >> 16) & 0xff);
        off += 3;
      } else {
        dv.setFloat32(off, v, true);
        off += 4;
      }
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
}

export function maxAbs(channels: Float32Array[]): number {
  let m = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > m) m = a;
    }
  }
  return m;
}
