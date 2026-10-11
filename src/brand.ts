/**
 * Which extension this build is. One source tree builds two extensions (`esbuild.mjs`):
 * Pyokka, for Python files, and Tracelight (`tracelight/`), for JavaScript and TypeScript files on
 * the Node runtime in `node/`. They install side by side: Tracelight's build renames every
 * `pyokka` id (commands, settings, views, context keys, the debug type, `~/.pyokka`, `PYOKKA_*`) to
 * `tracelight` (`scripts/brand.mjs`), so the two never share a command, a setting or a directory.
 *
 * The few places where the two extensions behave differently, not just carry another name, test
 * `IS_TRACELIGHT` (which languages run, which CLI shim is written, where the runtime is). Never
 * compare with the string 'pyokka': Tracelight's build renames that literal too.
 * Unbundled code (unit tests) is Pyokka.
 */
declare const __BRAND__: string | undefined;

export const IS_TRACELIGHT: boolean = typeof __BRAND__ === 'string' && __BRAND__ === 'tracelight';
