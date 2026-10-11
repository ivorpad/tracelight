/** Offset <-> position over a source text: lines 1-based, columns 0-based UTF-16 units (oxc's offsets). */
import type { Range } from './protocol.ts';

export class LineIndex {
  readonly starts: number[] = [0];
  readonly text: string;

  constructor(text: string) {
    this.text = text;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      if (ch === 10) this.starts.push(i + 1);
      else if (ch === 13 && text.charCodeAt(i + 1) !== 10) this.starts.push(i + 1);
    }
  }

  line(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  pos(offset: number): [number, number] {
    const line = this.line(offset);
    return [line, offset - this.starts[line - 1]!];
  }

  range(start: number, end: number): Range {
    const [sl, sc] = this.pos(start);
    const [el, ec] = this.pos(end);
    return [sl, sc, el, ec];
  }

  offset(line: number, col: number): number {
    return (this.starts[line - 1] ?? this.text.length) + col;
  }
}
