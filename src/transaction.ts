/**
 * `x-client-transaction-id` generator.
 *
 * x.com signs API requests with a header derived from (a) the `twitter-site-verification`
 * key in the home page HTML, (b) one of the four hidden `loading-x-anim-N` SVGs, and (c) a
 * few byte indices hard-coded in the generator chunk. This is a port of the algorithm used
 * by the open-source XClientTransaction project.
 */
import { createHash } from "node:crypto";

export const DEFAULT_KEYWORD = "obfiowerehiring";
const ADDITIONAL_RANDOM_NUMBER = 3;
const EPOCH_OFFSET_SEC = 1682924400;

export interface TransactionParams {
  /** `twitter-site-verification` content (base64). */
  key: string;
  /** The `d` attribute of the second <path> in each loading-x-anim-N svg, by N. */
  frames: string[];
  rowIndex: number;
  keyBytesIndices: number[];
}

export interface TransactionContext {
  keyBytes: number[];
  animationKey: string;
}

/** Extract byte indices like `(e[25],16)` from the generator chunk: first = row index, rest = key byte indices. */
export function parseIndices(js: string): { rowIndex: number; keyBytesIndices: number[] } | null {
  const found = [...js.matchAll(/\(\w\[(\d{1,2})\],\s*16\)/g)].map((m) => Number(m[1]));
  if (found.length < 3) return null;
  return { rowIndex: found[0]!, keyBytesIndices: found.slice(1) };
}

export function base64ToBytes(b64: string): number[] {
  return [...Buffer.from(b64, "base64")];
}

/** Python's round(): halves go to the nearest even integer. */
export function roundHalfEven(n: number): number {
  const f = Math.floor(n);
  const diff = n - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

function jsRound(n: number): number {
  return Math.floor(n + 0.5);
}

function solve(value: number, min: number, max: number, rounding: boolean): number {
  const r = (value * (max - min)) / 255 + min;
  return rounding ? Math.floor(r) : Math.round(r * 100) / 100;
}

export class Cubic {
  constructor(private readonly c: number[]) {}
  private static calc(a: number, b: number, m: number): number {
    return 3 * a * (1 - m) * (1 - m) * m + 3 * b * (1 - m) * m * m + m * m * m;
  }
  value(t: number): number {
    const c = this.c as [number, number, number, number];
    if (t <= 0) {
      let g = 0;
      if (c[0] > 0) g = c[1] / c[0];
      else if (c[1] === 0 && c[2] > 0) g = c[3] / c[2];
      return g * t;
    }
    if (t >= 1) {
      let g = 0;
      if (c[2] < 1) g = (c[3] - 1) / (c[2] - 1);
      else if (c[2] === 1 && c[0] < 1) g = (c[1] - 1) / (c[0] - 1);
      return 1 + g * (t - 1);
    }
    let start = 0;
    let end = 1;
    let mid = 0;
    // Bounded: with NaN or an unreachable target, mid stops moving while start < end stays true.
    for (let i = 0; i < 64 && start < end; i++) {
      mid = (start + end) / 2;
      const x = Cubic.calc(c[0], c[2], mid);
      if (Math.abs(t - x) < 0.00001) return Cubic.calc(c[1], c[3], mid);
      if (x < t) start = mid;
      else end = mid;
    }
    return Cubic.calc(c[1], c[3], mid);
  }
}

const interpolate = (from: number[], to: number[], f: number) => from.map((a, i) => a * (1 - f) + to[i]! * f);

export function floatToHex(input: number): string {
  if (!Number.isFinite(input)) throw new Error(`floatToHex: non-finite input ${input}`);
  let x = input;
  const result: string[] = [];
  let quotient = Math.trunc(x);
  let fraction = x - quotient;
  while (quotient > 0) {
    quotient = Math.trunc(x / 16);
    const remainder = Math.trunc(x - quotient * 16);
    result.unshift(remainder > 9 ? String.fromCharCode(remainder + 55) : String(remainder));
    x = quotient;
  }
  if (fraction === 0) return result.join("");
  result.push(".");
  while (fraction > 0) {
    fraction *= 16;
    const integer = Math.trunc(fraction);
    fraction -= integer;
    result.push(integer > 9 ? String.fromCharCode(integer + 55) : String(integer));
  }
  return result.join("");
}

function animate(row: number[], targetTime: number): string {
  const fromColor = [...row.slice(0, 3), 1];
  const toColor = [...row.slice(3, 6), 1];
  const toRotation = [solve(row[6]!, 60, 360, true)];
  const curves = row.slice(7).map((v, i) => solve(v, i % 2 ? -1 : 0, 1, false));
  const val = new Cubic(curves).value(targetTime);
  const color = interpolate(fromColor, toColor, val).map((v) => (v > 0 ? v : 0));
  const rotation = interpolate([0], toRotation, val)[0]!;
  const rad = (rotation * Math.PI) / 180;
  const matrix = [Math.cos(rad), -Math.sin(rad), Math.sin(rad), Math.cos(rad)];
  const parts = color.slice(0, -1).map((v) => roundHalfEven(v).toString(16));
  for (const v of matrix) {
    let r = Math.round(v * 100) / 100;
    if (r < 0) r = -r;
    const hex = floatToHex(r);
    parts.push(hex.startsWith(".") ? `0${hex}`.toLowerCase() : hex || "0");
  }
  parts.push("0", "0");
  return parts.join("").replace(/[.-]/g, "");
}

/** Parse the numbers out of an SVG path's `d` attribute into rows (one per `C` segment). */
export function frameRows(d: string): number[][] {
  return d
    .slice(9)
    .split("C")
    .map((seg) =>
      seg
        .replace(/[^\d]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number),
    );
}

export function buildContext(p: TransactionParams): TransactionContext {
  const keyBytes = base64ToBytes(p.key);
  const totalTime = 4096;
  const rowIndex = keyBytes[p.rowIndex]! % 16;
  let frameTime = p.keyBytesIndices.map((i) => keyBytes[i]! % 16).reduce((a, b) => a * b, 1);
  frameTime = jsRound(frameTime / 10) * 10;
  const frame = p.frames[keyBytes[5]! % 4];
  if (!frame) throw new Error("animation frame not found");
  const row = frameRows(frame)[rowIndex];
  if (!row) throw new Error("animation row not found");
  return { keyBytes, animationKey: animate(row, frameTime / totalTime) };
}

export function generateTransactionId(
  ctx: TransactionContext,
  method: string,
  path: string,
  opts: { keyword?: string; nowMs?: number; random?: number } = {},
): string {
  const timeNow = Math.floor(((opts.nowMs ?? Date.now()) - EPOCH_OFFSET_SEC * 1000) / 1000);
  const timeBytes = [0, 1, 2, 3].map((i) => (timeNow >> (i * 8)) & 0xff);
  const keyword = opts.keyword ?? process.env.X_CLI_TX_KEYWORD ?? DEFAULT_KEYWORD;
  const hash = [...createHash("sha256").update(`${method}!${path}!${timeNow}${keyword}${ctx.animationKey}`).digest()];
  const rnd = opts.random ?? Math.floor(Math.random() * 256);
  const bytes = [...ctx.keyBytes, ...timeBytes, ...hash.slice(0, 16), ADDITIONAL_RANDOM_NUMBER];
  const out = Buffer.from([rnd, ...bytes.map((b) => b ^ rnd)]);
  return out.toString("base64").replace(/=+$/, "");
}
