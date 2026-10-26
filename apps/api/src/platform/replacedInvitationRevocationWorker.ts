// VAY-2274: retries revoking the WorkOS invitation a Team "Resend" replaced, when the attempt made
// right after delivering the replacement did not land. Each due row is claimed for five minutes,
// so this runs every minute without hammering WorkOS while it is down.
type ReplacedInvitationRevocationWorkerOptions = {
  delivery: { revokeReplacedInvitations(): Promise<"revoked" | "failed" | undefined> };
  warn(error: unknown, message: string): void;
};

export function startReplacedInvitationRevocationWorker(
  options: ReplacedInvitationRevocationWorkerOptions,
) {
  let active: Promise<void> | undefined;
  let closed = false;
  const runNow = () => {
    if (closed) return Promise.resolve();
    if (active) return active;
    active = options.delivery
      .revokeReplacedInvitations()
      .then((outcome) => {
        if (outcome === "failed") {
          options.warn(undefined, "A replaced WorkOS invitation is still not revoked; retrying");
        }
      })
      .catch((error: unknown) =>
        options.warn({ err: error }, "Replaced invitation revocation worker failed"),
      )
      .finally(() => {
        active = undefined;
      });
    return active;
  };
  const timer = setInterval(() => void runNow(), 60_000);
  timer.unref();
  void runNow();

  return {
    runNow,
    async close() {
      closed = true;
      clearInterval(timer);
      await active;
    },
  };
}
