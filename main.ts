// Entrypoint the grader runs as `node main.ts`.
//
// Wiring only: the wire shim (vendor/makefun-bot.ts) owns the stdin/stdout
// protocol, and strategy.ts owns every trading decision. This file contains
// no trading logic of its own.

import { runBot } from './vendor/makefun-bot.ts';
import { createBot } from './strategy.ts';

// Any protocol or order error rejects here; report it on stderr only
// (stdout carries replies alone) and exit non-zero.
await runBot(createBot()).catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
