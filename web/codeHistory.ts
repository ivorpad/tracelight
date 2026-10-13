import { pausedOccurrences, pausedSummary, pausedHover, type PausedValues } from './pausedValues';
import type { LocalVar } from './debugHost';

/** Keep observed changes beside declarations. No expressions or previous recordings are evaluated. */
export function inlineHistory(source: string, tokens: { offset: number; type: string }[][], snapshots: PausedValues[]): Map<number, { preview: string; hover: string }> {
  const lines = source.split(/\r?\n/);
  const bindings = new Map<string, { line: number; name: string; changes: { local: LocalVar; snapshot?: string }[] }>();
  for (const pause of snapshots) {
    if (pause.content !== source) continue;
    const seen = new Set<string>();
    for (const o of pausedOccurrences(lines, tokens, pause)) {
      if (o.unavailable || o.path?.length || o.line > pause.line || seen.has(o.local.name)) continue;
      if (!/\b(?:const|let|var)\s+$/.test(lines[o.line - 1]!.slice(0, o.start))) continue;
      seen.add(o.local.name);
      const key = `${o.line}:${o.start}:${o.local.name}`;
      const binding = bindings.get(key) ?? { line: o.line, name: o.local.name, changes: [] };
      if (binding.changes.at(-1)?.local.text !== o.local.text) binding.changes.push({ local: o.local, snapshot: pause.snapshot });
      bindings.set(key, binding);
    }
  }
  const rows = new Map<number, { previews: string[]; hovers: string[] }>();
  for (const binding of bindings.values()) {
    const row = rows.get(binding.line) ?? { previews: [], hovers: [] };
    const changes = binding.changes;
    row.previews.push(`${binding.name} = ${changes.length > 3 ? '… → ' : ''}${changes.slice(-3).map(c => pausedSummary(c.local)).join(' → ')}`);
    row.hovers.push(changes.map(c => `Observed code history · ${c.snapshot ?? 'pause'}\n\n${pausedHover(c.local)}`).join('\n\n---\n\n'));
    rows.set(binding.line, row);
  }
  return new Map([...rows].map(([line, row]) => [line, { preview: row.previews.join(' · '), hover: row.hovers.join('\n\n---\n\n') }]));
}
