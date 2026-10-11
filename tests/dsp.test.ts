import { stretchChannels, StretchMethod } from "../src/audio/stretch";
const sr = 44100;
function drums(bpm: number, beats: number) {
  const bl = Math.round(60 / bpm * sr), len = bl * beats + 4000;
  const L = new Float32Array(len), R = new Float32Array(len);
  for (let b = 0; b < beats; b++) for (let i = 0; i < 3000; i++) {
    const t = i / sr, v = Math.sin(2 * Math.PI * (55 + 80 * Math.exp(-t * 40)) * t) * Math.exp(-t * 18) * 0.9;
    L[b * bl + i] += v; R[b * bl + i] += v * 0.8;
  }
  return { chs: [L, R], bl };
}
function hits(x: Float32Array, minGap: number) {
  const res: number[] = []; let last = -1e9;
  for (let k = 0; k < x.length; k++) if (Math.abs(x[k]) > 0.3 && k - last > minGap) { res.push(k); last = k; }
  return res;
}
let fail = 0;
for (const method of ["wsola", "pvoc", "resample"] as StretchMethod[]) {
  for (const f of [0.8333, 1.2, 1.5, 0.6]) {
    const { chs, bl } = drums(100, 16);
    const t0 = Date.now();
    const out = stretchChannels(chs, sr, f, method);
    const ms = Date.now() - t0;
    const exp = Math.round(chs[0].length * f);
    let nan = 0, peak = 0; for (const c of out) for (const v of c) { if (!isFinite(v)) nan++; peak = Math.max(peak, Math.abs(v)); }
    const pk = hits(out[0], bl * f * 0.5);
    let maxErr = 0; for (let b = 0; b < Math.min(pk.length, 16); b++) maxErr = Math.max(maxErr, Math.abs(pk[b] - b * bl * f) / sr * 1000);
    const ok = out[0].length === exp && nan === 0 && peak < 1.2 && pk.length === 16 && maxErr < 25;
    if (!ok) fail++;
    console.log(`${ok ? "OK  " : "FAIL"} ${method.padEnd(8)} f=${f} len=${out[0].length}/${exp} nan=${nan} peak=${peak.toFixed(2)} hits=${pk.length} maxHitErr=${maxErr.toFixed(1)}ms ${ms}ms`);
  }
}
function zc(x: Float32Array, a: number, b: number) { let n = 0; for (let i = a + 1; i < b; i++) if (x[i - 1] <= 0 && x[i] > 0) n++; return n / ((b - a) / sr); }
const tone = new Float32Array(sr * 3); for (let i = 0; i < tone.length; i++) tone[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / sr);
for (const method of ["wsola", "pvoc", "resample"] as StretchMethod[]) {
  const out = stretchChannels([tone], sr, 1.25, method)[0];
  const fr = zc(out, sr, out.length - sr);
  const expect = method === "resample" ? 440 / 1.25 : 440;
  const ok = Math.abs(fr - expect) < 3; if (!ok) fail++;
  let rms = 0; for (let i = sr; i < out.length - sr; i++) rms += out[i] * out[i]; rms = Math.sqrt(rms / (out.length - 2 * sr));
  console.log(`${ok ? "OK  " : "FAIL"} tono ${method.padEnd(8)} freq=${fr.toFixed(1)} (esperado ${expect.toFixed(1)}) rms=${rms.toFixed(3)} (orig 0.354)`);
}
{ const x = new Float32Array(sr); for (let i = 0; i < 2000; i++) x[i] = 0.9 * Math.exp(-i / 300) * Math.sin(i * 0.3);
  for (const method of ["wsola", "pvoc", "resample"] as StretchMethod[]) {
    const o = stretchChannels([x], sr, 1.2, method)[0]; let pk = 0; for (let i = 0; i < 600; i++) pk = Math.max(pk, Math.abs(o[i]));
    const ok = pk > 0.6 && pk < 1.1; if (!ok) fail++;
    console.log(`${ok ? "OK  " : "FAIL"} ataque en muestra 0 ${method.padEnd(8)} pico inicial=${pk.toFixed(2)} (orig 0.9)`);
  } }
console.log(fail ? `\n${fail} FALLOS` : "\nTODO OK"); process.exit(fail ? 1 : 0);
