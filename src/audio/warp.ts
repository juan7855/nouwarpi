// Plan de alineación: mapa de tiempo entre el audio original y el audio estirado
// (dominio "estirado", sin el relleno de silencio del compás inicial).
//
//  - constantPlan: un único factor (BPM original / BPM del proyecto).
//  - variablePlan: cada pulso detectado se lleva a su posición exacta de la rejilla del
//    proyecto, tramo a tramo (como los warp markers de Ableton). Imprescindible para
//    canciones cuyo tempo no es perfectamente constante.

import type { Anchor } from "./stretch";

export interface WarpPlan {
  kind: "const" | "var";
  anchors: Anchor[]; // en SEGUNDOS: in = tiempo original, out = tiempo estirado
  fwd(tIn: number): number;
  inv(tOut: number): number;
  stretchedDur: number;
  avgFactor: number;
}

function build(kind: "const" | "var", anchors: Anchor[]): WarpPlan {
  const a = anchors;
  const seg = (v: number, key: "in" | "out") => {
    let lo = 0;
    let hi = a.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (a[mid][key] <= v) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const last = a[a.length - 1];
  return {
    kind,
    anchors: a,
    fwd(t) {
      const i = seg(t, "in");
      return a[i].out + ((t - a[i].in) * (a[i + 1].out - a[i].out)) / (a[i + 1].in - a[i].in);
    },
    inv(t) {
      const i = seg(t, "out");
      return a[i].in + ((t - a[i].out) * (a[i + 1].in - a[i].in)) / (a[i + 1].out - a[i].out);
    },
    stretchedDur: last.out,
    avgFactor: last.out / last.in,
  };
}

export function constantPlan(dur: number, factor: number): WarpPlan {
  return build("const", [
    { in: 0, out: 0 },
    { in: dur, out: dur * factor },
  ]);
}

// Convierte la lista de pulsos a otra subdivisión: 2 = añade el punto medio, 0.5 = quita uno de cada dos.
export function scaleBeats(beats: number[], mult: number, anchorSec: number): number[] {
  if (mult === 1 || beats.length < 2) return beats;
  if (mult === 2) {
    const out: number[] = [];
    for (let i = 0; i < beats.length; i++) {
      out.push(beats[i]);
      if (i + 1 < beats.length) out.push((beats[i] + beats[i + 1]) / 2);
    }
    return out;
  }
  // mult 0.5: conserva el pulso más cercano al ancla y de ahí cada dos
  let j = 0;
  for (let i = 1; i < beats.length; i++) if (Math.abs(beats[i] - anchorSec) < Math.abs(beats[j] - anchorSec)) j = i;
  return beats.filter((_, i) => (i - j) % 2 === 0);
}

// `beats`: pulsos detectados (s) sobre todo el audio. `markerSec`: el pulso 1 del compás elegido.
// `projBeatLen`: duración de un pulso en el proyecto (s). Devuelve también el marcador en
// el dominio estirado.
export function variablePlan(
  beats: number[],
  markerSec: number,
  projBeatLen: number,
  dur: number
): { plan: WarpPlan; markerOut: number } | null {
  if (beats.length < 4) return null;
  // el pulso más cercano al marcador pasa a ser exactamente el marcador
  let j = 0;
  for (let i = 1; i < beats.length; i++) if (Math.abs(beats[i] - markerSec) < Math.abs(beats[j] - markerSec)) j = i;
  const delta = markerSec - beats[j];
  const bs = beats.map((b) => b + delta);

  const localLen = (i: number) => {
    const a = Math.max(0, i - 1);
    const b = Math.min(bs.length - 1, i + 1);
    return (bs[b] - bs[a]) / (b - a);
  };
  const markerOut = markerSec * (projBeatLen / localLen(j));

  const pts: Anchor[] = [{ in: 0, out: 0 }];
  for (let i = 0; i < bs.length; i++) {
    const tin = bs[i];
    const tout = markerOut + (i - j) * projBeatLen;
    const last = pts[pts.length - 1];
    if (tin <= 0 || tout <= 0 || tin >= dur) continue;
    if (tin > last.in + 1e-3 && tout > last.out + 1e-3) pts.push({ in: tin, out: tout });
  }
  const tail = pts[pts.length - 1];
  const fEnd = projBeatLen / localLen(bs.length - 1);
  pts.push({ in: dur, out: tail.out + (dur - tail.in) * fEnd });
  if (pts.length < 4) return null;
  return { plan: build("var", pts), markerOut };
}
