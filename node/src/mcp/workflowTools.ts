import { AgentError } from '../agent/source.ts';
import { saveInvestigation, openInvestigation } from '../agent/investigation.ts';
import { sessionState } from './session.ts';
import { seekRecorded } from './seek.ts';

type Args = Record<string, any>;
const text = { type: 'string', minLength: 1, maxLength: 4096 };
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const definitions = [
  { name: 'tracelight_session', title: 'Inspect sessions and positions',
    description: 'With no arguments list available sessions without connecting. With run inspect saved execution; with live or session inspect one existing live session. Separates livePause from recordedSelection and does not launch, move or claim the editor is showing either position.',
    properties: { run: text, live: { type: 'boolean' }, session: text, step: { type: 'integer', minimum: 0 } }, required: [], annotations: read },
  { name: 'tracelight_seek', title: 'Find a recorded destination',
    description: 'Find the first or last recorded value equal to exact recorded text, or execution of a file and line. Returns evidence and context without running the program or moving the live debugger. Use value plus equals, or file plus line. A missing match is not proof of absence from an incomplete recording.',
    properties: { run: text, value: { ...text, maxLength: 256 }, equals: { type: 'string', maxLength: 4096 }, file: text,
      line: { type: 'integer', minimum: 1 }, occurrence: { type: 'string', enum: ['first', 'last'] } }, required: ['run'], annotations: read },
  { name: 'tracelight_save_investigation', title: 'Save investigation checkpoints',
    description: 'Save a question and named recorded checkpoints to a new private artifact. Refuses overwrite. References the existing recording and its content hash; keep both files to reopen later. Never runs code or changes a live session.',
    properties: { path: text, run: text, question: text, checkpoints: { type: 'array', minItems: 1, maxItems: 20,
      items: { type: 'object', additionalProperties: false, properties: { name: { ...text, maxLength: 256 }, step: { type: 'integer', minimum: 0 } }, required: ['name', 'step'] } } },
    required: ['path', 'run', 'question', 'checkpoints'], annotations: { ...read, readOnlyHint: false, idempotentHint: false } },
  { name: 'tracelight_open_investigation', title: 'Resume a saved investigation',
    description: 'Reopen a question and recorded checkpoints. Checks the recording hash before returning evidence, uses the recorded source, and never resumes live execution.',
    properties: { path: text }, required: ['path'], annotations: read },
];

export const workflowDefinitions = definitions.map(({ properties, required, ...definition }) => ({ ...definition,
  inputSchema: { type: 'object', additionalProperties: false, properties, required }, outputSchema: { type: 'object' } }));

function validate(value: any, schema: any, at: string): void {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentError(`${at} must be an object`);
    for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties, key)) throw new AgentError(`unsupported argument ${at}.${key}`);
    for (const key of schema.required ?? []) if (value[key] === undefined) throw new AgentError(`${at}.${key} is required`);
    for (const [key, item] of Object.entries(value)) validate(item, schema.properties[key], `${at}.${key}`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) throw new AgentError(`${at} has an invalid item count`);
    value.forEach((item, i) => validate(item, schema.items, `${at}[${i}]`));
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value) || value < (schema.minimum ?? -Infinity)) throw new AgentError(`${at} must be an integer >= ${schema.minimum ?? 0}`);
  } else if (typeof value !== schema.type || (schema.type === 'string' && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)))) {
    throw new AgentError(`${at} must be a valid ${schema.type}`);
  }
  if (schema.enum && !schema.enum.includes(value)) throw new AgentError(`${at} must be one of ${schema.enum.join(', ')}`);
}

export async function callWorkflow(name: string, args: Args): Promise<Args> {
  const definition = workflowDefinitions.find(d => d.name === name);
  if (!definition) throw new AgentError(`unknown workflow ${name}`);
  validate(args, definition.inputSchema, 'arguments');
  switch (name) {
    case 'tracelight_session': return sessionState(args);
    case 'tracelight_seek': return seekRecorded(args as any);
    case 'tracelight_save_investigation': return saveInvestigation(args as any);
    case 'tracelight_open_investigation': return openInvestigation(args.path);
    default: throw new AgentError(`unknown workflow ${name}`);
  }
}
