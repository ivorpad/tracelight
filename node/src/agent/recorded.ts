import { AgentError, SavedRun } from './source.ts';

/** Historical evidence must use the source that ran, never a later edit on disk. */
export class RecordedRun extends SavedRun {
  private readonly recordedSources = new Map<number, string[]>();
  constructor(path: string, doc?: unknown) {
    super(path, doc);
    if (this.meta.language !== undefined && this.meta.language !== 'javascript') {
      throw new AgentError('This is not a JavaScript or TypeScript recording.', 'Use the runtime that produced this recording.');
    }
  }
  override sourceLines(fileId: number): string[] {
    let lines = this.recordedSources.get(fileId);
    if (!lines) {
      const kept = this.keptSource(this.filePath(fileId));
      lines = kept === null ? [] : kept.split('\n');
      this.recordedSources.set(fileId, lines);
    }
    return lines;
  }
}
