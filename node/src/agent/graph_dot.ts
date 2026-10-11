/**
 * `graph --dot`: the execution graph of `graph.ts` as a Graphviz digraph.
 *
 * Modules and functions are records (the label and location, then one row per line), packages
 * are folders, decisions diamonds, statements plain boxes with a monospace label (their rows
 * under it), each hung from its parent by a dotted link; call edges carry `×N`, tool edges say
 * so, data edges are dashed and carry the name. Labels are escaped for Graphviz; the CLI
 * redacts them.
 */
import { rowText } from './graph.ts';

type Msg = Record<string, any>;

const RECORD_SPECIALS = '{}|<>';

export function escape(text: unknown, record = false): string {
  let s = String(text).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
  if (record) for (const ch of RECORD_SPECIALS) s = s.replaceAll(ch, '\\' + ch);
  return s;
}

function where(n: Msg): string {
  const file = n.file;
  if (!file) return '';
  const name = String(file).split('/').pop()!;
  return n.line ? `${name}:${n.line}` : name;
}

export function renderDot(result: Msg): string {
  const lines = ['digraph run {', '  rankdir=TB;', '  node [fontname="Helvetica", fontsize=10];', '  edge [fontname="Helvetica", fontsize=9];'];
  const links: string[] = [];
  for (const n of result.nodes as Msg[]) {
    const rows = n.rows.map((r: Msg) => escape(rowText(r), true) + '\\l').join('');
    if (n.kind === 'decision') {
      const label = escape(n.text) + (n.notRun.length ? '\\nnot run: ' + n.notRun.map(String).join(', ') : '');
      lines.push(`  ${n.id} [shape=diamond, label="${label}"];`);
      links.push(`  ${n.parent} -> ${n.id} [style=dotted, arrowhead=none];`);
    } else if (n.kind === 'statement') {
      const label = escape(n.label) + n.rows.map((r: Msg) => '\\n' + escape(rowText(r))).join('');
      lines.push(`  ${n.id} [shape=box, fontname="Courier", label="${label}"];`);
      links.push(`  ${n.parent} -> ${n.id} [style=dotted, arrowhead=none];`);
    } else if (n.kind === 'package') {
      const head = escape(`${n.label} ×${n.calls}`) + (n.nested !== null && n.nested !== undefined ? `\\n${n.nested} nested` : '') + (n.more ? '\\n' + escape(where(n)) : '');
      lines.push(`  ${n.id} [shape=folder, label="${head}"];`);
    } else {
      const head = escape(`${n.label} ×${n.calls}`, true) + '\\n' + escape(where(n), true);
      lines.push(`  ${n.id} [shape=record, label="{${head}${rows ? '|' + rows : ''}}"];`);
    }
  }
  lines.push(...links);
  for (const e of result.edges as Msg[]) {
    if (e.kind === 'data') lines.push(`  ${e.from} -> ${e.to} [style=dashed, label="${escape(e.label)}"];`);
    else lines.push(`  ${e.from} -> ${e.to} [label="${e.kind === 'tool' ? 'tool ' : ''}×${e.count}"];`);
  }
  lines.push('}');
  return lines.join('\n');
}
