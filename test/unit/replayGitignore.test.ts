import { describe, expect, it, vi } from 'vitest';
import { appendGitignoreLine, gitignoreCoversReplay } from '../../src/features/replayGitignore';

// the module imports vscode for the prompt; the pure helpers under test never touch it
vi.mock('vscode', () => ({}));

describe('gitignoreCoversReplay', () => {
  it('accepts the replay directory, its parent and the alternate directory, anchored or not, with or without a slash', () => {
    for (const line of ['.tracelight', '.tracelight/', '.tracelight/replay', '.tracelight/replay/', '.tracelight-replay', '.tracelight-replay/', '/.tracelight/replay/', '**/.tracelight/', '  .tracelight/replay/  ', '.tracelight/**', '.tracelight/*', '.tracelight/replay/**', '.tracelight-replay/*']) {
      expect(gitignoreCoversReplay(`node_modules/\n${line}\ndist/\n`), line).toBe(true);
    }
  });
  it('rejects unrelated, commented or negated lines and an empty file', () => {
    for (const text of ['', 'node_modules/\ndist/\n', '# .tracelight/replay/\n', '!.tracelight/replay/\n', '.tracelight.json\n', '.tracelight/cache/\n', 'tracelight/replay/\n', '*.jsonl\n']) {
      expect(gitignoreCoversReplay(text), JSON.stringify(text)).toBe(false);
    }
  });
  it('reads CRLF files', () => {
    expect(gitignoreCoversReplay('dist/\r\n.tracelight/replay/\r\n')).toBe(true);
  });
});

describe('appendGitignoreLine', () => {
  it('starts a missing file with the line', () => {
    expect(appendGitignoreLine('', '.tracelight/replay/')).toBe('.tracelight/replay/\n');
  });
  it('keeps the text and ends it with exactly one newline before the line', () => {
    expect(appendGitignoreLine('dist/', '.tracelight/replay/')).toBe('dist/\n.tracelight/replay/\n');
    expect(appendGitignoreLine('dist/\n', '.tracelight/replay/')).toBe('dist/\n.tracelight/replay/\n');
    expect(appendGitignoreLine('dist/\n\n\n', '.tracelight/replay/')).toBe('dist/\n.tracelight/replay/\n');
    expect(appendGitignoreLine('# keep\ndist/\r\n', '.tracelight-replay/')).toBe('# keep\ndist/\n.tracelight-replay/\n');
  });
});
