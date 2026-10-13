/**
 * The live debugger's controls under the code pane: what VS Code's debug toolbar and Run and Debug
 * side bar show for a `record: false` session (continue, pause, step over / into / out, restart,
 * stop; where it is paused and why; the call stack; the selected frame's variables). The panel's
 * Debugger view keeps the watches, breakpoints, exceptions and output, as it does in VS Code.
 */
import type { DebugHost } from './debugHost';
import { useEffect, useState } from 'preact/hooks';
import type { ValueNode } from '../src/shared/protocol';
import { pausedSummary, runtimeCapped } from './pausedValues';
import { tokenize } from '../webview/highlight';

type Inspector = Pick<DebugHost, 'expandNode'>;

export function ValueSyntax({ text }: { text: string }) {
  return <>{tokenize(text).map((token, i) => <span key={i} class={`pkw-token-${token.cls}`}>{token.text}</span>)}</>;
}

export function ValueTree({ node, debug, name, initialOpen = false, onOpenSource }: { node: ValueNode; debug: Inspector; name: string; initialOpen?: boolean; onOpenSource?: (location: { path: string; line: number; column: number }) => void }) {
  const [value, setValue] = useState(node);
  const [open, setOpen] = useState(initialOpen);
  const [message, setMessage] = useState('');
  useEffect(() => { setValue(node); }, [node]);
  useEffect(() => {
    if (!initialOpen || !node.expandable) return;
    let active = true;
    setMessage('Loading…');
    void debug.expandNode(node).then(more => {
      if (!active) return;
      if (more) setValue(more);
      setMessage(more ? '' : 'More detail is unavailable for this pause.');
    }).catch(err => { if (active) setMessage(err instanceof Error ? err.message : String(err)); });
    return () => { active = false; };
  }, [node, initialOpen]);
  const toggle = async () => {
    setOpen(!open);
    if (open || !value.expandable) return;
    setMessage('Loading…');
    try {
      const more = await debug.expandNode(value);
      if (more) setValue(more);
      setMessage(more ? '' : 'More detail is unavailable for this pause.');
    } catch (err) { setMessage(err instanceof Error ? err.message : String(err)); }
  };
  const container = !!value.props?.length || !!value.expandable;
  const string = value.type === 'str';
  const expandable = container || !!value.functionSource || !!value.functionLocation || (string && ((value.value?.length ?? 0) > 80 || /[\r\n]/.test(value.value ?? '')));
  const size = value.length ?? value.props?.length ?? 0;
  const collectionPreview = value.type === 'list' ? size === 0 && !value.expandable ? '[]' : `Array(${size})`
    : value.type === 'dict' ? container ? '{…}' : '{}' : value.type;
  const preview = open && container ? collectionPreview
    : string ? JSON.stringify(value.value ?? '') : value.value ?? collectionPreview;
  const row = <><i class={`codicon codicon-${expandable ? open ? 'chevron-down' : 'chevron-right' : 'blank'}`} />{name ? <><span class="pkw-value-name">{name}</span><span class="pkw-value-colon">:</span></> : null}<span class="pkw-value-preview"><ValueSyntax text={preview} /></span></>;
  return <div class={`pkw-value-tree${open ? ' open' : ''}`}>
    {expandable ? <button class="pkw-value-toggle" aria-label={`Inspect ${name}`} aria-expanded={open} onClick={() => void toggle()}>{row}</button>
      : <div class="pkw-value-row">{row}</div>}
    {open ? <div class="pkw-value-children">{message ? <div class="pkw-value-note">{message}</div> : null}
      {string ? <pre class="pkw-value-string">{value.value}</pre> : null}
      {value.functionSource ? <pre class="pkw-function-source"><ValueSyntax text={value.functionSource} /></pre> : null}
      {value.functionSourceCapped ? <div class="pkw-value-note">Runtime function preview limited to 2000 characters. Open source for its context.</div> : null}
      {value.functionLocation && onOpenSource ? <button type="button" class="pkw-function-link" onClick={() => onOpenSource(value.functionLocation!)}>Open function source · line {value.functionLocation.line}</button> : null}
      {value.functionSource && !value.functionLocation ? <div class="pkw-value-note">Source location unavailable for this runtime function.</div> : null}
      {value.props?.map((p, i) => <ValueTree key={`${p.queryPath.join('/')}:${p.name}:${i}`} node={p} name={p.name} debug={debug} onOpenSource={onOpenSource} />)}
      {runtimeCapped(value) ? <div class="pkw-value-note">{value.expandable ? 'Additional runtime detail can be loaded by expanding its fields.' : 'The runtime limited this value; no further detail is available.'}</div> : null}
    </div> : null}
  </div>;
}

function ObservedBinding({ v, inspector, open, onToggle }: { open: boolean; onToggle: (name: string) => void; v: { name: string; text: string; valueBag?: { data: ValueNode; runtimeKey: string } }; inspector: Inspector }) {
  const node = v.valueBag?.data;
  const tree = !!node && (!!node.props?.length || !!node.expandable || !!node.functionSource || !!node.functionLocation);
  const summary = pausedSummary(v);
  const expandable = tree || (!node && summary !== v.text.replace(/\s*\n\s*/g, ' ')) || v.text.includes('\n');
  const contents = <><span class="pkw-debug-name">{v.name}</span> <span class="pkw-observed-preview">{open ? '' : summary}</span></>;
  return <div class={`pkw-observed-binding${open ? ' pkw-observed-open' : ''}`}>
    {expandable ? <button class="pkw-observed-summary" aria-expanded={open} title={v.text} onClick={() => onToggle(v.name)}>{contents}</button> : <span class="pkw-observed-scalar" title={v.text}>{contents}</span>}
    {open && expandable ? <div class="pkw-variable-detail">
      {tree ? <ValueTree node={node!} name={v.name} debug={inspector} initialOpen /> : <pre>{v.text}</pre>}
    </div> : null}
  </div>;
}

export function ObservedBindings({ locals, inspector, expanded, onToggle }: { expanded: Set<string>; onToggle: (name: string) => void; locals: { name: string; text: string; valueBag?: { data: ValueNode; runtimeKey: string } }[]; inspector: Inspector }) {
  return <div class="pkw-observed-bindings" aria-label="Valores de la pausa actual">
    {locals.map(v => <ObservedBinding key={v.name} v={v} inspector={inspector} open={expanded.has(v.name)} onToggle={onToggle} />)}
  </div>;
}

function Variable({ v, debug }: { v: { name: string; text: string; valueBag?: { data: ValueNode } }; debug: Inspector }) {
  if (v.valueBag) return <div class="pkw-variable" data-variable-name={v.name}><ValueTree node={v.valueBag.data} name={v.name} debug={debug} /></div>;
  return <details class="pkw-variable" data-variable-name={v.name}>
    <summary class="pkw-debug-row" title="Expand the value from this paused frame">
      <span class="pkw-debug-name">{v.name}</span><span class="pkw-debug-value"><ValueSyntax text={v.text} /></span>
    </summary>
    <div class="pkw-variable-detail"><pre><ValueSyntax text={v.text} /></pre>
      {runtimeCapped(undefined, v.text) ? <div class="pkw-value-note">The runtime limited this preview; no structured detail is available.</div> : null}
    </div>
  </details>;
}

/** Pointer capture keeps dragging reliable outside the narrow separator. */
function dragSeparator(event: PointerEvent, move: (e: PointerEvent) => void) {
  const el = event.currentTarget as HTMLElement;
  event.preventDefault();
  el.setPointerCapture(event.pointerId);
  const finish = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', finish); el.removeEventListener('pointercancel', finish); };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
}

type Action = 'continue' | 'pause' | 'stepOver' | 'stepInto' | 'stepOut' | 'restart' | 'stop';

function Btn({ icon, title, disabled, onClick }: { icon: string; title: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" class="pkw-btn" title={title} disabled={disabled} onClick={onClick}>
      <i class={`codicon codicon-${icon}`} />
    </button>
  );
}

export function DebugPane({ debug, onShowView, onLayout = () => {}, learning = false, expanded = true, onToggleTools = () => {}, onReturnToPause }: {
  debug: DebugHost; onShowView: () => void; onLayout?: () => void; learning?: boolean; expanded?: boolean; onToggleTools?: () => void; onReturnToPause?: () => void;
}) {
  const state = debug.state();
  if (!state) return null;
  const paused = state.paused;
  const live = state.running;
  const act = (a: Action) => void debug.control(a);
  const height = (el: HTMLElement, pixels: number) => {
    const wrapper = el.closest('#pkw-debugpane') as HTMLElement;
    const total = wrapper.parentElement!.clientHeight;
    wrapper.style.height = `${Math.max(90, Math.min(total - 100, pixels))}px`;
    onLayout();
  };
  const columns = (el: HTMLElement, fraction: number) => {
    const body = el.parentElement!;
    body.style.setProperty('--stack-width', `${Math.max(20, Math.min(70, fraction))}%`);
  };
  return (
    <div class="pkw-debug">
      {expanded ? <div class="pkw-debug-resize" role="separator" aria-label="Debugger height" aria-orientation="horizontal" tabIndex={0}
        onPointerDown={(e) => { const el = e.currentTarget; const bottom = el.closest('#pkw-debugpane')!.getBoundingClientRect().bottom; dragSeparator(e, (p) => height(el, bottom - p.clientY)); }}
        onKeyDown={(e) => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); height(e.currentTarget, e.currentTarget.closest('#pkw-debugpane')!.clientHeight + (e.key === 'ArrowUp' ? 20 : -20)); } }} /> : null}
      <div class="pkw-debug-bar">
        {!learning ? <span class="pkw-debug-title">
          <i class="codicon codicon-debug-alt" /> Debugger
        </span> : null}
        <span class="pkw-debug-reason" title={state.location}>
          {learning ? paused ? `Pausa · ${state.location}` : live ? 'En ejecución' : 'Finalizado' : paused ? `${state.reasonText} · ${state.location}` : state.reasonText}
        </span>
        <span class="pkw-spacer" />
        {paused && onReturnToPause ? <button type="button" class="pkw-text-btn" title="Return to the live paused line without executing code" onClick={onReturnToPause}>Back to pause</button> : null}
        {learning ? <>
          {live && !paused ? <Btn icon="debug-pause" title="Pause" onClick={() => act('pause')} /> : <Btn icon="debug-continue" title="Continue (F5)" disabled={!paused} onClick={() => act('continue')} />}
          <button type="button" class="pkw-btn" title="Step: next executed statement, including calls" aria-label="Step" disabled={!paused} onClick={() => act('stepInto')}><i class="codicon codicon-debug-step-into pkw-step-forward" /></button>
          <Btn icon="debug-step-over" title="Step over (F10)" disabled={!paused} onClick={() => act('stepOver')} />
          <Btn icon="debug-step-into" title="Step into (F11)" disabled={!paused} onClick={() => act('stepInto')} />
          <Btn icon="debug-step-out" title="Step out (Shift+F11)" disabled={!paused} onClick={() => act('stepOut')} />
          <Btn icon="debug-restart" title="Restart" onClick={() => act('restart')} />
          {live ? <Btn icon="debug-stop" title="Stop" onClick={() => act('stop')} /> : null}
          {expanded ? <button class="pkw-text-btn" onClick={onShowView}>Puntos de pausa</button> : null}
        </> : <>
          {live && !paused ? <Btn icon="debug-pause" title="Pause" onClick={() => act('pause')} /> : <Btn icon="debug-continue" title="Continue (F5)" disabled={!paused} onClick={() => act('continue')} />}
          <button type="button" class="pkw-btn" title="Step: next executed statement, including calls" aria-label="Step" disabled={!paused} onClick={() => act('stepInto')}><i class="codicon codicon-debug-step-into pkw-step-forward" /></button>
          <Btn icon="debug-step-over" title="Step over (F10)" disabled={!paused} onClick={() => act('stepOver')} />
          <Btn icon="debug-step-into" title="Step into (F11)" disabled={!paused} onClick={() => act('stepInto')} />
          <Btn icon="debug-step-out" title="Step out (Shift+F11)" disabled={!paused} onClick={() => act('stepOut')} />
          <Btn icon="debug-restart" title="Restart" onClick={() => act('restart')} />
          {live ? <Btn icon="debug-stop" title="Stop" onClick={() => act('stop')} /> : null}
          <Btn icon="output" title="Watches, breakpoints and output (the Debugger view)" onClick={onShowView} />
        </>}
        <button type="button" class="pkw-btn" title="Variables and call stack" aria-label="Variables and call stack" aria-expanded={expanded} onClick={onToggleTools}><i class="codicon codicon-symbol-variable" /></button>
        {paused && expanded ? <button type="button" class="pkw-btn" title="Close variables and call stack" aria-label="Close variables and call stack" onClick={onToggleTools}><i class="codicon codicon-close" /></button> : null}
      </div>
      {paused ? (
        <div class="pkw-debug-body" hidden={!expanded}>
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
          <div class="pkw-debug-split" role="separator" aria-label="Call Stack and Variables width" aria-orientation="vertical" tabIndex={0}
            onPointerDown={(e) => { const el = e.currentTarget; const rect = el.parentElement!.getBoundingClientRect(); dragSeparator(e, (p) => columns(el, 100 * (p.clientX - rect.left) / rect.width)); }}
            onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); const el = e.currentTarget; const body = el.parentElement!; const current = parseFloat(body.style.getPropertyValue('--stack-width')) || 40; columns(el, current + (e.key === 'ArrowLeft' ? -5 : 5)); } }} />
          <div class="pkw-debug-col">
            <div class="pkw-debug-head">VARIABLES</div>
            {state.locals.length ? (
              state.locals.map((v) => (
                <Variable key={`${state.id}:${debug.paused?.step}:${state.selectedFrame}:${v.name}`} v={v} debug={debug} />
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
