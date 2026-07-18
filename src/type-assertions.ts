// Compile-level-only assertions (Spec 03 A4 and friends). These functions are never invoked at
// runtime — their sole purpose is to make `@ts-expect-error` assertions about vendored wire
// types actually type-checked by `tsc --noEmit`.
//
// IMPORTANT: `tsconfig.json`'s `exclude` drops `src/**/*.test.ts` from the `tsc --noEmit` program
// (Spec 01 R6 test-runner note), and `tsx --test` runs test files through esbuild, which strips
// types without type-checking them. A `@ts-expect-error` comment living inside a `*.test.ts` file
// therefore provides ZERO compile-time protection — `npm run typecheck` never sees it, and
// `npm test` never type-checks it either. This file is a plain `.ts` module (picked up by
// `tsconfig.json`'s `include: ["src/**/*.ts"]`), so its `@ts-expect-error` lines are real,
// enforced assertions: flip the underlying field to a wrongly-typed value and `npm run typecheck`
// fails; revert it and `npm run typecheck` passes.
//
// `export {}` below is required only so this file is treated as a module (not a global script)
// under `isolatedModules`/`verbatimModuleSyntax` — otherwise its top-level `void` statements etc.
// would need no export, but an explicit empty export keeps intent unambiguous.

import type { TwilioMediaMessage } from './twilio-media.js';

/**
 * A4 (Spec 03 R3, findings/03 claim 4/gotcha 4): the vendored inbound `media` message type must
 * declare `chunk`/`timestamp` as `string` — Twilio sends these numeric-looking fields as wire
 * STRINGS, never numbers. Assigning a `number` literal here must be a type error; if either
 * `@ts-expect-error` below stops being needed (i.e. the assignment no longer errors), `tsc` fails
 * the build with "Unused '@ts-expect-error' directive" — so this check is red in BOTH directions.
 */
function _typeCheckMediaNumericsAreStrings(): void {
  const msg: TwilioMediaMessage = {
    event: 'media',
    sequenceNumber: '1',
    streamSid: 'MZ1',
    media: {
      track: 'inbound',
      // @ts-expect-error chunk is a wire STRING, never a number
      chunk: 1,
      // @ts-expect-error timestamp is a wire STRING, never a number
      timestamp: 12345,
      payload: 'AQ==',
    },
  };
  void msg;
}
void _typeCheckMediaNumericsAreStrings;

export {};
