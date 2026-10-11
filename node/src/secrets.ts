/**
 * Secret masking by provenance, as Pyokka's secrets.py: values of secret-looking environment
 * variables are scrubbed from every outgoing text, and a string under a secret-looking name is
 * masked whatever it holds. No value-shape detection.
 */
export const MASK = '••••••••';
const MIN_VALUE_LEN = 8;
const REFRESH_MS = 100;
const SECRET_WORDS = new Set([
  'apikey', 'accesskey', 'secretkey', 'privatekey', 'signingkey', 'encryptionkey', 'sessionkey', 'masterkey', 'licensekey', 'licencekey',
  'secret', 'secrets', 'password', 'passwd', 'passphrase', 'credential', 'credentials', 'token', 'tokens', 'auth', 'authorization', 'bearer', 'dsn',
]);
const NAME_TOKENS = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+/g;

export function nameTokens(name: string): string[] {
  return (name.match(NAME_TOKENS) ?? []).map((t) => t.toLowerCase());
}

export class SecretFilter {
  mask = true;
  extra = new Set<string>();
  private values: string[] = [];
  private envSize = -1;
  private checkedAt = -Infinity;
  private cache = new Map<string, boolean>();

  configure(mask: boolean, names: string[]): void {
    this.mask = mask;
    this.extra = new Set(names.map((n) => n.toLowerCase()));
    this.cache.clear();
    this.envSize = -1;
    this.checkedAt = -Infinity;
  }

  isSecretName(name: unknown): boolean {
    if (!this.mask || typeof name !== 'string' || !name) return false;
    let hit = this.cache.get(name);
    if (hit !== undefined) return hit;
    const words = nameTokens(name);
    hit = false;
    for (let i = 0; i < words.length && !hit; i++) {
      const w = words[i]!;
      if (SECRET_WORDS.has(w) || this.extra.has(w)) hit = true;
      else if (i + 1 < words.length) {
        const pair = w + words[i + 1];
        if (SECRET_WORDS.has(pair) || this.extra.has(pair)) hit = true;
      }
    }
    if (!hit && (SECRET_WORDS.has(name.toLowerCase()) || this.extra.has(name.toLowerCase()))) hit = true;
    if (this.cache.size > 4096) this.cache.clear();
    this.cache.set(name, hit);
    return hit;
  }

  private refresh(): void {
    // listing process.env costs tens of microseconds, and scrub runs per returned value: look again
    // at most every REFRESH_MS (a secret the program puts in its own env is masked from then on)
    const now = performance.now();
    if (now - this.checkedAt < REFRESH_MS) return;
    this.checkedAt = now;
    const keys = Object.keys(process.env);
    if (keys.length === this.envSize) return;
    this.envSize = keys.length;
    const vals = new Set<string>();
    for (const k of keys) {
      const v = process.env[k];
      if (v && v.length >= MIN_VALUE_LEN && this.isSecretName(k)) vals.add(v);
    }
    this.values = [...vals].sort((a, b) => b.length - a.length);
  }

  /** replace every secret env value in `text` */
  scrub(text: string): string {
    if (!this.mask || text.length < MIN_VALUE_LEN) return text;
    this.refresh();
    for (const v of this.values) if (text.includes(v)) text = text.split(v).join(MASK);
    return text;
  }
}

export const secrets = new SecretFilter();
