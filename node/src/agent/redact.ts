/**
 * Secret redaction for everything the agent verbs print.
 *
 * The rules are the contract in docs/PROTOCOL.md ("Redaction"); test/unit/fixtures/redact.json
 * pins them. Whole tokens of the common shapes (`sk-…`, `AKIA…`, `ghp_…`, `xox[abp]-…`, JWTs,
 * `Bearer <token>`) and the value of any key whose name mentions a credential become
 * `«redacted»`. null, numbers and short words are left alone.
 */

export const REDACTED = '«redacted»';

const KEY_WORDS = 'api_key|apikey|secret|token|password|passwd|authorization';
const MIN_VALUE_LEN = 6;

// key=value, key: value, 'key': 'value', key='value' (quotes stay, the value goes); an unquoted value
// ends at `&` so `?api_key=…&v=1` keeps its other query parameters. The lookbehind after the quote
// keeps it linear (src/util/redact.ts explains why).
const KV = new RegExp(
  `(?<key>(?<q>['"]?)(?<![A-Za-z0-9_.\\-])[A-Za-z0-9_.\\-]*(?:${KEY_WORDS})[A-Za-z0-9_\\-]*\\k<q>)(?<sep>\\s*[=:]\\s*)(?<value>(?<vq>['"])(?:\\\\.|(?!\\k<vq>).)*\\k<vq>|[^\\s,;()\\[\\]{}'"&]+)`,
  'gi',
);
const BEARER = /\b(?<prefix>[Bb]earer\s+)(?<token>[A-Za-z0-9._~+/=\-]{6,})/g;
const TOKENS = [
  /(?<![A-Za-z0-9_\-])sk-[A-Za-z0-9_\-]{16,}(?![A-Za-z0-9_\-])/g,
  /(?<![A-Za-z0-9])AKIA[A-Z0-9]{16}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9_])ghp_[A-Za-z0-9]{30,}(?![A-Za-z0-9_])/g,
  /(?<![A-Za-z0-9_\-])xox[abp]-[A-Za-z0-9\-]{8,}(?![A-Za-z0-9_\-])/g,
  /(?<![A-Za-z0-9_\-])eyJ[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}(?![A-Za-z0-9_\-])/g,
];
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
// `Authorization: Bearer <token>` is a scheme word plus a token; the Bearer rule takes the token.
const LITERALS = new Set(['none', 'null', 'true', 'false', 'nan', 'inf', 'bearer', 'basic', REDACTED.toLowerCase()]);

/** null, numbers and short words are never redacted */
function keepValue(raw: string): boolean {
  let inner = raw;
  if (raw.length >= 2 && raw[0] === raw[raw.length - 1] && (raw[0] === "'" || raw[0] === '"')) inner = raw.slice(1, -1);
  if (LITERALS.has(inner.toLowerCase()) || NUMBER.test(inner)) return true;
  return [...inner].length < MIN_VALUE_LEN;
}

export function redact<T>(text: T): T {
  if (!text || typeof text !== 'string') return text;
  let out = text.replace(KV, (...args: any[]) => {
    const m = args[0] as string;
    const groups = args[args.length - 1] as Record<string, string | undefined>;
    const offset = args[args.length - 3] as number;
    const whole = args[args.length - 2] as string;
    const value = groups.value ?? '';
    if (keepValue(value)) return m;
    const next = whole[offset + m.length];
    if (!groups.vq && (next === '(' || next === '[')) return m; // `api_key = getenv("X")`, `token = cfg["t"]`: code, not a secret
    const q = groups.vq ?? '';
    return `${groups.key}${groups.sep}${q}${REDACTED}${q}`;
  });
  out = out.replace(BEARER, (_m, prefix: string) => prefix + REDACTED);
  for (const pat of TOKENS) out = out.replace(pat, REDACTED);
  return out as T;
}

// Event fields that carry user-visible text (`url`: an `http.exchange` row's; `returned`: a trace scope's return
// value). Everything else (paths, ids, base64 step arrays, range tables) is structural and left alone.
const TEXT_FIELDS = new Set(['text', 'value', 'message', 'traceback', 'context', 'capped', 'keyRepr', 'detail', 'instrumentedSource', 'url', 'returned']);

/** redact the text fields of an event, value node or reply tree in place (and return it) */
export function redactValue<T>(obj: T): T {
  if (Array.isArray(obj)) {
    for (const item of obj) if (item && typeof item === 'object') redactValue(item);
  } else if (obj && typeof obj === 'object') {
    const o = obj as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === 'string') {
        if (TEXT_FIELDS.has(k)) o[k] = redact(v);
      } else if (v && typeof v === 'object') redactValue(v);
    }
  }
  return obj;
}
