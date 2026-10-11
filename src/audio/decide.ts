// Decisiones automáticas de la app (puras, probadas en tests): qué pulso es el "1", qué octava del
// tempo usar respecto al proyecto y qué plan de alineación construir.

import type { BeatTrack } from "./tracker";
import { constantPlan, variablePlan, scaleBeats, WarpPlan } from "./warp";

// Primer tiempo fuerte (inicio de compás) a partir del primer sonido real.
export function firstDownbeat(tr: BeatTrack, bpb: number): number {
  const beats = tr.beats;
  if (!beats.length) return tr.firstSoundSec;
  // el "1" debe caer SIEMPRE sobre un pulso con ataque real (no sobre uno extrapolado en una intro)
  const good = (i: number) => !tr.beatGood || tr.beatGood[i] !== false;
  let i = beats.findIndex((b, idx) => b >= tr.firstSoundSec - 0.08 && good(idx));
  if (i < 0) i = beats.findIndex((b) => b >= tr.firstSoundSec - 0.08);
  if (i < 0) i = 0;
  // con todos los pulsos iguales (p. ej. un bombo en cada negra) no hay forma de saber cuál es el
  // tiempo fuerte: se usa el primer golpe audible, que es lo que se espera
  if (tr.downbeatMargin >= 0.3) {
    for (let n = 0; n < bpb && i < beats.length - 1; n++) {
      if ((((i - tr.downbeatPhase) % bpb) + bpb) % bpb === 0) break;
      i++;
    }
    while (i < beats.length - 1 && !good(i)) i += bpb; // si cae en un hueco, el siguiente compás con golpe real
  }
  return beats[Math.min(i, beats.length - 1)];
}

// La lectura puede salir al doble o a la mitad del tempo "sentido": se elige la octava que deja el
// tempo más cerca del BPM del proyecto (así se estira lo menos posible).
export function bestOctave(trackBpm: number, projectBpm: number): 1 | 2 | 0.5 {
  let best: 1 | 2 | 0.5 = 1;
  for (const m of [0.5, 1, 2] as const) {
    if (Math.abs(Math.log2((trackBpm * m) / projectBpm)) < Math.abs(Math.log2((trackBpm * best) / projectBpm)) - 1e-9) best = m;
  }
  return best;
}

// ¿Basta un tempo constante? Con 8 ms de deriva o más, un factor único deja los golpes lejos de la rejilla.
export function constantIsEnough(tr: BeatTrack): boolean {
  return tr.driftMs < 8 && tr.rmsMs < 8;
}

export interface AutoPlan {
  plan: WarpPlan;
  markerSec: number;
  markerOut: number; // marcador en el dominio estirado (sin relleno)
  mode: "const" | "var";
  mult: 1 | 2 | 0.5;
}

// Plan automático completo para una canción con pulso.
export function autoPlan(tr: BeatTrack, dur: number, projectBpm: number, bpb: number): AutoPlan {
  const markerSec = firstDownbeat(tr, bpb);
  const mult = bestOctave(tr.bpm, projectBpm);
  const L = 60 / projectBpm;
  if (!constantIsEnough(tr)) {
    const beats = scaleBeats(tr.beats, mult, markerSec);
    const vp = variablePlan(beats, markerSec, L, dur);
    if (vp) return { plan: vp.plan, markerSec, markerOut: vp.markerOut, mode: "var", mult };
  }
  const f = (tr.bpm * mult) / projectBpm;
  const plan = constantPlan(dur, f);
  return { plan, markerSec, markerOut: plan.fwd(markerSec), mode: "const", mult };
}
