// Codificación WAV sin pérdida: 24 bits PCM o 32 bits flotante,
// a la misma frecuencia de muestreo y canales del original.

export function encodeWav(
  channels: Float32Array[],
  sampleRate: number,
  bitDepth: 24 | 32
): Blob {
  const numCh = channels.length;
  const numSamples = channels[0].length;
  const isFloat = bitDepth === 32;
  const blockAlign = numCh * (bitDepth / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;

  const headerSize = 12 + 8 + 16 + 8; // RIFF + fmt + data headers
  const buffer = new ArrayBuffer(headerSize + dataSize);
  const dv = new DataView(buffer);

  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  dv.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, isFloat ? 3 : 1, true); // formato
  dv.setUint16(22, numCh, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bitDepth, true);
  writeStr(36, "data");
  dv.setUint32(40, dataSize, true);

  let off = headerSize;
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
