import type { sharedSetupClient } from "@/services/api/sharedHotelSetupClient";

// Moved from marketplace-web (VAY-2262). Errors carry a translation key; the page translates them.
export type AirbnbStartErrorKey =
  | "airbnb.error.temporarilyDisabled"
  | "airbnb.error.notReady"
  | "airbnb.error.startFailed"
  | "airbnb.error.progressUnconfirmed"
  | "airbnb.error.existingConnection"
  | "airbnb.error.notVerified"
  | "airbnb.error.didNotFinish"
  | "airbnb.error.stillRunning";

export class AirbnbPreparationError extends Error {
  constructor(readonly messageKey: AirbnbStartErrorKey) {
    super(messageKey);
    this.name = "AirbnbPreparationError";
  }
}

/** Message key for a failed start or preparation; a disabled connection is not "not ready". */
export function describeAirbnbStartError(cause: unknown): AirbnbStartErrorKey {
  if (cause instanceof AirbnbPreparationError) return cause.messageKey;
  const failure =
    typeof cause === "object" && cause !== null ? (cause as Record<string, unknown>) : {};
  const code = (failure.data as { code?: unknown } | undefined)?.code;
  if (
    (failure.status === 409 && code === "channex_capability_not_mutating") ||
    (failure.status === 503 && code === "channex_commands_unavailable")
  )
    return "airbnb.error.temporarilyDisabled";
  if (failure.status === 409) return "airbnb.error.notReady";
  return "airbnb.error.startFailed";
}

type Operation = {
  operationId: string;
  propertyId: string;
  commandId: string;
  operationType: string;
  status: string;
};
export async function prepareAirbnbHotel(
  client: Pick<typeof sharedSetupClient, "get" | "post">,
  propertyId: string,
  commandId: string,
  callerSignal: AbortSignal,
) {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 70_000);
  try {
    await runPreparation(
      client,
      propertyId,
      commandId,
      AbortSignal.any([callerSignal, deadline.signal]),
    );
  } catch (error) {
    if (deadline.signal.aborted && !callerSignal.aborted)
      throw new AirbnbPreparationError("airbnb.error.progressUnconfirmed");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Reuse the durable enable command; link creation still requires verified creation evidence. */
async function runPreparation(
  client: Pick<typeof sharedSetupClient, "get" | "post">,
  propertyId: string,
  commandId: string,
  signal: AbortSignal,
) {
  const path = `/api/pms/properties/${propertyId}/channex`;
  const snapshot = await client.get<{
    propertyId: string;
    connection: { status: string; externalPropertyId: string | null };
  }>(path, { signal });
  if (
    snapshot.propertyId !== propertyId ||
    snapshot.connection.externalPropertyId !== null ||
    snapshot.connection.status !== "disconnected"
  )
    throw new AirbnbPreparationError("airbnb.error.existingConnection");
  let operation = await client.post<Operation>(
    `${path}/commands`,
    {
      commandId,
      idempotencyKey: `airbnb-prepare:${propertyId}:${commandId}`,
      operationType: "enable",
    },
    { signal },
  );
  const operationId = operation.operationId;
  for (let attempt = 0; attempt <= 30; attempt++) {
    signal.throwIfAborted();
    if (
      operation.operationId !== operationId ||
      operation.propertyId !== propertyId ||
      operation.commandId !== commandId ||
      operation.operationType !== "enable" ||
      !/^[0-9a-f-]{36}$/i.test(operation.operationId)
    )
      throw new AirbnbPreparationError("airbnb.error.notVerified");
    if (operation.status === "succeeded") return;
    if (!["queued", "running", "retry_scheduled"].includes(operation.status))
      throw new AirbnbPreparationError("airbnb.error.didNotFinish");
    if (attempt === 30) break;
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, 2000);
      signal.addEventListener("abort", abort, { once: true });
    });
    operation = await client.get<Operation>(`${path}/operations/${operation.operationId}`, {
      signal,
    });
  }
  throw new AirbnbPreparationError("airbnb.error.stillRunning");
}
