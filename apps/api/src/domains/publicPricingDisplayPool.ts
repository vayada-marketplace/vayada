import pg from "pg";
import type { Pool, PoolClient, PoolConfig, QueryConfig, QueryResult } from "pg";

/**
 * VAY-2458: a pool for display prices, which shows many stays at once (the agency page). The
 * price calculation is the one quotes use, so a card shows what the stay's own page shows. That
 * calculation locks the hotel's pricing inputs and its account row for a binding quote. A display
 * read must not take those locks: the account's own quotes and bookings would wait on it.
 *
 * Every transaction here is read-only and sees one snapshot (each `BEGIN` becomes `BEGIN
 * ISOLATION LEVEL REPEATABLE READ READ ONLY`, with lock and statement timeouts), so a read can
 * never write and a calculation's checks agree with each other. Each statement loses its row-lock
 * clauses (`FOR UPDATE`, `FOR SHARE`, ...) and each statement that is only a transaction-level
 * advisory lock is skipped. Fine for showing a price, never for binding one: the quote on /book
 * stays the binding price.
 *
 * Anything else that could lock or write fails the read: another advisory lock, `READ WRITE` or
 * another change to the transaction's mode, a statement outside a transaction (or on the pool
 * itself), a row lock the rewrite missed (the server refuses it in a read-only transaction), or a
 * write.
 *
 * At most `max` connections are checked out at once; further reads wait here, up to the
 * connection timeout, rather than in the pool. Production's pool runtime sizes every pool itself
 * and reports requests waiting in a pool as saturation (with an ops alert after 30 s), which an
 * agency page's many reads would set off on every search.
 */
export function createPublicPricingDisplayPool(
  config: { connectionString: string; max: number; connectionTimeoutMillis?: number },
  /** The pool class; production's pool runtime replaces `pg.Pool` (tests pass it in). */
  PoolClass: new (config: PoolConfig) => Pool = pg.Pool,
): Pool {
  const pool = new PoolClass(displayPoolConfig(config));
  // An idle client's error must not end the process; the next read on it fails instead.
  pool.on("error", () => undefined);
  return lockFreePool(pool, checkouts(config.max, config.connectionTimeoutMillis ?? 3000));
}

type Checkouts = { enter(): Promise<void>; leave(): void };

/** At most `size` at once; the rest wait in turn, each for at most `timeoutMs`. */
export function checkouts(size: number, timeoutMs: number): Checkouts {
  let busy = 0;
  const waiting: (() => void)[] = [];
  return {
    async enter() {
      if (busy < size) {
        busy++;
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(go), 1);
          reject(new Error("Display prices waited too long for a connection."));
        }, timeoutMs);
        waiting.push(go);
      });
    },
    leave() {
      // The place passes to the next in line, or frees up.
      const next = waiting.shift();
      if (next) next();
      else busy--;
    },
  };
}

/**
 * No session settings (`options`, timeouts): production's pool runtime would make the pool a
 * one-connection one (`hasClientTuning`), so each transaction sets its own. Its own application
 * name keeps it apart from the API's other pools, which the runtime shares when settings are equal.
 */
export function displayPoolConfig(config: {
  connectionString: string;
  max: number;
  connectionTimeoutMillis?: number;
}): PoolConfig {
  return {
    connectionString: config.connectionString,
    max: config.max,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 3000,
    application_name: "vayada-display-prices",
  };
}

/** Row-lock clauses: `FOR UPDATE | NO KEY UPDATE | SHARE | KEY SHARE [OF t, ...] [NOWAIT | SKIP LOCKED]`. */
const ROW_LOCK =
  /\bFOR\s+(?:NO\s+KEY\s+UPDATE|UPDATE|KEY\s+SHARE|SHARE)(?:\s+OF\s+[A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*)?(?:\s+(?:NOWAIT|SKIP\s+LOCKED))?/gi;
const ADVISORY_LOCK_STATEMENT = /^\s*SELECT\s+pg_advisory_xact_lock\s*\(/i;
const ANY_ADVISORY = /\bpg_(?:try_)?advisory_/i;
/** A change to the transaction's mode: `READ WRITE`, `SET TRANSACTION`/`SESSION ...`, `*read_only`. */
const MODE_CHANGE = /\bREAD\s+WRITE\b|\bSET\s+(?:SESSION|TRANSACTION)\b|read_only\b/i;
const BEGIN = /^\s*(?:BEGIN|START\s+TRANSACTION)\b[^;]*;?\s*$/i;
const END = /^\s*(?:COMMIT|ROLLBACK|END|ABORT)\s*;?\s*$/i;
/** One snapshot, read-only, giving up rather than waiting behind a migration or a slow plan. */
const DISPLAY_BEGIN =
  "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL lock_timeout = '1s'; SET LOCAL statement_timeout = '3s'";

/** The statement to run for display, or null when it is only an advisory lock to skip. */
export function displayStatement(sql: string): string | null {
  if (ADVISORY_LOCK_STATEMENT.test(sql) && onlyTheCall(sql)) return null;
  if (ANY_ADVISORY.test(sql)) throw new Error("Display prices refuse an advisory lock.");
  if (MODE_CHANGE.test(sql)) throw new Error("Display prices refuse a change to read-only mode.");
  return sql.replace(ROW_LOCK, "");
}

/** `SELECT pg_advisory_xact_lock(...)` with nothing after the call but an optional `;`. */
function onlyTheCall(sql: string) {
  const open = sql.indexOf("(");
  let depth = 0;
  for (let index = open; index < sql.length; index++) {
    const char = sql[index];
    if (char === "'" || char === '"') {
      // Skip a quoted literal or identifier; a doubled quote is an escaped one.
      const close = sql.indexOf(char, index + 1);
      if (close < 0) return false;
      index = close;
      continue;
    }
    if (char === "(") depth++;
    if (char === ")" && --depth === 0) return /^\s*;?\s*$/.test(sql.slice(index + 1));
  }
  return false;
}

const SKIPPED: QueryResult = {
  command: "SELECT",
  rowCount: 1,
  oid: 0,
  fields: [],
  rows: [{ pg_advisory_xact_lock: "" }],
};

function queryConfig(config: unknown, values: unknown): QueryConfig {
  if (typeof values === "function") throw new Error("Display prices support promise queries only.");
  if (typeof config === "string")
    return { text: config, ...(values !== undefined && { values: values as unknown[] }) };
  if (config && typeof config === "object" && typeof (config as QueryConfig).text === "string")
    return {
      ...(config as QueryConfig),
      ...(values !== undefined && { values: values as unknown[] }),
    };
  throw new Error("Display prices support text queries only.");
}

function lockFreeClient(client: PoolClient, leave: () => void): PoolClient {
  // Whether this checkout is inside a transaction it began here.
  let open = false,
    released = false;
  const release = (error?: Error | boolean) => {
    if (released) return;
    released = true;
    try {
      client.release(error);
    } finally {
      leave();
    }
  };
  const run = async (config: unknown, values: unknown) => {
    const query = queryConfig(config, values);
    if (BEGIN.test(query.text)) {
      if (open) throw new Error("Display prices run one transaction at a time.");
      if (MODE_CHANGE.test(query.text))
        throw new Error("Display prices refuse a change to read-only mode.");
      const results = (await client.query(DISPLAY_BEGIN)) as unknown as QueryResult[];
      open = true;
      return results[0]!;
    }
    if (END.test(query.text)) {
      open = false;
      return client.query(query);
    }
    if (!open) throw new Error("Display prices run only inside a read-only transaction.");
    const text = displayStatement(query.text);
    return text === null ? SKIPPED : client.query({ ...query, text });
  };
  const query = (config: unknown, values?: unknown, ...rest: unknown[]) =>
    rest.length
      ? Promise.reject(new Error("Display prices support promise queries only."))
      : run(config, values);
  return new Proxy(client, {
    get(target, property) {
      if (property === "query") return query;
      if (property === "release") return release;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The pool with every client's statements made lock-free and read-only as above, and its
 * checkouts limited by `limit` (none by default). */
export function lockFreePool(
  pool: Pool,
  limit: Checkouts = { enter: async () => undefined, leave: () => undefined },
): Pool {
  const connect = async (...rest: unknown[]) => {
    if (rest.length) throw new Error("Display prices support promise connections only.");
    await limit.enter();
    let client;
    try {
      client = await pool.connect();
    } catch (error) {
      limit.leave();
      throw error;
    }
    return lockFreeClient(client, () => limit.leave());
  };
  // A statement on the pool would run outside a read-only transaction.
  const query = () =>
    Promise.reject(new Error("Display prices run inside a transaction: use connect()."));
  return new Proxy(pool, {
    get(target, property) {
      if (property === "connect") return connect;
      if (property === "query") return query;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
