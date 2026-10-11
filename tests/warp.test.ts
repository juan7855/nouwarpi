import { trackBeats, fineFlux, refineOnset } from "../src/audio/tracker";
import { stretchChannels, StretchMethod } from "../src/audio/stretch";
import { variablePlan, constantPlan } from "../src/audio/warp";
import { makeSong } from "./song";

function mono(chs: Float32Array[]) { const o = new Float32Array(chs[0].length); for (const c of chs) for (let i = 0; i < o.length; i++) o[i] += c[i] / chs.length; return o; }
let fail = 0;
const sr = 44100, target = 128, L = 60 / target;

function gridErrors(out: Float32Array[], markerOut: number, nBeats: number) {
  const fine = fineFlux(mono(out), sr);
  const errs: number[] = [];
  for (let k = 0; k < nBeats; k++) {
    const t = markerOut + k * L;
    const r = refineOnset(fine, t, 0.04);
    if (r) errs.push((r.t - t) * 1000);
  }
  return errs;
}

const cases: { name: string; bpmAt: (b: number) => number; jitter: number }[] = [
  { name: "constante 123.4", bpmAt: () => 123.4, jitter: 0 },
  { name: "variable ±3% + jitter 6ms", bpmAt: (b) => 120 * (1 + 0.03 * Math.sin(b / 14)), jitter: 6 },
];
for (const cs of cases) {
  const song = makeSong({ sr, bars: 48, bpmAt: cs.bpmAt, introSec: 0.5, jitterMs: cs.jitter, seed: 3 });
  const m = mono(song.chs);
  const tr = trackBeats(m, sr, 4);
  // marcador = primer tiempo fuerte tras la entrada de la batería (beat 8 = compás 3)
  let i0 = tr.beats.findIndex((b) => b >= song.beatT[8] - 0.05);
  while ((i0 - tr.downbeatPhase) % 4 !== 0) i0++;
  const marker = tr.beats[i0];
  const dur = m.length / sr;
  for (const method of ["wsola", "pvoc"] as StretchMethod[]) {
    const vp = variablePlan(tr.beats, marker, L, dur)!;
    const anchors = vp.plan.anchors.map((a) => ({ in: a.in * sr, out: a.out * sr }));
    const t0 = Date.now();
    const out = stretchChannels(song.chs, sr, anchors, method);
    const errs = gridErrors(out, vp.markerOut, 120);
    const mx = Math.max(...errs.map(Math.abs)), med = errs.map(Math.abs).sort((a, b) => a - b)[Math.floor(errs.length / 2)];
    if (process.env.DBG) console.log("   idx>6ms:", errs.map((e, i) => [i, e]).filter(([, e]) => Math.abs(e as number) > 6).map(([i, e]) => i + ":" + (e as number).toFixed(0)).join(" "));
    const sorted = errs.map(Math.abs).sort((a, b) => a - b);
    const p98 = sorted[Math.floor(sorted.length * 0.98)];
    const ok = (method === "wsola" ? mx < 12 : p98 < 12) && errs.length > 100;
    if (!ok) fail++;
    console.log(`${ok ? "OK  " : "FAIL"} ${cs.name} | variable ${method.padEnd(5)} → ${target} BPM: ataques en rejilla mediana=${med.toFixed(1)}ms máx=${mx.toFixed(1)}ms (n=${errs.length}) ${Date.now() - t0}ms`);
  }
  // modo constante sobre la misma canción, para ver cuánto mejora el variable
  {
    const f = target ? (60 / tr.bpm) / L * 0 + tr.bpm / target : 1;
    const out = stretchChannels(song.chs, sr, f, "wsola");
    const markerOut = marker * f;
    const errs = gridErrors(out, markerOut, 120);
    const mx = Math.max(...errs.map(Math.abs));
    console.log(`     (referencia) constante wsola con BPM medio ${tr.bpm.toFixed(2)}: máx desvío=${mx.toFixed(1)}ms`);
    void constantPlan;
  }
}
console.log(fail ? `\n${fail} FALLOS` : "\nTODO OK"); process.exit(fail ? 1 : 0);
