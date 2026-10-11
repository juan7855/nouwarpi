// ESTEFA: sincronización automática de audio SIN pulso fijo (frases, samples sueltos,
// grabaciones con rubato, one-shots encadenados...). DSP puro.
//
// Estefa no necesita un BPM de origen. Decide ella:
//
//  1. CUÁNTOS pulsos ocupa el audio (1, 2, 4 pulsos, 1 compás, 2, 4, 8 compases...).
//  2. El FACTOR de estirado que lo encaja en esa duración al tempo del proyecto.
//  3. La SUBDIVISIÓN de la rejilla donde caen sus sonidos (negras, corcheas,
//     semicorcheas, tresillos).
//
// Para decidir combina tres criterios:
//   · matemático: error de cada ataque respecto a la rejilla, normalizado frente al
//     azar (con una rejilla fina todo "encaja"; se mide cuánto mejor que al azar);
//   · musical: preferencia por duraciones de compases enteros y potencias de dos;
//   · artefactos: se penaliza estirar mucho (cuanto menos se estira, mejor suena).
//
// Después hace un cuantizado ELÁSTICO: cada ataque fuerte se acerca a su punto de la
// rejilla (con la fuerza elegida) respetando que la velocidad local no cambie
// bruscamente, de modo que el resultado suene natural y no "a máquina rota".

import type { Anchor } from "./stretch";
import type { OnsetEvent } from "./tracker";

export interface EstefaInput {
  onsets: OnsetEvent[];
  markerSec: number; // el primer tiempo fuerte (inicio de la rejilla)
  contentEnd: number; // fin del sonido real
  dur: number; // duración total del audio
  projBeatLen: number; // segundos por pulso en el proyecto
  beatsPerBar: number;
  strength: number; // 0..1: cuánto se acerca cada ataque a su punto de rejilla
  pick?: number; // índice de la alternativa elegida por el usuario (0 = la que decide Estefa)
}

export interface EstefaCandidate {
  beats: number; // duración en pulsos
  factor: number; // salida / entrada
  subdiv: number; // divisiones por pulso de la rejilla ganadora
  fit: number; // 0..1: cuánto mejor que el azar encajan los ataques
  score: number;
  label: string;
}

export interface EstefaResult {
  best: EstefaCandidate;
  candidates: EstefaCandidate[]; // mejores alternativas (la primera es `best`)
  confidence: number; // 0..1
  anchors: Anchor[]; // segundos: in = original, out = estirado (sin relleno)
  markerOut: number; // posición del marcador en el dominio estirado
  snapped: number; // ataques movidos a la rejilla
  total: number; // ataques considerados
  naturalBpm: number; // tempo "natural" implícito en el audio
}

// Rejillas candidatas: divisiones por pulso y preferencia a priori (más simple = más probable).
const SUBDIVS: { s: number; prior: number; name: string }[] = [
  { s: 1, prior: 1.0, name: "negras" },
  { s: 2, prior: 0.97, name: "corcheas" },
  { s: 4, prior: 0.92, name: "semicorcheas" },
  { s: 3, prior: 0.85, name: "tresillos" },
  { s: 6, prior: 0.78, name: "tresillos de semicorchea" },
];

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// Cuánto mejor que el azar encajan los ataques en la rejilla (0 = azar, 1 = perfecto).
// Devuelve la mejor rejilla (ponderada por su simplicidad).
function gridFit(
  ev: OnsetEvent[],
  marker: number,
  f: number,
  L: number
): { fit: number; subdiv: number } {
  let best = { fit: 0, subdiv: 1, eff: -1 };
  let wsum = 0;
  for (const e of ev) wsum += 0.25 + e.s;
  if (ev.length < 3 || wsum <= 0) return { fit: 0.4, subdiv: 2 };
  for (const g of SUBDIVS) {
    const step = L / g.s;
    let err = 0;
    for (const e of ev) {
      const u = (e.t - marker) * f;
      const d = Math.abs(u - Math.round(u / step) * step);
      err += (0.25 + e.s) * d;
    }
    err /= wsum;
    const fit = clamp(1 - err / (step / 4), 0, 1); // el azar da step/4
    const eff = fit * g.prior;
    if (eff > best.eff) best = { fit, subdiv: g.s, eff };
  }
  return { fit: best.fit, subdiv: best.subdiv };
}

// Subdivisión de la rejilla donde caen los sonidos: la más gruesa que "cubre" casi todos los
// ataques (con tolerancia proporcional al paso); si ninguna lo logra, la que más cubre.
function chooseSubdiv(ev: OnsetEvent[], marker: number, f: number, L: number): number {
  let wsum = 0;
  for (const e of ev) wsum += 0.25 + e.s;
  if (ev.length < 3 || wsum <= 0) return 2;
  const cover = (sd: number) => {
    const step = L / sd;
    let ok = 0;
    for (const e of ev) {
      const u = (e.t - marker) * f;
      const d = Math.abs(u - Math.round(u / step) * step);
      if (d <= 0.35 * step) ok += 0.25 + e.s;
    }
    return ok / wsum;
  };
  const chain = [1, 2, 4];
  const cov = chain.map(cover);
  for (let i = 0; i < chain.length; i++) if (cov[i] >= 0.93) return chain[i];
  const tri = [3, 6];
  const covT = tri.map(cover);
  const bestC = Math.max(...cov);
  const bi = covT[0] >= covT[1] ? 0 : 1;
  if (covT[bi] >= 0.93 && covT[bi] > bestC + 0.05) return tri[bi];
  return chain[cov.indexOf(bestC)];
}

// Curva de "evidencia de pulso": autocorrelación del tren de ataques (ponderado por fuerza).
// Un pulso real se ve como pares de ataques acentuados separados exactamente un pulso.
const A_LO = 0.15; // s
const A_HI = 2.0;
const A_BIN = 0.002;
const A_SIGMA = 0.012;

function pulseCurve(ev: OnsetEvent[]): Float64Array {
  const n = Math.floor((A_HI - A_LO) / A_BIN) + 1;
  const A = new Float64Array(n);
  const top = ev.slice().sort((a, b) => b.s - a.s).slice(0, 240).sort((a, b) => a.t - b.t);
  const reach = Math.ceil((3 * A_SIGMA) / A_BIN);
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      const d = top[j].t - top[i].t;
      if (d > A_HI + 3 * A_SIGMA) break;
      if (d < A_LO - 3 * A_SIGMA) continue;
      const w = top[i].s * top[j].s;
      const c = Math.round((d - A_LO) / A_BIN);
      for (let k = Math.max(0, c - reach); k <= Math.min(n - 1, c + reach); k++) {
        const x = (A_LO + k * A_BIN - d) / A_SIGMA;
        A[k] += w * Math.exp(-0.5 * x * x);
      }
    }
  }
  return A;
}

// Curva nula: la misma autocorrelación pero con los intervalos entre ataques barajados
// (conserva el vocabulario rítmico y destruye la periodicidad). Devuelve media y desviación
// por retardo, para exigir que el pulso supere al azar en varias desviaciones típicas
// (así no se premia al "mejor de muchos candidatos" por pura casualidad).
function nullCurve(ev: OnsetEvent[], len: number): { mu: Float64Array; sd: Float64Array } {
  const mu = new Float64Array(len);
  const sd = new Float64Array(len);
  if (ev.length < 8) return { mu, sd };
  const iois: number[] = [];
  for (let i = 1; i < ev.length; i++) iois.push(ev[i].t - ev[i - 1].t);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const R = 16;
  const sq = new Float64Array(len);
  for (let r = 0; r < R; r++) {
    const sh = iois.slice();
    for (let i = sh.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [sh[i], sh[j]] = [sh[j], sh[i]];
    }
    let t = ev[0].t;
    const fake: OnsetEvent[] = [{ t, s: ev[0].s }];
    for (let i = 0; i < sh.length; i++) {
      t += sh[i];
      fake.push({ t, s: ev[i + 1].s });
    }
    const c = pulseCurve(fake);
    for (let i = 0; i < len; i++) {
      mu[i] += c[i] / R;
      sq[i] += (c[i] * c[i]) / R;
    }
  }
  for (let i = 0; i < len; i++) sd[i] = Math.sqrt(Math.max(0, sq[i] - mu[i] * mu[i]));
  return { mu, sd };
}

// Evidencia de pulso a una distancia `tb` (0 = como el azar, 1 = claramente periódico).
function makePulse(A: Float64Array, N: { mu: Float64Array; sd: Float64Array }, hasNull: boolean) {
  let max = 0;
  for (const v of A) if (v > max) max = v;
  const at = (C: Float64Array, tb: number) => {
    const c = (tb - A_LO) / A_BIN;
    const i0 = Math.max(0, Math.floor(c) - 1);
    const i1 = Math.min(C.length - 1, Math.ceil(c) + 1);
    let v = 0;
    for (let i = i0; i <= i1; i++) if (C[i] > v) v = C[i];
    return v;
  };
  return (tb: number) => {
    if (tb < A_LO || tb > A_HI) return 0;
    const a = at(A, tb);
    if (!hasNull) return clamp(a / Math.max(1e-9, max), 0, 1) * 0.5;
    const mu = at(N.mu, tb);
    const sd = at(N.sd, tb);
    return clamp((a - mu - 2 * sd) / (3 * sd + 0.1 * max), 0, 1);
  };
}

// Jerarquía de acentos: los ataques más fuertes deben caer en pulsos o medios pulsos
// (si no, una rejilla de tresillos "encaja" con cualquier cosa).
function accentFit(ev: OnsetEvent[], marker: number, f: number, L: number): number {
  const strong = ev.filter((e) => e.s >= 0.85);
  if (strong.length < 3 || strong.length === ev.length) return 0.5;
  let best = 0;
  for (const g of [{ s: 1, prior: 1.0 }, { s: 2, prior: 0.95 }]) {
    const step = L / g.s;
    let err = 0;
    for (const e of strong) {
      const u = (e.t - marker) * f;
      err += Math.abs(u - Math.round(u / step) * step);
    }
    err /= strong.length;
    best = Math.max(best, clamp(1 - err / (step / 4), 0, 1) * g.prior);
  }
  return best;
}

// Tempo "natural" más probable de una pieza (BPM del audio): centrado hacia 105 BPM.
const tempoPrior = (bpm: number) => Math.exp(-0.5 * Math.pow(Math.log2(bpm / 105) / 0.75, 2));

// ¿La duración del audio es un número "bonito" de compases (1, 2, 4, 8...)?
function loopBonus(spans: number[], tb: number, bpb: number): number {
  let best = 0;
  for (const D of spans) {
    const bars = D / (tb * bpb);
    const r = Math.round(bars);
    if (r < 1) continue;
    const closeness = 1 - Math.min(1, Math.abs(bars - r) / 0.1);
    const nice = (r & (r - 1)) === 0 ? 1 : r % 2 === 0 ? 0.6 : 0.4;
    best = Math.max(best, closeness * nice);
  }
  return best;
}

function describe(D: number, tb: number, bpb: number): string {
  const beats = D / tb;
  const bars = beats / bpb;
  if (Math.abs(bars - Math.round(bars)) < 0.08 && bars >= 1) {
    const b = Math.round(bars);
    return b === 1 ? "1 compás" : `${b} compases`;
  }
  const n = Math.round(beats * 2) / 2;
  return n === 1 ? "1 pulso" : `${n} pulsos`;
}

export function estefa(inp: EstefaInput): EstefaResult | null {
  const { markerSec, contentEnd, dur, projBeatLen: L, beatsPerBar: bpb } = inp;
  // periodo refractario (~90 ms): las colas de un golpe grave generan falsos ataques justo detrás
  const prim: OnsetEvent[] = [];
  for (const e of inp.onsets.slice().sort((a, b) => a.t - b.t)) {
    const last = prim[prim.length - 1];
    if (last && e.t - last.t < 0.09) {
      if (e.s > 1.5 * last.s) prim[prim.length - 1] = e;
      continue;
    }
    prim.push(e);
  }
  const ev = prim.filter((e) => e.t >= markerSec - 0.02 && e.t <= contentEnd + 0.05);
  const spans: number[] = [];
  const d1 = contentEnd - markerSec;
  const d2 = dur - markerSec;
  if (d1 > 0.05) spans.push(d1);
  if (d2 > 0.05 && Math.abs(d2 - d1) > 0.02) spans.push(d2);
  if (!spans.length) return null;
  const D = spans[0];

  // 1) el tempo natural sale de la propia estructura del audio: picos de la curva de pulso
  //    (y sus octavas) como candidatos, afinados por encaje en la rejilla
  const A = ev.length >= 4 ? pulseCurve(ev) : new Float64Array(0);
  const hasNull = ev.length >= 8;
  const Nc = A.length ? nullCurve(ev, A.length) : { mu: new Float64Array(0), sd: new Float64Array(0) };
  const pulse = A.length ? makePulse(A, Nc, hasNull) : () => 0;
  const tbCands: number[] = [];
  if (A.length) {
    let max = 0;
    for (const v of A) if (v > max) max = v;
    for (let i = 2; i < A.length - 2; i++) {
      if (A[i] >= 0.3 * max && A[i] >= A[i - 1] && A[i] >= A[i + 1] && A[i] >= A[i - 2] && A[i] >= A[i + 2]) {
        const tb = A_LO + i * A_BIN;
        for (const m of [0.5, 1, 2, 3, 4]) tbCands.push(tb * m);
      }
    }
  }
  // sin evidencia: se prueban tempos naturales repartidos (el criterio "estirar poco" decide)
  for (let bpm = 60; bpm <= 180; bpm += 4) tbCands.push(60 / bpm);

  const cands: EstefaCandidate[] = [];
  const seen: number[] = [];
  for (const tb0 of tbCands) {
    const f0 = L / tb0;
    if (f0 < 0.5 || f0 > 2 || tb0 < 0.2 || tb0 > 1.5) continue;
    // 2) afinado fino ±3 % del factor
    let bestF = f0;
    let bestVal = -1;
    for (let k = -12; k <= 12; k++) {
      const f = f0 * (1 + k * 0.0025);
      const g = gridFit(ev, markerSec, f, L);
      const val = 0.5 * pulse(L / f) + 0.5 * g.fit - 0.2 * Math.abs(k * 0.0025);
      if (val > bestVal) {
        bestVal = val;
        bestF = f;
      }
    }
    if (seen.some((x) => Math.abs(Math.log2(x / bestF)) < 0.006)) continue;
    seen.push(bestF);
    const tb = L / bestF;
    const g = gridFit(ev, markerSec, bestF, L);
    const pl = pulse(tb);
    const prior = tempoPrior(60 / tb);
    const loop = loopBonus(spans, tb, bpb);
    const stretchPen = Math.abs(Math.log2(bestF));
    const acc = accentFit(ev, markerSec, bestF, L);
    const score = 0.26 * pl + 0.2 * g.fit + 0.2 * acc + 0.1 * prior + 0.1 * loop - 0.22 * stretchPen;
    cands.push({
      beats: D / tb,
      factor: bestF,
      subdiv: chooseSubdiv(ev, markerSec, bestF, L),
      fit: g.fit,
      score,
      label: `${Math.round(60 / tb)} BPM naturales → ×${bestF.toFixed(3)} (${describe(D, tb, bpb)}, ajuste ${Math.round(g.fit * 100)} %)`,
    });
    void pl;
  }
  const list = cands.sort((a, b) => b.score - a.score);
  if (!list.length) return null;
  // alternativas realmente distintas (la primera es la que decide Estefa)
  const alts: EstefaCandidate[] = [list[0]];
  for (const c of list.slice(1)) {
    if (alts.length >= 5) break;
    if (alts.every((a) => Math.abs(Math.log2(a.factor / c.factor)) > 0.08)) alts.push(c);
  }
  const best = alts[Math.min(Math.max(0, inp.pick ?? 0), alts.length - 1)];
  const others = alts.filter((a) => a !== best);
  const second = others.reduce<EstefaCandidate | undefined>((m, c) => (!m || c.score > m.score ? c : m), undefined);
  const margin = second ? clamp((best.score - second.score) / 0.1, 0, 1) : 1;
  const evidence = clamp(0.5 * pulse(L / best.factor) + 0.5 * best.fit, 0, 1);
  const confidence = ev.length < 6 ? evidence * 0.5 : evidence * (0.55 + 0.45 * margin);

  // 3) cuantizado elástico
  const f = best.factor;
  const markerOut = markerSec * f;
  const step = L / best.subdiv;
  const maxShift = 0.45 * step;
  const strong = ev.filter((e) => e.s >= 0.3);
  const pts: Anchor[] = [
    { in: 0, out: 0 },
    { in: markerSec, out: markerOut },
  ];
  let lastIn = markerSec;
  let lastOut = markerOut;
  let snapped = 0;
  for (const e of strong) {
    if (e.t <= lastIn + 0.02) continue;
    const u = (e.t - markerSec) * f;
    const q = Math.round(u / step) * step;
    const d = q - u;
    if (Math.abs(d) > maxShift) continue;
    const out = markerOut + u + inp.strength * d;
    // la velocidad local no puede cambiar bruscamente (suena natural, sin artefactos)
    const slope = (out - lastOut) / (e.t - lastIn);
    if (slope < 0.6 * f || slope > 1.6 * f) continue;
    pts.push({ in: e.t, out });
    lastIn = e.t;
    lastOut = out;
    if (Math.abs(d) > 1e-4) snapped++;
  }
  pts.push({ in: dur, out: lastOut + (dur - lastIn) * f });

  return {
    best,
    candidates: alts,
    confidence,
    anchors: pts,
    markerOut,
    snapped,
    total: strong.length,
    naturalBpm: (60 * f) / L,
  };
}
