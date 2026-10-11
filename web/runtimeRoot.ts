/** Where the bridge finds the runtime it spawns, and the tour and narration files next to it. */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The runtime's directory: the build's copy (`dist/node`), else the checkout's `node/`. */
export function runtimeRoot(distDir: string): string {
  const candidates = [path.join(distDir, 'node'), path.join(distDir, '..', 'node')];
  return candidates.find((d) => fs.existsSync(path.join(d, 'bin', 'tracelight.mjs'))) ?? candidates[candidates.length - 1]!;
}
