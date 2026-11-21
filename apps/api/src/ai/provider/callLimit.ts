/**
 * The provider-call limit across all hotels and AI features (plan 3.7): at most `max` model calls
 * run at once in this process; others wait up to `waitMs`, then give up. next-api runs as one task,
 * so this is the global limit; for the few seconds two tasks overlap in a deploy it doubles.
 */
export type CallLimit = {
  /** Resolves to a release function, or null when no place came free in time. */
  acquire(): Promise<(() => void) | null>;
};

export function createCallLimit(max: number, waitMs: number): CallLimit {
  let running = 0;
  const waiting: (() => void)[] = [];

  function grant(): () => void {
    running += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      running -= 1;
      waiting.shift()?.();
    };
  }

  return {
    acquire() {
      if (running < max) return Promise.resolve(grant());
      return new Promise((resolve) => {
        const next = () => {
          clearTimeout(timer);
          resolve(grant());
        };
        const timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(next), 1);
          resolve(null);
        }, waitMs);
        waiting.push(next);
      });
    },
  };
}
