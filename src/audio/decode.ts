// Decodificación que respeta la frecuencia de muestreo y la profundidad del archivo.
// decodeAudioData remuestrea al rate del contexto (normalmente 44,1/48 kHz), lo que
// alteraría samples a 88,2/96 kHz. Por eso los WAV se leen directamente y, para
// FLAC/MP3/OGG, se detecta el rate del archivo y se decodifica a ese mismo rate.

const tag = (dv: DataView, o: number) =>
  String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));

function makeBuffer(frames: number, sr: number, chans: Float32Array[]): AudioBuffer {
  const buf = new AudioBuffer({ length: frames, sampleRate: sr, numberOfChannels: chans.length });
  for (let c = 0; c < chans.length; c++) buf.copyToChannel(chans[c] as Float32Array<ArrayBuffer>, c);
  return buf;
}

export function parseWav(ab: ArrayBuffer): AudioBuffer | null {
  if (ab.byteLength < 44) return null;
  const dv = new DataView(ab);
  const riff = tag(dv, 0);
  if ((riff !== "RIFF" && riff !== "RF64") || tag(dv, 8) !== "WAVE") return null;

  let fmtTag = 0;
  let nCh = 0;
  let sr = 0;
  let bits = 0;
  let dataOff = -1;
  let dataLen = 0;
  let pos = 12;
  while (pos + 8 <= ab.byteLength) {
    const id = tag(dv, pos);
    let size = dv.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === "fmt ") {
      fmtTag = dv.getUint16(body, true);
      nCh = dv.getUint16(body + 2, true);
      sr = dv.getUint32(body + 4, true);
      bits = dv.getUint16(body + 14, true);
      if (fmtTag === 0xfffe && size >= 40) fmtTag = dv.getUint16(body + 24, true);
    } else if (id === "data") {
      if (size === 0xffffffff || body + size > ab.byteLength) size = ab.byteLength - body;
      dataOff = body;
      dataLen = size;
      break;
    }
    pos = body + size + (size & 1);
  }
  if (dataOff < 0 || !nCh || !sr) return null;

  const bps = bits / 8;
  const isFloat = fmtTag === 3;
  if (!((fmtTag === 1 && [8, 16, 24, 32].includes(bits)) || (isFloat && (bits === 32 || bits === 64)))) {
    return null;
  }
  const frames = Math.floor(dataLen / (nCh * bps));
  if (frames < 1) return null;

  const chans: Float32Array[] = [];
  for (let c = 0; c < nCh; c++) chans.push(new Float32Array(frames));
  let o = dataOff;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nCh; c++) {
      let v: number;
      if (isFloat) {
        v = bits === 32 ? dv.getFloat32(o, true) : dv.getFloat64(o, true);
      } else if (bits === 16) {
        v = dv.getInt16(o, true) / 32768;
      } else if (bits === 24) {
        const x = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);
        v = ((x << 8) >> 8) / 8388608;
      } else if (bits === 32) {
        v = dv.getInt32(o, true) / 2147483648;
      } else {
        v = (dv.getUint8(o) - 128) / 128;
      }
      chans[c][i] = v;
      o += bps;
    }
  }
  try {
    return makeBuffer(frames, sr, chans);
  } catch {
    return null; // rate o canales no admitidos por AudioBuffer → decodificador del navegador
  }
}

function indexOfAscii(u8: Uint8Array, s: string, limit: number): number {
  const end = Math.min(u8.length, limit) - s.length;
  outer: for (let i = 0; i < end; i++) {
    for (let j = 0; j < s.length; j++) if (u8[i + j] !== s.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

// Frecuencia de muestreo declarada en la cabecera (FLAC, OGG, MP3). 0 si no se sabe.
export function sniffSampleRate(ab: ArrayBuffer): number {
  const u8 = new Uint8Array(ab, 0, Math.min(ab.byteLength, 1 << 20));
  const dv = new DataView(ab);
  if (u8.length > 24 && indexOfAscii(u8, "fLaC", 4) === 0) {
    return (u8[18] << 12) | (u8[19] << 4) | (u8[20] >> 4); // FLAC STREAMINFO
  }
  if (u8.length > 4 && indexOfAscii(u8, "OggS", 4) === 0) {
    const v = indexOfAscii(u8, "\u0001vorbis", 4096);
    if (v >= 0 && v + 16 < u8.length) return dv.getUint32(v + 7 + 4 + 1, true);
    if (indexOfAscii(u8, "OpusHead", 4096) >= 0) return 48000; // Opus siempre decodifica a 48 kHz
    return 0;
  }
  // MP3: saltar ID3v2 y leer la primera cabecera de trama
  let p = 0;
  if (indexOfAscii(u8, "ID3", 3) === 0) {
    p = 10 + ((u8[6] << 21) | (u8[7] << 14) | (u8[8] << 7) | u8[9]);
  }
  for (let i = p; i < Math.min(u8.length - 4, p + 65536); i++) {
    if (u8[i] === 0xff && (u8[i + 1] & 0xe0) === 0xe0) {
      const ver = (u8[i + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
      const layer = (u8[i + 1] >> 1) & 3;
      const idx = (u8[i + 2] >> 2) & 3;
      if (ver === 1 || layer === 0 || idx === 3) continue;
      const base = [44100, 48000, 32000][idx];
      return ver === 3 ? base : ver === 2 ? base / 2 : base / 4;
    }
  }
  return 0;
}

export async function decodeAudioFile(file: File): Promise<AudioBuffer> {
  const ab = await file.arrayBuffer();
  const wav = parseWav(ab);
  if (wav) return wav;
  const sr = sniffSampleRate(ab) || 44100;
  const ctx = new OfflineAudioContext(2, 1, Math.min(96000, Math.max(8000, sr)));
  return ctx.decodeAudioData(ab);
}
