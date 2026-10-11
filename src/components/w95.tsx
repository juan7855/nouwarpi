// Primitivas de interfaz con estética Windows 95/98.
import React, { useRef, useState, useEffect } from "react";

/* ---------------- Ventana ---------------- */

export function Win95Window(props: {
  title: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
  onClose?: () => void;
  zIndex?: number;
  onFocus?: () => void;
  draggable?: boolean;
  defaultPos?: { x: number; y: number };
  width?: number | string;
  id?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(props.defaultPos ?? { x: 24, y: 24 });
  const [widthOv, setWidthOv] = useState<number | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  const isMobile = () => typeof window !== "undefined" && window.innerWidth < 820;

  // Mantiene la ventana dentro del escritorio (nunca fuera por la izquierda,
  // derecha ni por encima) y avisa al contenedor para que crezca.
  const clampPos = (x: number, y: number) => {
    const el = ref.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent) return { x, y };
    const maxX = Math.max(0, parent.clientWidth - el.offsetWidth);
    return { x: Math.max(0, Math.min(maxX, x)), y: Math.max(0, y) };
  };

  useEffect(() => {
    const onResize = () => setPos((p) => clampPos(p.x, p.y));
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    window.dispatchEvent(new Event("w95-layout"));
  });

  // "Ordenar": la app coloca cada ventana en su sitio (evento w95-arrange con {id: {x, y, width}})
  useEffect(() => {
    if (!props.id) return;
    const id = props.id;
    const onArrange = (e: Event) => {
      const d = (e as CustomEvent).detail?.[id];
      if (!d) return;
      setPos({ x: d.x, y: d.y });
      setWidthOv(d.width ?? null);
      setMaximized(false);
      setMinimized(false);
    };
    window.addEventListener("w95-arrange", onArrange);
    return () => window.removeEventListener("w95-arrange", onArrange);
  }, [props.id]);

  const onPointerDown = (e: React.PointerEvent) => {
    props.onFocus?.();
    if (!props.draggable || maximized || isMobile()) return;
    if ((e.target as HTMLElement).closest("button")) return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    window.dispatchEvent(new Event("w95-userdrag")); // el usuario coloca a mano: la app deja de reordenar sola
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    if (e.buttons === 0) {
      drag.current = null; // se soltó el botón sin que llegara el evento: no seguir arrastrando
      return;
    }
    const el = ref.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent) return;
    const pr = parent.getBoundingClientRect();
    // el puntero no puede salir de la zona visible (sobre la barra de estado)
    const cy = Math.max(0, Math.min(window.innerHeight - 60, e.clientY));
    const x = e.clientX - pr.left - drag.current.dx;
    const y = cy - pr.top - drag.current.dy;
    setPos(clampPos(x, y));
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const mobile = isMobile();
  const floating = !mobile;

  return (
    <div
      ref={ref}
      className="w95-window"
      data-win={props.id}
      style={{
        ...(!floating
          ? { position: "static", width: "100%", marginBottom: 14 }
          : maximized
            ? { position: "absolute", left: 0, top: 0, width: "100%", zIndex: 80 }
            : {
                position: "absolute",
                left: pos.x,
                top: pos.y,
                width: widthOv ?? props.width ?? 420,
                maxWidth: "100%",
                zIndex: props.zIndex ?? 1,
              }),
        ...props.style,
      }}
      onPointerDown={props.onFocus}
    >
      <div
        className="w95-titlebar"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => floating && setMaximized((m) => !m)}
      >
        <span className="w95-titlebar-text">{props.title}</span>
        <span className="w95-titlebar-btns">
          <button
            className="w95-tb-btn"
            tabIndex={-1}
            aria-label="Minimizar"
            onClick={() => setMinimized((m) => !m)}
          >
            _
          </button>
          <button
            className="w95-tb-btn"
            tabIndex={-1}
            aria-label="Maximizar"
            onClick={() => {
              setMaximized((m) => !m);
              setMinimized(false);
            }}
          >
            {maximized ? "❐" : "□"}
          </button>
          {props.onClose && (
            <button className="w95-tb-btn" tabIndex={-1} onClick={props.onClose} aria-label="Cerrar">✕</button>
          )}
        </span>
      </div>
      {!minimized && <div className="w95-window-body">{props.children}</div>}
    </div>
  );
}

/* ---------------- Botón ---------------- */

export function W95Button(props: {
  children: React.ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  disabled?: boolean;
  className?: string;
  title?: string;
  style?: React.CSSProperties;
}) {
  return (
    <button
      className={"w95-btn" + (props.className ? " " + props.className : "")}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
      style={props.style}
    >
      {props.children}
    </button>
  );
}

/* ---------------- Campo numérico ---------------- */

export function W95NumField(props: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  style?: React.CSSProperties;
}) {
  const [text, setText] = useState(String(props.value));
  useEffect(() => setText(String(props.value)), [props.value]);
  const commit = () => {
    let v = parseFloat(text);
    if (isNaN(v)) {
      setText(String(props.value));
      return;
    }
    if (props.min !== undefined) v = Math.max(props.min, v);
    if (props.max !== undefined) v = Math.min(props.max, v);
    props.onChange(v);
    setText(String(v));
  };
  return (
    <input
      className="w95-field w95-num"
      value={text}
      disabled={props.disabled}
      style={props.style}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "ArrowUp") {
          e.preventDefault();
          const s = props.step ?? 1;
          props.onChange(Math.min(props.max ?? 1e9, props.value + s));
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          const s = props.step ?? 1;
          props.onChange(Math.max(props.min ?? -1e9, props.value - s));
        }
      }}
    />
  );
}

/* ---------------- Casilla ---------------- */

export function W95Checkbox(props: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className={"w95-check" + (props.disabled ? " w95-disabled" : "")}>
      <span className={"w95-box" + (props.checked ? " w95-box-on" : "")}>
        {props.checked && <span className="w95-checkmark">✓</span>}
      </span>
      <span>{props.label}</span>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
        style={{ position: "absolute", opacity: 0, width: 0, height: 0 }}
      />
    </label>
  );
}

/* ---------------- Selector ---------------- */

export function W95Select(props: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <span className="w95-select-wrap">
      <select
        className="w95-field w95-select"
        value={props.value}
        disabled={props.disabled}
        style={props.style}
        onChange={(e) => props.onChange(e.target.value)}
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

/* ---------------- Barra de progreso de bloques ---------------- */

export function W95Progress(props: { frac: number; blocks?: number }) {
  const n = props.blocks ?? 14;
  const filled = Math.round(props.frac * n);
  return (
    <div className="w95-progress">
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className={"w95-progress-block" + (i < filled ? " w95-progress-on" : "")} />
      ))}
    </div>
  );
}

/* ---------------- Radio ---------------- */

export function W95Radio(props: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className={"w95-check" + (props.disabled ? " w95-disabled" : "")}>
      <span className={"w95-radio" + (props.checked ? " w95-radio-on" : "")}>
        {props.checked && <span className="w95-radio-dot" />}
      </span>
      <span>{props.label}</span>
      <input
        type="radio"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
        style={{ position: "absolute", opacity: 0, width: 0, height: 0 }}
      />
    </label>
  );
}

/* ---------------- Barra de desplazamiento horizontal ---------------- */

export function HScrollbar(props: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  page?: number;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ kind: "thumb" | "track"; startX: number; startVal: number } | null>(null);
  const range = Math.max(1e-6, props.max - props.min);
  const page = Math.min(range, Math.max(1e-4, props.page ?? range * 0.25));
  // el borde izquierdo no puede pasar de aquí: la barra NUNCA se va más allá del contenido
  const top = Math.max(props.min, props.max - page);
  const clampV = (v: number) => Math.max(props.min, Math.min(top, v));
  const thumbW = Math.max(6, Math.min(100, (page / range) * 100));
  const frac = Math.max(0, Math.min(1, (props.value - props.min) / Math.max(1e-6, top - props.min)));
  const thumbLeft = frac * (100 - thumbW);

  const end = () => {
    drag.current = null;
  };
  const valFromX = (clientX: number) => {
    const track = trackRef.current;
    if (!track) return props.value;
    const r = track.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
    return clampV(props.min + f * (top - props.min));
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (e.buttons === 0) {
      end(); // soltaste el botón fuera de la barra: dejar de seguir al ratón
      return;
    }
    const track = trackRef.current;
    if (!track) return;
    if (d.kind === "track") {
      props.onChange(valFromX(e.clientX));
    } else {
      const r = track.getBoundingClientRect();
      const usable = Math.max(1, r.width * (1 - thumbW / 100));
      props.onChange(clampV(d.startVal + ((e.clientX - d.startX) / usable) * (top - props.min)));
    }
  };

  return (
    <div className="w95-hscroll">
      <button
        className="w95-scroll-btn"
        onClick={() => props.onChange(clampV(props.value - page * 0.25))}
        tabIndex={-1}
      >
        ◀
      </button>
      <div
        ref={trackRef}
        className="w95-scroll-track"
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          const v = valFromX(e.clientX);
          props.onChange(v);
          drag.current = { kind: "track", startX: e.clientX, startVal: v };
        }}
        onPointerMove={onMove}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
      >
        <div
          className="w95-scroll-thumb"
          style={{ left: `${thumbLeft}%`, width: `${thumbW}%` }}
          onPointerDown={(e) => {
            e.stopPropagation();
            (e.currentTarget.parentElement as HTMLElement).setPointerCapture(e.pointerId);
            drag.current = { kind: "thumb", startX: e.clientX, startVal: clampV(props.value) };
          }}
        />
      </div>
      <button
        className="w95-scroll-btn"
        onClick={() => props.onChange(clampV(props.value + page * 0.25))}
        tabIndex={-1}
      >
        ▶
      </button>
    </div>
  );
}

/* ---------------- Panel de texto hundido ---------------- */

export function W95Field(props: { children: React.ReactNode; style?: React.CSSProperties; className?: string }) {
  return (
    <span className={"w95-sunken w95-field-text" + (props.className ? " " + props.className : "")} style={props.style}>
      {props.children}
    </span>
  );
}
