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
    | { mode: "marker" | "cursor" | "pan"; startX: number; startVal: number }
    | null
  >(null);
  const [tick, setTick] = useState(0);
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
    for (let b = firstBeat; ; b++) {
      const t = originSec + b * beatLenSec;
      if (t > tRight) break;
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
        const t0 = xToTime(x);
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
        const afterMarker = t0 + secPerPx / 2 >= markerSec - 1e-9;
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
    zoom, scrollBar, height, xToTime, timeToX, tick,
  ]);

  // redibujar al redimensionar
  useEffect(() => {
    const onResize = () => setTick((t) => t + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // rueda del ratón → zoom
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const tAnchor = xToTime(mx);
      const f = e.deltaY < 0 ? 1.25 : 0.8;
      const newZoom = Math.max(24, Math.min(2400, zoom * f));
      props.onZoomChange?.(newZoom);
      const newScroll =
        1 + (tAnchor - originSec) / beatLenSec - mx / newZoom;
      props.onScrollChange?.(Math.max(-60, Math.min(totalBars + 60, newScroll)));
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, [xToTime, zoom, originSec, beatLenSec, totalBars, props]);

  const onPointerDown = (e: React.PointerEvent) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const x = e.clientX - rect.left;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    if (e.button === 1 || e.shiftKey) {
      drag.current = { mode: "pan", startX: x, startVal: scrollBar };
      return;
    }
    const mX = timeToX(markerSec);
    const cX = timeToX(cursorSec);
    if (Math.abs(x - mX) < 10) {
      drag.current = { mode: "marker", startX: x, startVal: markerSec };
    } else if (Math.abs(x - cX) < 10) {
      drag.current = { mode: "cursor", startX: x, startVal: cursorSec };
    } else {
      // clic: colocar el marcador y arrastrar
      const t = Math.max(0, xToTime(x));
      props.onMarkerChange?.(t);
      drag.current = { mode: "marker", startX: x, startVal: t };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const secPerPx = beatLenSec / zoom;
    if (d.mode === "pan") {
      const dBars = (x - d.startX) / zoom;
      props.onScrollChange?.(
        Math.max(-60, Math.min(totalBars + 60, d.startVal - dBars))
      );
    } else if (d.mode === "marker") {
      const t = Math.max(0, d.startVal + (x - d.startX) * secPerPx);
      props.onMarkerChange?.(t);
    } else {
      const t = Math.max(0, d.startVal + (x - d.startX) * secPerPx);
      props.onCursorChange?.(t);
    }
  };

  const onPointerUp = () => {
    drag.current = null;
  };

  return (
    <div
      ref={wrapRef}
      className="wave-wrap"
      style={{ height }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <canvas ref={canvasRef} />
    </div>
  );
}
