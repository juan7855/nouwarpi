// Web Worker: ejecuta el estirado fuera del hilo de la interfaz.
// La interfaz nunca se congela y un cambio de BPM cancela el cálculo anterior
// (el Processor termina este worker y crea otro).

import { stretchChannels, StretchMethod } from "./stretch";

interface Job {
  id: number;
  channels: Float32Array[];
  sampleRate: number;
  factor: number;
  method: StretchMethod;
}

const post = (msg: unknown, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<Job>) => {
  const { id, channels, sampleRate, factor, method } = e.data;
  try {
    const out = stretchChannels(channels, sampleRate, factor, method, (frac) =>
      post({ id, type: "progress", frac })
    );
    post(
      { id, type: "done", channels: out },
      out.map((c) => c.buffer)
    );
  } catch (err) {
    post({ id, type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
