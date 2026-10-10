/**
 * The live debugger's controls under the code pane: what VS Code's debug toolbar and Run and Debug
 * side bar show for a `record: false` session (continue, pause, step over / into / out, restart,
 * stop; where it is paused and why; the call stack; the selected frame's variables). The panel's
 * Debugger view keeps the watches, breakpoints, exceptions and output, as it does in VS Code.
 */
import type { DebugHost } from './debugHost';

type Action = 'continue' | 'pause' | 'stepOver' | 'stepInto' | 'stepOut' | 'restart' | 'stop';

function Btn({ icon, title, disabled, onClick }: { icon: string; title: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" class="pkw-btn" title={title} disabled={disabled} onClick={onClick}>
      <i class={`codicon codicon-${icon}`} />
    </button>
  );
}

export function DebugPane({ debug, onShowView }: { debug: DebugHost; onShowView: () => void }) {
  const state = debug.state();
  if (!state) return null;
  const paused = state.paused;
  const live = state.running;
  const act = (a: Action) => void debug.control(a);
  return (
    <div class="pkw-debug">
      <div class="pkw-debug-bar">
        <span class="pkw-debug-title">
          <i class="codicon codicon-debug-alt" /> Debugger
        </span>
        <span class="pkw-debug-reason" title={state.location}>
          {paused ? `${state.reasonText} · ${state.location}` : state.reasonText}
        </span>
        <span class="pkw-spacer" />
        {live && !paused ? <Btn icon="debug-pause" title="Pause" onClick={() => act('pause')} /> : <Btn icon="debug-continue" title="Continue (F5)" disabled={!paused} onClick={() => act('continue')} />}
        <Btn icon="debug-step-over" title="Step over (F10)" disabled={!paused} onClick={() => act('stepOver')} />
        <Btn icon="debug-step-into" title="Step into (F11)" disabled={!paused} onClick={() => act('stepInto')} />
        <Btn icon="debug-step-out" title="Step out (Shift+F11)" disabled={!paused} onClick={() => act('stepOut')} />
        <Btn icon="debug-restart" title="Restart" onClick={() => act('restart')} />
        {live ? <Btn icon="debug-stop" title="Stop" onClick={() => act('stop')} /> : null}
        <Btn icon="output" title="Watches, breakpoints and output (the Debugger view)" onClick={onShowView} />
      </div>
      {paused ? (
        <div class="pkw-debug-body">
          <div class="pkw-debug-col">
            <div class="pkw-debug-head">CALL STACK</div>
            {state.stack.map((f, i) => (
              <div key={i} class={`pkw-debug-row${i === state.selectedFrame ? ' selected' : ''}${f.library ? ' dim' : ''}`} onClick={() => void debug.selectFrame(i)} title={`${f.file}:${f.line}`}>
                <span class="pkw-debug-name">{f.name}</span>
                <span class="pkw-debug-loc">
                  {f.file.split('/').pop()}:{f.line}
                </span>
              </div>
            ))}
          </div>
          <div class="pkw-debug-col">
            <div class="pkw-debug-head">VARIABLES</div>
            {state.locals.length ? (
              state.locals.map((v) => (
                <div key={v.name} class="pkw-debug-row" title={v.text}>
                  <span class="pkw-debug-name">{v.name}</span>
                  <span class="pkw-debug-value">{v.text}</span>
                </div>
              ))
            ) : (
              <div class="pkw-debug-row dim">none in this frame</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
