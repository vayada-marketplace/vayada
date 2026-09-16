import { createBookingGuestPolicyOutboxProjector } from "./bookingGuestPolicyProjectionRuntime.js";

export function startBookingGuestPolicyProjectionWorker(config: {
  projector: ReturnType<typeof createBookingGuestPolicyOutboxProjector>;
  workerId: string;
  warn(error: unknown, message: string): void;
  intervalMs?: number;
}): { close(): Promise<void> } {
  let active: Promise<void> | undefined;
  let closed = false;
  const run = () => {
    if (closed || active) return;
    active = config.projector
      .runBatch({ workerId: config.workerId })
      .then(({ conflicts, retrying, deadLettered }) => {
        if (conflicts || retrying || deadLettered)
          config.warn(
            { conflicts, retrying, deadLettered },
            "Booking guest-policy projection completed with non-applied events",
          );
      })
      .catch((error: unknown) =>
        config.warn({ err: error }, "Booking guest-policy projection worker failed"),
      )
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(run, config.intervalMs ?? 30_000);
  timer.unref();
  run();
  return {
    async close() {
      closed = true;
      clearInterval(timer);
      await active;
    },
  };
}
