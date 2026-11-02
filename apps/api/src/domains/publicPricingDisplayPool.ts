import pg from "pg";
import type { Pool, PoolClient, QueryConfig, QueryResult } from "pg";

/**
 * VAY-2458: a pool for display prices, which shows many stays at once (the agency page). The
 * price calculation is the one quotes use, so a card shows what the stay's own page shows. That
 * calculation locks the hotel's pricing inputs and its account row for a binding quote. A display
 * read must not take those locks: the account's own quotes and bookings would wait on it.
 *
 * Every connection here is read-only on the server (`default_transaction_read_only`), so a read
 * can never write. Each statement loses its row-lock clauses (`FOR UPDATE`, `FOR SHARE`, ...) and
 * each statement that is only a transaction-level advisory lock is skipped. The read then sees one
 * snapshot per statement instead of a frozen set of inputs: fine for showing a price, never for
 * binding one. The quote on /book stays the binding price.
 *
 * Anything else that could lock or write fails the read: another advisory lock, `READ WRITE`, a
 * row lock the rewrite missed (the server refuses it in a read-only transaction), or a write.
 */
export function createPublicPricingDisplayPool(config: {
  connectionString: string;
  max: number;
  connectionTimeoutMillis?: number;
}): Pool {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5000,
    options: "-c default_transaction_read_only=on -c lock_timeout=1s -c statement_timeout=3s",
  });
  return lockFreePool(pool);
}

/** Row-lock clauses: `FOR UPDATE | NO KEY UPDATE | SHARE | KEY SHARE [OF t, ...] [NOWAIT | SKIP LOCKED]`. */
const ROW_LOCK =
  /\bFOR\s+(?:NO\s+KEY\s+UPDATE|UPDATE|KEY\s+SHARE|SHARE)(?:\s+OF\s+[A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*)?(?:\s+(?:NOWAIT|SKIP\s+LOCKED))?/g;
const ADVISORY_LOCK_STATEMENT = /^\s*SELECT\s+pg_advisory_xact_lock\s*\(/i;
const ANY_ADVISORY = /\bpg_(?:try_)?advisory_/i;
const READ_WRITE = /\bREAD\s+WRITE\b/i;

/** The statement to run for display, or null when it is only an advisory lock to skip. */
export function displayStatement(sql: string): string | null {
  if (ADVISORY_LOCK_STATEMENT.test(sql) && onlyTheCall(sql)) return null;
  if (ANY_ADVISORY.test(sql)) throw new Error("Display prices refuse an advisory lock.");
  if (READ_WRITE.test(sql)) throw new Error("Display prices refuse a read-write transaction.");
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

async function displayQuery(
  run: (config: QueryConfig) => Promise<QueryResult>,
  config: unknown,
  values: unknown,
) {
  if (typeof values === "function") throw new Error("Display prices support promise queries only.");
  const query: QueryConfig =
    typeof config === "string"
      ? { text: config, ...(values !== undefined && { values: values as unknown[] }) }
      : config && typeof config === "object" && typeof (config as QueryConfig).text === "string"
        ? {
            ...(config as QueryConfig),
            ...(values !== undefined && { values: values as unknown[] }),
          }
        : (() => {
            throw new Error("Display prices support text queries only.");
          })();
  const text = displayStatement(query.text);
  return text === null ? SKIPPED : run({ ...query, text });
}

function lockFreeClient(client: PoolClient): PoolClient {
  const query = (config: unknown, values?: unknown, ...rest: unknown[]) =>
    rest.length
      ? Promise.reject(new Error("Display prices support promise queries only."))
      : displayQuery((next) => client.query(next), config, values);
  return new Proxy(client, {
    get(target, property) {
      if (property === "query") return query;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The pool with every client's statements made lock-free as above. */
export function lockFreePool(pool: Pool): Pool {
  const connect = async (...rest: unknown[]) => {
    if (rest.length) throw new Error("Display prices support promise connections only.");
    return lockFreeClient(await pool.connect());
  };
  const query = (config: unknown, values?: unknown, ...rest: unknown[]) =>
    rest.length
      ? Promise.reject(new Error("Display prices support promise queries only."))
      : displayQuery((next) => pool.query(next), config, values);
  return new Proxy(pool, {
    get(target, property) {
      if (property === "connect") return connect;
      if (property === "query") return query;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
