import type { MoveKind } from './pageHost';

export function RecordingControls({ step, location, canStep, canAdvance, advance, move, restart, stop }: {
  step: number; location: string;
  canStep: Record<MoveKind, boolean>;
  canAdvance: boolean; advance: () => void;
  move: (kind: MoveKind) => void; restart: () => void; stop: () => void;
}) {
  const button = (icon: string, title: string, action: () => void, enabled = true) => <button type="button" class="pkw-btn" title={title} aria-label={title} disabled={!enabled} onClick={action}><i class={`codicon codicon-${icon}`} /></button>;
  return <div class="pkw-debug"><div class="pkw-debug-bar" aria-label="Recording controls">
    <span class="pkw-debug-reason">Recording · {location} · #{step}</span><span class="pkw-spacer" />
    <button type="button" class="pkw-btn" title="Step: next recorded event" aria-label="Step" disabled={!canAdvance} onClick={advance}><i class="codicon codicon-debug-step-into pkw-step-forward" /></button>
    {button('debug-step-back', 'Step back', () => move('back'), canStep.back)}
    {button('debug-step-over', 'Step over (F10)', () => move('over'), canStep.over)}
    {button('debug-step-into', 'Step into (F11)', () => move('into'), canStep.into)}
    {button('debug-step-out', 'Step out (Shift+F11)', () => move('out'), canStep.out)}
    {button('debug-restart', 'Restart recording', restart)}
    {button('debug-stop', 'Close recording', stop)}
  </div></div>;
}
