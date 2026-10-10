/** The REPL rule for `exec`: a trailing expression is shown; an assignment or a declaration is not. */
import { parseSync } from 'oxc-parser';

export function showsValue(source: string): boolean {
  const res = parseSync('tracelight-exec.js', source, { sourceType: 'script' });
  if (res.errors.length) return true;
  const last = res.program.body.at(-1);
  if (!last || last.type !== 'ExpressionStatement') return false;
  const t = (last as any).expression.type;
  return t !== 'AssignmentExpression' && t !== 'UpdateExpression';
}
