// Mide en LINEAL si el estirado introduce clics o picos justo antes de los golpes (donde se anclan
// fragmentos) y cuánto se desplazan los golpes. Se ejecuta con distintos márgenes de ajuste de fase.
import { trackBeats, fineFlux, onsetEvents } from "../src/audio/tracker";
import { stretchChannels } from "../src/audio/stretch";
import { variablePlan } from "../src/audio/warp";
import { makeSong } from "./song";
const sr = 44100, L = 60 / 128;
const song = makeSong({ sr, bars: 48, bpmAt: () => 123.4, introSec: 0.5, jitterMs: 0, seed: 3 });
const m = new Float32Array(song.chs[0].length); for (const c of song.chs) for (let i = 0; i < m.length; i++) m[i] += c[i] / 2;
const tr = trackBeats(m, sr, 4);
let i0 = tr.beats.findIndex((b) => b >= song.beatT[8] - 0.05); while ((i0 - tr.downbeatPhase) % 4 !== 0) i0++;
const marker = tr.beats[i0];
const vp = variablePlan(tr.beats, marker, L, m.length / sr)!;
const out = stretchChannels(song.chs, sr, vp.plan.anchors.map((a) => ({ in: a.in * sr, out: a.out * sr })), "wsola");
const mo = new Float32Array(out[0].length); for (const c of out) for (let i = 0; i < mo.length; i++) mo[i] += c[i] / 2;
let j0 = 0; song.beatT.forEach((t, j) => { if (Math.abs(t - marker) < Math.abs(song.beatT[j0] - marker)) j0 = j; });
const d1 = (x: Float32Array, a: number, b: number) => { let mx = 0; for (let i = Math.max(1, Math.floor(a * sr)); i < Math.floor(b * sr); i++) mx = Math.max(mx, Math.abs(x[i] - x[i - 1])); return mx; };
const pk = (x: Float32Array, a: number, b: number) => { let mx = 0; for (let i = Math.max(0, Math.floor(a * sr)); i < Math.floor(b * sr); i++) mx = Math.max(mx, Math.abs(x[i])); return mx; };
const jump: number[] = [], peak: number[] = [], timing: number[] = [];
const ev = onsetEvents(fineFlux(mo, sr));
for (let k = 0; k < 120; k++) {
  const tb = song.beatT[j0 + k], to = vp.plan.fwd(tb);
  const dIn = d1(m, tb - 0.07, tb - 0.012), dOut = d1(mo, to - 0.07, to - 0.012);
  const pIn = pk(m, tb - 0.07, tb - 0.012), pOut = pk(mo, to - 0.07, to - 0.012);
  if (dIn > 1e-6) jump.push(dOut / dIn);
  if (pIn > 1e-6) peak.push(pOut / pIn);
  let best: { t: number; s: number } | null = null; for (const e of ev) if (Math.abs(e.t - to) <= 0.05 && (!best || e.s > best.s)) best = e;
  if (best) timing.push(Math.abs(best.t - to) * 1000);
}
const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(a.length * p)];
console.log(`pico previo salida/entrada: p90 ${q(peak, 0.9).toFixed(3)} máx ${q(peak, 0.99).toFixed(3)} | salto muestra a muestra: p90 ${q(jump, 0.9).toFixed(3)} máx ${q(jump, 0.99).toFixed(3)} | timing del golpe: mediana ${q(timing, 0.5).toFixed(2)} ms, máx ${q(timing, 0.99).toFixed(2)} ms`);
const ok = q(peak, 0.99) < 1.3 && q(jump, 0.99) < 1.6 && q(timing, 0.99) < 6;
console.log(ok ? "TODO OK" : "FALLO"); process.exit(ok ? 0 : 1);
