/**
 * Every agent verb `tracelight` has, one import per module; each module calls `registerVerb`
 * (`commands.ts`). A new verb is a new module under `verbs/` and one line here.
 */
import './verbs/story.ts';
import './verbs/steps.ts';
import './verbs/step.ts';
import './verbs/context.ts';
import './verbs/values.ts';
import './verbs/find.ts';
import './verbs/var.ts';
import './verbs/keep.ts';
import './verbs/state.ts';
import './verbs/watch.ts';
import './verbs/walkthrough.ts';
import './verbs/diff.ts';
import './verbs/why.ts';
import './verbs/origin.ts';
import './verbs/exceptions.ts';
import './verbs/graph.ts';
import './verbs/debugger.ts';
import './verbs/shell.ts';
import './verbs/coverage.ts';
import './verbs/history.ts';
import './verbs/narrate.ts';
import './verbs/tour.ts';
