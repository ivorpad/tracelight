import type { Finding } from '../types'

// The band's settings, and what one load of the plugin remembers outside its atoms (the atoms
// are in register.tsx, where the validator can read every update of them).

export const TRACELIGHT = ['tracelight']
/** Tracelight, the same CLI for JavaScript and TypeScript (`node/bin/tracelight.mjs`). */
export const TRACELIGHT = ['tracelight']
export const JS_FILE = /\.[mc]?[jt]sx?$/
/** The CLI that reads a program: `tracelight` for a JS/TS file, `tracelight` for the rest. */
export const cliFor = (path: string) => (JS_FILE.test(path) ? TRACELIGHT : TRACELIGHT)
/** The program's language, for the model prompts. */
export const languageOf = (path: string) => (/\.[mc]?tsx?$/.test(path) ? 'TypeScript' : JS_FILE.test(path) ? 'JavaScript' : 'Python')
/** How the program runs without the Time Machine, for a fix check. */
export const plainRun = (path: string) => (JS_FILE.test(path) ? ['node', path] : ['python3', path])
export const POLL_MS = 3000
export const FOLLOW_MS = 60_000
// With no tracelight or tracelight command, band press or band tool call for this long, the band steps aside.
export const IDLE_MS = 10 * 60_000
export const TRACELIGHT_COMMAND = /(^|[\s;&|/])(tracelight|tracelight|pk)(\s|$)/
export const NARRATOR = 'haiku'
export const FIXER = 'sonnet'
/**
 * Where a fix is checked: `.tracelight/band-tmp/` next to the program, beside the plans in
 * `.tracelight/findings/`. The host has no temp-directory call, and `/tmp` is not on every OS.
 */
export const scratchDir = (programPath: string) => `${programPath.slice(0, programPath.lastIndexOf('/'))}/.tracelight/band-tmp`
export const WINDOW_BEFORE = 3
export const WINDOW_AFTER = 6

/** A fix plan written this load: its path, and how to know its finding in a later run. */
export type PlanRecord = { path: string; kind: string; where: string; status: string }

// One load's memory, outside the atoms because no view draws it.
export const memory = {
  /** The session the band follows: the descriptor or file name the CLI named last. */
  session: undefined as string | undefined,
  /** The CLI of the session the band follows: the one the agent ran last, or the program's. */
  cli: TRACELIGHT,
  /** Narrations written this load, by step (and whether a finding was on it), or by pause. */
  narrations: new Map<string, string>(),
  /** The last thing shown was a debug pause without a recording. */
  wasPaused: false,
  /** How that pause ended, when a step of the band's ran the program to its end. */
  pauseEnded: undefined as string | undefined,
  /** The last narration shown: the narrator reads it so stops read as one story. */
  previous: '',
  /** The run the last bug scan covered (file, step count, stale), so each run is scanned once. */
  scannedRun: '',
  /** Source files by path, read once per load. */
  sources: new Map<string, string[]>(),
  plans: new Map<string, PlanRecord>(),
}

export const findingAt = (findings: Finding[] | undefined, step: number): Finding | undefined =>
  findings?.find(f => f.step === step)
