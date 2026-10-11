/**
 * `watch`: one line per stop while the user steps in VS Code, until Ctrl-C (Pyokka's `pyokka
 * watch`). It follows a live session (`source.watch`); a saved run does not move, so it is refused.
 */
import { NAME } from '../../protocol.ts';
import { pyDumps, registerVerb } from '../commands.ts';
import { oneLine } from '../render.ts';
import { redact } from '../redact.ts';
import { AgentError } from '../source.ts';

type Msg = Record<string, any>;

/** the line a streamed event prints as; the live module replaces it with Pyokka's `watch_line` */
export const watchFormat: { line: (event: Msg, source: Msg) => string } = {
  line: (event) => `${event.event ?? ''} ${oneLine(JSON.stringify(event))}`,
};

registerVerb({
  name: 'watch',
  help: '--live: print one line per stop while the user steps in VS Code, until Ctrl-C',
  async stream(source, args, out) {
    if (typeof source.watch !== 'function') throw new AgentError('watch follows the user\'s stepping in VS Code, so it needs --live', `\`${NAME} watch --live\`; a saved run does not move`);
    let stop: () => void = () => {};
    const interrupted = new Promise<void>((res) => {
      stop = res;
      process.once('SIGINT', res);
    });
    await Promise.race([source.watch((ev: Msg) => out((args.json ? pyDumps(ev) : redact(watchFormat.line(ev, source))) + '\n')), interrupted]);
    stop();
    return 0;
  },
});
