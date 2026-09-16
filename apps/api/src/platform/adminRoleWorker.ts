import pg from "pg";
import { reconcileNextAdminRole, type AdminRoleProvider } from "@vayada/backend-auth";
export function startAdminRoleWorker(options: {
  connectionString: string;
  provider: AdminRoleProvider;
  warn(): void;
}) {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: 2,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
  });
  let closed = false,
    active: Promise<void> | undefined;
  const runNow = () => {
    if (closed) return Promise.resolve();
    if (active) return active;
    active = (async () => {
      for (let i = 0; i < 25 && !closed; i++) {
        if (!(await reconcileNextAdminRole(pool, options.provider))) break;
      }
    })()
      .catch(() => options.warn())
      .finally(() => {
        active = undefined;
      });
    return active;
  };
  const timer = setInterval(() => void runNow(), 5000);
  timer.unref();
  void runNow();
  return {
    runNow,
    async close() {
      closed = true;
      clearInterval(timer);
      await active;
      await pool.end();
    },
  };
}
