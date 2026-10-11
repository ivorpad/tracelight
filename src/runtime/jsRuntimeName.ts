/**
 * The JS/TS runtime's name and environment prefix, read from the runtime itself
 * (`node/src/protocol.ts`), so a rename there reaches the extension without a second edit.
 */
export { NAME as JS_RUNTIME_NAME, ENV as JS_RUNTIME_ENV } from '../../node/src/protocol';
