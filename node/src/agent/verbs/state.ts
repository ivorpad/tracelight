/** `state`: what the run is, file, steps, exit code, staleness (Pyokka's `pyokka state`). */
import { registerVerb } from '../commands.ts';
import { renderState } from '../render.ts';

registerVerb({
  name: 'state',
  help: 'what the run is: file, steps, exit code, staleness',
  run: (source) => source.state(),
  render: renderState,
});
