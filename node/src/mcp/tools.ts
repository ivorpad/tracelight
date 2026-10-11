/**
 * The MCP tools' definitions for `tracelight mcp` (`server.ts`): the same six tools, inputs and
 * descriptions as `pyokka mcp` (python/pyokka_runtime/agent/mcp_tools.py), so an agent that knows
 * one knows the other. The actions' descriptions are the agent commands' own help text, read from
 * the Python parser that runs them; `pyokka_run` describes a JavaScript / TypeScript run.
 */

export const MAP_ACTIONS = ['state', 'walkthrough', 'story', 'steps', 'find', 'graph', 'exceptions', 'http', 'tour', 'diff'] as const;
export const VALUE_ACTIONS = ['var', 'why', 'origin', 'values', 'eval', 'expand', 'release'] as const;
export const MOVES = ['into', 'over', 'out', 'back', 'back-over', 'back-out'] as const;
export const DEBUG_ACTIONS = ['start', 'continue', 'pause', 'stop', 'restart', 'break', 'watches', 'locals', 'exec', 'record'] as const;
/** the command each action runs, where the names differ */
export const DEBUG_COMMAND: Record<string, string> = { start: 'debug' };

type Schema = Record<string, any>;

function sourceProps(): Schema {
  return {
    run: { type: 'string', description: 'path of a saved run.json (from pyokka_run); omit with live' },
    live: { type: 'boolean', description: 'read the open VS Code session instead of a saved run (setting pyokka.agentAccess)' },
    session: { type: 'string', description: "with live: the session's file name, when more than one window session is open" },
    json: { type: 'boolean', description: 'the raw JSON shape instead of the text form' },
  };
}

function actionList(actions: readonly string[], helps: Record<string, string>, rename: Record<string, string> = {}): string {
  return actions.map((a) => `- ${a}: ${helps[rename[a] ?? a] ?? ''}`).join('\n');
}

export function toolDefinitions(helps: Record<string, string>): Schema[] {
  const src = sourceProps();
  const lineProp = { type: 'string', description: 'FILE:LINE, e.g. app.ts:57 (path suffix or basename)' };
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  return [
    {
      name: 'pyokka_run',
      title: 'Record a run',
      description: "Run a JavaScript or TypeScript file (or a Python file, through pyokka) under the tracer and save the recording (run.json) that every other tool reads. Prints the runtime, the step count and the exit code; a program that throws is still recorded. Returns the run path to pass as `run`.",
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'the file to run: .js, .mjs, .cjs, .ts, .mts, .cts (or .py)' },
          save: { type: 'string', description: 'where to write the run.json (default: .pyokka/runs/<file name>.json next to the file)' },
          args: { type: 'array', items: { type: 'string' }, description: 'arguments for the program (process.argv.slice(2))' },
          no_locals: { type: 'boolean', description: 'do not record locals at every step (var, why and origin need them)' },
          http: { type: 'string', enum: ['off', 'record', 'replay'], description: 'record every HTTP exchange next to the file, or replay from that recording without the network' },
          timeout_ms: { type: 'integer', description: 'stop the program after this many milliseconds (default 30,000)' },
          max_steps: { type: 'integer', description: 'record at most this many steps (default 999,999); a cut run says so' },
          python: { type: 'string', description: 'a .py file: interpreter or venv directory (see pyokka run)' },
          library_code: { type: 'boolean', description: 'a .py file: instrument third-party packages too' },
          keep: { type: 'boolean', description: 'a .py file: keep the runner alive for pyokka_value eval/expand' },
        },
        required: ['file'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    {
      name: 'pyokka_map',
      title: 'Map a run',
      description: 'What a recorded or live run did, with step numbers to step to. Start with walkthrough.\n' + actionList(MAP_ACTIONS, helps),
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: [...MAP_ACTIONS] },
          ...src,
          file: { type: 'string', description: 'walkthrough, story: only this file (path suffix or basename)' },
          scope: { type: 'string', description: 'walkthrough, story, graph: only inside calls of this function' },
          line: { ...lineProp, description: 'story: blocks that ran this line; steps: every step on this line (FILE:LINE)' },
          from: { type: 'integer', description: 'walkthrough: first step of the window; steps: first step' },
          to: { type: 'integer', description: 'walkthrough: last step of the window' },
          count: { type: 'integer', description: 'steps: how many (default 40)' },
          all: { type: 'boolean', description: 'walkthrough, graph: one entry per library call instead of one per call site' },
          text: { type: 'string', description: 'find: the text to search values, locals, errors, output and source for' },
          limit: { type: 'integer', description: 'find: most matches; story: most lines; diff: most statements' },
          goal: { type: 'string', description: "tour: explain this variable's last value (NAME) or this line's last pass (FILE:LINE)" },
          budget: { type: 'integer', description: 'tour: token budget (default 40,000)' },
          before: { type: 'string', description: 'diff: the run.json from before the edit' },
          after: { type: 'string', description: 'diff: the run.json from after the edit (or live: true for the open session)' },
        },
        required: ['action'],
      },
      annotations: readOnly,
    },
    {
      name: 'pyokka_step',
      title: 'Time Machine',
      description: 'The Time Machine: the code, values, call stack and available moves at one step of a run, or after a move from it. Without move or to, the context at `step` (or at the first step of `line`). Moves: into a call (lands in the callee with its arguments), over, out, back, back-over, back-out; `to` jumps. Live at a debug pause, into/over/out run the program to the next stop and `count` takes several steps.',
      inputSchema: {
        type: 'object',
        properties: {
          ...src,
          step: { type: 'integer', description: 'the step to read or move from (with live: omit for the current step)' },
          move: { type: 'string', enum: [...MOVES] },
          to: { type: 'integer', description: 'jump to this step' },
          line: { ...lineProp, description: 'without step: the context at the first step on this FILE:LINE' },
          count: { type: 'integer', description: 'live at a pause: take this many steps in a row (1..1000)' },
          whole_block: { type: 'boolean', description: 'the whole block and every value (lifts the 60-line / 20-value caps)' },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'pyokka_value',
      title: 'Read values',
      description: 'Values of a run and where they came from.\n' + actionList(VALUE_ACTIONS, helps),
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: [...VALUE_ACTIONS] },
          ...src,
          name: { type: 'string', description: 'var, why: a name or property path (total, this.balance); origin: the expression to follow (items[0].price), omit to take the value the exception is about' },
          step: { type: 'integer', description: 'why: the step whose statement made the value; origin: the failing statement\'s step (an exception\'s step)' },
          line: { ...lineProp, description: 'values: every value logged on this FILE:LINE, by hit' },
          expression: { type: 'string', description: 'eval: a pure expression (names, properties, subscripts, non-mutating calls)' },
          frame: { type: 'integer', description: 'eval, live at a pause: which frame, innermost 0' },
          value_id: { type: 'string', description: 'expand: valueBag.data.id from eval with json: true' },
          path: { type: 'array', items: { type: 'string' }, description: 'expand: query path segments' },
          depth: { type: 'integer', description: 'why: levels to expand (default 5); origin: most links (default 20)' },
          file: { type: 'string', description: 'var: only changes in this file' },
          scope: { type: 'string', description: 'var: only changes inside this function' },
          limit: { type: 'integer', description: 'var: most changes (default 200)' },
        },
        required: ['action'],
      },
      annotations: readOnly,
    },
    {
      name: 'pyokka_coverage',
      title: 'Coverage',
      description: (helps.coverage || 'which statements ran: per file the lines that ran, the ones that never did and the partial ones') + '. Lines are statement lines; a line marked partial ran only in part (a branch arm or a short-circuit that never ran), raised is where an exception came from.',
      inputSchema: { type: 'object', properties: { ...src, file: { type: 'string', description: 'also list this file line by line with hit counts' } } },
      annotations: readOnly,
    },
    {
      name: 'pyokka_debug',
      title: 'Live debugger',
      description: "Drive Pyokka's debugger in VS Code (the extension must be installed; the window opens on start). Every action that runs the program returns the next stop the way pyokka_step prints one.\n" + actionList(DEBUG_ACTIONS, helps, DEBUG_COMMAND),
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: [...DEBUG_ACTIONS] },
          session: src.session,
          json: src.json,
          file: { type: 'string', description: "start: the file to debug (omit to debug the open session's file)" },
          module: { type: 'string', description: 'start: a dotted module to run like python -m (Python only)' },
          args: { type: 'array', items: { type: 'string' }, description: 'start: arguments for the program' },
          cwd: { type: 'string', description: "start: working directory (default: the file's directory)" },
          env: { type: 'object', additionalProperties: { type: 'string' }, description: 'start: environment variables for the program' },
          python: { type: 'string', description: "start: interpreter (default: the window's)" },
          at: { type: 'array', items: { type: 'string' }, description: 'start, break: stop at these FILE:LINEs or function names (rrf, Ranker.rank)' },
          record: { type: 'boolean', description: 'start: also record the run, so pyokka_step back moves and why work at every pause' },
          record_from: { type: 'string', description: 'start: run at full speed to this NAME or FILE:LINE, then record from there' },
          library_code: { type: 'boolean', description: 'start: step into and pause inside third-party packages too' },
          stop_on_entry: { type: 'boolean', description: 'start, restart: pause before the first statement' },
          no_focus: { type: 'boolean', description: 'start: do not bring the VS Code window to the front at the first stop' },
          until: { type: 'string', description: 'continue: run until this expression is true' },
          to: { type: 'string', description: 'continue: run to this FILE:LINE' },
          no_wait: { type: 'boolean', description: 'continue, pause: answer at once instead of waiting for the stop' },
          add: { type: 'array', items: { type: 'string' }, description: 'break: FILE:LINE breakpoints to add; watches: expressions to add' },
          when: { type: 'string', description: 'break: only pause when this expression is true at the added line' },
          remove: { type: 'array', items: { type: 'string' }, description: 'break: FILE:LINE or function names to remove; watches: watch ids to remove' },
          on_exception: { type: 'string', enum: ['off', 'uncaught', 'raised'], description: 'break: when an exception pauses the run' },
          break_when: { type: 'string', enum: ['change', 'true'], description: 'watches: make the added watches pause the run on change, or when true' },
          frame: { type: 'integer', description: 'locals, exec: which frame of the pause, innermost 0' },
          source: { type: 'string', description: 'exec: the statement to run in the paused frame (it changes the program\'s state)' },
        },
        required: ['action'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
  ];
}
