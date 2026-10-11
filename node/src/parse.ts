/**
 * oxc-parser with raw transfer when the platform has it: the AST is read straight out of the
 * parser's buffer instead of through JSON, about three times faster on a large library file
 * (typescript.js: 2.0 s to 0.66 s). Same ESTree, same UTF-16 offsets.
 */
import { ENV } from './protocol.ts';
import { parseSync as oxcParse, rawTransferSupported } from 'oxc-parser';

const RAW = (() => {
  try {
    return process.env[`${ENV}RAW_TRANSFER`] !== '0' && !!rawTransferSupported?.();
  } catch {
    return false;
  }
})();

export function parseSync(filename: string, source: string, options: Record<string, unknown>): any {
  return oxcParse(filename, source, (RAW ? { ...options, experimentalRawTransfer: true } : options) as any);
}
