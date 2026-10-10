// FFT radix-2 iterativo con tablas precalculadas (para el vocoder de fase).

export class FFT {
  readonly size: number;
  private bitRev: Uint32Array;
  private cosT: Float32Array[]; // por nivel
  private sinT: Float32Array[];

  constructor(size: number) {
    this.size = size;
    const levels = Math.log2(size);
    this.bitRev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let j = 0; j < levels; j++) r = (r << 1) | ((i >> j) & 1);
      this.bitRev[i] = r;
    }
    this.cosT = [];
    this.sinT = [];
    for (let l = 1; l <= levels; l++) {
      const len = 1 << l;
      const half = len >> 1;
      const c = new Float32Array(half);
      const s = new Float32Array(half);
      for (let j = 0; j < half; j++) {
        const a = (-2 * Math.PI * j) / len;
        c[j] = Math.cos(a);
        s[j] = Math.sin(a);
      }
      this.cosT.push(c);
      this.sinT.push(s);
    }
  }

  // forward=false → transformada inversa (sin escalar; el llamador divide por N)
  transform(re: Float32Array, im: Float32Array, forward: boolean): void {
    const n = this.size;
    const br = this.bitRev;
    for (let i = 0; i < n; i++) {
      const j = br[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const levels = Math.log2(n);
    for (let l = 1; l <= levels; l++) {
      const len = 1 << l;
      const half = len >> 1;
      const ct = this.cosT[l - 1];
      const st = this.sinT[l - 1];
      for (let i = 0; i < n; i += len) {
        for (let j = 0; j < half; j++) {
          const c = ct[j];
          const s = forward ? st[j] : -st[j];
          const a = i + j;
          const b = i + j + half;
          const tr = re[b] * c - im[b] * s;
          const ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }
}

export function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

export const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

export function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec * 1000) % 1000);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

export function formatSec(sec: number, digits = 4): string {
  return sec.toFixed(digits) + " s";
}
