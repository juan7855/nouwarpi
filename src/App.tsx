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
import { Waveform, Peaks, ZOOM_MIN, ZOOM_MAX } from "./components/Waveform";
import { Engine } from "./audio/engine";
import type { BeatTrack } from "./audio/tracker";
import { constantPlan, variablePlan, scaleBeats, anchorPlan, WarpPlan } from "./audio/warp";
import { estefa } from "./audio/estefa";
import { firstDownbeat, bestOctave, constantIsEnough } from "./audio/decide";
import { Processor, CANCELLED } from "./audio/processor";
import { decodeAudioFile } from "./audio/decode";
import type { StretchMethod } from "./audio/stretch";
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

function mixToMono(buf: AudioBuffer): Float32Array {
  const n = buf.length;
  const out = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i];
  }
  if (buf.numberOfChannels > 1) for (let i = 0; i < n; i++) out[i] /= buf.numberOfChannels;
  return out;
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
  // marcas puestas con clics (la primera es el "1"); sin marcas manda el marcador automático
  const [marks, setMarks] = useState<number[]>([]);
  const [autoMarker, setAutoMarker] = useState(0);
  const markerSec = marks.length ? marks[0] : autoMarker;
  const marksRef = useRef<number[]>([]);
  marksRef.current = marks;
  const autoRef = useRef(0);
  autoRef.current = autoMarker;
  const setMarkerSec = useCallback((v: number | ((m: number) => number)) => {
    const cur = marksRef.current.length ? marksRef.current[0] : autoRef.current;
    const nv = typeof v === "function" ? v(cur) : v;
    if (marksRef.current.length) setMarks([nv, ...marksRef.current.slice(1)].sort((a, b) => a - b));
    else setAutoMarker(nv);
    // la rejilla se re-ancla en el "1": se compensa el desplazamiento para que la vista no salte
    if (beatLenRef.current > 0) setScrollRaw((sc) => sc + (cur - nv) / beatLenRef.current);
  }, []);
  const [cursorSec, setCursorSec] = useState(0);
  const [projectBPM, setProjectBPM] = useState(120);
  const [originalBPM, setOriginalBPM] = useState(120);
  const [beatsPerBar, setBeatsPerBar] = useState(4);
  const [method, setMethod] = useState<StretchMethod>("wsola");
  const [embedTempo, setEmbedTempo] = useState(true);
  const [track, setTrack] = useState<BeatTrack | null>(null);
  const [tempoMode, setTempoMode] = useState<"const" | "var" | "estefa" | "manual">("const");
  const [estefaStrength, setEstefaStrength] = useState(1);
  const [estefaPick, setEstefaPick] = useState(0);
  // octava: la lectura puede salir al doble o a la mitad del tempo "sentido". Por defecto se elige
  // la que deja el tempo más cerca del BPM del proyecto (así se estira lo menos posible).
  const [autoOctave, setAutoOctave] = useState(true);
  const [octaveMult, setOctaveMult] = useState<1 | 2 | 0.5>(1);
  const [bpmManual, setBpmManual] = useState(false);
  const [playing, setPlaying] = useState<"orig" | "adj" | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
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
  const [scrollBar, setScrollRaw] = useState(0);
  // la vista nunca puede irse más allá del contenido (antes se perdía "al infinito")
  const scrollLimits = useRef({ min: -4, max: 100 });
  const setScrollBar = useCallback((v: number) => {
    const { min, max } = scrollLimits.current;
    setScrollRaw(Math.max(min, Math.min(max, v)));
  }, []);
  const beatLenRef = useRef(0.5);
  // modo de clic en la onda y audición al colocar el "1"
  const [markMode, setMarkMode] = useState<"first" | "beats">("first");
  const [auditionOn, setAuditionOn] = useState(true);
  const [auditionReq, setAuditionReq] = useState(0);
  const auditionTok = useRef(0);
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

  // colocación automática: cada ventana en su sitio, sin solaparse (hasta que el usuario mueva alguna)
  const userMovedRef = useRef(false);
  useEffect(() => {
    const h = () => {
      userMovedRef.current = true;
    };
    window.addEventListener("w95-userdrag", h);
    return () => window.removeEventListener("w95-userdrag", h);
  }, []);
  const arrangeWindows = useCallback((force?: boolean) => {
    if (force) userMovedRef.current = false;
    if (userMovedRef.current) return;
    const main = mainRef.current;
    if (!main) return;
    const W = main.clientWidth;
    if (W < 820) return;
    const hOf = (id: string) => (main.querySelector(`[data-win="${id}"]`) as HTMLElement | null)?.offsetHeight ?? 300;
    const GAP = 10;
    const c1 = 350;
    const det: Record<string, { x: number; y: number; width?: number }> = {};
    det.file = { x: 8, y: 8, width: c1 };
    det.ajustes = { x: 8, y: 8 + hOf("file") + GAP, width: c1 };
    const x2 = 8 + c1 + GAP;
    const wide = W >= 1450;
    const waveW = Math.max(560, Math.min(820, W - x2 - (wide ? 330 + GAP + 8 : 8)));
    det.wave = { x: x2, y: 8, width: waveW };
    const y2 = 8 + hOf("wave") + GAP;
    det.repro = { x: x2, y: y2, width: 400 };
    if (wide) det.export = { x: x2 + waveW + GAP, y: 8, width: 330 };
    else if (x2 + 400 + GAP + 330 <= W - 8) det.export = { x: x2 + 400 + GAP, y: y2, width: 330 };
    else det.export = { x: x2, y: y2 + hOf("repro") + GAP, width: 330 };
    window.dispatchEvent(new CustomEvent("w95-arrange", { detail: det }));
  }, []);
  const [dropHover, setDropHover] = useState(false);
  const [tapCount, setTapCount] = useState(0);
  const [exportBusy, setExportBusy] = useState(false);

  // se reordena al abrir, al cargar un audio, al cambiar de modo (cambia la altura de Ajustes) y al redimensionar
  useEffect(() => {
    const run = () => {
      arrangeWindows();
      // la altura cambia al fijar el ancho: segunda pasada
      setTimeout(() => arrangeWindows(), 80);
    };
    const t1 = setTimeout(run, 40);
    const t2 = setTimeout(run, 400);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [file, track, tempoMode, arrangeWindows]);
  useEffect(() => {
    let t: number | undefined;
    const onResize = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => arrangeWindows(), 150);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [arrangeWindows]);

  const stretchedRef = useRef<AudioBuffer | null>(null);
  const procToken = useRef(0);
  const analyzeToken = useRef(0);
  const processorRef = useRef<Processor | null>(null);
  if (!processorRef.current) processorRef.current = new Processor();
  const analyzerRef = useRef<Processor | null>(null);
  if (!analyzerRef.current) analyzerRef.current = new Processor();
  const autoMarkerRef = useRef(0);
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

  const bestOct = useMemo<1 | 2 | 0.5>(() => (track ? bestOctave(track.bpm, projectBPM) : 1), [track, projectBPM]);
  const beatMult: 1 | 2 | 0.5 = autoOctave ? bestOct : octaveMult;

  // el BPM original sigue a la lectura (con la octava elegida) salvo que el usuario lo fije a mano
  useEffect(() => {
    if (!track || bpmManual) return;
    setOriginalBPM(Math.min(300, Math.max(30, Math.round(track.bpm * beatMult * 100) / 100)));
  }, [track, beatMult, bpmManual]);

  // pulsos detectados (con la subdivisión elegida) y plan de alineación
  const beatsAdj = useMemo(
    () => (track ? scaleBeats(track.beats, beatMult, markerSec) : []),
    [track, beatMult, markerSec]
  );
  const varResult = useMemo(
    () =>
      file && tempoMode === "var" && track
        ? variablePlan(beatsAdj, markerSec, beatLen, file.duration)
        : null,
    [file, tempoMode, track, beatsAdj, markerSec, beatLen]
  );
  // Estefa: sincronización automática (sin BPM de origen) con cuantizado elástico
  const estefaRes = useMemo(
    () =>
      file && tempoMode === "estefa" && track
        ? estefa({
            onsets: track.onsets,
            markerSec,
            contentEnd: track.contentEnd,
            dur: file.duration,
            projBeatLen: beatLen,
            beatsPerBar,
            strength: estefaStrength,
            pick: estefaPick,
          })
        : null,
    [file, tempoMode, track, markerSec, beatLen, beatsPerBar, estefaStrength, estefaPick]
  );
  const manualResult = useMemo(
    () =>
      file && tempoMode === "manual" && marks.length >= 2
        ? variablePlan(marks, marks[0], beatLen, file.duration)
        : null,
    [file, tempoMode, marks, beatLen]
  );
  const plan: WarpPlan = useMemo(
    () =>
      varResult?.plan ??
      manualResult?.plan ??
      (estefaRes ? anchorPlan(estefaRes.anchors) : constantPlan(file ? file.duration : 1, factor)),
    [varResult, manualResult, estefaRes, file, factor]
  );
  // pulsos que se dibujan en la onda original: los detectados (variable) o la rejilla de Estefa
  const viewBeats = useMemo(() => {
    if (tempoMode === "manual" && marks.length >= 2) return marks;
    if (tempoMode === "var" && track) return beatsAdj;
    if (tempoMode === "estefa" && estefaRes && file) {
      const out: number[] = [];
      const m = plan.fwd(markerSec);
      for (let k = -64; k < 4096; k++) {
        const o = m + k * beatLen;
        if (o <= 0) continue;
        if (o >= plan.stretchedDur) break;
        out.push(plan.inv(o));
      }
      return out;
    }
    return undefined;
  }, [tempoMode, track, beatsAdj, estefaRes, file, plan, markerSec, beatLen, marks]);
  const beatZero = useMemo(() => {
    if (!viewBeats) return 0;
    let j = 0;
    for (let i = 1; i < viewBeats.length; i++)
      if (Math.abs(viewBeats[i] - markerSec) < Math.abs(viewBeats[j] - markerSec)) j = i;
    return j;
  }, [viewBeats, markerSec]);

  const markerStretched = plan.fwd(markerSec);
  const pad = useMemo(() => {
    if (!file) return 0;
    const r = markerStretched % barLen;
    return r < 1e-6 || barLen - r < 1e-6 ? 0 : barLen - r;
  }, [file, markerStretched, barLen]);
  const stretchedDur = file ? plan.stretchedDur : 0;
  const totalOut = pad + stretchedDur;
  const outBars = file ? Math.max(1, Math.ceil(totalOut / barLen - 1e-9)) : 0;
  const origBars = file ? Math.max(1, Math.ceil(file.duration / origBarLen - 1e-9)) : 0;
  const tempoChangePct = (plan.avgFactor - 1) * 100;
  const tempoWarn = Math.abs(tempoChangePct) > 25;

  const markerOut = pad + markerStretched; // el marcador, siempre en una línea de compás

  beatLenRef.current = origBeatLen;
  {
    // rango de desplazamiento (en pulsos desde el "1"): de t = 0 al final, en ambas vistas
    const topMin = 1 - markerSec / origBeatLen - 1;
    const topMax = file ? (file.duration - markerSec) / origBeatLen + 1 : 100;
    const outMin = -markerOut / beatLen - 1;
    const outMax = file ? (totalOut - markerOut) / beatLen + 1 : 100;
    scrollLimits.current = { min: file ? Math.min(topMin, outMin) : -4, max: file ? Math.max(topMax, outMax) : 100 };
  }

  const exportPlan = useMemo(() => {
    if (!file) return null;
    let startOut: number;
    let lengthOut: number;
    if (exportMode === "all") {
      startOut = 0;
      lengthOut = outBars * barLen;
    } else if (exportMode === "beat") {
      startOut = markerOut;
      lengthOut = Math.max(1, Math.ceil((totalOut - markerOut) / barLen - 1e-9)) * barLen;
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
  }, [file, exportMode, outBars, barLen, markerOut, totalOut, selStart, selEnd, projectBPM]);

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
    setFile(info);
    setPeaksOrig(peaks);
    setPeaksAdj(null);
    stretchedRef.current = null;
    setMarks([]);
    setAutoMarker(0);
    setCursorSec(0);
    setTrack(null);
    setDetected(null);
    setTempoMode("const");
    setEstefaPick(0);
    setAutoOctave(true);
    setOctaveMult(1);
    setBpmManual(false);
    setIrregular(false);
    setScrollBar(0);
    setTapCount(0);
    tapsRef.current = [];

    // lectura de los pulsos de TODA la canción (en el worker)
    const token = ++analyzeToken.current;
    setAnalyzing(true);
    setStatus("Analizando pulsos…");
    analyzerRef
      .current!.track(mixToMono(buf), buf.sampleRate, 4, (frac) => {
        if (token === analyzeToken.current) setStatus(`Analizando pulsos… ${Math.round(frac * 100)}%`);
      })
      .then((tr) => {
        if (token !== analyzeToken.current) return;
        const marker = firstDownbeat(tr, 4);
        autoMarkerRef.current = marker;
        setTrack(tr);
        setAutoMarker(marker);
        setOriginalBPM(Math.round(tr.bpm * 100) / 100);
        setDetected({ firstBeat: marker, bpm: tr.bpm, conf: tr.confidence });
        const noPulse = tr.goodBeats < 8;
        setTempoMode(noPulse ? "estefa" : constantIsEnough(tr) ? "const" : "var");
        setIrregular(!constantIsEnough(tr));
        setAnalyzing(false);
        setStatus(
          noPulse
            ? "Sin pulso claro: Estefa decide el encaje"
            : constantIsEnough(tr)
              ? `Tempo estable: ${tr.bpm.toFixed(2)} BPM`
              : `Tempo variable (deriva ${tr.driftMs.toFixed(0)} ms): se sigue cada pulso`
        );
      })
      .catch((e) => {
        if (e instanceof Error && e.message === CANCELLED) return;
        if (token !== analyzeToken.current) return;
        setAnalyzing(false);
        setStatus("No se pudo leer el tempo: ajústalo a mano.");
      });
  }, []);

  const loadFile = useCallback(
    async (f: File) => {
      setStatus("Cargando…");
      try {
        const buf = await decodeAudioFile(f);
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

  /* ---------- procesado (Web Worker) ---------- */

  useEffect(() => {
    if (!file) return;
    const token = ++procToken.current;
    const processor = processorRef.current!;
    const t = setTimeout(async () => {
      if (plan.kind === "const" && Math.abs(plan.avgFactor - 1) < 0.0005) {
        stretchedRef.current = file.buffer;
        setPeaksAdj(peaksOrig);
        setClipWarn(null);
        setProc({ active: false, label: "", frac: 0 });
        setStatus("Listo");
        return;
      }
      setProc({ active: true, label: "Procesando…", frac: 0 });
      setStatus("Procesando…");
      try {
        const chs: Float32Array[] = [];
        for (let c = 0; c < file.channels; c++) chs.push(file.buffer.getChannelData(c).slice());
        const sr = file.sampleRate;
        const warp =
          plan.kind === "const"
            ? plan.avgFactor
            : plan.anchors.map((a) => ({ in: a.in * sr, out: a.out * sr }));
        const out = await processor.stretch(chs, sr, warp, method, (frac) => {
          if (token === procToken.current) setProc({ active: true, label: "Procesando…", frac });
        });
        if (token !== procToken.current) return;
        const buf = new AudioBuffer({
          length: out[0].length,
          sampleRate: file.sampleRate,
          numberOfChannels: out.length,
        });
        for (let c = 0; c < out.length; c++) buf.copyToChannel(out[c] as Float32Array<ArrayBuffer>, c);
        stretchedRef.current = buf;
        setPeaksAdj(computePeaks(buf, 256));
        const m = maxAbs(out);
        setClipWarn(m > 0.999 ? m : null);
        setProc({ active: false, label: "", frac: 0 });
        setStatus("Listo");
      } catch (e) {
        if (e instanceof Error && e.message === CANCELLED) return;
        setProc({ active: false, label: "", frac: 0 });
        setStatus("Error al procesar: " + (e instanceof Error ? e.message : "desconocido"));
      }
    }, 350);
    return () => {
      clearTimeout(t);
      procToken.current++;
      processor.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, plan, method]);

  /* ---------- reproducción ---------- */

  const stopPlayback = useCallback(() => {
    auditionTok.current++;
    engineRef.current!.stop();
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    setPlaying(null);
  }, []);

  const startPlayback = useCallback(
    (mode: "adj" | "orig", startOut: number) => {
      if (!file) return;
      const eng = engineRef.current!;
      eng.stop();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);

      let buffer: AudioBuffer;
      let offsetSrc: number;

      if (mode === "adj") {
        const sb = stretchedRef.current;
        if (!sb) {
          setStatus("Aún procesando…");
          return;
        }
        buffer = sb;
        offsetSrc = startOut - pad;
      } else {
        buffer = file.buffer;
        offsetSrc = plan.inv(Math.max(0, startOut - pad));
      }

      const srcFromOut = (o: number) => (mode === "adj" ? o - pad : plan.inv(Math.max(0, o - pad)));

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
        rate: 1,
        loopStartSec: loopStartSrc,
        loopEndSec: loopEndSrc,
        onEnded: () => {
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          rafRef.current = 0;
          setPlaying(null);
        },
      });
      setPlaying(mode);
      setSourceMode(mode);

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
            ? plan.inv(Math.max(0, startOut + el - pad))
            : plan.inv(Math.max(0, startOut - pad)) + el;
        setCursorSec(Math.max(0, cur));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
      setStatus(
        mode === "adj" ? "▶ SONANDO: SINCRONIZADA (al tempo del proyecto)" : "▶ SONANDO: ORIGINAL (sin ajustar)"
      );
    },
    [file, plan, pad, loopOn, loopBars, barLen, metronomeOn, projectBPM, beatsPerBar]
  );

  // Reproduce una fuente. Si ya está sonando la otra, CAMBIA en la misma posición musical (A/B).
  // Parado, SIEMPRE arranca desde el 1 (rojo). Si ya está sonando, cambia de fuente en la misma posición
  // (A/B). `from = "cursor"` fuerza el cursor amarillo.
  const playSource = useCallback(
    (mode: "adj" | "orig", from?: "cursor") => {
      if (!file) return;
      auditionTok.current++;
      const start = from === "cursor" || playing ? plan.fwd(cursorSec) + pad : markerOut;
      startPlayback(mode, start);
    },
    [file, playing, cursorSec, plan, pad, markerOut, startPlayback]
  );

  // al activar/desactivar el metrónomo con el audio sonando, se reinicia en la misma posición
  const prevMetro = useRef(metronomeOn);
  useEffect(() => {
    if (prevMetro.current === metronomeOn) return;
    prevMetro.current = metronomeOn;
    if (playing) startPlayback(playing, plan.fwd(cursorSec) + pad);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metronomeOn]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLSelectElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      if (e.code === "Space") {
        e.preventDefault();
        if (engineRef.current!.playing) stopPlayback();
        else playSource(sourceMode);
      } else if (e.key === "1" || e.key.toLowerCase() === "o") {
        playSource("orig");
      } else if (e.key === "2" || e.key.toLowerCase() === "s") {
        playSource("adj");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playSource, stopPlayback, sourceMode]);

  /* ---------- detección / tap ---------- */

  const onDetectBpm = useCallback(() => {
    if (!track) {
      setStatus(analyzing ? "Aún analizando…" : "No hay lectura de pulsos disponible.");
      return;
    }
    setAutoOctave(true);
    setBpmManual(false);
    setIrregular(!track.constantOk);
    setStatus(
      track.constantOk
        ? `BPM detectado: ${track.bpm.toFixed(2)} (desvío ${track.rmsMs.toFixed(1)} ms)`
        : `Tempo variable: BPM medio ${track.bpm.toFixed(2)}`
    );
  }, [track, analyzing]);

  const onDetectFirst = useCallback(() => {
    if (!file || !track) return;
    const fb = firstDownbeat(track, beatsPerBar);
    setMarks([]);
    setAutoMarker(fb);
    setStatus("Primer tiempo fuerte: " + fb.toFixed(3) + " s");
  }, [file, track, beatsPerBar]);

  // al colocar el "1": se oye un fragmento del ORIGINAL desde ahí para comprobar que es el golpe
  useEffect(() => {
    if (!auditionReq || !file) return;
    const tok = ++auditionTok.current;
    startPlayback("orig", markerOut);
    const t = setTimeout(() => {
      if (auditionTok.current === tok) stopPlayback();
    }, 1300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditionReq]);

  /* ---------- marcas con clics ---------- */

  // correr el "1" un pulso (corregir el tiempo fuerte): al pulso detectado anterior / siguiente
  const shiftMarkerBeat = useCallback(
    (dir: -1 | 1) => {
      if (!file) return;
      const beats = track && track.beats.length ? track.beats : null;
      const cur = markerSec;
      let next: number;
      if (beats) {
        const good = beats.filter((_, i) => track!.beatGood[i] !== false);
        const list = good.length > 4 ? good : beats;
        const cand = dir > 0 ? list.find((b) => b > cur + 0.02) : [...list].reverse().find((b) => b < cur - 0.02);
        next = cand ?? cur + dir * origBeatLen;
      } else next = cur + dir * origBeatLen;
      setMarkerSec(clampMarker(next, file.duration));
    },
    [file, track, markerSec, origBeatLen, setMarkerSec]
  );


  const snapTimes = useMemo(() => (track ? track.onsets.map((o) => o.t) : undefined), [track]);

  const addMark = useCallback(
    (t: number) => {
      if (!file) return;
      const nt = clampMarker(t, file.duration);
      const cur = marksRef.current;
      if (cur.some((m) => Math.abs(m - nt) < 0.004)) return;
      const next = [...cur, nt].sort((a, b) => a - b);
      setMarks(next);
      if (next.length === 1) {
        setStatus(`Marca 1 en ${nt.toFixed(3)} s. Pon más marcas en los siguientes pulsos o usa Estefa.`);
      } else if (next.length === 2) {
        setTempoMode("manual");
        setStatus("Marcas manuales: cada marca es un pulso. Estiro entre tus marcas.");
      }
    },
    [file]
  );
  const removeMark = useCallback((t: number) => {
    const cur = marksRef.current;
    const next = cur.filter((m) => Math.abs(m - t) > 0.002);
    setMarks(next);
    if (next.length < 2) setTempoMode((m) => (m === "manual" ? "const" : m));
    if (!next.length) setAutoMarker(autoRef.current);
  }, []);
  const moveMark = useCallback(
    (from: number, to: number) => {
      if (!file) return;
      const nt = clampMarker(to, file.duration);
      setMarks((cur) => cur.map((m) => (Math.abs(m - from) < 0.002 ? nt : m)).sort((a, b) => a - b));
    },
    [file]
  );
  const clearMarks = useCallback(() => {
    setMarks([]);
    setTempoMode((m) => (m === "manual" ? "const" : m));
    setStatus("Marcas borradas");
  }, []);

  // con 2+ marcas, el BPM original sale de la distancia media entre ellas
  useEffect(() => {
    if (marks.length < 2) return;
    const d: number[] = [];
    for (let i = 1; i < marks.length; i++) d.push(marks[i] - marks[i - 1]);
    d.sort((a, b) => a - b);
    const med = d[Math.floor(d.length / 2)];
    if (med > 0.05) {
      setBpmManual(true);
      setOriginalBPM(Math.min(300, Math.max(30, Math.round((60 / med) * 100) / 100)));
    }
  }, [marks]);

  // "Ver toda la canción"
  const fitAll = useCallback(() => {
    if (!file) return;
    const beats = file.duration / origBeatLen;
    setZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, 600 / (beats + 1))));
    setScrollBar(1 - markerSec / origBeatLen);
  }, [file, origBeatLen, markerSec]);

  // Estefa: activar / desactivar (vuelve al modo que sugirió el análisis)
  const toggleEstefa = useCallback(() => {
    if (!track) {
      setStatus(analyzing ? "Espera: aún analizando el audio…" : "Carga un audio primero para usar Estefa");
      return;
    }
    setEstefaPick(0);
    if (tempoMode === "estefa") {
      setTempoMode(track.constantOk ? "const" : "var");
      setStatus("Estefa desactivada");
    } else {
      setTempoMode("estefa");
      setStatus("Estefa activada: decide el tempo natural y cuantiza los sonidos");
    }
  }, [track, analyzing, tempoMode]);

  const bumpTempo = useCallback((k: 2 | 0.5) => {
    if (track) {
      const nm = beatMult * k;
      setAutoOctave(false);
      setBpmManual(false);
      setOctaveMult(nm >= 2 ? 2 : nm <= 0.5 ? 0.5 : 1);
    } else {
      setBpmManual(true);
      setOriginalBPM((v) => Math.min(300, Math.max(30, Math.round(v * k * 100) / 100)));
    }
  }, [track, beatMult]);

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
      setBpmManual(true);
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
      const sr = file.sampleRate;
      const { startOut, lengthOut, fname } = exportPlan;
      const lengthSamples = Math.max(1, Math.round(lengthOut * sr));

      const sb = stretchedRef.current;
      if (!sb) {
        setStatus("Aún procesando…");
        return;
      }
      // puede haber silencio inicial (intro) si startOut < pad
      const srcStartF = (startOut - pad) * sr;
      const dstSkip = Math.max(0, Math.round(-srcStartF));
      const srcStart = Math.max(0, Math.round(srcStartF));
      const channels: Float32Array[] = [];
      for (let c = 0; c < sb.numberOfChannels; c++) {
        const src = sb.getChannelData(c);
        const dst = new Float32Array(lengthSamples);
        const avail = Math.max(0, src.length - srcStart);
        const n = Math.min(lengthSamples - dstSkip, avail);
        if (n > 0) dst.set(src.subarray(srcStart, srcStart + n), dstSkip);
        channels.push(dst);
      }

      const m = maxAbs(channels);
      if (m > 0.999) setClipWarn(m);

      const blob = encodeWav(
        channels,
        sr,
        bitDepth,
        embedTempo
          ? { bpm: projectBPM, beats: exportPlan.barCount * beatsPerBar, beatsPerBar }
          : undefined
      );
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
  }, [file, exportPlan, pad, bitDepth, embedTempo, projectBPM, beatsPerBar]);

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
        <span
          className="menu-item"
          onClick={toggleEstefa}
          title="Sincroniza audio SIN BPM fijo: Estefa decide el tempo natural y cuantiza los sonidos"
          style={tempoMode === "estefa" ? { background: "#000080", color: "#ffffff", fontWeight: "bold" } : { fontWeight: "bold" }}
        >
          ★ Estefa{tempoMode === "estefa" ? " (activa)" : ""}
        </span>
        <span className="menu-item" onClick={() => arrangeWindows(true)} title="Coloca cada ventana en su sitio">
          ▦ Ordenar ventanas
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
          id="file"
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
                      {detected.bpm.toFixed(2)} (conf. {Math.round(detected.conf * 100)}%)
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
          id="wave"
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
                onClick={() => setZoom((z) => Math.max(ZOOM_MIN, z / 1.5))}
                title="Alejar"
              >
                −
              </W95Button>
              <W95Button
                onClick={() => setZoom((z) => Math.min(ZOOM_MAX, z * 1.5))}
                title="Acercar"
              >
                +
              </W95Button>
              <W95Field style={{ width: 90 }}>Zoom: {Math.round(zoom)}</W95Field>
              <W95Button onClick={fitAll} disabled={!file} title="Ver toda la canción">
                Ver todo
              </W95Button>
              <W95Button onClick={() => setScrollBar(0)}>Ir al compás 1</W95Button>
              <W95Button
                onClick={clearMarks}
                disabled={!marks.length}
                title="Quitar todas las marcas y volver al marcador automático"
              >
                Borrar marcas ({marks.length})
              </W95Button>
              <span className="w95-label mono">
                Marcador: {markerSec.toFixed(4)} s
              </span>
              <span className="w95-label mono">
                Cursor: {cursorSec.toFixed(4)} s
              </span>
            </div>

            {/* qué hace un clic en la onda */}
            <div className="flex items-center gap-3 flex-wrap">
              <span className="w95-label" style={{ fontWeight: "bold" }}>Clic en la onda:</span>
              <W95Radio
                checked={markMode === "first"}
                onChange={() => setMarkMode("first")}
                label="Poner el 1 (primer golpe)"
              />
              <W95Radio
                checked={markMode === "beats"}
                onChange={() => {
                  setMarkMode("beats");
                  if (!marksRef.current.length) setMarks([markerSec]); // el 1 actual pasa a ser la marca 1
                }}
                label="Marcar pulsos"
              />
              <W95Checkbox checked={auditionOn} onChange={setAuditionOn} label="Oír al poner el 1" />
            </div>

            {/* ajuste fino del marcador */}
            <div className="flex items-center gap-1 flex-wrap">
              <span className="w95-label mr-1">Marcador:</span>
              <W95Button onClick={() => shiftMarkerBeat(-1)} disabled={!file} title="Mover el 1 al pulso anterior">
                « pulso
              </W95Button>
              <W95Button onClick={() => shiftMarkerBeat(1)} disabled={!file} title="Mover el 1 al pulso siguiente">
                pulso »
              </W95Button>
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
              <span style={playing === "orig" ? { background: "#ffa733", padding: "0 4px" } : undefined}>
                ORIGINAL{playing === "orig" ? " ● sonando" : ""}
              </span>{" "}
              (rojo = el 1, naranja = marcas, cian = pulsos detectados, amarillo = cursor)
            </div>
            <Waveform
              peaks={peaksOrig}
              originSec={markerSec}
              beatLenSec={origBeatLen}
              beatTimes={viewBeats}
              beatZero={beatZero}
              beatsPerBar={beatsPerBar}
              totalBars={origBars}
              markerSec={markerSec}
              marks={marks}
              markMode={markMode}
              onSetMarker={(t) => file && setMarkerSec(clampMarker(t, file.duration))}
              onMarkerCommit={() => auditionOn && setAuditionReq((n) => n + 1)}
              scrollMin={scrollLimits.current.min}
              scrollMax={scrollLimits.current.max}
              ticks={track ? track.beats : undefined}
              ticksGood={track ? track.beatGood : undefined}
              snapTimes={snapTimes}
              editable
              onAddMark={addMark}
              onRemoveMark={removeMark}
              onMoveMark={moveMark}
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
              <span style={playing === "adj" ? { background: "#33dd55", padding: "0 4px" } : undefined}>
                SINCRONIZADA{playing === "adj" ? " ● sonando" : ""}
              </span>{" "}
              (al tempo del proyecto, alineada por el marcador)
            </div>
            <Waveform
              peaks={peaksAdj}
              originSec={markerOut}
              beatLenSec={beatLen}
              beatsPerBar={beatsPerBar}
              totalBars={outBars}
              markerSec={markerOut}
              peaksOffset={pad}
              scrollMin={scrollLimits.current.min}
              scrollMax={scrollLimits.current.max}
              marks={marks.map((m) => plan.fwd(m) + pad)}
              ticks={track ? track.beats.map((b) => plan.fwd(b) + pad) : undefined}
              ticksGood={track ? track.beatGood : undefined}
              editable={false}
              cursorSec={plan.fwd(cursorSec) + pad}
              onCursorChange={(t) =>
                file && setCursorSec(clampMarker(plan.inv(Math.max(0, t - pad)), file.duration))
              }
              zoom={zoom}
              onZoomChange={setZoom}
              scrollBar={scrollBar}
              onScrollChange={setScrollBar}
              height={130}
            />

            <HScrollbar
              value={scrollBar}
              min={scrollLimits.current.min}
              max={scrollLimits.current.max}
              onChange={setScrollBar}
              page={Math.max(1, 620 / zoom)}
            />
            <div className="w95-label" style={{ color: "#404040" }}>
{markMode === "first"
                ? "Clic = poner el 1 (se pega al golpe) · arrastra el rojo para afinar · franja inferior = mover el cursor amarillo · Alt = sin imán · Rueda = zoom · Mayús+arrastrar = desplazar"
                : "Clic = añadir marca de pulso · clic en una marca naranja = quitarla · arrástrala para moverla · franja inferior = cursor · Alt = sin imán · Rueda = zoom"}
            </div>
          </div>
        </Win95Window>

        {/* ---- Ajustes ---- */}
        <Win95Window
          id="ajustes"
          title="Ajustes"
          draggable
          defaultPos={{ x: 8, y: 410 }}
          width={350}
          zIndex={focus === "ajustes" ? 60 : 10}
          onFocus={() => setFocus("ajustes")}
        >
          <div className="flex flex-col gap-3">
            <div>
              <div className="w95-group-title">Tempo</div>
              <W95Button
                onClick={toggleEstefa}
                disabled={!file}
                title="Sincroniza audio sin BPM fijo"
                style={{
                  width: "100%",
                  marginBottom: 6,
                  fontWeight: "bold",
                  ...(tempoMode === "estefa" ? { background: "#000080", color: "#ffffff" } : {}),
                }}
              >
                {tempoMode === "estefa"
                  ? "★ Estefa ACTIVA — clic para desactivar"
                  : "★ Estefa: sincronizar sin BPM (automático)"}
              </W95Button>
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
                  onChange={(v) => {
                    setBpmManual(true);
                    setOriginalBPM(v);
                  }}
                  min={30}
                  max={300}
                  disabled={tempoMode !== "const"}
                />
                <W95Button
                  onClick={() => bumpTempo(0.5)}
                  disabled={!file || tempoMode === "estefa" || tempoMode === "manual"}
                  title="La lectura es el doble de rápida de lo que sientes: dividir entre 2"
                  style={{ minWidth: 0, padding: "3px 7px" }}
                >
                  ÷2
                </W95Button>
                <W95Button
                  onClick={() => bumpTempo(2)}
                  disabled={!file || tempoMode === "estefa" || tempoMode === "manual"}
                  title="La lectura es la mitad de rápida de lo que sientes: multiplicar por 2"
                  style={{ minWidth: 0, padding: "3px 7px" }}
                >
                  ×2
                </W95Button>
                <W95Button onClick={onDetectBpm} disabled={!file || analyzing}>
                  Detectar BPM
                </W95Button>
                <W95Button onClick={onTap} disabled={!file}>
                  Tap ({tapCount})
                </W95Button>
              </div>
              {track && autoOctave && beatMult !== 1 && tempoMode !== "estefa" && (
                <div className="w95-label" style={{ color: "#404040" }}>
                  {`Lectura ${track.bpm.toFixed(1)} BPM → se usa ${beatMult === 2 ? "×2" : "÷2"} (la octava más cercana al proyecto).`}
                </div>
              )}
              <div className="flex items-center gap-2 mt-1">
                <span className="w95-label" style={{ width: 105, flex: "0 0 auto" }}>
                  Modo de tempo:
                </span>
                <W95Select
                  value={tempoMode}
                  onChange={(v) => {
                    setTempoMode(v as "const" | "var" | "estefa" | "manual");
                    setEstefaPick(0);
                  }}
                  disabled={!track && marks.length < 2}
                  options={[
                    { value: "const", label: "Constante (un solo BPM)" },
                    { value: "var", label: "Seguir los pulsos (variable)" },
                    { value: "estefa", label: "Estefa (automático, sin BPM)" },
                    { value: "manual", label: "Manual (mis marcas = pulsos)" },
                  ]}
                />
              </div>
              {tempoMode === "estefa" && estefaRes && (
                <div className="flex flex-col gap-1 mt-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="w95-label" style={{ width: 105, flex: "0 0 auto" }}>
                      Interpretación:
                    </span>
                    <W95Select
                      value={String(Math.min(estefaPick, estefaRes.candidates.length - 1))}
                      onChange={(v) => setEstefaPick(parseInt(v, 10))}
                      options={estefaRes.candidates.map((c, i) => ({
                        value: String(i),
                        label: (i === 0 ? "★ " : "") + c.label,
                      }))}
                    />
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="w95-label" style={{ width: 105, flex: "0 0 auto" }}>
                      Cuantizado:
                    </span>
                    <W95Select
                      value={String(estefaStrength)}
                      onChange={(v) => setEstefaStrength(parseFloat(v))}
                      options={[
                        { value: "0", label: "0 % (solo estirar)" },
                        { value: "0.5", label: "50 %" },
                        { value: "0.75", label: "75 %" },
                        { value: "1", label: "100 % (a la rejilla)" },
                      ]}
                    />
                  </div>
                  <div className="w95-label" style={{ color: "#404040" }}>
                    {`Estefa lee ${estefaRes.naturalBpm.toFixed(1)} BPM naturales y los lleva a ${projectBPM} (×${estefaRes.best.factor.toFixed(3)}). Rejilla de ${
                      { 1: "negras", 2: "corcheas", 3: "tresillos", 4: "semicorcheas", 6: "tresillos de semicorchea" }[estefaRes.best.subdiv] ?? "—"
                    }; ${estefaRes.snapped} de ${estefaRes.total} sonidos cuantizados. Confianza ${Math.round(estefaRes.confidence * 100)} %.`}
                  </div>
                  {estefaRes.confidence < 0.35 && (
                    <div className="w95-warn">
                      Poca confianza: el audio no tiene un pulso claro. Revisa la interpretación o baja el cuantizado.
                    </div>
                  )}
                </div>
              )}
              {tempoMode === "estefa" && !estefaRes && track && (
                <div className="w95-warn mt-1">Estefa no encontró sonidos suficientes para decidir.</div>
              )}
              {analyzing && <div className="w95-label" style={{ color: "#404040" }}>Leyendo los pulsos de la canción…</div>}
              {track && tempoMode !== "estefa" && (
                <div className="w95-label" style={{ color: "#404040", marginTop: 2 }}>
                  {tempoMode === "var"
                    ? `Cada tramo entre pulsos se estira para caer en la rejilla (${track.beats.length} pulsos).`
                    : track.constantOk
                      ? `Tempo estable: desvío ${track.rmsMs.toFixed(1)} ms.`
                      : `Aviso: el tempo se mueve hasta ${track.driftMs.toFixed(0)} ms; usa "Seguir los pulsos".`}
                </div>
              )}
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
              <div className="flex items-center gap-2" style={{ margin: "2px 0" }}>
                <span className="w95-label">Algoritmo:</span>
                <W95Select
                  value={method}
                  onChange={(v) => setMethod(v as StretchMethod)}
                  options={[
                    { value: "wsola", label: "Rítmico (conserva la onda)" },
                    { value: "pvoc", label: "Tonal (vocoder de fase)" },
                    { value: "resample", label: "Remuestreo (cambia el tono)" },
                  ]}
                />
              </div>
              <div className="w95-label" style={{ color: "#404040", marginBottom: 2 }}>
                {method === "wsola" &&
                  "Copia fragmentos reales de la onda y ancla los golpes: ideal para percusión y loops."}
                {method === "pvoc" &&
                  "Reconstruye el audio con fases: mejor para pads, cuerdas y voces sostenidas."}
                {method === "resample" &&
                  "No deforma la onda en absoluto, pero sube/baja el tono como un vinilo."}
              </div>

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
              <W95Checkbox
                checked={embedTempo}
                onChange={setEmbedTempo}
                label="Incrustar tempo en el WAV (chunk ACID)"
              />
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
          id="repro"
          title="Reproducción"
          draggable
          defaultPos={{ x: 374, y: 664 }}
          width={400}
          zIndex={focus === "repro" ? 60 : 10}
          onFocus={() => setFocus("repro")}
        >
          <div className="flex flex-col gap-2">
            {/* indicador grande: qué se está escuchando */}
            <div
              className="w95-sunken"
              style={{
                padding: "7px 8px",
                fontWeight: "bold",
                fontSize: 14,
                textAlign: "center",
                color: playing ? "#000000" : "#404040",
                background: playing === "orig" ? "#ffa733" : playing === "adj" ? "#33dd55" : "#d8d8d8",
              }}
            >
              {playing === "orig"
                ? "● SONANDO: ORIGINAL (sin ajustar)"
                : playing === "adj"
                  ? "● SONANDO: SINCRONIZADA (al tempo del proyecto)"
                  : "■ Detenido"}
            </div>
            <div className="flex gap-2">
              <W95Button
                onClick={() => playSource("orig")}
                disabled={!file}
                title="Teclas: 1 u O"
                style={{
                  flex: 1,
                  fontWeight: "bold",
                  minHeight: 34,
                  ...(playing === "orig" ? { background: "#ffa733" } : {}),
                }}
              >
                ▶ ORIGINAL
              </W95Button>
              <W95Button
                onClick={() => playSource("adj")}
                disabled={!file}
                title="Teclas: 2 o S"
                style={{
                  flex: 1,
                  fontWeight: "bold",
                  minHeight: 34,
                  ...(playing === "adj" ? { background: "#33dd55" } : {}),
                }}
              >
                ▶ SINCRONIZADA
              </W95Button>
              <W95Button onClick={stopPlayback} disabled={!file || !playing} style={{ minHeight: 34 }}>
                ■
              </W95Button>
            </div>
            <div className="w95-label" style={{ color: "#404040" }}>
              Parado, arranca siempre desde el 1 (rojo). Mientras suena, pulsa el otro botón para cambiar en la
              misma posición (A/B). Teclas: Espacio = reproducir/parar · 1 = original · 2 = sincronizada.
            </div>
            <div className="flex gap-2 flex-wrap">
              <W95Button onClick={() => playSource(sourceMode, "cursor")} disabled={!file} title="Desde el cursor amarillo">
                ▶ Desde el cursor (amarillo)
              </W95Button>
            </div>
            <W95Checkbox
              checked={metronomeOn}
              onChange={setMetronomeOn}
              label="Metrónomo al tempo del proyecto (clic en cada pulso)"
            />
            <div className="w95-label" style={{ color: "#404040" }}>
              Con el metrónomo, el ORIGINAL se va descolocando de los clics; la SINCRONIZADA queda fija en ellos.
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
            <div className="flex items-center gap-2">
              <span className="w95-label">Posición:</span>
              <W95Field>
                compás {cursorBar} · {formatTime(cursorSec)}
              </W95Field>
            </div>
            <div className="w95-label" style={{ color: "#404040" }}>
              Volumen igual al original (sin normalizar, sin comprimir).
            </div>
          </div>
        </Win95Window>

        {/* ---- Exportar ---- */}
        <Win95Window
          id="export"
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
              <div className="w95-label">· Lee los pulsos de toda la canción; si el tempo se mueve, alinea cada pulso a la rejilla</div>
              <div className="w95-label">· Comparador A/B: ORIGINAL / SINCRONIZADA con indicador y cambio en caliente (teclas 1 y 2)</div>
              <div className="w95-label">· El tempo se lee con el cuerpo de la música (no los charleys) y se elige la octava más cercana al proyecto</div>
              <div className="w95-label">· Un clic pone el 1 (rojo, se pega al golpe y se oye al instante); el cursor amarillo se mueve en la franja inferior; modo "Marcar pulsos" para marcas manuales</div>
              <div className="w95-label">· Estefa: sin BPM de origen, decide el tempo natural y cuantiza elásticamente cada sonido</div>
              <div className="w95-label">· Estirado en un Web Worker: tres algoritmos, golpes anclados al compás</div>
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
              ? `Proyecto: ${Math.round(projectBPM)} BPM · Original: ${originalBPM.toFixed(2)} BPM · ${beatsPerBar}/${beatsPerBar === 6 ? 8 : 4}`
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
