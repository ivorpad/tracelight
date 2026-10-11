/**
 * `tour`: chapters and candidate stops of a recorded run (docs/TOUR.md), as Pyokka's `agent/tour/`.
 *
 *     model     `TourRun`: per-step arrays, scopes, moments, HTTP rows and local changes of a `SavedRun`
 *     astinfo   what a statement is (oxc AST): its calls, what each reaches, whether it keeps a result
 *     chapters  top-level calls, then phases inside a long call, never through concurrent work
 *     signals   spine, crossing, io, exception, narrative, evidence: the steps worth a stop and why
 *     rank      novelty for repeated lines, scores, the token budget
 *     values    what the program held at a candidate, and how a long or repeated value is shaped
 *     build     `buildTour`: `tour.json`
 *     prose     `--prose`: check tour.prose.json against the run, then merge it
 *     text      the text form
 *     py        Python's lengths, rounding and JSON sizes, so the budget counts as Pyokka's
 * The verb is `../verbs/tour.ts`.
 */
export { DEFAULT_BUDGET, buildTour } from './build.ts';
export { renderTour } from './text.ts';
