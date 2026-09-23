// SPDX-License-Identifier: Apache-2.0
// Escaping for what the tools print. Every string that comes from the chain,
// the indexer or a bundle goes through `printable` before it reaches a
// terminal, and `--json` output goes through `asciiJson`, so no such string can
// add report lines, move the cursor or hide text.

/** `JSON.stringify`, with every character outside ASCII escaped as `\uXXXX`. */
export function asciiJson(value, replacer, space) {
  return JSON.stringify(value, replacer, space)
    ?.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * A string from the chain or a bundle, made safe to print on a terminal: unchanged
 * when it is printable ASCII, otherwise a JSON string literal in which every other
 * character is escaped. No newline, escape sequence or bidirectional control
 * reaches the output, so such a string cannot forge or hide report lines.
 */
export function printable(s) {
  const t = String(s);
  return /^[\x20-\x7e]*$/.test(t) ? t : asciiJson(t);
}
