// What skills/tracelight's renderers need from npm, bundled once so a page renders with nothing
// installed: Handlebars, and Shiki cut down to JavaScript, TypeScript, TSX and Python, one theme
// and the JavaScript regex engine (no WASM). `scripts/build-render-deps.mjs` turns this into
// skills/tracelight/scripts/render-deps.cjs.
import Handlebars from 'handlebars/dist/cjs/handlebars.js';
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import javascript from '@shikijs/langs/javascript';
import typescript from '@shikijs/langs/typescript';
import tsx from '@shikijs/langs/tsx';
import python from '@shikijs/langs/python';
import githubDarkDimmed from '@shikijs/themes/github-dark-dimmed';

export { Handlebars };

let highlighter;
export const shiki = {
  bundledThemes: { 'github-dark-dimmed': githubDarkDimmed },
  bundledLanguages: { javascript: true, typescript: true, tsx: true, python: true },
  async codeToTokens(code, options) {
    highlighter ??= await createHighlighterCore({ themes: [githubDarkDimmed], langs: [javascript, typescript, tsx, python], engine: createJavaScriptRegexEngine() });
    return highlighter.codeToTokens(code, options);
  },
};
