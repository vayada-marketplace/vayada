import pg from "pg";

const GENERAL_POOL_MAX = 8;
const SPECIALIZED_POOL_MAX = 1;
const CONNECTION_TIMEOUT_MS = 3_000;
const HEALTH_PROBE_TIMEOUT_MS = 2_000;
const HEALTH_PROBE_CACHE_MS = 5_000;
const KEEP_ALIVE_INITIAL_DELAY_MS = 10_000;
// A pool that is still full after this many waiter timeouts, with no client handed out since, has
// stopped serving (for example every slot hung on a peer that vanished in a failover).
const STALLED_POOL_TIMEOUTS = 5;
// pg-pool's message when a request waited connectionTimeoutMillis for an existing client.
const POOL_WAITER_TIMEOUT_MESSAGE = "timeout exceeded when trying to connect";
// SQLSTATEs for a refused, dropped or shutting-down connection (classes 08 and 57P, plus 53300).
const CONNECTION_FAILURE_STATES = new Set([
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "53300",
  "57P01",
  "57P02",
  "57P03",
]);
// Socket failures while reaching or holding a connection; only trusted from a runtime client.
const SOCKET_FAILURE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
]);
// pg and pg-pool messages for a connection that timed out or dropped.
const CONNECTION_FAILURE_MESSAGE =
  /^(?:timeout\b.*\btrying to connect|connection terminated\b.*\bconnection timeout|connection terminated unexpectedly|client has encountered a connection error and is not queryable|timeout expired)$/i;
// Connection failures raised by a runtime client, which may carry generic socket codes.
const connectionFailures = new WeakSet<object>();
type PgModule = Pick<typeof pg, "Pool">;
type ClientClass = typeof pg.Client;
type ConnectCallback = Parameters<pg.Client["connect"]>[0];
type PoolEntry = {
  pool: pg.Pool;
  references: number;
  closed: boolean;
  waiterTimeouts: number;
};
type OwnedListener = {
  event: string | symbol;
  original: (...arguments_: unknown[]) => void;
  wrapped: (...arguments_: unknown[]) => void;
};
type Logger = {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
};
type ConnectionErrorReporter = (fields: { code: string | null; error: string }) => void;

/** Resolves false while PostgreSQL does not answer; results are cached briefly. */
export type DatabaseHealthCheck = () => Promise<boolean>;

export type PostgresPoolSnapshot = Readonly<{
  physicalPoolCount: number;
  maxConnections: number;
  totalConnections: number;
  idleConnections: number;
  waitingRequests: number;
  stalledPools: number;
}>;

export function installPostgresPoolRuntime(postgres: PgModule = pg): {
  snapshot(): PostgresPoolSnapshot;
  startTelemetry(logger: Logger, intervalMs?: number): () => void;
  healthCheck(connectionString: string): DatabaseHealthCheck;
  close(): Promise<void>;
} {
  const OriginalPool = postgres.Pool;
  const entries = new Map<string, PoolEntry>();
  const clientClasses = new Map<ClientClass, ClientClass>();
  const probePools: pg.Pool[] = [];
  let unsharedPool = 0;
  let reportConnectionError: ConnectionErrorReporter = (fields) =>
    process.emitWarning("PostgreSQL client connection failed", {
      code: "POSTGRES_CONNECTION_ERROR",
      detail: JSON.stringify(fields),
    });
  const runtimeClient = (base: ClientClass): ClientClass => {
    let client = clientClasses.get(base);
    if (!client) {
      client = createRuntimeClient(base, (fields) => reportConnectionError(fields));
      clientClasses.set(base, client);
    }
    return client;
  };
  const SharedPool = new Proxy(OriginalPool, {
    construct(target, args) {
      const requested = (args[0] ?? {}) as pg.PoolConfig;
      const specialized = hasClientTuning(requested);
      const bounded = {
        ...requested,
        max: specialized ? SPECIALIZED_POOL_MAX : GENERAL_POOL_MAX,
        connectionTimeoutMillis: boundedTimeout(requested.connectionTimeoutMillis),
        idleTimeoutMillis: 30_000,
        // Without keepalive an idle connection to a peer that vanished silently is only noticed
        // when the next query on it times out at the TCP level.
        keepAlive: true,
        keepAliveInitialDelayMillis: KEEP_ALIVE_INITIAL_DELAY_MS,
      };
      const key = Object.values(requested).some(
        (value) => value !== null && (typeof value === "object" || typeof value === "function"),
      )
        ? `unshared:${unsharedPool++}`
        : poolKey(bounded);
      let entry = entries.get(key);
      if (!entry) {
        const client = runtimeClient((requested.Client as ClientClass | undefined) ?? pg.Client);
        const pool = Reflect.construct(target, [{ ...bounded, Client: client }]) as pg.Pool;
        // pg-pool re-emits idle-client errors here after the client listener reported them, and
        // an unhandled pool 'error' event would exit the process.
        pool.on("error", () => undefined);
        const created: PoolEntry = { pool, references: 0, closed: false, waiterTimeouts: 0 };
        // Any client handed out, including after a waiter timed out, means the pool still serves.
        pool.on("acquire", () => {
          created.waiterTimeouts = 0;
        });
        entry = created;
        entries.set(key, entry);
      }
      entry.references += 1;
      return lease(entry, key, entries, recordWaiterTimeout);
    },
  }) as typeof pg.Pool;
  Object.defineProperty(postgres, "Pool", {
    configurable: true,
    writable: true,
    value: SharedPool,
  });
  let reportStalledPool = (fields: object) =>
    process.emitWarning("PostgreSQL pool stopped handing out connections", {
      code: "POSTGRES_POOL_STALLED",
      detail: JSON.stringify(fields),
    });
  const isFull = ({ pool }: PoolEntry) =>
    pool.idleCount === 0 && pool.totalCount >= pool.options.max;
  const isStalled = (entry: PoolEntry) =>
    !entry.closed && entry.waiterTimeouts >= STALLED_POOL_TIMEOUTS && isFull(entry);
  const recordWaiterTimeout = (entry: PoolEntry, error: unknown) => {
    if (!(error instanceof Error && error.message === POOL_WAITER_TIMEOUT_MESSAGE)) return;
    entry.waiterTimeouts += 1;
    if (entry.waiterTimeouts !== STALLED_POOL_TIMEOUTS || !isFull(entry)) return;
    try {
      reportStalledPool({
        waiterTimeouts: entry.waiterTimeouts,
        maxConnections: entry.pool.options.max,
        totalConnections: entry.pool.totalCount,
        waitingRequests: entry.pool.waitingCount,
      });
    } catch {
      // Reporting must never break the caller's checkout.
    }
  };
  const snapshot = (): PostgresPoolSnapshot => {
    const pools = [...entries.values()].filter(({ closed }) => !closed).map(({ pool }) => pool);
    return {
      physicalPoolCount: pools.length,
      maxConnections: pools.reduce((sum, pool) => sum + pool.options.max, 0),
      totalConnections: pools.reduce((sum, pool) => sum + pool.totalCount, 0),
      idleConnections: pools.reduce((sum, pool) => sum + pool.idleCount, 0),
      waitingRequests: pools.reduce((sum, pool) => sum + pool.waitingCount, 0),
      stalledPools: [...entries.values()].filter(isStalled).length,
    };
  };

  return {
    snapshot,
    startTelemetry(logger, intervalMs = 1_000) {
      reportConnectionError = (fields) =>
        logger.warn(fields, "PostgreSQL client connection failed");
      reportStalledPool = (fields) =>
        logger.warn(fields, "PostgreSQL pool stopped handing out connections");
      logger.info(
        {
          ...snapshot(),
          generalPoolMax: GENERAL_POOL_MAX,
          specializedPoolMax: SPECIALIZED_POOL_MAX,
          connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
        },
        "PostgreSQL runtime pool budget configured",
      );
      const timer = setInterval(() => {
        const state = snapshot();
        if (state.waitingRequests > 0) logger.warn(state, "PostgreSQL runtime pool is saturated");
      }, intervalMs);
      timer.unref();
      return () => clearInterval(timer);
    },
    healthCheck(connectionString) {
      // Its own connection, outside the shared pools, so a saturated pool can't fail the probe.
      // pg-pool discards the client after any failed query, so the next probe reconnects.
      const pool = new OriginalPool({
        connectionString,
        max: 1,
        connectionTimeoutMillis: HEALTH_PROBE_TIMEOUT_MS,
        query_timeout: HEALTH_PROBE_TIMEOUT_MS,
        idleTimeoutMillis: 60_000,
        keepAlive: true,
        keepAliveInitialDelayMillis: KEEP_ALIVE_INITIAL_DELAY_MS,
        Client: runtimeClient(pg.Client),
      });
      pool.on("error", () => undefined);
      probePools.push(pool);
      const probe = cachedHealthCheck(() => pool.query("SELECT 1"), HEALTH_PROBE_CACHE_MS);
      // The probe has its own connection, so it can't see shared pools that stopped serving.
      return async () => ![...entries.values()].some(isStalled) && (await probe());
    },
    async close() {
      await Promise.all(probePools.splice(0).map((pool) => pool.end()));
      const pools = [...entries.values()];
      entries.clear();
      await Promise.all(
        pools.map(async (entry) => {
          if (entry.closed) return;
          entry.closed = true;
          await entry.pool.end();
        }),
      );
    },
  };
}

export function isPostgresUnavailableError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth += 1) {
    if (connectionFailures.has(current)) return true;
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof candidate.code === "string" && CONNECTION_FAILURE_STATES.has(candidate.code)) {
      return true;
    }
    if (
      typeof candidate.message === "string" &&
      CONNECTION_FAILURE_MESSAGE.test(candidate.message)
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

/** Shares one in-flight probe and reuses its result for cacheMs. */
export function cachedHealthCheck(
  probe: () => Promise<unknown>,
  cacheMs: number,
  now: () => number = Date.now,
): DatabaseHealthCheck {
  let checkedAt = Number.NEGATIVE_INFINITY;
  let healthy = true;
  let pending: Promise<boolean> | undefined;
  return () => {
    if (now() - checkedAt < cacheMs) return Promise.resolve(healthy);
    pending ??= probe()
      .then(
        () => true,
        () => false,
      )
      .then((result) => {
        healthy = result;
        checkedAt = now();
        pending = undefined;
        return result;
      });
    return pending;
  };
}

// Transient connect failures only: a rejected password, a missing database or a TLS mismatch
// stays a server error instead of reading as a temporary outage.
function isTransientConnectFailure(error: unknown): error is object {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    (typeof code === "string" &&
      (CONNECTION_FAILURE_STATES.has(code) || SOCKET_FAILURE_CODES.has(code))) ||
    (typeof message === "string" && CONNECTION_FAILURE_MESSAGE.test(message))
  );
}

// pg-pool listens for client errors only while a client is idle, and pg emits 'error' when a
// checked-out connection drops. Every runtime client therefore keeps its own listener, so a
// terminated or unreachable database fails the affected queries instead of exiting the process.
function createRuntimeClient(base: ClientClass, report: ConnectionErrorReporter): ClientClass {
  return class RuntimePostgresClient extends base {
    constructor(config?: string | pg.ClientConfig) {
      super(config);
      // pg emits 'error' only for connection-level failures, after which the client is unusable.
      this.on("error", (error: unknown) => {
        if (!error || typeof error !== "object") return;
        connectionFailures.add(error);
        const { code, message } = error as { code?: unknown; message?: unknown };
        const socketCode = typeof code === "string" && SOCKET_FAILURE_CODES.has(code);
        // Socket error messages carry the database address, so those log only their code.
        report({
          code: typeof code === "string" ? code : null,
          error: socketCode ? String(code) : String(message),
        });
      });
    }

    override connect(): Promise<pg.Client>;
    override connect(callback: ConnectCallback): void;
    override connect(callback?: ConnectCallback): Promise<pg.Client> | void {
      if (!callback) {
        return super.connect().catch((error: unknown) => {
          if (isTransientConnectFailure(error)) connectionFailures.add(error);
          throw error;
        });
      }
      const forward = callback as (...outcome: unknown[]) => void;
      super.connect(((...outcome: unknown[]) => {
        if (isTransientConnectFailure(outcome[0])) connectionFailures.add(outcome[0]);
        forward(...outcome);
      }) as ConnectCallback);
    }
  };
}

function lease(
  entry: PoolEntry,
  key: string,
  entries: Map<string, PoolEntry>,
  recordWaiterTimeout: (entry: PoolEntry, error: unknown) => void,
): pg.Pool {
  let released = false;
  const listeners: OwnedListener[] = [];
  let facade: pg.Pool;
  facade = new Proxy(entry.pool, {
    get(pool, property) {
      if (property === "end") {
        return async () => {
          if (released || entry.closed) return;
          released = true;
          for (const listener of listeners.splice(0)) {
            pool.removeListener(listener.event, listener.wrapped);
          }
          entry.references -= 1;
          if (entry.references > 0) return;
          entries.delete(key);
          entry.closed = true;
          await pool.end();
        };
      }
      if (
        property === "on" ||
        property === "addListener" ||
        property === "once" ||
        property === "prependListener" ||
        property === "prependOnceListener"
      ) {
        return (event: string | symbol, original: (...arguments_: unknown[]) => void) => {
          const wrapped = (...arguments_: unknown[]) => original.apply(facade, arguments_);
          listeners.push({ event, original, wrapped });
          Reflect.apply(pool[property], pool, [event, wrapped]);
          return facade;
        };
      }
      if (property === "off" || property === "removeListener") {
        return (event: string | symbol, original: (...arguments_: unknown[]) => void) => {
          const index = listeners.findLastIndex(
            (listener) => listener.event === event && listener.original === original,
          );
          if (index !== -1) {
            const [listener] = listeners.splice(index, 1);
            pool.removeListener(event, listener.wrapped);
          }
          return facade;
        };
      }
      if (property === "removeAllListeners") {
        return (event?: string | symbol) => {
          for (let index = listeners.length - 1; index >= 0; index -= 1) {
            const listener = listeners[index];
            if (event !== undefined && listener.event !== event) continue;
            pool.removeListener(listener.event, listener.wrapped);
            listeners.splice(index, 1);
          }
          return facade;
        };
      }
      if (property === "connect" || property === "query") {
        const method = Reflect.get(pool, property, pool) as (...arguments_: unknown[]) => unknown;
        return (...arguments_: unknown[]) => {
          const callback = arguments_.at(-1);
          if (typeof callback === "function") {
            arguments_[arguments_.length - 1] = (error: unknown, ...rest: unknown[]) => {
              recordWaiterTimeout(entry, error);
              return Reflect.apply(callback, undefined, [error, ...rest]);
            };
            return Reflect.apply(method, pool, arguments_);
          }
          const result = Reflect.apply(method, pool, arguments_) as Promise<unknown>;
          // Rethrow so an ignored rejection still surfaces as unhandled, exactly as before.
          return result.then(undefined, (error: unknown) => {
            recordWaiterTimeout(entry, error);
            throw error;
          });
        };
      }
      const value = Reflect.get(pool, property, pool) as unknown;
      return typeof value === "function" ? value.bind(pool) : value;
    },
  });
  return facade;
}

function boundedTimeout(requested: number | undefined): number {
  return requested && requested > 0
    ? Math.min(requested, CONNECTION_TIMEOUT_MS)
    : CONNECTION_TIMEOUT_MS;
}

function hasClientTuning(options: pg.PoolConfig): boolean {
  return [
    options.statement_timeout,
    options.lock_timeout,
    options.idle_in_transaction_session_timeout,
    options.options,
  ].some((value) => value !== undefined);
}

function poolKey(options: pg.PoolConfig): string {
  return JSON.stringify(
    Object.entries(options)
      .filter(([key]) => key !== "max" && key !== "idleTimeoutMillis")
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}
