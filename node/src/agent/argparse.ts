/**
 * The part of Python's argparse the agent verbs use, so `tracelight <verb>` takes the same words,
 * in the same places, and refuses them with the same `usage:` and `error:` lines as `pyokka <verb>`.
 *
 * The parsing is argparse's: the arguments become a pattern of `O` (an option), `A` (an argument)
 * and `-` (`--`), positionals are consumed in runs between options with argparse's greedy regular
 * expressions (so `step 5 run.json --into` reads 5 as RUN, as `pyokka` does), long options may be
 * abbreviated to a unique prefix, `--opt=value` works, a negative number is an argument, and
 * mutually exclusive groups refuse a second member. Usage lines wrap the way argparse wraps them
 * (width `$COLUMNS - 2`, default 78).
 */

type Value = any;

/**
 * A custom argparse `Action`'s `__call__`: `values` is the string (one value), the list (`nargs`
 * a number) or `[]` (`nargs: 0`); `fail` raises argparse's `ArgumentError` for this argument.
 */
export type ActionFn = (ns: Record<string, Value>, values: Value, optionString: string | null, fail: (message: string) => never) => void;

export interface ArgSpec {
  /** `--name` (and aliases) for an option; empty for a positional */
  flags: string[];
  dest: string;
  /** undefined: one value; '?': zero or one; '*': any number; 'remainder': everything after; 0: a flag; N: exactly N values */
  nargs?: undefined | '?' | '*' | 'remainder' | 'parser' | number;
  /** `store_true` / `store_false` / `append` (each occurrence adds one value), or a custom action */
  action?: 'store' | 'store_true' | 'store_false' | 'append' | ActionFn;
  type?: 'int' | 'str';
  required?: boolean;
  default?: Value;
  /** a list for `nargs` N: one name per value (`['STEP', 'NAME']`) */
  metavar?: string | string[];
  choices?: string[];
  help?: string;
}

interface Group {
  required: boolean;
  actions: ArgSpec[];
}

export class ArgError extends Error {
  readonly parser: ArgumentParser;
  constructor(parser: ArgumentParser, message: string) {
    super(message);
    this.parser = parser;
  }
}

/** `-h` / `--help`: the help text is the message, printed to stdout with exit 0 */
export class HelpRequested extends Error {}

/** Python's `repr` of a string: `'x'`, or `"it's"` when it holds a single quote and no double one */
export function pyRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === quote) out += '\\' + ch;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20 || c === 0x7f) out += '\\x' + c.toString(16).padStart(2, '0');
    else if (c >= 0x80 && c < 0xa0) out += '\\x' + c.toString(16).padStart(2, '0');
    else out += ch;
  }
  return out + quote;
}

const NEGATIVE = /^-\d+$|^-\d*\.\d+$/;

function width(): number {
  const cols = Number(process.env.COLUMNS);
  return (Number.isFinite(cols) && cols > 0 ? cols : 80) - 2;
}

export class ArgumentParser {
  readonly prog: string;
  readonly description: string | undefined;
  readonly actions: ArgSpec[] = [];
  readonly groups: Group[] = [];
  readonly defaults: Record<string, Value> = {};

  constructor(prog: string, description?: string) {
    this.prog = prog;
    this.description = description;
    this.actions.push({ flags: ['-h', '--help'], dest: 'help', nargs: 0, action: 'store_true', help: 'show this help message and exit' });
  }

  /** `addArgument('--count', {type: 'int', default: 40, metavar: 'K'})`, `addArgument('run', {nargs: '?', metavar: 'RUN'})` */
  addArgument(name: string | string[], spec: Partial<ArgSpec> = {}, group?: Group): ArgSpec {
    const names = Array.isArray(name) ? name : [name];
    const isOption = names[0]!.startsWith('-');
    const action = spec.action ?? 'store';
    const a: ArgSpec = {
      flags: isOption ? names : [],
      dest: spec.dest ?? (isOption ? (names.find((n) => n.startsWith('--')) ?? names[0]!).replace(/^-+/, '').replace(/-/g, '_') : names[0]!),
      nargs: action === 'store_true' || action === 'store_false' ? 0 : spec.nargs,
      action,
      type: spec.type,
      required: spec.required ?? false,
      default: spec.default !== undefined ? spec.default : action === 'store_true' ? false : action === 'store_false' ? true : action === 'append' ? null : null,
      metavar: spec.metavar,
      choices: spec.choices,
      help: spec.help,
    };
    if (!isOption && a.nargs === undefined) a.required = true;
    if (!isOption && (a.nargs === '?' || a.nargs === '*')) a.required = false;
    this.actions.push(a);
    group?.actions.push(a);
    return a;
  }

  /** a mutually exclusive group: `const g = p.group(); p.addArgument('--a', {}, g)` */
  group(required = false): Group {
    const g: Group = { required, actions: [] };
    this.groups.push(g);
    return g;
  }

  setDefaults(values: Record<string, Value>): void {
    Object.assign(this.defaults, values);
  }

  private optionMap(): Map<string, ArgSpec> {
    const m = new Map<string, ArgSpec>();
    for (const a of this.actions) for (const f of a.flags) m.set(f, a);
    return m;
  }

  // -- usage and help --------------------------------------------------------------------------
  private metavar(a: ArgSpec): string {
    if (Array.isArray(a.metavar)) return a.metavar.join(' ');
    if (a.metavar) return a.metavar;
    if (a.choices) return `{${a.choices.join(',')}}`;
    return a.flags.length ? a.dest.toUpperCase() : a.dest;
  }

  private formatArgs(a: ArgSpec): string {
    const m = this.metavar(a);
    if (a.nargs === undefined) return m;
    if (a.nargs === '?') return `[${m}]`;
    if (a.nargs === '*') return `[${m} ...]`;
    if (a.nargs === 'remainder') return '...';
    if (a.nargs === 'parser') return `${m} ...`;
    if (typeof a.nargs === 'number' && a.nargs > 0) return Array.isArray(a.metavar) ? a.metavar.join(' ') : Array(a.nargs).fill(m).join(' ');
    return '';
  }

  private usageParts(): [string[], number] {
    const optionals = this.actions.filter((a) => a.flags.length);
    const positionals = this.actions.filter((a) => !a.flags.length);
    const actions = [...optionals, ...positionals];
    const inGroup = new Set<ArgSpec>();
    const inserts: [number, number, Group][] = [];
    for (const g of this.groups) {
      const start = actions.indexOf(g.actions[0]!);
      if (start < 0) continue;
      const end = start + g.actions.length;
      if (g.actions.every((x, i) => actions[start + i] === x)) {
        for (const x of g.actions) inGroup.add(x);
        inserts.push([start, end, g]);
      }
    }
    const parts: (string | null)[] = actions.map((a) => {
      if (!a.flags.length) {
        let part = this.formatArgs(a);
        if (inGroup.has(a) && part.startsWith('[') && part.endsWith(']')) part = part.slice(1, -1);
        return part;
      }
      let part = a.nargs === 0 ? a.flags[0]! : `${a.flags[0]} ${this.formatArgs(a)}`;
      if (!a.required && !inGroup.has(a)) part = `[${part}]`;
      return part;
    });
    for (const [start, end, g] of inserts.sort((x, y) => y[0] - x[0])) {
      const gp = parts.slice(start, end) as string[];
      const [open, close] = g.required ? (gp.length > 1 ? ['(', ')'] : ['', '']) : ['[', ']'];
      gp[0] = open + gp[0];
      gp[gp.length - 1] = gp[gp.length - 1] + close;
      for (let i = 0; i < gp.length - 1; i++) parts[start + i] = gp[i] + ' |';
      parts[start + gp.length - 1] = gp[gp.length - 1]!;
    }
    const posStart = parts.slice(0, optionals.length).filter((p) => p !== null).length;
    return [parts.filter((p): p is string => p !== null), posStart];
  }

  usage(): string {
    const prefix = 'usage: ';
    const [parts, posStart] = this.usageParts();
    const full = [this.prog, parts.join(' ')].filter((s) => s).join(' ');
    const textWidth = width();
    if (prefix.length + full.length <= textWidth) return prefix + full;
    const optParts = parts.slice(0, posStart);
    const posParts = parts.slice(posStart);
    const getLines = (ps: string[], indent: string, pre?: string): string[] => {
      const lines: string[] = [];
      let line: string[] = [];
      let lineLen = pre !== undefined ? pre.length - 1 : indent.length - 1;
      for (const part of ps) {
        if (lineLen + 1 + part.length > textWidth && line.length) {
          lines.push(indent + line.join(' '));
          line = [];
          lineLen = indent.length - 1;
        }
        line.push(part);
        lineLen += part.length + 1;
      }
      if (line.length) lines.push(indent + line.join(' '));
      if (pre !== undefined) lines[0] = lines[0]!.slice(indent.length);
      return lines;
    };
    let lines: string[];
    if (prefix.length + this.prog.length <= 0.75 * textWidth) {
      const indent = ' '.repeat(prefix.length + this.prog.length + 1);
      if (optParts.length) lines = [...getLines([this.prog, ...optParts], indent, prefix), ...getLines(posParts, indent)];
      else if (posParts.length) lines = getLines([this.prog, ...posParts], indent, prefix);
      else lines = [this.prog];
    } else {
      const indent = ' '.repeat(prefix.length);
      lines = getLines([...optParts, ...posParts], indent);
      if (lines.length > 1) lines = [...getLines(optParts, indent), ...getLines(posParts, indent)];
      lines = [this.prog, ...lines];
    }
    return prefix + lines.join('\n');
  }

  /** argparse's help layout: usage, then the positionals and the options with their help */
  help(): string {
    const w = width();
    const invocation = (a: ArgSpec) => (a.flags.length ? (a.nargs === 0 ? a.flags.join(', ') : `${a.flags.join(', ')} ${this.formatArgs(a)}`) : this.metavar(a));
    // argparse's help_position: the longest invocation (indented 2) plus 2, at most max_help_position
    const col = Math.min(Math.max(...this.actions.map((a) => 2 + invocation(a).length)) + 2, Math.min(24, Math.max(w - 20, 11 * 2)));
    const out = [this.usage(), ''];
    if (this.description) out.push(this.description, '');
    const section = (title: string, list: ArgSpec[]) => {
      if (!list.length) return;
      out.push(`${title}:`);
      for (const a of list) {
        const inv = invocation(a);
        const words = (a.help ?? '').split(/\s+/).filter(Boolean);
        const helpLines: string[] = [];
        let cur = '';
        for (const word of words) {
          if (cur && cur.length + 1 + word.length > w - col) {
            helpLines.push(cur);
            cur = word;
          } else cur = cur ? `${cur} ${word}` : word;
        }
        if (cur) helpLines.push(cur);
        const head = `  ${inv}`;
        if (!helpLines.length) out.push(head);
        else if (head.length <= col - 2) {
          out.push(head.padEnd(col) + helpLines[0]);
          for (const l of helpLines.slice(1)) out.push(' '.repeat(col) + l);
        } else {
          out.push(head);
          for (const l of helpLines) out.push(' '.repeat(col) + l);
        }
      }
      out.push('');
    };
    section('positional arguments', this.actions.filter((a) => !a.flags.length));
    section('options', this.actions.filter((a) => a.flags.length));
    return out.join('\n').replace(/\n+$/, '') + '\n';
  }

  // -- parsing ----------------------------------------------------------------------------------
  private name(a: ArgSpec): string {
    return a.flags.length ? a.flags.join('/') : a.metavar ? this.metavar(a) : a.dest;
  }

  private error(message: string): never {
    throw new ArgError(this, message);
  }

  private convert(a: ArgSpec, s: string): Value {
    let v: Value = s;
    if (a.type === 'int') {
      if (!/^\s*[+-]?\d+(_\d+)*\s*$/.test(s)) this.error(`argument ${this.name(a)}: invalid int value: ${pyRepr(s)}`);
      v = parseInt(s.replace(/_/g, ''), 10);
    }
    if (a.choices && !a.choices.includes(v)) this.error(`argument ${this.name(a)}: invalid choice: ${pyRepr(String(v))} (choose from ${a.choices.map((c) => pyRepr(c)).join(', ')})`);
    return v;
  }

  private nargsPattern(a: ArgSpec): string {
    const option = a.flags.length > 0;
    if (typeof a.nargs === 'number' && a.nargs > 0) return option ? `([AO]{${a.nargs}})` : `((?:-*A){${a.nargs}}-*)`;
    switch (a.nargs) {
      case undefined:
        return option ? '(A)' : '(-*A-*)';
      case '?':
        return option ? '(A?)' : '(-*A?-*)';
      case '*':
        return option ? '(A*)' : '(-*[A-]*)';
      case 'remainder':
        return option ? '([AO]*)' : '(.*)';
      case 'parser':
        return option ? '(A[AO]*)' : '(-*A[-AO]*)';
      default:
        return option ? '()' : '(-*)';
    }
  }

  /** the option tuples an argument string can mean: `[action, optionString, explicitArg]`; null for a positional */
  private parseOptional(arg: string, map: Map<string, ArgSpec>): [ArgSpec | null, string, string | null][] | null {
    if (!arg || arg[0] !== '-') return null;
    if (map.has(arg)) return [[map.get(arg)!, arg, null]];
    if (arg.length === 1) return null;
    const eq = arg.indexOf('=');
    if (eq >= 0 && map.has(arg.slice(0, eq))) return [[map.get(arg.slice(0, eq))!, arg.slice(0, eq), arg.slice(eq + 1)]];
    const tuples: [ArgSpec | null, string, string | null][] = [];
    if (arg.startsWith('--')) {
      const prefix = eq >= 0 ? arg.slice(0, eq) : arg;
      const explicit = eq >= 0 ? arg.slice(eq + 1) : null;
      for (const [opt, a] of map) if (opt.startsWith(prefix)) tuples.push([a, opt, explicit]);
    } else {
      const short = arg.slice(0, 2);
      for (const [opt, a] of map) if (opt === short) tuples.push([a, opt, arg.slice(2)]);
    }
    if (tuples.length) return tuples;
    if (NEGATIVE.test(arg)) return null;
    if (arg.includes(' ')) return null;
    return [[null, arg, null]];
  }

  /** parse `argv` into a namespace (dest -> value); throws `ArgError` (exit 2) or `HelpRequested` (exit 0) */
  parse(argv: string[]): Record<string, Value> {
    const ns: Record<string, Value> = {};
    for (const a of this.actions) if (a.dest !== 'help') ns[a.dest] = a.default;
    Object.assign(ns, this.defaults);
    const map = this.optionMap();
    const conflicts = new Map<ArgSpec, ArgSpec[]>();
    for (const g of this.groups) for (const a of g.actions) conflicts.set(a, [...(conflicts.get(a) ?? []), ...g.actions.filter((x) => x !== a)]);
    const optionAt = new Map<number, [ArgSpec | null, string, string | null][]>();
    let pattern = '';
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]!;
      if (arg === '--') {
        pattern += '-' + 'A'.repeat(argv.length - i - 1);
        break;
      }
      const t = this.parseOptional(arg, map);
      if (t === null) pattern += 'A';
      else {
        optionAt.set(i, t);
        pattern += 'O';
      }
    }
    const seen = new Set<ArgSpec>();
    const seenNonDefault = new Set<ArgSpec>();
    const extras: string[] = [];
    const take = (a: ArgSpec, strings: string[], optionString: string | null = null) => {
      seen.add(a);
      if (a.flags.length || strings.length) {
        seenNonDefault.add(a);
        for (const c of conflicts.get(a) ?? []) if (seenNonDefault.has(c)) this.error(`argument ${this.name(a)}: not allowed with argument ${this.name(c)}`);
      }
      if (a.dest === 'help') throw new HelpRequested(this.help());
      if (typeof a.action === 'function') {
        const values = typeof a.nargs === 'number' || a.nargs === '*' || a.nargs === 'remainder' || a.nargs === 'parser' ? strings.map((s) => this.convert(a, s)) : strings.length ? this.convert(a, strings[0]!) : a.default;
        a.action(ns, values, optionString, (message) => this.error(`argument ${this.name(a)}: ${message}`));
      } else if (a.action === 'store_true') ns[a.dest] = true;
      else if (a.action === 'store_false') ns[a.dest] = false;
      else if (a.action === 'append') ns[a.dest] = [...(ns[a.dest] ?? []), this.convert(a, strings[0]!)];
      else if (a.nargs === '?') ns[a.dest] = strings.length ? this.convert(a, strings[0]!) : a.default;
      else if (a.nargs === '*' || a.nargs === 'remainder') ns[a.dest] = strings.map((s) => this.convert(a, s));
      else ns[a.dest] = this.convert(a, strings[0]!);
    };
    const matchArgument = (a: ArgSpec, pat: string): number => {
      const m = new RegExp('^' + this.nargsPattern(a)).exec(pat);
      if (!m) this.error(`argument ${this.name(a)}: ${a.nargs === '?' ? 'expected at most one argument' : typeof a.nargs === 'number' ? `expected ${a.nargs} argument${a.nargs === 1 ? '' : 's'}` : 'expected one argument'}`);
      return m[1]!.length;
    };
    const consumeOptional = (start: number): number => {
      const tuples = optionAt.get(start)!;
      if (tuples.length > 1) this.error(`ambiguous option: ${argv[start]} could match ${tuples.map((t) => t[1]).join(', ')}`);
      const [a, opt, explicit] = tuples[0]!;
      if (a === null) {
        extras.push(argv[start]!);
        return start + 1;
      }
      if (explicit !== null) {
        if (a.nargs === 0) this.error(`argument ${this.name(a)}: ignored explicit argument ${pyRepr(explicit)}`);
        if (typeof a.nargs === 'number' && a.nargs > 1) matchArgument(a, 'A');
        take(a, [explicit], opt);
        return start + 1;
      }
      const count = matchArgument(a, pattern.slice(start + 1));
      take(a, argv.slice(start + 1, start + 1 + count), opt);
      return start + 1 + count;
    };
    let positionals = this.actions.filter((a) => !a.flags.length);
    const consumePositionals = (start: number): number => {
      const pat = pattern.slice(start);
      let counts: number[] = [];
      for (let i = positionals.length; i > 0; i--) {
        const re = new RegExp('^' + positionals.slice(0, i).map((a) => this.nargsPattern(a)).join(''));
        const m = re.exec(pat);
        if (m) {
          counts = m.slice(1).map((g) => g.length);
          if (m[0].length < pat.length && pat[m[0].length] === 'O') while (counts.length && !counts[counts.length - 1]) counts.pop();
          break;
        }
      }
      let index = start;
      counts.forEach((count, k) => {
        const a = positionals[k]!;
        const args = argv.slice(index, index + count);
        if (a.nargs !== 'remainder' && pattern.slice(index, index + count).includes('-')) args.splice(args.indexOf('--'), 1);
        index += count;
        take(a, args);
      });
      positionals = positionals.slice(counts.length);
      return index;
    };
    let start = 0;
    const maxOption = optionAt.size ? Math.max(...optionAt.keys()) : -1;
    while (start <= maxOption) {
      let next = start;
      while (next <= maxOption && !optionAt.has(next)) next++;
      if (start !== next) {
        const end = consumePositionals(start);
        if (end > start) {
          start = end;
          continue;
        }
        start = end;
      }
      if (!optionAt.has(start)) {
        extras.push(...argv.slice(start, next));
        start = next;
      }
      start = consumeOptional(start);
    }
    const stop = consumePositionals(start);
    extras.push(...argv.slice(stop));
    const required = this.actions.filter((a) => !seen.has(a) && a.required).map((a) => this.name(a));
    if (required.length) this.error(`the following arguments are required: ${required.join(', ')}`);
    for (const g of this.groups) {
      if (g.required && !g.actions.some((a) => seenNonDefault.has(a))) this.error(`one of the arguments ${g.actions.map((a) => this.name(a)).join(' ')} is required`);
    }
    if (extras.length) throw new UnrecognizedArguments(extras);
    return ns;
  }
}

/** arguments nobody took: argparse reports them from the top-level parser */
export class UnrecognizedArguments extends Error {
  readonly extras: string[];
  constructor(extras: string[]) {
    super(`unrecognized arguments: ${extras.join(' ')}`);
    this.extras = extras;
  }
}
