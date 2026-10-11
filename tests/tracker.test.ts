import { trackBeats } from "../src/audio/tracker";
import { makeSong } from "./song";

function mono(chs: Float32Array[]) { const o = new Float32Array(chs[0].length); for (const c of chs) for (let i = 0; i < o.length; i++) o[i] += c[i] / chs.length; return o; }
let fail = 0;
function check(name: string, ok: boolean, info: string) { if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${name}: ${info}`); }

// A) tempo constante con decimales, 2 compases de intro sin batería, pickup de 0.37 s
for (const [bpm, sr] of [[123.4, 44100], [87.6, 48000], [140, 44100]] as const) {
  const song = makeSong({ sr, bars: 48, bpmAt: () => bpm, introSec: 0.37 });
  const t0 = Date.now();
  const tr = trackBeats(mono(song.chs), sr, 4);
  const ms = Date.now() - t0;
  // verdad: pulso k ↔ beatT[k]. El primer pulso del tracker puede ser cualquiera: emparejar por cercanía
  const errs: number[] = [];
  for (const b of tr.beats) { let best = 1e9; for (const t of song.beatT) best = Math.min(best, Math.abs(t - b)); if (b >= song.beatT[9] && b <= song.beatT[190]) errs.push(best * 1000); }
  errs.sort((a, b) => a - b);
  const med = errs[Math.floor(errs.length / 2)], mx = errs[errs.length - 1];
  check(`constante ${bpm} @${sr}`, Math.abs(tr.bpm - bpm) < 0.05 && mx < 15 && tr.constantOk,
    `bpm=${tr.bpm.toFixed(3)} err mediana=${med.toFixed(1)}ms máx=${mx.toFixed(1)}ms rms=${tr.rmsMs.toFixed(1)}ms deriva=${tr.driftMs.toFixed(1)}ms constOk=${tr.constantOk} fase=${tr.downbeatPhase} ${ms}ms`);
}

// B) tempo variable (±3 % ondulante) + jitter humano ±6 ms
{
  const sr = 44100;
  const song = makeSong({ sr, bars: 48, bpmAt: (b) => 120 * (1 + 0.03 * Math.sin(b / 14)), introSec: 0.5, jitterMs: 6, seed: 7 });
  const tr = trackBeats(mono(song.chs), sr, 4);
  const errs: number[] = [];
  for (const b of tr.beats) { let best = 1e9; for (const t of song.beatT) best = Math.min(best, Math.abs(t - b)); if (b >= song.beatT[9] && b <= song.beatT[190]) errs.push(best * 1000); }
  errs.sort((a, b) => a - b);
  check("variable ±3% + jitter", errs[errs.length - 1] < 20 && !tr.constantOk,
    `bpm medio=${tr.bpm.toFixed(2)} err mediana=${errs[Math.floor(errs.length / 2)].toFixed(1)}ms máx=${errs[errs.length - 1].toFixed(1)}ms deriva=${tr.driftMs.toFixed(1)}ms constOk=${tr.constantOk}`);
}
console.log(fail ? `\n${fail} FALLOS` : "\nTODO OK"); process.exit(fail ? 1 : 0);
