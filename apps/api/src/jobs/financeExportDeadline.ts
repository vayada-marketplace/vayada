import type pg from "pg";

// Used only by the isolated one-shot pool. Its connections are destroyed on
// release, so session timeout settings cannot leak into the normal worker.
export function exportDeadlineClient(
  client: pg.PoolClient,
  deadline: () => number,
  clock: () => Date = () => new Date(),
): pg.PoolClient {
  let released = false;
  let timer: ReturnType<typeof setTimeout>;
  const close = () => {
    clearTimeout(timer);
    if (!released) {
      released = true;
      client.release(true);
    }
  };
  const remaining = () => {
    const budget = Math.floor(deadline() - clock().getTime());
    if (released || !Number.isFinite(budget) || budget <= 0) {
      close();
      throw new Error("one_shot_deadline_passed");
    }
    clearTimeout(timer);
    timer = setTimeout(close, budget);
    timer.unref();
    return Math.min(45_000, budget);
  };
  remaining();
  return new Proxy(client, {
    get(target, property) {
      if (property === "release") return close;
      if (property !== "query") return Reflect.get(target, property);
      return async (text: string, values?: unknown[]) => {
        // Server-side cancellation bounds lock/query execution. The client
        // timeout also bounds a missing response; that outcome is ambiguous.
        const budget = remaining();
        const timeoutConfig = {
          text: "SELECT set_config('statement_timeout',$1,false)",
          values: [String(budget)],
          query_timeout: budget,
        };
        await target.query(timeoutConfig);
        const config = { text, values, query_timeout: remaining() };
        const result = await target.query(config);
        remaining(); // Never report a late COMMIT response as verified success.
        return result;
      };
    },
  });
}
