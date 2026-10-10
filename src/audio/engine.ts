// Motor de reproducción: buffer sources, metrónomo con planificación
// anticipada, bucle de tramo y comparación original/ajustado al mismo volumen.

export interface PlayOptions {
  buffer: AudioBuffer;
  offsetSec: number; // desplazamiento dentro del buffer
  rate: number; // velocidad de reproducción (1 = normal)
  loopStartSec?: number; // en el dominio del buffer
  loopEndSec?: number;
  onEnded?: () => void;
}

export class Engine {
  private ctx: AudioContext | null = null;
  private src: AudioBufferSourceNode | null = null;
  private master: GainNode | null = null;
  private metroTimer: number | null = null;
  private metroOscs: OscillatorNode[] = [];
  private metroState: {
    nextClickOut: number; // tiempo de salida (dominio del proyecto)
    clickIndex: number;
    beatLen: number;
    beatsPerBar: number;
    startCtx: number; // ctx.currentTime cuando empezó
    outOffset: number; // posición de salida al empezar
  } | null = null;

  playing = false;

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 1; // mismo volumen, sin normalizar
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  stop() {
    if (this.src) {
      try {
        this.src.onended = null;
        this.src.stop();
      } catch {
        /* ya parado */
      }
      this.src.disconnect();
      this.src = null;
    }
    if (this.metroTimer !== null) {
      window.clearInterval(this.metroTimer);
      this.metroTimer = null;
    }
    for (const o of this.metroOscs) {
      try {
        o.stop();
      } catch {
        /* noop */
      }
      o.disconnect();
    }
    this.metroOscs = [];
    this.metroState = null;
    this.playing = false;
  }

  play(opts: PlayOptions) {
    const ctx = this.ensureCtx();
    this.stop();

    const src = ctx.createBufferSource();
    src.buffer = opts.buffer;
    src.playbackRate.value = opts.rate;
    if (opts.loopStartSec !== undefined && opts.loopEndSec !== undefined && opts.loopEndSec > opts.loopStartSec) {
      src.loop = true;
      src.loopStart = Math.max(0, opts.loopStartSec);
      src.loopEnd = Math.min(opts.buffer.duration, opts.loopEndSec);
    }
    src.connect(this.master!);
    src.onended = () => {
      if (this.src === src) {
        this.stop();
        opts.onEnded?.();
      }
    };
    // desplazamiento negativo → silencio inicial (p. ej. la intro)
    const off = Math.max(
      0,
      Math.min(opts.offsetSec, opts.buffer.duration - 0.01)
    );
    const delay = opts.offsetSec < 0 ? -opts.offsetSec : 0;
    src.start(delay, off);
    this.src = src;
    this.playing = true;
    return ctx.currentTime + delay;
  }

  startMetronome(opts: {
    bpm: number;
    beatsPerBar: number;
    outOffsetSec: number; // posición de salida (dominio proyecto) al empezar
    startCtxTime: number; // ctx.currentTime en el momento de empezar
  }) {
    this.stopMetronomeOnly();
    const beatLen = 60 / opts.bpm;
    const firstClick = Math.ceil(opts.outOffsetSec / beatLen - 1e-6) * beatLen;
    this.metroState = {
      nextClickOut: firstClick,
      clickIndex: Math.round(firstClick / beatLen),
      beatLen,
      beatsPerBar: opts.beatsPerBar,
      startCtx: opts.startCtxTime,
      outOffset: opts.outOffsetSec,
    };
    this.metroTimer = window.setInterval(() => this.scheduleClicks(), 40);
  }

  private stopMetronomeOnly() {
    if (this.metroTimer !== null) {
      window.clearInterval(this.metroTimer);
      this.metroTimer = null;
    }
    for (const o of this.metroOscs) {
      try {
        o.stop();
      } catch {
        /* noop */
      }
      o.disconnect();
    }
    this.metroOscs = [];
    this.metroState = null;
  }

  private scheduleClicks() {
    const ctx = this.ctx;
    const st = this.metroState;
    if (!ctx || !st || !this.master) return;
    const horizon = ctx.currentTime + 0.18;
    while (true) {
      const t = st.startCtx + (st.nextClickOut - st.outOffset);
      if (t > horizon) break;
      if (t >= ctx.currentTime - 0.02) this.click(t, st.clickIndex % st.beatsPerBar === 0);
      st.nextClickOut += st.beatLen;
      st.clickIndex++;
    }
  }

  private click(when: number, accent: boolean) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = accent ? 1760 : 1100;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(accent ? 0.28 : 0.18, when + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.07);
    osc.connect(g);
    g.connect(this.master!);
    osc.start(when);
    osc.stop(when + 0.09);
    this.metroOscs.push(osc);
    osc.onended = () => {
      osc.disconnect();
      const i = this.metroOscs.indexOf(osc);
      if (i >= 0) this.metroOscs.splice(i, 1);
    };
  }
}
