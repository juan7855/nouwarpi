import { trackBeats } from "../src/audio/tracker";
import { GENRES, makeGenreSong } from "./genres";
const name = process.argv[2];
const g = GENRES.find((x) => x.name.startsWith(name))!;
const song = makeGenreSong(g);
const mono = new Float32Array(song.chs[0].length); for (const c of song.chs) for (let i = 0; i < mono.length; i++) mono[i] += c[i] / song.chs.length;
const tr = trackBeats(mono, song.sr, 4);
console.log(g.name, tr.bpm.toFixed(2), "T truth", 60 / g.bpm, "constOk", tr.constantOk, "drift", tr.driftMs.toFixed(0), "rms", tr.rmsMs.toFixed(0));
tr.beats.forEach((b, i) => { let best = 1e9; for (const t of song.beatT) if (Math.abs(t - b) < Math.abs(best)) best = t - b; if (i < 400) console.log(i, b.toFixed(3), (best * 1000).toFixed(0) + "ms", tr.beatGood[i] ? "good" : "-"); });
