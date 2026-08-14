"use client";

/**
 * The canvas that lives behind the whole dapp. It draws the 44px grid Roque's
 * stylesheet used to paint with linear-gradient, then animates two things on
 * top of it: live-wire traces that run along grid edges and branch like a
 * circuit board, and chess glyphs that glitch-transition between cells like
 * they are not quite sure which square they belong on. Both are purely
 * decorative. Neither intercepts a pointer event or a scroll.
 *
 * Colors come from CSS custom properties so the canvas follows the theme
 * toggle rather than hardcoding anything. A MutationObserver on <html>'s
 * data-theme attribute triggers a color refresh the instant the toggle fires.
 * prefers-reduced-motion skips all animation and leaves only the static grid.
 */

import { useEffect, useRef } from "react";

// The grid pitch in px, matching the body background-size the CSS used to
// paint. Canvas takes over that job; the CSS grid is removed.
const CELL = 44;

// Unicode chess piece codepoints, white and black sets. We render at low alpha
// so they read as glyphs, not emoji; explicit text rendering helps on some
// engines but we mostly rely on the alpha.
const GLYPHS = ["♔", "♕", "♖", "♗", "♘", "♙", "♚", "♛", "♜", "♝", "♞", "♟"];

// --- Types ----------------------------------------------------------------

interface Colors {
  grid: string;
  wire: string;
  piece: string;
}

// A wire segment is one straight horizontal or vertical run along a grid line.
// It grows from `pos` toward `end` over time, then picks a branch direction.
interface Wire {
  // Grid coordinates of the origin cell corner.
  ox: number;
  oy: number;
  // Current head position in px along the wire's axis.
  headPx: number;
  // Target end position in px along the wire's axis.
  endPx: number;
  // Whether this wire runs horizontally (true) or vertically (false).
  horiz: boolean;
  // +1 or -1; which direction along the axis the wire is growing.
  dir: 1 | -1;
  // How long the tail is (fades older segments).
  tailLen: number;
  // Speed in px per frame.
  speed: number;
  // Alpha; wires fade out as they age.
  alpha: number;
  // Age in frames; used for fade scheduling.
  age: number;
  // How many frames it lives before it is reaped.
  lifetime: number;
  // Accumulated branch budget: when this hits CELL the wire may fork.
  branchBudget: number;
}

// A chess glyph that glitches between two cells on a grid.
interface Piece {
  // Origin cell (grid integer coordinates).
  gx: number;
  gy: number;
  // Target cell to glitch toward.
  tx: number;
  ty: number;
  // The chess symbol.
  glyph: string;
  // 0 = at origin, 1 = at target.
  progress: number;
  // Phase: "stable" (sitting still), "glitching" (mid-transition).
  phase: "stable" | "glitching";
  // Frames remaining in the current phase.
  timer: number;
  // Alpha, for fade-in and fade-out.
  alpha: number;
  // Glitch offset in px; non-zero during the glitch phase.
  jitterX: number;
  jitterY: number;
  fontSize: number;
}

// --- Helpers ---------------------------------------------------------------

function readColors(el: HTMLElement): Colors {
  const style = getComputedStyle(el);
  // --bg-grid is the faint grid tint; wires use --accent (clearly different).
  const grid = style.getPropertyValue("--bg-grid").trim();
  const wire = style.getPropertyValue("--accent").trim();
  const textRaw = style.getPropertyValue("--text").trim();
  // Derive the piece colour as --text at very low alpha so it feels stencilled.
  const piece = textRaw ? toneAlpha(textRaw, 0.07) : "rgba(128,128,128,0.07)";
  return { grid: grid || "rgba(128,128,128,0.04)", wire, piece };
}

// Convert any CSS color to rgba at a given alpha. Works for hex and rgb/rgba.
function toneAlpha(color: string, alpha: number): string {
  const div = document.createElement("div");
  div.style.color = color;
  document.body.appendChild(div);
  const computed = getComputedStyle(div).color;
  document.body.removeChild(div);
  // computed is "rgb(r, g, b)" or "rgba(r, g, b, a)".
  const m = computed.match(/[\d.]+/g);
  if (!m || m.length < 3) return `rgba(128,128,128,${alpha})`;
  return `rgba(${m[0]},${m[1]},${m[2]},${alpha})`;
}

function rnd(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function pickDir(): 1 | -1 {
  return Math.random() < 0.5 ? 1 : -1;
}

// Snap a pixel coordinate to the nearest grid corner.
function snapX(px: number, cols: number): number {
  return Math.min(cols - 1, Math.max(0, Math.round(px / CELL))) * CELL;
}
function snapY(px: number, rows: number): number {
  return Math.min(rows - 1, Math.max(0, Math.round(px / CELL))) * CELL;
}

// --- Wire factory ----------------------------------------------------------

function spawnWire(w: number, h: number): Wire {
  const cols = Math.ceil(w / CELL) + 1;
  const rows = Math.ceil(h / CELL) + 1;
  const horiz = Math.random() < 0.5;
  const dir = pickDir();
  const ox = Math.floor(Math.random() * cols) * CELL;
  const oy = Math.floor(Math.random() * rows) * CELL;
  const segLen = CELL * Math.floor(rnd(2, 10));
  const endPx = horiz
    ? Math.max(0, Math.min(cols * CELL, ox + dir * segLen))
    : Math.max(0, Math.min(rows * CELL, oy + dir * segLen));
  return {
    ox, oy,
    headPx: horiz ? ox : oy,
    endPx,
    horiz, dir,
    tailLen: CELL * Math.floor(rnd(2, 5)),
    speed: rnd(1.2, 2.8),
    alpha: rnd(0.55, 0.9),
    age: 0,
    lifetime: Math.floor(rnd(80, 220)),
    branchBudget: 0,
  };
}

// --- Piece factory ---------------------------------------------------------

function spawnPiece(cols: number, rows: number): Piece {
  const gx = Math.floor(Math.random() * cols);
  const gy = Math.floor(Math.random() * rows);
  return {
    gx, gy,
    tx: gx, ty: gy,
    glyph: pick(GLYPHS),
    progress: 1,
    phase: "stable",
    timer: Math.floor(rnd(60, 300)),
    alpha: rnd(0.5, 0.9),
    jitterX: 0,
    jitterY: 0,
    fontSize: Math.floor(rnd(13, 22)),
  };
}

// --- Draw helpers ----------------------------------------------------------

function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number, color: string) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= w; x += CELL) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
  }
  for (let y = 0; y <= h; y += CELL) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
  }
  ctx.stroke();
  ctx.restore();
}

function drawWire(ctx: CanvasRenderingContext2D, wire: Wire, wireColor: string) {
  const { horiz, dir, ox, oy, headPx, tailLen, alpha, age, lifetime } = wire;
  // Fade in over first 20 frames, fade out over last 30.
  const fadeIn = Math.min(1, age / 20);
  const fadeOut = Math.min(1, (lifetime - age) / 30);
  const a = alpha * fadeIn * fadeOut;
  if (a <= 0) return;

  const tailPx = headPx - dir * tailLen;
  const x1 = horiz ? tailPx : ox;
  const y1 = horiz ? oy : tailPx;
  const x2 = horiz ? headPx : ox;
  const y2 = horiz ? oy : headPx;

  // Gradient along the wire: bright at head, fades to transparent at tail.
  const grad = horiz
    ? ctx.createLinearGradient(x1, oy, x2, oy)
    : ctx.createLinearGradient(ox, y1, ox, y2);
  grad.addColorStop(dir === 1 ? 0 : 1, `rgba(0,0,0,0)`);
  grad.addColorStop(dir === 1 ? 1 : 0, hexToRgba(wireColor, a));

  ctx.save();
  ctx.strokeStyle = grad;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x1 + 0.5, y1 + 0.5);
  ctx.lineTo(x2 + 0.5, y2 + 0.5);
  ctx.stroke();

  // A small bright dot at the head.
  ctx.fillStyle = hexToRgba(wireColor, a);
  ctx.beginPath();
  ctx.arc(x2 + 0.5, y2 + 0.5, 1.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawPiece(ctx: CanvasRenderingContext2D, p: Piece, pieceColor: string) {
  const { gx, gy, tx, ty, progress, alpha, jitterX, jitterY, glyph, fontSize } = p;
  // Lerp between current and target cell.
  const px = (gx + (tx - gx) * progress) * CELL + CELL / 2 + jitterX;
  const py = (gy + (ty - gy) * progress) * CELL + CELL / 2 + jitterY;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = pieceColor;
  ctx.font = `${fontSize}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Prevent emoji color fonts from overriding our fill.
  ctx.fillText(glyph, px, py);
  ctx.restore();
}

// Convert a hex color to rgba string, handling both #rgb and #rrggbb.
// Falls back gracefully if the input is already rgb/rgba.
function hexToRgba(color: string, alpha: number): string {
  if (!color.startsWith("#")) {
    // Assume it's already a parseable color; wrap in rgba if possible.
    const m = color.match(/[\d.]+/g);
    if (m && m.length >= 3) return `rgba(${m[0]},${m[1]},${m[2]},${alpha})`;
    return `rgba(128,128,128,${alpha})`;
  }
  let r: number, g: number, b: number;
  if (color.length === 4) {
    r = parseInt(color[1] + color[1], 16);
    g = parseInt(color[2] + color[2], 16);
    b = parseInt(color[3] + color[3], 16);
  } else {
    r = parseInt(color.slice(1, 3), 16);
    g = parseInt(color.slice(3, 5), 16);
    b = parseInt(color.slice(5, 7), 16);
  }
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Component ──────────────────────────────────────────────────────────────

export function ChessCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Hold mutable state in a ref so the rAF loop sees the latest without
  // triggering re-renders. We never set React state inside the loop.
  const stateRef = useRef<{
    ctx: CanvasRenderingContext2D;
    wires: Wire[];
    pieces: Piece[];
    colors: Colors;
    reduced: boolean;
    w: number;
    h: number;
    raf: number;
  } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const html = document.documentElement;

    // Initial size.
    let w = window.innerWidth;
    let h = window.innerHeight;
    canvas.width = w;
    canvas.height = h;

    const cols = () => Math.ceil(w / CELL) + 1;
    const rows = () => Math.ceil(h / CELL) + 1;

    // Seed initial state.
    const colors = readColors(html);
    const wires: Wire[] = reduced ? [] : Array.from({ length: 6 }, () => spawnWire(w, h));
    const pieces: Piece[] = Array.from({ length: 12 }, () => spawnPiece(cols(), rows()));

    stateRef.current = { ctx, wires, pieces, colors, reduced, w, h, raf: 0 };

    // Resize handler.
    const onResize = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w;
      canvas.height = h;
      if (stateRef.current) {
        stateRef.current.w = w;
        stateRef.current.h = h;
        stateRef.current.colors = readColors(html);
      }
    };
    window.addEventListener("resize", onResize, { passive: true });

    // Theme change observer.
    const obs = new MutationObserver(() => {
      if (stateRef.current) {
        stateRef.current.colors = readColors(html);
      }
    });
    obs.observe(html, { attributes: true, attributeFilter: ["data-theme"] });

    // --- rAF loop ----------------------------------------------------------
    function tick() {
      const s = stateRef.current;
      if (!s) return;

      s.ctx.clearRect(0, 0, s.w, s.h);

      // Grid.
      drawGrid(s.ctx, s.w, s.h, s.colors.grid);

      if (!s.reduced) {
        // --- Wires ---
        // Advance each wire.
        for (let i = s.wires.length - 1; i >= 0; i--) {
          const wire = s.wires[i];
          wire.age++;

          const distLeft = wire.dir * (wire.endPx - wire.headPx);
          if (distLeft > 0) {
            wire.headPx += wire.dir * wire.speed;
            wire.branchBudget += wire.speed;
            // Branch: when a full cell has been traversed, maybe fork.
            if (wire.branchBudget >= CELL && Math.random() < 0.18) {
              wire.branchBudget = 0;
              // Spawn a perpendicular child wire from the current head.
              const child = spawnWire(s.w, s.h);
              child.horiz = !wire.horiz;
              child.dir = pickDir();
              child.ox = wire.horiz
                ? snapX(wire.headPx, Math.ceil(s.w / CELL) + 1)
                : wire.ox;
              child.oy = wire.horiz
                ? wire.oy
                : snapY(wire.headPx, Math.ceil(s.h / CELL) + 1);
              child.headPx = child.horiz ? child.ox : child.oy;
              const segLen = CELL * Math.floor(rnd(2, 7));
              child.endPx = child.horiz
                ? Math.max(0, Math.min(s.w, child.ox + child.dir * segLen))
                : Math.max(0, Math.min(s.h, child.oy + child.dir * segLen));
              s.wires.push(child);
            } else if (wire.branchBudget >= CELL) {
              wire.branchBudget = 0;
            }
          }

          // Reap expired wires.
          if (wire.age >= wire.lifetime) {
            s.wires.splice(i, 1);
          } else {
            drawWire(s.ctx, wire, s.colors.wire);
          }
        }
        // Top up the wire pool to keep it lively without flooding.
        while (s.wires.length < 7) {
          s.wires.push(spawnWire(s.w, s.h));
        }
      }

      // --- Chess pieces ---
      const c = cols();
      const r = rows();
      for (const p of s.pieces) {
        p.timer--;

        if (p.phase === "stable") {
          if (p.timer <= 0) {
            // Begin a glitch transition.
            p.phase = "glitching";
            // Pick a target cell: 1–5 cells away in a random cardinal direction.
            const horiz = Math.random() < 0.5;
            const steps = Math.floor(rnd(1, 6));
            const dir = pickDir();
            if (horiz) {
              p.tx = Math.max(0, Math.min(c - 1, p.gx + dir * steps));
              p.ty = p.gy;
            } else {
              p.tx = p.gx;
              p.ty = Math.max(0, Math.min(r - 1, p.gy + dir * steps));
            }
            p.progress = 0;
            // Randomly swap the glyph during the glitch.
            if (Math.random() < 0.4) p.glyph = pick(GLYPHS);
            p.timer = Math.floor(rnd(20, 50));
          }
          p.jitterX = 0;
          p.jitterY = 0;
        } else {
          // Glitching: step progress, add pixel jitter, complete when done.
          p.progress = Math.min(1, p.progress + 1 / (p.timer + 1));
          // Heavy jitter early in the glitch, fades out.
          const jAmt = (1 - p.progress) * rnd(0, 5);
          p.jitterX = (Math.random() - 0.5) * 2 * jAmt;
          p.jitterY = (Math.random() - 0.5) * 2 * jAmt;
          if (p.timer <= 0 || p.progress >= 1) {
            p.gx = p.tx;
            p.gy = p.ty;
            p.progress = 1;
            p.jitterX = 0;
            p.jitterY = 0;
            p.phase = "stable";
            p.timer = Math.floor(rnd(90, 400));
          }
        }
        drawPiece(s.ctx, p, s.colors.piece);
      }

      s.raf = requestAnimationFrame(tick);
    }

    stateRef.current.raf = requestAnimationFrame(tick);

    return () => {
      if (stateRef.current) cancelAnimationFrame(stateRef.current.raf);
      stateRef.current = null;
      window.removeEventListener("resize", onResize);
      obs.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: -1,
      }}
    />
  );
}
