import { trackBeats } from "../src/audio/tracker";
import { GENRES, makeGenreSong } from "./genres";
import { autoPlan } from "../src/audio/decide";

function mono(chs: Float32Array[]) { const o = new Float32Array(chs[0].length); for (const c of chs) for (let i = 0; i < o.length; i++) o[i] += c[i] / chs.length; return o; }
let fail = 0;
const verbose = !!process.env.VERBOSE;

for (const g of GENRES) {
  const song = makeGenreSong(g);
  const t0 = Date.now();
  const tr = trackBeats(mono(song.chs), song.sr, 4);
  const ms = Date.now() - t0;
  const truth = song.beatT;
  const T = 60 / g.bpm;
  // región con batería
  const from = song.barT[3], to = song.barT[song.barT.length - 3];
  const near = (t: number) => { let best = 1e9; for (const b of truth) { const d = Math.abs(b - t); if (d < best) best = d; } return best; };
  const inReg = tr.beats.filter((b) => b >= from && b <= to);
  const ds = inReg.map(near).sort((a, b) => a - b);
  const med = ds[Math.floor(ds.length / 2)] * 1000;
  const within = ds.filter((d) => d < 0.02).length / ds.length;
  const offbeat = inReg.filter((b) => Math.abs(near(b) - T / 2) < 0.025).length / inReg.length;
  const ratio = tr.bpm / g.bpm;
  const octave = Math.abs(ratio - 1) < 0.03 ? "1×" : Math.abs(ratio - 2) < 0.06 ? "2× (octava rápida)" : Math.abs(ratio - 0.5) < 0.03 ? "½× (octava lenta)" : `${ratio.toFixed(3)}× (¡raro!)`;
  // tiempo fuerte: ¿el pulso elegido como inicio de compás es un inicio de compás real?
  let i0 = tr.beats.findIndex((b) => b >= from);
  while ((((i0 - tr.downbeatPhase) % 4) + 4) % 4 !== 0) i0++;
  const dbDist = Math.min(...song.barT.map((b) => Math.abs(b - tr.beats[i0]))) * 1000;
  const ok = (octave === "1×" || octave.startsWith("½")) && within > 0.9 && offbeat < 0.1;
  // extremo a extremo: con el plan automático de la app llevando la canción a PROJECT BPM, ¿caen los
  // pulsos REALES de la canción sobre la rejilla del proyecto (anclada en el marcador elegido)?
  const PROJECT = Number(process.env.PROJECT ?? 120);
  const ap = autoPlan(tr, song.chs[0].length / song.sr, PROJECT, 4);
  const L = 60 / PROJECT / 2; // rejilla de corcheas del proyecto (con lectura a medio tiempo, cada 2 negras)
  const e2e: number[] = truth.filter((t) => t >= from && t <= to).map((t) => {
    const d = ap.plan.fwd(t) - ap.markerOut;
    return Math.abs(d - Math.round(d / L) * L) * 1000;
  }).sort((a, b) => a - b);
  const e2eMax = e2e[e2e.length - 1], e2eMed = e2e[Math.floor(e2e.length / 2)];
  const e2eOk = e2eMax < 12;
  if (!e2eOk) fail++;
  const markerBar = Math.min(...song.barT.map((b) => Math.abs(b - ap.markerSec))) * 1000;
  const markerBeat = Math.min(...truth.map((b) => Math.abs(b - ap.markerSec))) * 1000;
  console.log(`      ${e2eOk ? "✔" : "✘"} EXTREMO A EXTREMO → ${PROJECT} BPM (rejilla de corcheas) (modo ${ap.mode}, octava ×${ap.mult}): pulsos reales sobre la rejilla del proyecto: mediana ${e2eMed.toFixed(1)} ms, máx ${e2eMax.toFixed(1)} ms; marcador a ${markerBeat.toFixed(0)} ms de un pulso real y a ${markerBar.toFixed(0)} ms de un inicio de compás`);
  if (!ok) fail++;
  console.log(`${ok ? "OK  " : "FAIL"} ${g.name}\n      tempo ${tr.bpm.toFixed(2)} vs ${g.bpm} → ${octave}; pulsos en rejilla real ±20ms: ${(within * 100).toFixed(0)} %, mediana ${med.toFixed(1)} ms, a contratiempo: ${(offbeat * 100).toFixed(0)} %; compás: ${dbDist < 25 ? "bien" : "DESPLAZADO " + dbDist.toFixed(0) + " ms"} (margen ${tr.downbeatMargin.toFixed(2)}); constOk=${tr.constantOk} deriva=${tr.driftMs.toFixed(1)}ms ${ms}ms`);
  if (verbose) void 0;
}
console.log(fail ? `\n${fail} FALLOS` : "\nTODO OK"); process.exit(fail ? 1 : 0);
