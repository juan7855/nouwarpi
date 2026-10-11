// Cliente del Web Worker de estirado. Un solo trabajo activo a la vez:
// lanzar uno nuevo (o llamar a cancel) termina el anterior.

import StretchWorker from "./worker?worker&inline";
import type { StretchMethod } from "./stretch";

export const CANCELLED = "cancelled";

export class Processor {
  private worker: Worker | null = null;
  private seq = 0;
  private reject: ((e: Error) => void) | null = null;

  run(
    channels: Float32Array[],
    sampleRate: number,
    factor: number,
    method: StretchMethod,
    onProgress: (frac: number) => void
  ): Promise<Float32Array[]> {
    this.cancel();
    const id = ++this.seq;
    const worker = new StretchWorker();
    this.worker = worker;
    return new Promise<Float32Array[]>((resolve, reject) => {
      this.reject = reject;
      worker.onmessage = (e: MessageEvent) => {
        const m = e.data;
        if (m.id !== id) return;
        if (m.type === "progress") onProgress(m.frac);
        else if (m.type === "done") {
          this.cleanup(worker);
          resolve(m.channels);
        } else if (m.type === "error") {
          this.cleanup(worker);
          reject(new Error(m.message));
        }
      };
      worker.onerror = (e) => {
        this.cleanup(worker);
        reject(new Error(e.message || "Error en el worker"));
      };
      worker.postMessage({ id, channels, sampleRate, factor, method }, channels.map((c) => c.buffer));
    });
  }

  cancel() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    if (this.reject) {
      const r = this.reject;
      this.reject = null;
      r(new Error(CANCELLED));
    }
  }

  private cleanup(w: Worker) {
    w.terminate();
    if (this.worker === w) this.worker = null;
    this.reject = null;
  }
}
