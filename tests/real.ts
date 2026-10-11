// Prueba con audio real (archivos locales): node .tmp/real.js "ruta.wav" [segundos]
import { readFileSync } from "fs";
import { trackBeats } from "../src/audio/tracker";

function parseWav(buf: Buffer, maxSec: number) {
  let p = 12, fmt: any = null, dataOff = 0, dataLen = 0;
  while (p + 8 <= buf.length) {
    const id = buf.toString("ascii", p, p + 4), sz = buf.readUInt32LE(p + 4);
    if (id === "fmt ") fmt = { tag: buf.readUInt16LE(p + 8), ch: buf.readUInt16LE(p + 10), sr: buf.readUInt32LE(p + 12), bits: buf.readUInt16LE(p + 22) };
    if (id === "data") { dataOff = p + 8; dataLen = Math.min(sz, buf.length - dataOff); break; }
    p += 8 + sz + (sz & 1);
  }
  const bps = fmt.bits / 8, n = Math.min(Math.floor(dataLen / bps / fmt.ch), Math.floor(maxSec * fmt.sr));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < fmt.ch; c++) {
      const o = dataOff + (i * fmt.ch + c) * bps;
      let v = 0;
      if (fmt.tag === 3) v = buf.readFloatLE(o);
      else if (fmt.bits === 16) v = buf.readInt16LE(o) / 32768;
      else if (fmt.bits === 24) v = buf.readIntLE(o, 3) / 8388608;
      else if (fmt.bits === 32) v = buf.readInt32LE(o) / 2147483648;
      s += v / fmt.ch;
    }
    out[i] = s;
  }
  return { x: out, sr: fmt.sr as number };
}


const file = process.argv[2], maxSec = Number(process.argv[3] ?? 90);
const { x, sr } = parseWav(readFileSync(file), maxSec);
const t0 = Date.now();
const tr = trackBeats(x, sr, 4);
const b = tr.beats, good = tr.beatGood;
const ibi: number[] = [];
for (let i = 1; i < b.length; i++) ibi.push(b[i] - b[i - 1]);
const sorted = [...ibi].sort((a, c) => a - c);
const med = sorted[Math.floor(sorted.length / 2)];
const dev = ibi.map((d) => Math.abs(d - med) / med);
console.log(file.split(/[\/]/).pop(), `dur=${(x.length / sr).toFixed(0)}s bpm=${tr.bpm.toFixed(2)} beats=${b.length} good=${good.filter(Boolean).length} medIBI=${(med * 1000).toFixed(0)}ms maxDev=${(Math.max(...dev) * 100).toFixed(0)}% p90dev=${(dev.sort((a, c) => a - c)[Math.floor(dev.length * 0.9)] * 100).toFixed(1)}% first=${b[0]?.toFixed(3)} dbPhase=${tr.downbeatPhase} ${Date.now() - t0}ms`);
