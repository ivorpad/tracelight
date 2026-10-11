/**
 * Python's string and number behaviour the tour's rules count with, so lengths, offsets and the
 * budget estimate come out as Pyokka's: lengths and offsets in code points (Python's `len` and
 * slices), `" ".join(s.split())`, `round`, and the length of `json.dumps(..., ensure_ascii=False)`
 * with the floats the Python tour writes (`score`, `share`) as floats.
 */

const SURROGATE = /[\uD800-\uDFFF]/;

/** `len(s)` */
export function cpLen(s: string): number {
  if (!SURROGATE.test(s)) return s.length;
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** `s[a:b]` with non-negative bounds */
export function cpSlice(s: string, a: number, b?: number): string {
  if (!SURROGATE.test(s)) return s.slice(a, b);
  return Array.from(s).slice(a, b).join('');
}

/** the code-point offset of the UTF-16 offset `i` in `s` */
export function cpIndex(s: string, i: number): number {
  return SURROGATE.test(s) ? cpLen(s.slice(0, i)) : i;
}

/** `" ".join(str(s).split())` */
export function flat(s: unknown): string {
  return String(s ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

/** `s if len(s) <= limit else s[:limit - 1] + "…"` */
export function cut(text: string, limit: number): string {
  return cpLen(text) <= limit ? text : cpSlice(text, 0, limit - 1) + '…';
}

/** `round(x, n)` */
export function pyRound(x: number, n = 0): number {
  const f = 10 ** n;
  return Math.round(x * f) / f;
}

/** Python's `%s` of a JSON value: `None`, `True`, `False`, else the value */
export function pyStr(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  return String(v);
}

/** `format(n, ",")` */
export function commas(n: unknown): string {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return String(n);
  const [whole, frac] = String(Math.abs(v)).split('.');
  return (v < 0 ? '-' : '') + whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac !== undefined ? '.' + frac : '');
}

/** keys whose values the Python tour writes as floats (`4.0`, `1.0`) */
const FLOAT_KEYS = new Set(['score', 'share']);

function dumps(v: unknown, compact: boolean, key: string | null): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return key !== null && FLOAT_KEYS.has(key) && Number.isInteger(v) ? `${v}.0` : JSON.stringify(v);
  if (typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  const [item, colon] = compact ? [',', ':'] : [', ', ': '];
  if (Array.isArray(v)) return '[' + v.map((x) => dumps(x, compact, null)).join(item) + ']';
  return (
    '{' +
    Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => JSON.stringify(k) + colon + dumps(x, compact, k))
      .join(item) +
    '}'
  );
}

/** `len(json.dumps(v, ensure_ascii=False))`, or with `separators=(",", ":")` when `compact` */
export function jsonLength(v: unknown, compact: boolean): number {
  return cpLen(dumps(v, compact, null));
}
