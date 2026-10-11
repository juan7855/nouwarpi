// Forma de onda estilo osciloscopio: fondo negro, trazo verde fosforescente,
// grilla de beats/compases, marcador de primer golpe en rojo y cursor en amarillo.

import React, { useEffect, useRef, useCallback, useState } from "react";

export interface Peaks {
  min: Float32Array;
  max: Float32Array;
  bucket: number; // muestras por cubo
  samples: number; // total de muestras
  sampleRate: number;
}

interface Props {
  peaks: Peaks | null;
  originSec: number; // posición del marcador en el dominio de esta vista
  beatLenSec: number;
  beatsPerBar: number;
  totalBars: number; // compases totales (para limitar desplazamiento)
  beatTimes?: number[]; // pulsos reales (s) en el dominio de esta vista; sustituyen a la rejilla uniforme
  beatZero?: number; // índice en beatTimes del pulso 1 del compás de referencia
  marks?: number[]; // marcas puestas por el usuario (s, en el dominio de esta vista); la primera es el "1"
  snapTimes?: number[]; // ataques detectados (s, ordenados): las marcas se pegan a ellos
  ticks?: number[]; // pulsos que el algoritmo detectó (s, dominio de esta vista): marcas cian en el borde superior
  ticksGood?: boolean[]; // true = sobre un ataque real; false = extrapolado
  peaksOffset?: number; // segundos que la onda está desplazada en esta vista (relleno de silencio inicial)
  editable?: boolean; // true: clic = poner/quitar marcas. false: clic = mover el cursor
  onAddMark?: (t: number) => void;
  onRemoveMark?: (t: number) => void;
  onMoveMark?: (from: number, to: number) => void;
  markerSec: number;
  onMarkerChange?: (t: number) => void;
  cursorSec: number;
  onCursorChange?: (t: number) => void;
  zoom: number; // píxeles por compás
  onZoomChange?: (z: number) => void;
  scrollBar: number; // compás en el borde izquierdo (puede ser negativo)
  onScrollChange?: (b: number) => void;
  height?: number;
}

export const ZOOM_MIN = 2; // px por pulso (vista de toda la canción)
export const ZOOM_MAX = 20000; // px por pulso (precisión de muestra)

const MARK = "#ff8000";
const GREEN = "#00ff00";
const GREEN_DIM = "#005a00";
const GRID_BEAT = "#242424";
const GRID_BAR = "#4a4a4a";
const GRID_BAR_BACK = "#1c1c1c";
const RED = "#ff0000";
const YELLOW = "#ffff00";

export function Waveform(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const drag = useRef<
    | { mode: "mark"; cur: number; moved: boolean; startX: number }
    | { mode: "auto"; startX: number }
    | { mode: "cursor" | "pan"; startX: number; startVal: number }
    | null
  >(null);
  const [tick, setTick] = useState(0);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const {
    peaks,
    originSec,
    beatLenSec,
    beatsPerBar,
    totalBars,
    markerSec,
    cursorSec,
    zoom,
    scrollBar,
    height = 170,
  } = props;

  const xToTime = useCallback(
    (x: number) => {
      const secPerPx = beatLenSec / zoom;
      return originSec + (scrollBar - 1) * beatLenSec + x * secPerPx;
    },
    [originSec, beatLenSec, zoom, scrollBar]
  );
  const timeToX = useCallback(
    (t: number) => {
      return (1 - scrollBar + (t - originSec) / beatLenSec) * zoom;
    },
    [originSec, beatLenSec, zoom, scrollBar]
  );

  // dibujo
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const cssW = wrap.clientWidth;
    if (cssW <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = cssW + "px";
    canvas.style.height = height + "px";
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const W = cssW;
    const H = height;
    const mid = H / 2;

    // fondo negro
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, W, H);

    const secPerPx = beatLenSec / zoom;

    // grilla
    const tLeft = xToTime(0);
    const tRight = xToTime(W);
    const firstBeat = Math.floor((tLeft - originSec) / beatLenSec) - 1;
    ctx.font = "10px 'Courier New', monospace";
    ctx.textAlign = "left";
    const bt = props.beatTimes;
    const bz = props.beatZero ?? 0;
    for (let n = bt ? 0 : firstBeat; ; n++) {
      if (bt && n >= bt.length) break;
      const b = bt ? n - bz : n;
      const t = bt ? bt[n] : originSec + b * beatLenSec;
      if (t > tRight) break;
      if (bt && t < tLeft - 0.05) continue;
      const x = timeToX(t);
      const isBar = b % beatsPerBar === 0;
      const back = b < 0;
      ctx.strokeStyle = isBar ? (back ? GRID_BAR_BACK : GRID_BAR) : GRID_BEAT;
      ctx.lineWidth = isBar ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, H);
      ctx.stroke();
      if (isBar) {
        const barNum = Math.floor(b / beatsPerBar) + 1;
        ctx.fillStyle = back ? "#3a6a3a" : GREEN;
        ctx.fillText(String(barNum), x + 3, 11);
      }
    }

    // forma de onda (min/max por columna de píxeles)
    if (peaks) {
      const { min, max, bucket, sampleRate } = peaks;
      const nBuckets = min.length;
      const sr = sampleRate;
      for (let x = 0; x < W; x++) {
        const t0 = xToTime(x) - (props.peaksOffset ?? 0);
        const t1 = t0 + secPerPx;
        let b0 = Math.floor(t0 * sr) / bucket;
        let b1 = Math.ceil(t1 * sr) / bucket;
        if (b1 < 0 || b0 > nBuckets) continue;
        b0 = Math.max(0, Math.floor(b0));
        b1 = Math.min(nBuckets, Math.ceil(b1));
        if (b1 <= b0) b1 = b0 + 1;
        let mn = 1;
        let mx = -1;
        for (let i = b0; i < b1; i++) {
          const v0 = min[i];
          const v1 = max[i];
          if (v0 < mn) mn = v0;
          if (v1 > mx) mx = v1;
        }
        if (mx < mn) continue;
        const yTop = mid - mx * (mid - 2);
        const yBot = mid - mn * (mid - 2);
        const afterMarker = t0 + (props.peaksOffset ?? 0) + secPerPx / 2 >= markerSec - 1e-9;
        ctx.strokeStyle = afterMarker ? GREEN : GREEN_DIM;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, yTop);
        ctx.lineTo(x + 0.5, Math.max(yBot, yTop + 1));
        ctx.stroke();
      }
    } else {
      ctx.strokeStyle = GREEN_DIM;
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(W, mid);
      ctx.stroke();
    }

    // marcador de primer golpe (rojo)
    const mx = timeToX(markerSec);
    if (mx >= -2 && mx <= W + 2) {
      ctx.strokeStyle = RED;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(mx, 0);
      ctx.lineTo(mx, H);
      ctx.stroke();
      // manija
      ctx.fillStyle = RED;
      ctx.fillRect(mx - 6, 1, 12, 9);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1;
      ctx.strokeRect(mx - 6.5, 0.5, 13, 10);
      ctx.fillStyle = RED;
      ctx.font = "bold 11px 'Courier New', monospace";
      ctx.fillText("1", mx + 4, 24);
    }

    // pulsos detectados por el algoritmo (cian = sobre un ataque real; gris = extrapolado)
    if (props.ticks) {
      const tk = props.ticks;
      for (let i = 0; i < tk.length; i++) {
        const t = tk[i];
        if (t > tRight + 0.05) break;
        if (t < tLeft - 0.05) continue;
        const x = timeToX(t);
        ctx.fillStyle = props.ticksGood?.[i] === false ? "#4a5a5a" : "#00e5ff";
        ctx.fillRect(x - 1, H - 7, 3, 7);
      }
    }

    // marcas del usuario (la primera es el "1" rojo, ya dibujado)
    const userMarks = props.marks ?? [];
    userMarks.forEach((m, i) => {
      if (i === 0) return;
      const x = timeToX(m);
      if (x < -8 || x > W + 8) return;
      ctx.strokeStyle = MARK;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
      ctx.fillStyle = MARK;
      ctx.fillRect(x - 5, 1, 10, 9);
      ctx.fillStyle = "#ffb060";
      ctx.font = "bold 10px 'Courier New', monospace";
      ctx.fillText(String(i + 1), x + 4, 22);
    });

    // vista previa: dónde caería la marca si haces clic (imán a los ataques)
    if (hoverT !== null && props.editable !== false) {
      const hx = timeToX(hoverT);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hx + 0.5, 0);
      ctx.lineTo(hx + 0.5, H);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // cursor de reproducción (amarillo)
    const cx = timeToX(cursorSec);
    if (cx >= -2 && cx <= W + 2) {
      ctx.strokeStyle = YELLOW;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx + 0.5, 0);
      ctx.lineTo(cx + 0.5, H);
      ctx.stroke();
      ctx.fillStyle = YELLOW;
      ctx.fillRect(cx - 5, H - 10, 10, 9);
      ctx.strokeStyle = "#000000";
      ctx.strokeRect(cx - 5.5, H - 10.5, 11, 10);
    }
  }, [
    peaks, originSec, beatLenSec, beatsPerBar, markerSec, cursorSec,
    zoom, scrollBar, height, xToTime, timeToX, tick, hoverT, props.marks, props.beatTimes, props.beatZero, props.peaksOffset, props.ticks, props.ticksGood,
  ]);

  // redibujar al redimensionar
  useEffect(() => {
    const onResize = () => setTick((t) => t + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // rueda del ratón → zoom proporcional alrededor del puntero (Mayús + rueda = desplazar)
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      const rect = wrap.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      if (e.shiftKey) {
        props.onScrollChange?.(Math.max(-60, Math.min(totalBars * beatsPerBar + 60, scrollBar + dy / zoom)));
        return;
      }
      const tAnchor = xToTime(mx);
      const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * Math.exp(-dy * 0.0022)));
      if (newZoom === zoom) return;
      props.onZoomChange?.(newZoom);
      const newScroll = 1 + (tAnchor - originSec) / beatLenSec - mx / newZoom;
      props.onScrollChange?.(Math.max(-60, Math.min(totalBars * beatsPerBar + 60, newScroll)));
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, [xToTime, zoom, scrollBar, originSec, beatLenSec, beatsPerBar, totalBars, props]);

  // imán: el ataque detectado más cercano (dentro de `px` píxeles)
  const snap = (t: number, px: number, off: boolean) => {
    const st = props.snapTimes;
    if (off || !st || !st.length) return t;
    const radius = (px * beatLenSec) / zoom;
    let lo = 0;
    let hi = st.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (st[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    let best = t;
    let bd = radius;
    for (const i of [lo - 1, lo]) {
      if (i >= 0 && i < st.length && Math.abs(st[i] - t) <= bd) {
        bd = Math.abs(st[i] - t);
        best = st[i];
      }
    }
    return best;
  };

  const markAt = (x: number): number | null => {
    for (const m of props.marks ?? []) if (Math.abs(timeToX(m) - x) <= 7) return m;
    return null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    if (e.button === 2) return; // clic derecho: se gestiona en onContextMenu
    const rect = wrap.getBoundingClientRect();
    const x = e.clientX - rect.left;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    if (e.button === 1 || e.shiftKey) {
      drag.current = { mode: "pan", startX: x, startVal: scrollBar };
      return;
    }
    const editable = props.editable !== false;
    const cX = timeToX(cursorSec);
    if (editable) {
      const m = markAt(x);
      if (m !== null) {
        drag.current = { mode: "mark", cur: m, moved: false, startX: x };
        return;
      }
      if (!(props.marks && props.marks.length) && Math.abs(x - timeToX(markerSec)) <= 7) {
        drag.current = { mode: "auto", startX: x }; // el marcador automático: al moverlo pasa a ser una marca
        return;
      }
      if (Math.abs(x - cX) < 8) {
        drag.current = { mode: "cursor", startX: x, startVal: cursorSec };
        return;
      }
      // clic en vacío: poner una marca (pegada al ataque más cercano; Alt = sin imán)
      props.onAddMark?.(Math.max(0, snap(xToTime(x), 14, e.altKey)));
      return;
    }
    // vista ajustada: clic = colocar el cursor de reproducción
    props.onCursorChange?.(Math.max(0, xToTime(x)));
    drag.current = { mode: "cursor", startX: x, startVal: Math.max(0, xToTime(x)) };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const d = drag.current;
    if (!d) {
      if (props.editable !== false) setHoverT(markAt(x) === null ? Math.max(0, snap(xToTime(x), 14, e.altKey)) : null);
      return;
    }
    const secPerPx = beatLenSec / zoom;
    if (d.mode === "pan") {
      const dBeats = (x - d.startX) / zoom;
      props.onScrollChange?.(Math.max(-60, Math.min(totalBars * beatsPerBar + 60, d.startVal - dBeats)));
    } else if (d.mode === "mark") {
      if (!d.moved && Math.abs(x - d.startX) < 4) return;
      d.moved = true;
      const t = Math.max(0, snap(xToTime(x), 10, e.altKey));
      props.onMoveMark?.(d.cur, t);
      d.cur = t;
    } else if (d.mode === "auto") {
      if (Math.abs(x - d.startX) < 4) return;
      const t = Math.max(0, snap(xToTime(x), 10, e.altKey));
      props.onAddMark?.(t);
      drag.current = { mode: "mark", cur: t, moved: true, startX: x };
    } else {
      const t = Math.max(0, d.startVal + (x - d.startX) * secPerPx);
      props.onCursorChange?.(t);
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    // clic sobre una marca (sin arrastrar) = quitarla
    if (d && d.mode === "mark" && !d.moved) props.onRemoveMark?.(d.cur);
    drag.current = null;
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const wrap = wrapRef.current;
    if (!wrap || props.editable === false) return;
    const x = e.clientX - wrap.getBoundingClientRect().left;
    const m = markAt(x);
    if (m !== null) props.onRemoveMark?.(m);
  };

  return (
    <div
      ref={wrapRef}
      className="wave-wrap"
      style={{ height }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setHoverT(null)}
      onContextMenu={onContextMenu}
    >
      <canvas ref={canvasRef} />
    </div>
  );
}
