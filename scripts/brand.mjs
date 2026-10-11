/**
 * Tracelight's names from Pyokka's: one source tree builds both extensions (`src/brand.ts`), and
 * Tracelight's build passes every source file of the extension and the panel, its manifest, its
 * grammars and its snippets through `toTracelight`, so the two extensions never share a command id,
 * a setting, a view, a context key, a debug type, a language id, `~/.pyokka` or a `PYOKKA_*`
 * variable. `pyokka_runtime` (the Python package) keeps its name; a line that ends in
 * `// brand: keep` is left as it is (it names Pyokka on purpose).
 */
export function toTracelight(text) {
  return text
    .split('\n')
    .map((line) =>
      line.includes('brand: keep')
        ? line
        : line
            .replace(/(?<![A-Za-z0-9])pyokka(?!_runtime)/g, 'tracelight')
            .replace(/Pyokka/g, 'Tracelight')
            .replace(/PYOKKA/g, 'TRACELIGHT'),
    )
    .join('\n');
}

/** An esbuild plugin that renames the extension's and the panel's sources on load (`src/`, `webview/`). */
export function tracelightSources(root) {
  return {
    name: 'tracelight-names',
    setup(build) {
      build.onLoad({ filter: /\.(ts|tsx)$/ }, async (args) => {
        const rel = args.path.slice(root.length + 1);
        if (!/^(src|webview)\//.test(rel)) return undefined;
        const { readFile } = await import('node:fs/promises');
        return { contents: toTracelight(await readFile(args.path, 'utf8')), loader: args.path.endsWith('x') ? 'tsx' : 'ts' };
      });
    },
  };
}
