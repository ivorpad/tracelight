/** Bound evidence detail without dropping the verdict or any verification check. */
const MAX_BYTES = 32768;
const MAX_NOTICES = 16;
const DECISION_FIELDS = new Set(['kind', 'verified', 'step', 'run', 'before', 'after', 'checks',
  'a', 'b', 'matching', 'firstDifference', 'total', 'shown', 'notes', 'meta', 'recording',
  'mode', 'found', 'selection', 'livePause', 'recordedSelection', 'frontier', 'capabilities',
  'allowedActions', 'visibleEditor', 'path', 'sha256', 'version', 'question']);
const IDENTITY_FIELDS = new Set(['kind', 'certainty', 'how', 'name', 'id', 'path', 'file', 'fileFullPath',
  'run', 'step', 'stepA', 'stepB', 'line', 'lineA', 'lineB']);

type Payload = Record<string, any>;
type Omission = { path: string; reason: string; [key: string]: unknown };
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

function prefix(text: string, maxBytes: number): string {
  let result = '', length = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (length + size > maxBytes) break;
    result += char;
    length += size;
  }
  return result;
}

export function boundedEvidence(payload: Payload, limit = 20): Payload {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Evidence limit must be an integer from 1 to 100.');
  // Dispatch returns JSON data. Cloning first also ensures no retained subtree aliases input.
  const source: Payload = JSON.parse(JSON.stringify(payload));
  delete source.response;
  const mandatory = Object.fromEntries(Object.entries(source).filter(([key]) => DECISION_FIELDS.has(key)));
  const attach = (result: Payload, omissions: Omission[]): Payload => {
    const ordered = [...omissions.filter(o => o.reason === 'section-byte-budget'), ...omissions.filter(o => o.reason !== 'section-byte-budget')];
    const notices = ordered.slice(0, MAX_NOTICES).map(notice => {
      const path = prefix(notice.path, 256);
      return path === notice.path ? notice : { ...notice, path: path + '…', pathTruncated: true };
    });
    if (omissions.length > MAX_NOTICES) notices.push({ path: 'response.omissions', reason: 'notice-limit', omitted: omissions.length - MAX_NOTICES });
    return { ...result, response: { limit, maxBytes: MAX_BYTES, omissions: notices } };
  };
  if (bytes(attach(mandatory, [])) > MAX_BYTES) {
    throw new Error('Mandatory evidence decision metadata and verification checks exceed the 32768-byte response budget.');
  }

  let result: Payload = {}, omissions: Omission[] = [];
  const bounds: [number, number][] = [[limit, 2048], [Math.min(limit, 5), 512], [1, 128], [0, 128]];
  for (const [arrayLimit, stringLimit] of bounds) {
    omissions = [];
    const compact = (value: any, path: string, key: string): any => {
      if (key === 'checks') return value;
      if (Array.isArray(value)) {
        if (value.length > arrayLimit) omissions.push({ path, reason: arrayLimit === limit ? 'array-limit' : 'byte-budget', original: value.length, retained: arrayLimit, omitted: value.length - arrayLimit });
        return value.slice(0, arrayLimit).map((item, index) => compact(item, `${path}[${index}]`, ''));
      }
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, compact(item, `${path}.${name}`, name)]));
      if (typeof value === 'string' && !IDENTITY_FIELDS.has(key) && Buffer.byteLength(value, 'utf8') > stringLimit) {
        const retained = prefix(value, stringLimit);
        omissions.push({ path, reason: 'string-limit', originalBytes: Buffer.byteLength(value, 'utf8'), retainedBytes: Buffer.byteLength(retained, 'utf8') });
        return retained + '… [truncated]';
      }
      return value;
    };
    result = Object.fromEntries(Object.entries(source).map(([key, value]) => [key, DECISION_FIELDS.has(key) ? value : compact(value, key, key)]));
    const candidate = attach(result, omissions);
    if (bytes(candidate) <= MAX_BYTES) return candidate;
  }

  // Large identities or many detail objects can still exceed the budget. Omit whole
  // detail sections explicitly, retaining the decision summaries and full checks.
  const sections = Object.keys(result).filter(key => !DECISION_FIELDS.has(key))
    .sort((a, b) => bytes(result[b]) - bytes(result[a]));
  for (const key of sections) {
    delete result[key];
    omissions.push({ path: key, reason: 'section-byte-budget' });
    const candidate = attach(result, omissions);
    if (bytes(candidate) <= MAX_BYTES) return candidate;
  }
  throw new Error('Mandatory evidence decision metadata and verification checks leave no room for omission notices within the 32768-byte response budget.');
}
