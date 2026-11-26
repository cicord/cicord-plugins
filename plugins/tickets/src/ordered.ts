import type { Context } from "@cicord/sdk";

// An instance may start a new callback while the preceding one awaits Discord. Keep
// multi-step writes ordered, including a queue-wide erase competing with a live reply.
// Isolated portal/action realms additionally use durable record revisions and atomic reservations.
let tail: Promise<void> = Promise.resolve();
export function ordered<A extends unknown[], R>(work: (ctx: Context, ...args: A) => Promise<R>) {
  return async (ctx: Context, ...args: A): Promise<R> => {
    const previous = tail;
    let finish!: () => void;
    tail = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await previous;
    try {
      return await work(ctx, ...args);
    } finally {
      finish();
    }
  };
}
