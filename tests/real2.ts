import { readFileSync } from "fs";
import { fineFlux, onsetEvents, validateOnsets } from "../src/audio/tracker";
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
  for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < fmt.ch; c++) { const o = dataOff + (i * fmt.ch + c) * bps; let v = 0;
    if (fmt.tag === 3) v = buf.readFloatLE(o); else if (fmt.bits === 16) v = buf.readInt16LE(o) / 32768; else if (fmt.bits === 24) v = buf.readIntLE(o, 3) / 8388608; else if (fmt.bits === 32) v = buf.readInt32LE(o) / 2147483648; s += v / fmt.ch; } out[i] = s; }
  return { x: out, sr: fmt.sr as number };
}
const { x, sr } = parseWav(readFileSync(process.argv[2]), Number(process.argv[3] ?? 90));
const ev = validateOnsets(x, sr, onsetEvents(fineFlux(x, sr)));
console.log("onsets", ev.length, "dur", (x.length / sr).toFixed(0));
const res: { bpm: number; R: number }[] = [];
for (let bpm = 60; bpm <= 200; bpm += 0.02) {
  const T = 60 / bpm; let c = 0, s = 0, w = 0;
  for (const e of ev) { const a = 2 * Math.PI * e.t / T; c += e.s * Math.cos(a); s += e.s * Math.sin(a); w += e.s; }
  res.push({ bpm, R: Math.hypot(c, s) / w });
}
const peaks = res.filter((r, i) => i > 0 && i < res.length - 1 && r.R > res[i - 1].R && r.R >= res[i + 1].R).sort((a, b) => b.R - a.R).slice(0, 6);
console.log(peaks.map((p) => p.bpm.toFixed(2) + ":" + p.R.toFixed(2)).join("  "));
