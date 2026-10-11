import { variablePlan } from "../src/audio/warp";
import { stretchChannels } from "../src/audio/stretch";
let fail = 0;
const L = 60 / 128, sr = 44100;
for (const marks of [[1.0, 1.62], [1.0, 1.62, 2.21], [0.9, 1.5, 2.15, 2.7, 3.35]]) {
  const vp = variablePlan(marks, marks[0], L, 6);
  const ok = !!vp && vp.plan.anchors.every((a, i, arr) => i === 0 || (a.in > arr[i - 1].in && a.out > arr[i - 1].out));
  // cada marca debe caer exactamente en la rejilla del proyecto
  const grid = vp ? marks.map((m, i) => Math.abs(vp.plan.fwd(m) - (vp.markerOut + i * L)) * 1000) : [999];
  const good = ok && Math.max(...grid) < 0.01;
  if (!good) fail++;
  console.log(`${good ? "OK  " : "FAIL"} ${marks.length} marcas → anclas ${vp?.plan.anchors.length}, desvío de marcas a la rejilla ${Math.max(...grid).toFixed(4)} ms`);
  if (vp) {
    const x = new Float32Array(6 * sr); for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin(i * 0.05);
    const out = stretchChannels([x], sr, vp.plan.anchors.map((a) => ({ in: a.in * sr, out: a.out * sr })), "wsola")[0];
    const fin = out.every(Number.isFinite);
    if (!fin) fail++;
    console.log(`     estirado: ${out.length} muestras, finito=${fin}`);
  }
}
console.log(fail ? `\n${fail} FALLOS` : "\nTODO OK"); process.exit(fail ? 1 : 0);
