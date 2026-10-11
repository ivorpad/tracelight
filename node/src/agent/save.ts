/**
 * The file helpers of Pyokka's `agent/save.py` the verbs need: a source file's text, and the hash
 * that tells whether it changed since the run (`meta.files[].sha256`, written by `cli.ts` `run --save`).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** the file as text with universal newlines (as Python's `decode_source` reads a source file) */
export function readText(path: string): string {
  return readFileSync(path, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** the hash `run --save` recorded for a file: sha256 of its UTF-8 text as read, null when unreadable */
export function fileHash(path: string): string | null {
  try {
    return sha256Text(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
