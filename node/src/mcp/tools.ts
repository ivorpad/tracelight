/**
 * The MCP tools' definitions for `tracelight mcp` (`server.ts`): tools over families of agent
 * commands. The actions' descriptions are the agent commands' own help text (`commandHelps`).
 */
import { workflowDefinitions } from './workflowTools.ts';
import { PAGE_ACTIONS, PAGE_DEBUG_OPS, PAGE_STEP_KINDS, SCRATCH_OPS } from './page.ts';

export const MAP_ACTIONS = ['state', 'walkthrough', 'story', 'steps', 'find', 'graph', 'exceptions', 'http', 'tour', 'diff'] as const;
export const VALUE_ACTIONS = ['var', 'why', 'origin', 'values', 'eval', 'expand', 'release'] as const;
export const MOVES = ['into', 'over', 'out', 'back', 'back-over', 'back-out'] as const;
export const DEBUG_ACTIONS = ['start', 'continue', 'pause', 'stop', 'restart', 'break', 'watches', 'locals', 'exec', 'record', 'status'] as const;
/** the command each action runs, where the names differ */
export const DEBUG_COMMAND: Record<string, string> = { start: 'debug' };

type Schema = Record<string, any>;

function sourceProps(): Schema {
  return {
    run: { type: 'string', description: 'path of a saved run.json (from tracelight_run); omit with live' },
    live: { type: 'boolean', description: 'read the open VS Code session instead of a saved run (setting tracelight.agentAccess)' },
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
  const evidenceLimit = { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'maximum entries per detail list; response.omissions identifies shortened detail. All verification checks are retained. JSON payload is capped at 32 KiB.' };
  const savedReadOnly = { ...readOnly, destructiveHint: false, idempotentHint: true };
  return [
    {
      name: 'tracelight_run',
      title: 'Record a run',
      description: "Run a JavaScript or TypeScript file under the tracer and save the recording (run.json) that every other tool reads. Prints the runtime, the step count and the exit code; a program that throws is still recorded. Returns the run path to pass as `run`.",
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'the file to run: .js, .mjs, .cjs, .jsx, .ts, .mts, .cts or .tsx' },
          save: { type: 'string', description: 'where to write the run.json (default: .tracelight/runs/<file name>.json next to the file)' },
          args: { type: 'array', items: { type: 'string' }, description: 'arguments for the program (process.argv.slice(2))' },
          no_locals: { type: 'boolean', description: 'do not record locals at every step (var, why and origin need them)' },
          http: { type: 'string', enum: ['off', 'record', 'replay'], description: 'record every HTTP exchange next to the file, or replay from that recording without the network' },
          timeout_ms: { type: 'integer', description: 'stop the program after this many milliseconds (default 30,000)' },
          max_steps: { type: 'integer', description: 'record at most this many steps (default 999,999); a cut run says so' },
          library_code: { type: 'boolean', description: 'also record inside node_modules packages (slower; off by default)' },
          exclude: { type: 'array', items: { type: 'string' }, description: 'glob patterns of files not to record, e.g. the files a cut run names' },
          only: { type: 'array', items: { type: 'string' }, description: 'record only files matching these glob patterns (under Bun, name source directories)' },
          plugins: { type: 'array', items: { type: 'string' }, description: 'runtime plugin modules to load (a relative path resolves from the server\'s directory)' },
          mode: { type: 'string', enum: ['normal', 'profile', 'snaps'], description: 'normal records steps; profile runs under the CPU profiler and writes a .cpuprofile instead; snaps records value snapshots only' },
          max_value_chars: { type: 'integer', description: 'characters kept of one value (default: the runtime\'s cap)' },
          keep: { type: 'boolean', description: 'keep the runner alive after the run so tracelight_value eval and expand can read the finished program; release ends it' },
          auto_log: { type: 'boolean', description: 'log the value of every assignment and call, as the editor does with auto-log on' },
          node: { type: 'string', description: 'the Node or Bun executable that runs the program (`bun` looks it up on PATH)' },
          cwd: { type: 'string', description: "the program's working directory (default: the file's directory)" },
          test: { type: 'string', description: 'run only this node:test test of the file: its name, or "suite test"' },
        },
        required: ['file'],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    {
      name: 'tracelight_map',
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
          prose: { type: 'string', description: 'tour: a tour.prose.json to check against the run and merge (give the same goal and budget)' },
          out: { type: 'string', description: 'tour: write the tour, merged with prose, to this file' },
          expand: { type: 'array', items: { type: 'string' }, description: 'graph: unroll these packages into their functions' },
          no_statements: { type: 'boolean', description: 'graph: no statement nodes, only modules, functions, packages and decisions' },
          dot: { type: 'boolean', description: 'graph: print a Graphviz digraph instead of the text form' },
          before: { type: 'string', description: 'diff: the run.json from before the edit' },
          after: { type: 'string', description: 'diff: the run.json from after the edit (or live: true for the open session)' },
        },
        required: ['action'],
      },
      annotations: readOnly,
    },
    {
      name: 'tracelight_step',
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
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    {
      name: 'tracelight_value',
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
      name: 'tracelight_coverage',
      title: 'Coverage',
      description: (helps.coverage || 'which statements ran: per file the lines that ran, the ones that never did and the partial ones') + '. Lines are statement lines; a line marked partial ran only in part (a branch arm or a short-circuit that never ran), raised is where an exception came from.',
      inputSchema: { type: 'object', properties: { ...src, file: { type: 'string', description: 'also list this file line by line with hit counts' } } },
      annotations: readOnly,
    },
    {
      name: 'tracelight_debug',
      title: 'Live debugger',
      description: "Drive Tracelight's debugger in VS Code (the extension must be installed; the window opens on start). Every action that runs the program returns the next stop the way tracelight_step prints one.\n" + actionList(DEBUG_ACTIONS.filter((a) => a !== 'status'), helps, DEBUG_COMMAND) + '\n- status: the live session\'s state without moving it; with wait_seconds, first wait up to that long for the running program to pause (a breakpoint, or the person stepping in VS Code) or finish',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: [...DEBUG_ACTIONS] },
          session: src.session,
          json: src.json,
          file: { type: 'string', description: "start: the file to debug (omit to debug the open session's file)" },
          args: { type: 'array', items: { type: 'string' }, description: 'start: arguments for the program' },
          cwd: { type: 'string', description: "start: working directory (default: the file's directory)" },
          env: { type: 'object', additionalProperties: { type: 'string' }, description: 'start: environment variables for the program' },
          node: { type: 'string', description: "start: the node binary (default: the window's)" },
          at: { type: 'array', items: { type: 'string' }, description: 'start, break: stop at these FILE:LINEs or function names (rrf, Ranker.rank)' },
          record: { type: 'boolean', description: 'start: also record the run, so tracelight_step back moves and why work at every pause' },
          record_from: { type: 'string', description: 'start: run at full speed to this NAME or FILE:LINE, then record from there' },
          library_code: { type: 'boolean', description: 'start: step into and pause inside third-party packages too' },
          stop_on_entry: { type: 'boolean', description: 'start, restart: pause before the first statement' },
          no_focus: { type: 'boolean', description: 'start: do not bring the VS Code window to the front at the first stop' },
          until: { type: 'string', description: 'continue: run until this expression is true' },
          to: { type: 'string', description: 'continue: run to this FILE:LINE' },
          no_wait: { type: 'boolean', description: 'continue, pause: answer at once instead of waiting for the stop' },
          add: { type: 'array', items: { type: 'string' }, description: 'break: FILE:LINE breakpoints to add; watches: expressions to add' },
          when: { type: 'string', description: 'break: only pause when this expression is true at the added line' },
          log_message: { type: 'string', description: 'break: log this message with pure {expression} substitutions instead of pausing at added lines' },
          clear: { type: 'boolean', description: 'break: remove all breakpoints from the selected session and editor' },
          names_only: { type: 'boolean', description: 'locals: return binding names and types without formatting values' },
          names: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1 }, description: 'locals: only read these named bindings in the selected frame and its lexical scopes' },
          remove: { type: 'array', items: { type: 'string' }, description: 'break: FILE:LINE or function names to remove; watches: watch ids to remove' },
          on_exception: { type: 'string', enum: ['off', 'uncaught', 'raised'], description: 'break: when an exception pauses the run' },
          break_when: { type: 'string', enum: ['change', 'true'], description: 'watches: make the added watches pause the run on change, or when true' },
          frame: { type: 'integer', description: 'locals, exec: which frame of the pause, innermost 0' },
          source: { type: 'string', description: 'exec: the statement to run in the paused frame (it changes the program\'s state)' },
          configuration: { type: 'string', description: 'start: take program, args, cwd, env, envFile and runtimeExecutable from this Node or Bun configuration of the nearest .vscode/launch.json above file or cwd; arguments given here win' },
          test: { type: 'string', description: 'start: run only this node:test test of the file (its name, or "suite test")' },
          scope: { type: 'string', enum: ['local', 'global', 'all'], description: "locals: local is the paused function's own scopes, global what the program added to the global object, all every scope plus those globals (default: the frame's lexical scopes)" },
          wait_seconds: { type: 'integer', minimum: 0, maximum: 600, description: 'status: wait up to this many seconds for a running program to pause or finish; returns at once when it is paused already' },
        },
        required: ['action'],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    {
      name: 'tracelight_investigate',
      title: 'Investigate recorded execution',
      description: 'Read one saved recording without executing the program. Bundles a selected value\'s history, context, why/origin chain, exceptions (including handled failures), and coverage. Without a value, start at the first recorded exception when available. Links distinguish recorded evidence from inference; notes and response.omissions disclose missing or shortened evidence. Returns structuredContent and matching JSON text. Use tracelight_step/tracelight_value to expand the cited steps.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: {
          run: { type: 'string', minLength: 1, maxLength: 4096, description: 'saved JS/TS run.json to investigate' },
          value: { type: 'string', minLength: 1, maxLength: 256, description: 'variable or property path to follow, e.g. total or order.price' },
          at: { type: 'integer', minimum: 0, description: 'recorded step to explain; otherwise first suspicious value or last recorded change' },
          limit: evidenceLimit,
        }, required: ['run'],
      },
      outputSchema: { type: 'object' },
      annotations: savedReadOnly,
    },
    {
      name: 'tracelight_verify',
      title: 'Check recorded fix expectations',
      description: 'Compare two saved recordings and check explicit final-value expectations. Never reruns a program, writes a file or controls a live session. verified is true only when every expectation matches a complete successful after recording; it does not prove correctness for other inputs. A mismatch or incomplete recording returns verified:false as a successful tool answer. ignore filters comparison facts, never checks. Returns bounded structuredContent and matching JSON text; response.omissions describes shortened detail.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: {
          before: { type: 'string', minLength: 1, maxLength: 4096, description: 'saved baseline JS/TS run.json' },
          after: { type: 'string', minLength: 1, maxLength: 4096, description: 'saved JS/TS run.json after the edit' },
          expect: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 2 }, description: 'NAME=TEXT expectations using exact recorded text, e.g. ["total=3"]; at most 8192 UTF-8 bytes total' },
          ignore: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 256 }, description: 'value/log names to ignore in the comparison, never in expectation checks' },
          limit: evidenceLimit,
        }, required: ['before', 'after', 'expect'],
      },
      outputSchema: { type: 'object' },
      annotations: savedReadOnly,
    },
    {
      name: 'tracelight_history',
      title: 'Code-history data',
      description: (helps.history || 'the data behind a code-history page') + '. Writes the JSON to `out`; every value in it comes from the run. Checkpoints: `at` steps or FILE:LINEs, a checkpoint per change of each `var`, the provenance chain of each `why`, or the live pause.',
      inputSchema: {
        type: 'object',
        properties: {
          ...src,
          out: { type: 'string', description: 'where the data JSON goes (required)' },
          at: { type: 'array', items: { type: 'string' }, description: 'checkpoints at these steps or at the first step on these FILE:LINEs' },
          var: { type: 'array', items: { type: 'string' }, description: 'a checkpoint per recorded change of each name, in step order' },
          why: { type: 'array', items: { type: 'object', properties: { step: { type: 'integer' }, name: { type: 'string' } }, required: ['step', 'name'] }, description: 'checkpoints for the provenance chain of name after step' },
          pause: { type: 'boolean', description: "with live: a checkpoint from the debug session's current pause, read without moving it" },
          prose: { type: 'string', description: 'a JSON file whose prose fields are merged in (it may not set a generated field)' },
          pad: { type: 'integer', description: 'source lines of context above and below each block (default 2)' },
          limit: { type: 'integer', description: 'most checkpoints one var may produce (default 20)' },
          lang: { type: 'string', enum: ['en', 'es'], description: "the page's language (default en)" },
          scope: { type: 'boolean', description: 'lift the 60-line block cap on every checkpoint' },
          append: { type: 'boolean', description: 'add these checkpoints to the page at out instead of replacing it' },
          value_chars: { type: 'integer', description: 'characters of one value on a card (0 shows every value whole)' },
        },
        required: ['out'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'tracelight_learn',
      title: 'Practice a checkpoint',
      description: (helps.learn || 'choose meaningful checkpoints, predict a result, then reveal the recorded evidence') + '. Without at it lists checkpoints; with at it hides the recorded values until reveal, and keeps a prediction beside them.',
      inputSchema: {
        type: 'object',
        properties: {
          ...src,
          at: { type: 'integer', description: 'the checkpoint step to practice' },
          prediction: { type: 'string', description: "the learner's prediction, kept beside the observed result" },
          reveal: { type: 'boolean', description: 'show the recorded values at the checkpoint' },
        },
      },
      annotations: readOnly,
    },
    {
      name: 'tracelight_pin',
      title: 'Pin a baseline',
      description: (helps.pin || 'keep a private baseline recording without rerunning the program') + '. The copy at out is what tracelight_verify compares a later run with; an existing file is never overwritten.',
      inputSchema: { type: 'object', properties: { ...src, out: { type: 'string', description: 'the new baseline file (required; refuses to overwrite)' } }, required: ['out'] },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'tracelight_narrate',
      title: 'Narrate a walkthrough',
      description: (helps.narrate || 'ask a model for one sentence of gloss per walkthrough moment and store it in the saved run') + '. It runs a model command (claude -p, else codex exec) and writes the gloss into the run; dry_run prints the prompt instead.',
      inputSchema: {
        type: 'object',
        properties: {
          ...src,
          command: { type: 'string', description: 'the model command: prompt on stdin, answer on stdout (default: claude -p, else codex exec)' },
          dry_run: { type: 'boolean', description: 'print the prompt instead of running the command' },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    {
      name: 'tracelight_page',
      title: 'Browser page',
      description: 'The Tracelight browser page: a code pane, the Time Machine, the live debugger and narration bubbles for a person watching. open starts the page for a file (nothing runs until debug start or run) and returns its URL, which a person opens in exactly one browser tab; every other action is sent to that tab. Actions: open, close (a page this server started), list; state and position (is the shown source ready to teach from); goto, step (kinds ' + PAGE_STEP_KINDS.join(', ') + '), line, start, stop, run, story move the recording; debug with op ' + PAGE_DEBUG_OPS.join(', ') + ' drives the live debugger; breakpoint sets one; say and clear manage narration bubbles; values, inspect, peek show captured bindings; eval, var, why, watch read values; profile runs the CPU profiler; wait_pause waits up to 25 s for the person to step.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: [...PAGE_ACTIONS] },
          port: { type: 'integer', description: "the page's port (default 4777, or TRACELIGHT_PORT)" },
          file: { type: 'string', description: 'open: the file to serve; line, say, values, breakpoint: an imported file instead of the main one' },
          runtime: { type: 'string', description: 'open: js, node, bun, or a command line for the runtime' },
          node: { type: 'string', description: 'open: the Node or Bun executable for the program' },
          only: { type: 'array', items: { type: 'string' }, description: 'open: record only files matching these patterns' },
          no_run: { type: 'boolean', description: 'open: false records the file at once (default true: nothing runs until asked)' },
          no_watch: { type: 'boolean', description: 'open: do not rerun when the file changes on disk' },
          open_browser: { type: 'boolean', description: "open: also open the URL in the system's browser" },
          step: { type: 'integer', description: 'goto: the recorded step; say: anchor the note at this step; why: after this step' },
          kind: { type: 'string', description: 'step: ' + PAGE_STEP_KINDS.join(', ') + ' (default into); debug with op step: into, over or out (default over)' },
          op: { type: 'string', enum: [...PAGE_DEBUG_OPS], description: 'debug: what the live debugger does (default state)' },
          line: { type: 'integer', description: 'line: the next pass of this line; say: anchor line; values: anchor line; breakpoint: the line' },
          say: { type: 'string', description: 'goto, step, line, debug: a narration bubble at the new position' },
          text: { type: 'string', description: 'say: the note text' },
          note_id: { type: 'string', description: 'say: update this note; clear: remove only this note' },
          note_kind: { type: 'string', enum: ['explanation', 'prediction'], description: 'say: what the note is' },
          mode: { type: 'string', description: 'values: selected, all or none (default selected); position: live, recorded or visible' },
          focus: { type: 'boolean', description: 'position: reveal that source without running anything' },
          names: { type: 'array', items: { type: 'string' }, description: 'values, inspect: the binding names to show' },
          name: { type: 'string', description: 'peek, var, why: a binding or property path (peek with an empty name dismisses the hover); inspect: one binding' },
          visible: { type: 'boolean', description: 'inspect: false closes the cards for these names (default true)' },
          expression: { type: 'string', description: 'eval: the expression (in the paused frame when the debugger is paused); watch: the watch expression' },
          remove: { type: 'boolean', description: 'watch: drop the watch with this text' },
          on: { type: 'boolean', description: 'breakpoint: true sets, false clears (default toggles)' },
          condition: { type: 'string', description: 'breakpoint: only pause when this expression is true' },
          after: { type: 'integer', description: 'wait_pause: the cursor of the pause already seen; omit to read the current cursor' },
          timeout_ms: { type: 'integer', minimum: 0, maximum: 25000, description: 'wait_pause: how long to wait (at most 25,000 ms)' },
          expect: { type: 'object', description: 'refuse the command unless the page shows this context: source (live|recording), runId, step, frame, file' },
        },
        required: ['action'],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    {
      name: 'tracelight_scratchpad',
      title: 'Browser scratchpad',
      description: "The browser page's scratchpad: run a copied function with copied paused inputs in a separate process, beside the live pause, which it never moves. Prepare a teaching experiment in ONE call with op experiment and complete code, inputs, mocks and mock_labels; read status, result.values, result.error, result.missingMocks and ready. Other ops: open (the function at the pause, or at line), close, state, update, run, restore, create, save, list, load, history. Fixture results are simulations; label every mock.",
      inputSchema: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: [...SCRATCH_OPS] },
          port: { type: 'integer', description: "the page's port (default 4777, or TRACELIGHT_PORT)" },
          id: { type: 'string', description: 'load, history, save: the scratchpad id (list names them)' },
          title: { type: 'string', description: 'create: the new scratchpad\'s name' },
          file: { type: 'string', description: 'create: the source file the copied code resolves imports from' },
          version: { type: 'integer', description: 'load, history: a saved version (default the latest)' },
          line: { type: 'integer', description: 'open: copy the function at this line of the shown file' },
          code: { type: 'string', description: 'experiment, update: the whole scratch code' },
          inputs: { type: 'object', description: 'experiment, update: the input values by name (replaces the whole object)' },
          mocks: { type: 'object', description: 'experiment, update: fixture return values by dotted function path (replaces the whole object)' },
          mock_labels: { type: 'object', additionalProperties: { type: 'string' }, description: 'experiment, update: a label per mock path saying what the fixture stands for' },
          auto_run: { type: 'boolean', description: 'experiment, update: rerun on every edit' },
          expect: { type: 'object', description: 'refuse unless the page shows this context: source, runId, step, frame, file' },
        },
        required: ['op'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ...workflowDefinitions,
  ];
}
