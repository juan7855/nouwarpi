import { readFileSync } from "fs";
import { trackBeats, fineFlux, onsetEvents, validateOnsets } from "../src/audio/tracker";
import { autoPlan, bestOctave } from "../src/audio/decide";
import { constantPlan, variablePlan, scaleBeats } from "../src/audio/warp";
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
const PROJ = Number(process.argv[4] ?? 90);
const dur = x.length / sr;
const tr = trackBeats(x, sr, 4);
const ev = validateOnsets(x, sr, onsetEvents(fineFlux(x, sr)));
const L = 60 / PROJ;
function score(fwd: (t: number) => number, anchor: number) {
  // coherencia con la rejilla de CORCHEAS del proyecto (periodo L/2) y con la de negras (L)
  const r = (P: number) => { let c = 0, s = 0, w = 0; for (const e of ev) { const a = (2 * Math.PI * (fwd(e.t) - anchor)) / P; c += e.s * Math.cos(a); s += e.s * Math.sin(a); w += e.s; } return Math.hypot(c, s) / w; };
  // fracción de ataques fuertes a ±20 ms de la rejilla de semicorcheas
  let on = 0, tot = 0; for (const e of ev) { if (e.s < 0.5) continue; tot++; const d = fwd(e.t) - anchor, q = L / 4, off = Math.abs(d - Math.round(d / q) * q); if (off < 0.02) on++; }
  return `Rneg=${r(L).toFixed(2)} R8=${r(L / 2).toFixed(2)} en16=${((on / tot) * 100).toFixed(0)}%`;
}
const ap = autoPlan(tr, dur, PROJ, 4);
const mult = bestOctave(tr.bpm, PROJ);
const cp = constantPlan(dur, (tr.bpm * mult) / PROJ);
const vp = variablePlan(scaleBeats(tr.beats, mult, ap.markerSec), ap.markerSec, L, dur);
const name = process.argv[2].split(/[\/]/).pop();
console.log(name, `bpm=${tr.bpm.toFixed(2)} x${mult} drift=${tr.driftMs.toFixed(0)} rms=${tr.rmsMs.toFixed(0)} good=${tr.goodBeats}/${tr.beats.length} auto=${ap.mode}`);
console.log("   const :", score(cp.fwd, cp.fwd(ap.markerSec)));
if (vp) console.log("   var   :", score(vp.plan.fwd, vp.plan.fwd(ap.markerSec)));
console.log("   AUTO  :", score(ap.plan.fwd, ap.markerOut));
