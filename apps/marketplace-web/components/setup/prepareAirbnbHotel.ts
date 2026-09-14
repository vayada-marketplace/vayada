import type { sharedSetupClient } from "@/services/api/sharedHotelSetupClient";

export class AirbnbPreparationError extends Error {}

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
      throw new AirbnbPreparationError(
        "Hotel preparation progress could not be confirmed. Try again shortly.",
      );
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
    throw new AirbnbPreparationError(
      "This hotel’s existing connection needs verification before Airbnb import.",
    );
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
      throw new AirbnbPreparationError("Hotel preparation could not be verified.");
    if (operation.status === "succeeded") return;
    if (!["queued", "running", "retry_scheduled"].includes(operation.status))
      throw new AirbnbPreparationError(
        "Hotel preparation did not finish. You can continue setup manually.",
      );
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
  throw new AirbnbPreparationError(
    "Hotel preparation is still running. Try again shortly to check its progress.",
  );
}
