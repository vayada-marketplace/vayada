// The recovery job of AI changes (VAY-2524): closes pending changes nobody answered in time and
// takes over runs whose lease ran out (a deploy, a crash), running them again with the same keys.
import type { AiChangeExecutor } from "./executor.js";

export const AI_CHANGE_RECOVERY_INTERVAL_MS = 30_000;

export function startAiChangeRecoveryWorker(options: {
  executor: Pick<AiChangeExecutor, "recover" | "expirePending">;
  enabled: boolean;
  intervalMs?: number;
  logger: {
    info(context: { expired: number; recovered: number }, message: string): void;
    error(context: { err: unknown }, message: string): void;
  };
}): { runNow(): Promise<void>; close(): Promise<void> } {
  let activeRun: Promise<void> | undefined;
  let closing = false;
  const sweep = async () => {
    const expired = await options.executor.expirePending();
    const recovered = await options.executor.recover();
    if (expired + recovered > 0) {
      options.logger.info(
        { expired, recovered },
        "Closed unanswered AI changes and took over runs",
      );
    }
  };
  const runNow = (): Promise<void> => {
    if (closing) return Promise.resolve();
    activeRun ??= sweep()
      .catch((error: unknown) => options.logger.error({ err: error }, "AI change recovery failed"))
      .finally(() => {
        activeRun = undefined;
      });
    return activeRun;
  };
  const timer = options.enabled
    ? setInterval(() => void runNow(), options.intervalMs ?? AI_CHANGE_RECOVERY_INTERVAL_MS)
    : undefined;
  timer?.unref();
  return {
    runNow,
    async close() {
      closing = true;
      if (timer) clearInterval(timer);
      await activeRun;
    },
  };
}
