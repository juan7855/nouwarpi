import { estefa } from "../src/audio/estefa";
import { stretchChannels } from "../src/audio/stretch";
import { fineFlux, onsetEvents, validateOnsets } from "../src/audio/tracker";
import { variablePlan } from "../src/audio/warp";

let fail = 0;
function check(name: string, ok: boolean, info: string) { if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${name}: ${info}`); }
let seed = 5; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

// patrón de semicorcheas (posiciones en 1/16 dentro de 4 pulsos) con acentos
const PATTERN = [0, 3, 4, 6, 8, 10, 12, 14]; // 16avos dentro del compás
function phrase(bpm: number, bars: number, rubatoMs: number, start: number, sixteenth = true) {
  const beat = 60 / bpm;
  const ev: { t: number; s: number }[] = [];
  for (let b = 0; b < bars; b++) for (const p of PATTERN) {
    const drift = 0.015 * Math.sin((b * 16 + p) / 9) * (rubatoMs / 25);
    const t = start + (b * 16 + p) * (beat / 4) + (rnd() * 2 - 1) * (rubatoMs / 1000) + drift * (sixteenth ? 1 : 0);
    ev.push({ t, s: p % 4 === 0 ? 1 : 0.6 });
  }
  return ev;
}

// A) frase a 97 BPM natural, 4 compases, rubato ±25 ms, proyecto 120 BPM
{
  const start = 0.8, ev = phrase(97, 4, 25, start);
  const end = ev[ev.length - 1].t + 1.2;
  const r = estefa({ onsets: ev, markerSec: start, contentEnd: end, dur: end + 0.3, projBeatLen: 0.5, beatsPerBar: 4, strength: 1 })!;
  const ok = Math.abs(r.best.factor - 97 / 120) < 0.03 && r.confidence > 0.5 && r.best.subdiv === 4;
  check("A frase 97 BPM → 120", ok, `elige ${r.best.label}, rejilla 1/${4 * r.best.subdiv / 4 | 0}→subdiv ${r.best.subdiv}, confianza ${(r.confidence * 100).toFixed(0)} %, BPM natural ${r.naturalBpm.toFixed(1)}, ataques cuantizados ${r.snapped}/${r.total}`);
  // tras el plan, ¿qué desvío queda de cada ataque a la rejilla de semicorcheas?
  const sixteenth = 0.5 / 4;
  const plan = r.anchors;
  const fwd = (t: number) => { for (let i = 0; i < plan.length - 1; i++) if (t <= plan[i + 1].in) return plan[i].out + ((t - plan[i].in) * (plan[i + 1].out - plan[i].out)) / (plan[i + 1].in - plan[i].in); return plan[plan.length - 1].out; };
  const devs = ev.map((e) => { const o = fwd(e.t) - r.markerOut; return Math.abs(o - Math.round(o / sixteenth) * sixteenth) * 1000; });
  const mx = Math.max(...devs);
  check("A cuantizado elástico", mx < 12, `desvío máximo a la rejilla tras el plan: ${mx.toFixed(1)} ms (antes del plan: ±25 ms de rubato)`);
}

// B) loop de 2 compases a 90 BPM, ritmo exacto, con cola larga de reverb
{
  const start = 0.2, ev = phrase(90, 2, 0, start, false);
  const dur = start + 2 * 4 * (60 / 90) + 0.9; // el archivo mide justo 2 compases + cola
  const r = estefa({ onsets: ev, markerSec: start, contentEnd: dur - 0.1, dur, projBeatLen: 60 / 128, beatsPerBar: 4, strength: 1 })!;
  check("B loop 2 compases 90→128", Math.abs(r.best.factor - 90 / 128) < 0.03, `elige ${r.best.label}, confianza ${(r.confidence * 100).toFixed(0)} %`);
}

// C) tiempo libre: ataques sin relación con ninguna rejilla
{
  const ev: { t: number; s: number }[] = []; let t = 0.5;
  for (let i = 0; i < 24; i++) { t += 0.13 + rnd() * 0.9; ev.push({ t, s: 0.5 + rnd() * 0.5 }); }
  const r = estefa({ onsets: ev, markerSec: 0.5, contentEnd: t + 0.8, dur: t + 1, projBeatLen: 0.5, beatsPerBar: 4, strength: 1 })!;
  check("C tiempo libre", r.confidence < 0.45 && r.best.factor > 0.5 && r.best.factor < 2, `elige ${r.best.label}, confianza ${(r.confidence * 100).toFixed(0)} % (debe ser baja)`);
}

// D) el tempo natural ya casi coincide con el del proyecto → casi sin estirar
{
  const start = 0.3, ev = phrase(118, 4, 10, start);
  const end = ev[ev.length - 1].t + 1;
  const r = estefa({ onsets: ev, markerSec: start, contentEnd: end, dur: end + 0.2, projBeatLen: 60 / 120, beatsPerBar: 4, strength: 1 })!;
  check("D casi sin estirar", Math.abs(r.best.factor - 118 / 120) < 0.02, `elige ${r.best.label}`);
}

// E) cadena con audio real: clicks con rubato → Estefa → WSOLA → ¿caen en la rejilla?
{
  const sr = 44100, start = 0.6, ev = phrase(97, 4, 25, start);
  const len = Math.ceil((ev[ev.length - 1].t + 1.5) * sr);
  const x = new Float32Array(len);
  for (const e of ev) { const s0 = Math.round(e.t * sr); for (let i = 0; i < 4000 && s0 + i < len; i++) { const tt = i / sr; x[s0 + i] += Math.sin(2 * Math.PI * (60 + 100 * Math.exp(-tt * 45)) * tt) * Math.exp(-tt * 18) * e.s; } }
  const fine = fineFlux(x, sr);
  const det = validateOnsets(x, sr, onsetEvents(fine));
  const L = 0.5;
  const r = estefa({ onsets: det, markerSec: det[0].t, contentEnd: len / sr - 0.2, dur: len / sr, projBeatLen: L, beatsPerBar: 4, strength: 1 })!;
  if (process.env.DBG) { console.log('det', det.length, 'true', ev.length, 'first det', det.slice(0, 8).map((d) => d.t.toFixed(3) + '(' + d.s.toFixed(2) + ')').join(' '), ' | first true', ev.slice(0, 6).map((d) => d.t.toFixed(3)).join(' ')); for (const c of r.candidates) console.log('  cand', c.label, 'score', c.score.toFixed(3), 'subdiv', c.subdiv); }
  const out = stretchChannels([x], sr, r.anchors.map((a) => ({ in: a.in * sr, out: a.out * sr })), "wsola");
  const fo = fineFlux(out[0], sr), dout = validateOnsets(out[0], sr, onsetEvents(fo));
  const step = L / r.best.subdiv;
  const devs = dout.filter((e) => e.t > r.markerOut - 0.02).map((e) => { const o = e.t - r.markerOut; return Math.abs(o - Math.round(o / step) * step) * 1000; });
  const med = devs.sort((a, b) => a - b)[Math.floor(devs.length / 2)];
  check("E audio de clicks con rubato", Math.abs(r.best.factor - 97 / 120) < 0.03 && med < 4 && Math.max(...devs) < 12, `${r.best.label}; ataques en la salida: mediana ${med.toFixed(1)} ms, máx ${Math.max(...devs).toFixed(1)} ms sobre la rejilla de ${r.best.subdiv}/pulso (n=${devs.length})`);
}
void variablePlan;
console.log(fail ? `\n${fail} FALLOS` : "\nTODO OK"); process.exit(fail ? 1 : 0);
