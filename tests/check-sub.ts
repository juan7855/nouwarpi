import fs from "node:fs";
import { fineFlux, onsetEvents, validateOnsets } from "../src/audio/tracker";
const [file, bpmS, subS] = process.argv.slice(2);
const step = 60 / Number(bpmS) / Number(subS);
const f = fs.readFileSync(file); const dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
let p = 12, ch = 2, sr = 44100, off = 0, len = 0;
while (p < f.length) { const id = f.toString("latin1", p, p + 4), size = dv.getUint32(p + 4, true); if (id === "fmt ") { ch = dv.getUint16(p + 10, true); sr = dv.getUint32(p + 12, true); } if (id === "data") { off = p + 8; len = size; break; } p += 8 + size + (size & 1); }
const n = len / (ch * 3), x = new Float32Array(n);
for (let i = 0; i < n; i++) { let a = 0; for (let c = 0; c < ch; c++) { const o = off + (i * ch + c) * 3; let v = f[o] | (f[o + 1] << 8) | (f[o + 2] << 16); v = (v << 8) >> 8; a += v / 8388608; } x[i] = a / ch; }
const ev = validateOnsets(x, sr, onsetEvents(fineFlux(x, sr)));
const t0 = ev[0].t;
const devs = ev.map((e) => { const o = e.t - t0; return Math.abs(o - Math.round(o / step) * step) * 1000; });
devs.sort((a, b) => a - b);
console.log(`duración ${(n / sr).toFixed(2)} s | golpes detectados ${ev.length} | desvío a la rejilla de ${bpmS} BPM / ${subS} por pulso: mediana ${devs[Math.floor(devs.length / 2)].toFixed(1)} ms, p90 ${devs[Math.floor(devs.length * 0.9)].toFixed(1)} ms, máx ${devs[devs.length - 1].toFixed(1)} ms`);
