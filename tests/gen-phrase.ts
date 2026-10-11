// Genera un sample "sin BPM": frase de golpes con rubato (±25 ms) a un tempo natural de 97 BPM.
import fs from "node:fs";
import { encodeWav } from "../src/audio/wav";
let seed = 5; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const PATTERN = [0, 3, 4, 6, 8, 10, 12, 14];
const bpm = 97, start = 0.6, beat = 60 / bpm, sr = 44100;
const ev: number[] = [], amp: number[] = [];
for (let b = 0; b < 4; b++) for (const p of PATTERN) { ev.push(start + (b * 16 + p) * (beat / 4) + (rnd() * 2 - 1) * 0.025 + 0.015 * Math.sin((b * 16 + p) / 9)); amp.push(p % 4 === 0 ? 1 : 0.6); }
const len = Math.ceil((ev[ev.length - 1] + 1.5) * sr), L = new Float32Array(len), R = new Float32Array(len);
ev.forEach((t, k) => { const s0 = Math.round(t * sr); for (let i = 0; i < 6000 && s0 + i < len; i++) { const x = i / sr; const v = (Math.sin(2 * Math.PI * (60 + 100 * Math.exp(-x * 45)) * x) * Math.exp(-x * 18) + 0.25 * (rnd() * 2 - 1) * Math.exp(-x * 60)) * amp[k] * 0.9; L[s0 + i] += v; R[s0 + i] += v; } });
encodeWav([L, R], sr, 24).arrayBuffer().then((ab) => { fs.writeFileSync(process.argv[2], Buffer.from(ab)); console.log("ok", ev.length, "golpes"); });
