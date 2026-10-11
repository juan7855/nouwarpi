// Web Worker: ejecuta el análisis de pulsos y el estirado fuera del hilo de la interfaz.
// La interfaz nunca se congela y un cambio de parámetros cancela el cálculo anterior
// (el Processor termina este worker y crea otro).

import { stretchChannels, StretchMethod, Anchor } from "./stretch";
import { trackBeats } from "./tracker";

type Job =
  | {
      id: number;
      type: "stretch";
      channels: Float32Array[];
      sampleRate: number;
      warp: number | Anchor[];
      method: StretchMethod;
    }
  | { id: number; type: "track"; channels: Float32Array[]; sampleRate: number; beatsPerBar: number };

const post = (msg: unknown, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<Job>) => {
  const job = e.data;
  try {
    if (job.type === "track") {
      const result = trackBeats(job.channels[0], job.sampleRate, job.beatsPerBar, (frac) =>
        post({ id: job.id, type: "progress", frac })
      );
      post({ id: job.id, type: "done", result });
      return;
    }
    const out = stretchChannels(job.channels, job.sampleRate, job.warp, job.method, (frac) =>
      post({ id: job.id, type: "progress", frac })
    );
    post(
      { id: job.id, type: "done", result: out },
      out.map((c) => c.buffer)
    );
  } catch (err) {
    post({ id: job.id, type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
