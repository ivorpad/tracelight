import type { ValueNode } from '../src/shared/protocol';

/** Captured data only. Missing/truncated data stays explicit, never guessed. */
export function scratchInput(node: ValueNode): unknown {
  if (node.secret || node.circular || node.type === 'function') return { __scratchUnavailable: node.type === 'function' ? 'function' : 'incomplete captured value' };
  if (node.type === 'str') return node.capped ? { __scratchUnavailable: 'incomplete string' } : node.value ?? '';
  if (node.type === 'number') return Number(node.value);
  if (node.type === 'bool') return node.value?.toLowerCase() === 'true';
  if (node.type === 'None') return null;
  if (node.type === 'list' || node.type === 'tuple') return node.cappedElements || (node.length !== undefined && (node.props?.length ?? 0) < node.length) ? { __scratchUnavailable: 'incomplete array' } : node.props?.map(p => scratchInput(p)) ?? [];
  if (node.props) return Object.fromEntries([...node.props.filter(p => !p.loadActionNode).map(p => [p.name, scratchInput(p)]), ...(node.cappedProps || node.cappedElements || (node.length !== undefined && node.props.length < node.length) ? [['__scratchMissing', true]] : [])]);
  return { __scratchUnavailable: node.type };
}
