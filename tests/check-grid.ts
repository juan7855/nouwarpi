import fs from "node:fs";
import { fineFlux, refineOnset } from "../src/audio/tracker";
const [file, bpmS] = process.argv.slice(2);
const L = 60 / Number(bpmS);
const f = fs.readFileSync(file);
const dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
let p = 12, ch = 2, sr = 44100, off = 0, len = 0;
while (p < f.length) { const id = f.toString("latin1", p, p + 4), size = dv.getUint32(p + 4, true); if (id === "fmt ") { ch = dv.getUint16(p + 10, true); sr = dv.getUint32(p + 12, true); } if (id === "data") { off = p + 8; len = size; break; } p += 8 + size + (size & 1); }
const n = len / (ch * 3), x = new Float32Array(n);
for (let i = 0; i < n; i++) { let a = 0; for (let c = 0; c < ch; c++) { const o = off + (i * ch + c) * 3; let v = f[o] | (f[o + 1] << 8) | (f[o + 2] << 16); v = (v << 8) >> 8; a += v / 8388608; } x[i] = a / ch; }
const fine = fineFlux(x, sr);
// el primer ataque marca el pulso 0
const first = refineOnset(fine, 0.02, 0.04);
const t0 = first ? first.t : 0;
const errs: number[] = [];
const total = Math.floor((n / sr - 2) / L);
for (let k = 8; k < total - 6; k++) { const t = k * L; const r = refineOnset(fine, t, 0.04); if (r) errs.push((r.t - t) * 1000); }
const abs = errs.map(Math.abs).sort((a, b) => a - b);
console.log(`duración ${(n / sr).toFixed(2)} s, sr ${sr}, pulsos medidos ${errs.length}/${total}; primer ataque en ${(t0 * 1000).toFixed(1)} ms`);
console.log(`desvío respecto a la rejilla de ${bpmS} BPM: mediana ${abs[Math.floor(abs.length / 2)].toFixed(1)} ms, p95 ${abs[Math.floor(abs.length * 0.95)].toFixed(1)} ms, máx ${abs[abs.length - 1].toFixed(1)} ms`);
console.log(errs.map((e, k) => Math.abs(e) > 6 ? k + ":" + e.toFixed(0) : "").filter(Boolean).join(" "));
