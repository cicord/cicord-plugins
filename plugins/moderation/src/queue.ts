/** Keep a member's commands, gateway changes, appeal decisions and expiry tasks ordered. */
const queues = new Map<string, Promise<void>>();
export async function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let unlock!: () => void;
  const completed = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const tail = previous.then(() => completed);
  queues.set(key, tail);
  await previous;
  try {
    return await work();
  } finally {
    unlock();
    if (queues.get(key) === tail) queues.delete(key);
  }
}
