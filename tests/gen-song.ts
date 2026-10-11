import fs from "node:fs";
import { makeSong } from "./song";
import { encodeWav } from "../src/audio/wav";
const out = process.argv[2];
const song = makeSong({ sr: 44100, bars: 40, bpmAt: (b) => 120 * (1 + 0.03 * Math.sin(b / 14)), introSec: 0.5, jitterMs: 6, seed: 11 });
const blob = encodeWav(song.chs, 44100, 24);
blob.arrayBuffer().then((ab) => { fs.writeFileSync(out, Buffer.from(ab)); fs.writeFileSync(out + ".truth.json", JSON.stringify(song.beatT)); console.log("ok", song.beatT.length); });
