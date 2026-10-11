import { expect, test } from 'claude-code/testing'

import { narrationPrompt } from '../hooks/narration'
import { fixPrompt } from '../hooks/fix'
import { toFindings, toSpot } from '../hooks/parse'
import type { RawFinding } from '../hooks/parse'
import { planPath } from '../hooks/plans'
import { cliFor, languageOf, plainRun } from '../hooks/state'
import { CONTEXT_64, EXCEPTIONS_CAUGHT } from './fixtures'
import { BAND, engine, newWorld } from './world'

// The band on a JavaScript / TypeScript session: it speaks `tracelight` instead of `tracelight`,
// runs the program with node and says the language in its prompts.

const TS_CONTEXT = JSON.parse(JSON.stringify(CONTEXT_64).replaceAll('/work/invoices.py', '/work/invoices.ts'))

test('a JS/TS file picks tracelight, node and its language; a Python file keeps tracelight', () => {
  expect(cliFor('/w/a.ts')).toEqual(['tracelight'])
  expect(cliFor('/w/a.mjs')).toEqual(['tracelight'])
  expect(cliFor('/w/a.tsx')).toEqual(['tracelight'])
  expect(cliFor('/w/a.py')).toEqual(['tracelight'])
  expect(plainRun('/w/a.js')).toEqual(['node', '/w/a.js'])
  expect(plainRun('/w/a.py')).toEqual(['python3', '/w/a.py'])
  expect(languageOf('/w/a.cts')).toBe('TypeScript')
  expect(languageOf('/w/a.jsx')).toBe('JavaScript')
  expect(languageOf('/w/a.py')).toBe('Python')
})

test('a tracelight command makes the band read the session with tracelight', async ($, on) => {
  const w = newWorld()
  w.context = TS_CONTEXT
  engine(on, w)
  await $.tool.call({ tool: 'Bash', command: 'tracelight step --live --to 64' })
  expect(w.runs[0]).toEqual(['tracelight', 'context', '--json', '--live'])
  const ui = await $.ui.mount({ plugin: 'tracelight-band', surface: 'terminal', component: 'AbovePrompt', props: BAND } as const)
  expect(await ui.find({ type: 'Text', text: 'invoices.ts:34' })).toBeDefined()
  // the band's own moves follow the session's CLI
  await $.tool.call({ tool: 'Bash', command: 'tracelight step --live --over' })
  expect(w.runs.every(r => r[0] === 'tracelight')).toBe(true)
})

test('prompts and plans name the TypeScript program', () => {
  const spot = toSpot(TS_CONTEXT)!
  const finding = toFindings(EXCEPTIONS_CAUGHT.rows as RawFinding[])[0]!
  expect(narrationPrompt(spot, '')).toContain('a recorded TypeScript run')
  expect(fixPrompt(finding, spot, 'const a = 1')).toContain('A TypeScript program ran to the end')
  expect(planPath('/work/invoices.ts', finding)).toMatch(/^\/work\/\.tracelight\/findings\/invoices-/)
})
