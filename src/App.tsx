import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Win95Window,
  W95Button,
  W95NumField,
  W95Checkbox,
  W95Radio,
  W95Select,
  W95Progress,
  W95Field,
  HScrollbar,
} from "./components/w95";
import { Waveform, Peaks } from "./components/Waveform";
import { Engine } from "./audio/engine";
import {
  computeOnsetEnvelope,
  detectFirstBeat,
  detectBpmFrom,
  OnsetEnvelope,
} from "./audio/analysis";
import { phaseVocoderStretch } from "./audio/pvoc";
import { encodeWav, maxAbs } from "./audio/wav";
import { formatTime } from "./audio/dsp";

interface LoadedFile {
  name: string;
  buffer: AudioBuffer;
  duration: number;
  sampleRate: number;
  channels: number;
}

function computePeaks(buf: AudioBuffer, bucket: number): Peaks {
  const ch = buf.numberOfChannels;
  const len = buf.length;
  const nB = Math.max(1, Math.ceil(len / bucket));
  const min = new Float32Array(nB).fill(1);
  const max = new Float32Array(nB).fill(-1);
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const b = (i / bucket) | 0;
      const v = d[i];
      if (v < min[b]) min[b] = v;
      if (v > max[b]) max[b] = v;
    }
  }
  return { min, max, bucket, samples: len, sampleRate: buf.sampleRate };
}

function resamplePeaks(p: Peaks, factor: number): Peaks {
  const nB = Math.max(1, Math.ceil((p.samples * factor) / p.bucket));
  const min = new Float32Array(nB).fill(1);
  const max = new Float32Array(nB).fill(-1);
  for (let b = 0; b < nB; b++) {
    const b0 = Math.floor(b / factor);
    const b1 = Math.max(b0 + 1, Math.ceil((b + 1) / factor));
    for (let i = b0; i < Math.min(b1, p.min.length); i++) {
      if (p.min[i] < min[b]) min[b] = p.min[i];
      if (p.max[i] > max[b]) max[b] = p.max[i];
    }
  }
  return { min, max, bucket: p.bucket, samples: Math.round(p.samples * factor), sampleRate: p.sampleRate };
}

const clampMarker = (t: number, max: number) => Math.max(0, Math.min(max, t));

// Audio de demostración: 8 compases a 100 BPM con intro de silencio.
function makeDemo(): AudioBuffer {
  const sr = 44100;
  const bpm = 100;
  const beatLen = 60 / bpm;
  const intro = 1.37;
  const bars = 8;
  const dur = intro + bars * 4 * beatLen + 0.6;
  const len = Math.ceil(dur * sr);
  const buf = new AudioBuffer({ length: len, sampleRate: sr, numberOfChannels: 2 });
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);

  for (let b = 0; b < bars * 4; b++) {
    // bombo en cada golpe
    const start = Math.floor((intro + b * beatLen) * sr);
    const n = Math.floor(0.2 * sr);
    for (let i = 0; i < n && start + i < len; i++) {
      const t = i / sr;
      const env = Math.exp(-t * 22);
      const f = 55 + 45 * Math.exp(-t * 30);
      const v = Math.sin(2 * Math.PI * f * t) * env * 0.85;
      L[start + i] += v;
      R[start + i] += v;
    }
    // charley fuera de golpe
    const start2 = Math.floor((intro + b * beatLen + beatLen / 2) * sr);
    const n2 = Math.floor(0.04 * sr);
    let last = 0;
    for (let i = 0; i < n2 && start2 + i < len; i++) {
      const w = Math.random() * 2 - 1;
      const hp = w - last; // diferenciador ≈ agudos
      last = w;
      const env = Math.exp(-(i / sr) * 90);
      L[start2 + i] += hp * env * 0.18;
      R[start2 + i] += hp * env * 0.14;
    }
    // bajo: una nota por compás
    if (b % 4 === 0) {
      const start3 = start;
      const n3 = Math.floor(beatLen * 1.8 * sr);
      const f = 55; // La1
      for (let i = 0; i < n3 && start3 + i < len; i++) {
        const t = i / sr;
        const env = Math.min(1, t * 40) * Math.exp(-t * 1.2);
        const v = (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * f * 2 * t)) * env * 0.4;
        L[start3 + i] += v;
        R[start3 + i] += v;
      }
    }
  }
  return buf;
}

export default function App() {
  const engineRef = useRef<Engine | null>(null);
  if (!engineRef.current) engineRef.current = new Engine();

  const [file, setFile] = useState<LoadedFile | null>(null);
  const [peaksOrig, setPeaksOrig] = useState<Peaks | null>(null);
  const [peaksAdj, setPeaksAdj] = useState<Peaks | null>(null);
  const [markerSec, setMarkerSec] = useState(0);
  const [cursorSec, setCursorSec] = useState(0);
  const [projectBPM, setProjectBPM] = useState(120);
  const [originalBPM, setOriginalBPM] = useState(120);
  const [beatsPerBar, setBeatsPerBar] = useState(4);
  const [keepPitch, setKeepPitch] = useState(true);
  const [metronomeOn, setMetronomeOn] = useState(false);
  const [exportMode, setExportMode] = useState<"all" | "beat" | "sel">("all");
  const [selStart, setSelStart] = useState(1);
  const [selEnd, setSelEnd] = useState(4);
  const [bitDepth, setBitDepth] = useState<24 | 32>(24);
  const [loopOn, setLoopOn] = useState(false);
  const [loopBars, setLoopBars] = useState(2);
  const [sourceMode, setSourceMode] = useState<"adj" | "orig">("adj");
  const [proc, setProc] = useState<{ active: boolean; label: string; frac: number }>({
    active: false,
    label: "",
    frac: 0,
  });
  const [status, setStatus] = useState("Listo");
  const [irregular, setIrregular] = useState(false);
  const [clipWarn, setClipWarn] = useState<number | null>(null);
  const [detected, setDetected] = useState<{ firstBeat: number; bpm: number; conf: number } | null>(null);
  const [zoom, setZoom] = useState(160);
  const [scrollBar, setScrollBar] = useState(0);
  const [focus, setFocus] = useState("wave");
  const mainRef = useRef<HTMLElement>(null);

  // el escritorio crece para contener todas las ventanas (y no quedan bajo la barra de estado)
  useEffect(() => {
    const fit = () => {
      const m = mainRef.current;
      if (!m) return;
      let bottom = 700;
      m.querySelectorAll<HTMLElement>(":scope > .w95-window").forEach((w) => {
        bottom = Math.max(bottom, w.offsetTop + w.offsetHeight + 56);
      });
      m.style.minHeight = bottom + "px";
    };
    fit();
    window.addEventListener("w95-layout", fit);
    window.addEventListener("resize", fit);
    return () => {
      window.removeEventListener("w95-layout", fit);
      window.removeEventListener("resize", fit);
    };
  }, []);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [dropHover, setDropHover] = useState(false);
  const [tapCount, setTapCount] = useState(0);
  const [exportBusy, setExportBusy] = useState(false);

  const envRef = useRef<OnsetEnvelope | null>(null);
  const stretchedRef = useRef<AudioBuffer | null>(null);
  const procToken = useRef(0);
  const tapsRef = useRef<number[]>([]);
  const rafRef = useRef<number>(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* ---------- derivados ---------- */

  const factor = useMemo(
    () => (file ? originalBPM / projectBPM : 1),
    [file, originalBPM, projectBPM]
  );
  const beatLen = 60 / projectBPM;
  const barLen = beatLen * beatsPerBar;
  const origBeatLen = 60 / originalBPM;
  const origBarLen = origBeatLen * beatsPerBar;
  const pad = useMemo(() => {
    if (!file) return 0;
    const m = markerSec * factor;
    return (barLen - (m % barLen)) % barLen;
  }, [file, markerSec, factor, barLen]);
  const stretchedDur = file ? file.duration * factor : 0;
  const totalOut = pad + stretchedDur;
  const outBars = file ? Math.max(1, Math.ceil(totalOut / barLen - 1e-9)) : 0;
  const origBars = file ? Math.max(1, Math.ceil(file.duration / origBarLen - 1e-9)) : 0;
  const tempoChangePct = (factor - 1) * 100;
  const tempoWarn = Math.abs(tempoChangePct) > 25;

  const exportPlan = useMemo(() => {
    if (!file) return null;
    let startOut: number;
    let lengthOut: number;
    if (exportMode === "all") {
      startOut = 0;
      lengthOut = outBars * barLen;
    } else if (exportMode === "beat") {
      startOut = pad;
      lengthOut = Math.ceil(stretchedDur / barLen - 1e-9) * barLen;
    } else {
      startOut = (selStart - 1) * barLen;
      lengthOut = (selEnd - selStart + 1) * barLen;
    }
    const barCount = Math.max(1, Math.round(lengthOut / barLen));
    const base =
      file.name
        .replace(/\.[^.]+$/, "")
        .replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ_-]/g, "_")
        .toLowerCase() || "audio";
    const fname = `${base}_${Math.round(projectBPM)}bpm_${barCount}compases.wav`;
    return { startOut, lengthOut, barCount, fname };
  }, [file, exportMode, outBars, barLen, pad, stretchedDur, selStart, selEnd, projectBPM]);

  /* ---------- carga de archivo ---------- */

  const loadBuffer = useCallback((buf: AudioBuffer, name: string) => {
    engineRef.current!.stop();
    const info: LoadedFile = {
      name,
      buffer: buf,
      duration: buf.duration,
      sampleRate: buf.sampleRate,
      channels: buf.numberOfChannels,
    };
    const peaks = computePeaks(buf, 256);
    const env = computeOnsetEnvelope(buf.getChannelData(0), buf.sampleRate);
    envRef.current = env;
    const fb = detectFirstBeat(env);
    const bpmRes = detectBpmFrom(env, fb);
    setFile(info);
    setPeaksOrig(peaks);
    setPeaksAdj(null);
    stretchedRef.current = null;
    setMarkerSec(fb);
    setCursorSec(0);
    setOriginalBPM(bpmRes.bpm);
    setDetected({ firstBeat: fb, bpm: bpmRes.bpm, conf: bpmRes.confidence });
    setIrregular(!bpmRes.stable);
    setStatus(
      !bpmRes.stable
        ? "Aviso: tempo irregular o con cambios. Corrige el BPM a mano."
        : "Listo"
    );
    setScrollBar(0);
    setTapCount(0);
    tapsRef.current = [];
  }, []);

  const loadFile = useCallback(
    async (f: File) => {
      setStatus("Cargando…");
      try {
        const ab = await f.arrayBuffer();
        const ctx = new OfflineAudioContext(1, 1, 44100);
        const buf = await ctx.decodeAudioData(ab);
        loadBuffer(buf, f.name);
      } catch {
        setStatus("Error: no se pudo decodificar el audio.");
      }
    },
    [loadBuffer]
  );

  const loadDemo = useCallback(() => {
    setStatus("Generando demo…");
    const buf = makeDemo();
    loadBuffer(buf, "demo_100bpm.wav");
  }, [loadBuffer]);

  /* ---------- procesado (vocoder) ---------- */

  useEffect(() => {
    if (!file) return;
    const token = ++procToken.current;
    const t = setTimeout(async () => {
      setProc({ active: true, label: "Procesando…", frac: 0 });
      setStatus("Procesando…");
      const f = factor;
      let stretched: AudioBuffer;
      if (keepPitch) {
        if (Math.abs(f - 1) < 0.002) {
          stretched = file.buffer;
        } else {
          stretched = await phaseVocoderStretch(file.buffer, f, (p) => {
            if (token === procToken.current)
              setProc({ active: true, label: p.label, frac: p.frac });
          });
        }
      } else {
        stretched = file.buffer;
      }
      if (token !== procToken.current) return;
      stretchedRef.current = keepPitch ? stretched : null;
      const adj = keepPitch
        ? stretched === file.buffer
          ? peaksOrig
          : computePeaks(stretched, 256)
        : peaksOrig
          ? resamplePeaks(peaksOrig, f)
          : null;
      setPeaksAdj(adj);
      if (keepPitch && stretched !== file.buffer) {
        const chs: Float32Array[] = [];
        for (let c = 0; c < stretched.numberOfChannels; c++)
          chs.push(stretched.getChannelData(c));
        const m = maxAbs(chs);
        setClipWarn(m > 0.999 ? m : null);
      } else {
        setClipWarn(null);
      }
      setProc({ active: false, label: "", frac: 0 });
      setStatus("Listo");
    }, 350);
    return () => {
      clearTimeout(t);
      procToken.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, originalBPM, projectBPM, keepPitch, factor]);

  /* ---------- reproducción ---------- */

  const stopPlayback = useCallback(() => {
    engineRef.current!.stop();
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  }, []);

  const startPlayback = useCallback(
    (mode: "adj" | "orig", startOut: number) => {
      if (!file) return;
      const eng = engineRef.current!;
      eng.stop();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);

      const f = factor;
      let buffer: AudioBuffer;
      let offsetSrc: number;
      let rate = 1;

      if (mode === "adj") {
        if (keepPitch) {
          const sb = stretchedRef.current;
          if (!sb) {
            setStatus("Aún procesando…");
            return;
          }
          buffer = sb;
          offsetSrc = startOut - pad;
          rate = 1;
        } else {
          buffer = file.buffer;
          offsetSrc = (startOut - pad) / f;
          rate = 1 / f;
        }
      } else {
        buffer = file.buffer;
        offsetSrc = (startOut - pad) / f;
        rate = 1;
      }

      const srcFromOut = (o: number) =>
        mode === "adj" && keepPitch ? o - pad : (o - pad) / f;

      let loopStartSrc: number | undefined;
      let loopEndSrc: number | undefined;
      if (loopOn) {
        const l0 = Math.max(0, srcFromOut(startOut));
        const l1 = Math.min(buffer.duration, srcFromOut(startOut + loopBars * barLen));
        if (l1 > l0 + 0.01) {
          loopStartSrc = l0;
          loopEndSrc = l1;
        }
      }

      const startCtx = eng.play({
        buffer,
        offsetSec: offsetSrc,
        rate,
        loopStartSec: loopStartSrc,
        loopEndSec: loopEndSrc,
        onEnded: () => {
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          rafRef.current = 0;
        },
      });

      if (metronomeOn) {
        eng.startMetronome({
          bpm: projectBPM,
          beatsPerBar,
          outOffsetSec: startOut,
          startCtxTime: startCtx,
        });
      }

      const t0 = performance.now();
      const tick = () => {
        const el = (performance.now() - t0) / 1000;
        // modo ajustado: posición musical en el dominio original
        // modo original: el audio avanza 1:1 desde su desplazamiento
        const cur =
          mode === "adj"
            ? (startOut + el - pad) / f
            : (startOut - pad) / f + el;
        setCursorSec(Math.max(0, cur));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
      setStatus(
        mode === "adj" ? "Reproduciendo: ajustado" : "Reproduciendo: original"
      );
    },
    [file, factor, keepPitch, pad, loopOn, loopBars, barLen, metronomeOn, projectBPM, beatsPerBar]
  );

  const onCompare = useCallback(() => {
    if (!file) return;
    const n = sourceMode === "adj" ? "orig" : "adj";
    setSourceMode(n);
    startPlayback(n, cursorSec * factor + pad);
  }, [file, sourceMode, startPlayback, cursorSec, factor, pad]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.code === "Space" &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLSelectElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        if (engineRef.current!.playing) stopPlayback();
        else startPlayback(sourceMode, cursorSec * factor + pad);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [startPlayback, stopPlayback, sourceMode, cursorSec, factor, pad]);

  /* ---------- detección / tap ---------- */

  const onDetectBpm = useCallback(() => {
    const env = envRef.current;
    if (!env) return;
    const r = detectBpmFrom(env, markerSec);
    setOriginalBPM(r.bpm);
    setIrregular(!r.stable);
    setStatus(
      !r.stable
        ? "Aviso: tempo irregular o con cambios."
        : `BPM detectado: ${r.bpm} (confianza ${Math.round(r.confidence * 100)}%)`
    );
  }, [markerSec]);

  const onDetectFirst = useCallback(() => {
    const env = envRef.current;
    if (!env || !file) return;
    const fb = detectFirstBeat(env);
    setMarkerSec(fb);
    setStatus("Primer golpe detectado: " + fb.toFixed(3) + " s");
  }, [file]);

  const onTap = useCallback(() => {
    const now = performance.now();
    tapsRef.current = tapsRef.current.filter((t) => now - t < 2500);
    tapsRef.current.push(now);
    setTapCount(tapsRef.current.length);
    if (tapsRef.current.length >= 2) {
      const ts = tapsRef.current;
      let sum = 0;
      for (let i = 1; i < ts.length; i++) sum += ts[i] - ts[i - 1];
      const avg = sum / (ts.length - 1);
      const bpm = Math.round((60000 / avg) * 10) / 10;
      setOriginalBPM(bpm);
      setStatus("BPM por Tap: " + bpm.toFixed(1));
    }
  }, []);

  /* ---------- exportar ---------- */

  const doExport = useCallback(async () => {
    if (!file || !exportPlan) return;
    setExportBusy(true);
    setStatus("Exportando…");
    try {
      const f = factor;
      const sr = file.sampleRate;
      const { startOut, lengthOut, fname } = exportPlan;
      const lengthSamples = Math.max(1, Math.round(lengthOut * sr));

      let channels: Float32Array[];
      if (keepPitch) {
        const sb = stretchedRef.current;
        if (!sb) {
          setStatus("Aún procesando…");
          return;
        }
        // puede haber silencio inicial (intro) si startOut < pad
        const srcStartF = (startOut - pad) * sr;
        const dstSkip = Math.max(0, Math.round(-srcStartF));
        const srcStart = Math.max(0, Math.round(srcStartF));
        channels = [];
        for (let c = 0; c < sb.numberOfChannels; c++) {
          const src = sb.getChannelData(c);
          const dst = new Float32Array(lengthSamples);
          const avail = Math.max(0, src.length - srcStart);
          const n = Math.min(lengthSamples - dstSkip, avail);
          if (n > 0) dst.set(src.subarray(srcStart, srcStart + n), dstSkip);
          channels.push(dst);
        }
      } else {
        const off = new OfflineAudioContext(file.channels, lengthSamples, sr);
        const srcNode = off.createBufferSource();
        srcNode.buffer = file.buffer;
        srcNode.playbackRate.value = 1 / f;
        srcNode.connect(off.destination);
        const off0 = (startOut - pad) / f;
        const delay = Math.max(0, -off0);
        srcNode.start(delay, Math.max(0, off0));
        const rendered = await off.startRendering();
        channels = [];
        for (let c = 0; c < rendered.numberOfChannels; c++)
          channels.push(rendered.getChannelData(c).slice());
      }

      const m = maxAbs(channels);
      if (m > 0.999) setClipWarn(m);

      const blob = encodeWav(channels, sr, bitDepth);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fname;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setStatus("Listo — exportado: " + fname);
    } finally {
      setExportBusy(false);
    }
  }, [file, exportPlan, factor, keepPitch, pad, bitDepth]);

  /* ---------- render ---------- */

  const cursorBar = file
    ? Math.max(1, Math.floor((cursorSec - markerSec) / origBarLen) + 1)
    : 0;

  return (
    <div className="min-h-screen pb-16">
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) loadFile(f);
          e.target.value = "";
        }}
      />

      {/* encabezado */}
      <header className="px-4 pt-4 pb-1 flex flex-wrap items-end gap-x-6 gap-y-2">
        <div>
          <div className="desktop-title">nouwarpi</div>
        </div>
      </header>

      {/* barra de menú */}
      <nav
        className="mx-2 mt-1 w95-outset flex items-center"
        style={{ padding: "1px 2px" }}
      >
        <span className="menu-item" onClick={() => fileInputRef.current?.click()}>
          Cargar audio…
        </span>
        <span className="menu-item" onClick={() => setAboutOpen(true)}>
          Acerca de
        </span>
        <span className="menu-item" style={{ color: "#808080" }}>
          Espacio = reproducir/detener
        </span>
      </nav>

      {/* ventanas */}
      <main ref={mainRef} className="px-2 pt-3 relative" style={{ minHeight: 700 }}>
        {/* ---- Archivo ---- */}
        <Win95Window
          title="Archivo"
          draggable
          defaultPos={{ x: 8, y: 8 }}
          width={350}
          zIndex={focus === "file" ? 60 : 10}
          onFocus={() => setFocus("file")}
        >
          <div
            className={"w95-dropzone" + (dropHover ? " w95-drop-hover" : "")}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDropHover(true);
            }}
            onDragLeave={() => setDropHover(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDropHover(false);
              const f = e.dataTransfer.files?.[0];
              if (f) loadFile(f);
            }}
          >
            <div style={{ fontSize: 13, fontWeight: "bold" }}>
              {file
                ? "Haz clic o arrastra para cargar otro audio"
                : "Arrastra un audio aquí o haz clic para elegir"}
            </div>
            <div className="desktop-sub" style={{ color: dropHover ? "#fff" : "#404040" }}>
              WAV, MP3, OGG, FLAC… (lo que el navegador decodifique)
            </div>
          </div>

          <div className="mt-2">
            <W95Button onClick={loadDemo} style={{ width: "100%" }}>
              Cargar demo (bucle a 100 BPM)
            </W95Button>
          </div>

          {file && (
            <div className="flex flex-col gap-1 mt-2">
              <div className="flex gap-2 items-baseline">
                <span className="w95-label" style={{ width: 110, flex: "0 0 auto" }}>
                  Nombre:
                </span>
                <W95Field style={{ flex: 1 }}>{file.name}</W95Field>
              </div>
              <div className="flex gap-2 items-baseline">
                <span className="w95-label" style={{ width: 110, flex: "0 0 auto" }}>
                  Duración:
                </span>
                <W95Field>{formatTime(file.duration)}</W95Field>
              </div>
              <div className="flex gap-2 items-baseline">
                <span className="w95-label" style={{ width: 110, flex: "0 0 auto" }}>
                  Frec. muestreo:
                </span>
                <W95Field>{file.sampleRate} Hz</W95Field>
              </div>
              <div className="flex gap-2 items-baseline">
                <span className="w95-label" style={{ width: 110, flex: "0 0 auto" }}>
                  Canales:
                </span>
                <W95Field>{file.channels === 1 ? "Mono" : "Estéreo"}</W95Field>
              </div>
              {detected && (
                <>
                  <div className="flex gap-2 items-baseline">
                    <span className="w95-label" style={{ width: 110, flex: "0 0 auto" }}>
                      1er golpe (auto):
                    </span>
                    <W95Field>{detected.firstBeat.toFixed(3)} s</W95Field>
                  </div>
                  <div className="flex gap-2 items-baseline">
                    <span className="w95-label" style={{ width: 110, flex: "0 0 auto" }}>
                      BPM (auto):
                    </span>
                    <W95Field>
                      {detected.bpm.toFixed(1)} (conf. {Math.round(detected.conf * 100)}%)
                    </W95Field>
                  </div>
                </>
              )}
              {irregular && (
                <div className="w95-warn">
                  Aviso: tempo irregular o con cambios de tempo.
                </div>
              )}
            </div>
          )}
        </Win95Window>

        {/* ---- Forma de onda ---- */}
        <Win95Window
          title="Forma de onda"
          draggable
          defaultPos={{ x: 374, y: 8 }}
          width={640}
          zIndex={focus === "wave" ? 60 : 10}
          onFocus={() => setFocus("wave")}
        >
          <div className="flex flex-col gap-2">
            {/* barra de herramientas */}
            <div className="flex items-center gap-2 flex-wrap">
              <W95Button
                onClick={() => setZoom((z) => Math.max(24, z / 1.25))}
                title="Alejar"
              >
                −
              </W95Button>
              <W95Button
                onClick={() => setZoom((z) => Math.min(2400, z * 1.25))}
                title="Acercar"
              >
                +
              </W95Button>
              <W95Field style={{ width: 90 }}>Zoom: {Math.round(zoom)}</W95Field>
              <W95Button onClick={() => setScrollBar(0)}>Ir al compás 1</W95Button>
              <span className="w95-label mono">
                Marcador: {markerSec.toFixed(4)} s
              </span>
              <span className="w95-label mono">
                Cursor: {cursorSec.toFixed(4)} s
              </span>
            </div>

            {/* ajuste fino del marcador */}
            <div className="flex items-center gap-1 flex-wrap">
              <span className="w95-label mr-1">Marcador:</span>
              <W95Button
                onClick={() => file && setMarkerSec((m) => clampMarker(m - 0.05, file.duration))}
                disabled={!file}
              >
                « 50ms
              </W95Button>
              <W95Button
                onClick={() => file && setMarkerSec((m) => clampMarker(m - 0.01, file.duration))}
                disabled={!file}
              >
                « 10ms
              </W95Button>
              <W95Button
                onClick={() => file && setMarkerSec((m) => clampMarker(m - 0.001, file.duration))}
                disabled={!file}
              >
                « 1ms
              </W95Button>
              <W95Button
                onClick={() => file && setMarkerSec((m) => clampMarker(m + 0.001, file.duration))}
                disabled={!file}
              >
                1ms »
              </W95Button>
              <W95Button
                onClick={() => file && setMarkerSec((m) => clampMarker(m + 0.01, file.duration))}
                disabled={!file}
              >
                10ms »
              </W95Button>
              <W95Button
                onClick={() => file && setMarkerSec((m) => clampMarker(m + 0.05, file.duration))}
                disabled={!file}
              >
                50ms »
              </W95Button>
              <W95Button onClick={onDetectFirst} disabled={!file}>
                Detectar primer golpe
              </W95Button>
            </div>

            {/* onda original */}
            <div className="w95-group-title">
              Original (rojo = primer golpe, amarillo = cursor)
            </div>
            <Waveform
              peaks={peaksOrig}
              originSec={markerSec}
              beatLenSec={origBeatLen}
              beatsPerBar={beatsPerBar}
              totalBars={origBars}
              markerSec={markerSec}
              onMarkerChange={(t) => file && setMarkerSec(clampMarker(t, file.duration))}
              cursorSec={cursorSec}
              onCursorChange={(t) => file && setCursorSec(clampMarker(t, file.duration))}
              zoom={zoom}
              onZoomChange={setZoom}
              scrollBar={scrollBar}
              onScrollChange={setScrollBar}
              height={170}
            />

            {/* onda ajustada */}
            <div className="w95-group-title">
              Ajustado al tempo del proyecto (alineado por el marcador)
            </div>
            <Waveform
              peaks={peaksAdj}
              originSec={pad}
              beatLenSec={beatLen}
              beatsPerBar={beatsPerBar}
              totalBars={outBars}
              markerSec={pad}
              onMarkerChange={(t) =>
                file && setMarkerSec(clampMarker((t - pad) / factor, file.duration))
              }
              cursorSec={cursorSec * factor + pad}
              onCursorChange={(t) =>
                file && setCursorSec(clampMarker((t - pad) / factor, file.duration))
              }
              zoom={zoom}
              onZoomChange={setZoom}
              scrollBar={scrollBar}
              onScrollChange={setScrollBar}
              height={130}
            />

            <HScrollbar
              value={scrollBar}
              min={-30}
              max={Math.max(origBars, outBars) + 30}
              onChange={setScrollBar}
              page={4}
            />
            <div className="w95-label" style={{ color: "#404040" }}>
              Rueda = zoom · clic = colocar marcador · arrastrar = mover ·
              Mayús+arrastrar = desplazar
            </div>
          </div>
        </Win95Window>

        {/* ---- Ajustes ---- */}
        <Win95Window
          title="Ajustes"
          draggable
          defaultPos={{ x: 8, y: 200 }}
          width={350}
          zIndex={focus === "ajustes" ? 60 : 10}
          onFocus={() => setFocus("ajustes")}
        >
          <div className="flex flex-col gap-3">
            <div>
              <div className="w95-group-title">Tempo</div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="w95-label" style={{ width: 105, flex: "0 0 auto" }}>
                  BPM del proyecto:
                </span>
                <W95NumField
                  value={projectBPM}
                  onChange={setProjectBPM}
                  min={30}
                  max={300}
                />
              </div>
              <div className="flex items-center gap-2 flex-wrap mt-1">
                <span className="w95-label" style={{ width: 105, flex: "0 0 auto" }}>
                  BPM original:
                </span>
                <W95NumField
                  value={originalBPM}
                  onChange={setOriginalBPM}
                  min={30}
                  max={300}
                />
                <W95Button onClick={onDetectBpm} disabled={!file}>
                  Detectar BPM
                </W95Button>
                <W95Button onClick={onTap} disabled={!file}>
                  Tap ({tapCount})
                </W95Button>
              </div>
              <div className="flex items-center gap-2 mt-1">
                <span className="w95-label" style={{ width: 105, flex: "0 0 auto" }}>
                  Compás:
                </span>
                <W95Select
                  value={String(beatsPerBar)}
                  onChange={(v) => setBeatsPerBar(parseInt(v, 10))}
                  options={[
                    { value: "2", label: "2/4" },
                    { value: "3", label: "3/4" },
                    { value: "4", label: "4/4" },
                    { value: "5", label: "5/4" },
                    { value: "6", label: "6/8" },
                  ]}
                />
              </div>
              {tempoWarn && (
                <div className="w95-warn mt-1">
                  Aviso: cambio de tempo &gt; 25% ({tempoChangePct.toFixed(0)}%).
                  El resultado puede sonar artificial.
                </div>
              )}
            </div>

            <div>
              <div className="w95-group-title">Procesado</div>
              <W95Checkbox
                checked={keepPitch}
                onChange={setKeepPitch}
                label="Mantener tono"
              />
              {!keepPitch && (
                <div className="w95-label" style={{ color: "#404040" }}>
                  Desactivado: cambia el tono como un vinilo.
                </div>
              )}
              <W95Checkbox
                checked={metronomeOn}
                onChange={setMetronomeOn}
                label="Metrónomo"
              />
            </div>

            <div>
              <div className="w95-group-title">Qué se exporta</div>
              <W95Radio
                checked={exportMode === "all"}
                onChange={() => setExportMode("all")}
                label="Todo con la intro (marcador al inicio de un compás)"
              />
              <W95Radio
                checked={exportMode === "beat"}
                onChange={() => setExportMode("beat")}
                label="Desde el primer golpe"
              />
              <W95Radio
                checked={exportMode === "sel"}
                onChange={() => setExportMode("sel")}
                label="Solo una selección"
              />
              {exportMode === "sel" && (
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span className="w95-label">Desde compás</span>
                  <W95NumField
                    value={selStart}
                    onChange={(v) => setSelStart(Math.max(1, Math.round(v)))}
                    min={1}
                    max={outBars}
                  />
                  <span className="w95-label">hasta compás</span>
                  <W95NumField
                    value={selEnd}
                    onChange={(v) => setSelEnd(Math.max(1, Math.round(v)))}
                    min={1}
                    max={outBars}
                  />
                </div>
              )}
              <div className="flex items-center gap-2 mt-1">
                <span className="w95-label">Formato:</span>
                <W95Select
                  value={String(bitDepth)}
                  onChange={(v) => setBitDepth(parseInt(v, 10) as 24 | 32)}
                  options={[
                    { value: "24", label: "WAV 24 bits (sin pérdida)" },
                    { value: "32", label: "WAV 32 bits flotante" },
                  ]}
                />
              </div>
            </div>
          </div>
        </Win95Window>

        {/* ---- Reproducción ---- */}
        <Win95Window
          title="Reproducción"
          draggable
          defaultPos={{ x: 374, y: 664 }}
          width={380}
          zIndex={focus === "repro" ? 60 : 10}
          onFocus={() => setFocus("repro")}
        >
          <div className="flex flex-col gap-2">
            <div className="flex gap-2 flex-wrap">
              <W95Button
                onClick={() => startPlayback(sourceMode, cursorSec * factor + pad)}
                disabled={!file}
              >
                ▶ Desde el cursor
              </W95Button>
              <W95Button
                onClick={() => startPlayback(sourceMode, pad)}
                disabled={!file}
              >
                ▶ Desde el primer golpe
              </W95Button>
              <W95Button onClick={stopPlayback} disabled={!file}>
                ■ Detener
              </W95Button>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <W95Checkbox
                checked={loopOn}
                onChange={setLoopOn}
                label="Repetir tramo en bucle"
              />
              <W95NumField
                value={loopBars}
                onChange={(v) => setLoopBars(Math.max(1, Math.min(64, Math.round(v))))}
                min={1}
                max={64}
                style={{ width: 50 }}
              />
              <span className="w95-label">compases</span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <W95Button onClick={onCompare} disabled={!file}>
                Comparar: {sourceMode === "adj" ? "Ajustado" : "Original"}
              </W95Button>
              <span className="w95-label">Metrónomo: {metronomeOn ? "sí" : "no"}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w95-label">Posición:</span>
              <W95Field>
                compás {cursorBar} · {formatTime(cursorSec)}
              </W95Field>
            </div>
            <div className="w95-label" style={{ color: "#404040" }}>
              Volumen igual al original (sin normalizar, sin comprimir). Se oye en
              tiempo real al mover el marcador o cambiar el tempo.
            </div>
          </div>
        </Win95Window>

        {/* ---- Exportar ---- */}
        <Win95Window
          title="Exportar"
          draggable
          defaultPos={{ x: window.innerWidth >= 1420 ? 1030 : 740, y: window.innerWidth >= 1420 ? 8 : 664 }}
          width={330}
          zIndex={focus === "export" ? 60 : 10}
          onFocus={() => setFocus("export")}
        >
          <div className="flex flex-col gap-2">
            {file && exportPlan ? (
              <>
                <div className="flex gap-2 items-baseline">
                  <span className="w95-label" style={{ width: 95, flex: "0 0 auto" }}>
                    Duración:
                  </span>
                  <W95Field>{formatTime(exportPlan.lengthOut)}</W95Field>
                </div>
                <div className="flex gap-2 items-baseline">
                  <span className="w95-label" style={{ width: 95, flex: "0 0 auto" }}>
                    Compases:
                  </span>
                  <W95Field>{exportPlan.barCount}</W95Field>
                </div>
                <div className="flex gap-2 items-baseline">
                  <span className="w95-label" style={{ width: 95, flex: "0 0 auto" }}>
                    Frecuencia:
                  </span>
                  <W95Field>{file.sampleRate} Hz</W95Field>
                </div>
                <div className="flex gap-2 items-baseline">
                  <span className="w95-label" style={{ width: 95, flex: "0 0 auto" }}>
                    Canales:
                  </span>
                  <W95Field>{file.channels === 1 ? "Mono" : "Estéreo"}</W95Field>
                </div>
                <div className="flex gap-2 items-baseline">
                  <span className="w95-label" style={{ width: 95, flex: "0 0 auto" }}>
                    Formato:
                  </span>
                  <W95Field>WAV {bitDepth === 24 ? "24 bits" : "32 flotante"}</W95Field>
                </div>
                <div className="flex gap-2 items-baseline">
                  <span className="w95-label" style={{ width: 95, flex: "0 0 auto" }}>
                    Archivo:
                  </span>
                  <W95Field style={{ flex: 1 }}>{exportPlan.fname}</W95Field>
                </div>
                {clipWarn !== null && (
                  <div className="w95-warn">
                    Aviso: el resultado supera el nivel máximo (pico{" "}
                    {clipWarn.toFixed(2)}). La exportación de 24 bits podría
                    recortar. Baja el volumen del original si quieres evitarlo.
                  </div>
                )}
                <W95Button
                  onClick={doExport}
                  disabled={proc.active || exportBusy}
                  style={{ marginTop: 4 }}
                >
                  {exportBusy ? "Exportando…" : "Exportar WAV"}
                </W95Button>
              </>
            ) : (
              <div className="w95-label">Carga un audio primero.</div>
            )}
            <div className="w95-label" style={{ color: "#404040" }}>
              El audio original nunca se modifica. Todo ocurre en tu navegador.
            </div>
          </div>
        </Win95Window>

        {/* ---- Acerca de ---- */}
        {aboutOpen && (
          <Win95Window
            title="Acerca de"
            draggable
            defaultPos={{ x: 220, y: 220 }}
            width={400}
            zIndex={70}
            onClose={() => setAboutOpen(false)}
          >
            <div className="flex flex-col gap-2">
              <div style={{ fontWeight: "bold", fontSize: 13 }}>
                nouwarpi v1.0
              </div>
              <div className="w95-label">
                Carga un audio, coloca el marcador en el primer golpe real,
                ajústalo al tempo de tu proyecto y descárgalo sincronizado.
              </div>
              <div className="w95-label">· Vocoder de fase con preservación de transitorios</div>
              <div className="w95-label">· Estéreo intacto, misma frecuencia de muestreo</div>
              <div className="w95-label">· Sin normalizar, sin comprimir, sin efectos</div>
              <div className="w95-label">· WAV 24 bits o 32 flotante, duración exacta en compases</div>
              <div className="w95-label">· Todo ocurre en tu navegador. Nada se sube a ningún servidor.</div>
            </div>
          </Win95Window>
        )}
      </main>

      {/* barra de estado */}
      <footer
        className="fixed bottom-0 left-0 right-0"
        style={{ background: "#c0c0c0", zIndex: 200 }}
      >
        <div className="w95-statusbar">
          <div className="w95-status-panel" style={{ flex: "1 1 auto", minWidth: 120 }}>
            {status}
          </div>
          <div className="w95-status-panel mono" style={{ flex: "0 0 auto" }}>
            {file
              ? `Proyecto: ${Math.round(projectBPM)} BPM · Original: ${originalBPM.toFixed(1)} BPM · ${beatsPerBar}/${beatsPerBar === 6 ? 8 : 4}`
              : "Sin audio"}
          </div>
          <div className="w95-status-panel" style={{ flex: "0 0 auto", minWidth: 190 }}>
            <W95Progress frac={proc.active ? proc.frac : 0} />
            <span className="mono" style={{ minWidth: 36, textAlign: "right" }}>
              {proc.active ? Math.round(proc.frac * 100) + "%" : ""}
            </span>
          </div>
          <div className="w95-status-panel" style={{ flex: "0 0 auto" }}>
            100% navegador
          </div>
        </div>
      </footer>
    </div>
  );
}
