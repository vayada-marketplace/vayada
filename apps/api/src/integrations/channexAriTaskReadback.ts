import { isDeepStrictEqual } from "node:util";
import { pricingObject } from "@vayada/domain-pms";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Channex's observed UTC task timestamp shape. Retain microseconds for ordering.
function taskTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) return null;
  const time = new Date(`${match[1]}Z`);
  if (!Number.isFinite(time.getTime()) || time.toISOString().slice(0, 19) !== match[1]) return null;
  return `${match[1]}.${(match[2] ?? "").padEnd(6, "0")}`;
}

/** Historical task finish observation only. Caller owns immutable-receipt
 * provenance, bounded authenticated IO, authority and definitive reconciliation. */
export async function verifyChannexAriTaskFinish(
  expected: Readonly<{ taskId: string; externalPropertyId: string; request: unknown }>,
  get: (method: "GET", path: string) => Promise<unknown>,
) {
  return verifyTaskFinish(expected, "Property.UpdateRestrictions", get);
}

/** Availability-task observation with the same immutable payload guarantees. */
export async function verifyChannexAvailabilityTaskFinish(
  expected: Readonly<{ taskId: string; externalPropertyId: string; request: unknown }>,
  get: (method: "GET", path: string) => Promise<unknown>,
) {
  return verifyTaskFinish(expected, "Property.UpdateAvailability", get);
}

async function verifyTaskFinish(
  expected: Readonly<{ taskId: string; externalPropertyId: string; request: unknown }>,
  expectedTask: "Property.UpdateRestrictions" | "Property.UpdateAvailability",
  get: (method: "GET", path: string) => Promise<unknown>,
) {
  const { taskId, externalPropertyId } = expected;
  if (![taskId, externalPropertyId].every((id) => typeof id === "string" && uuid.test(id)))
    throw new Error("ari_task_scope_unavailable");
  const request: unknown = structuredClone(expected.request);
  if (
    !pricingObject(request) ||
    !Array.isArray(request.values) ||
    request.values.length === 0 ||
    request.values.some(
      (value) => !pricingObject(value) || value.property_id !== externalPropertyId,
    )
  )
    throw new Error("ari_task_scope_unavailable");
  const response = await get("GET", `/api/v1/tasks/${taskId}`);
  if (
    !pricingObject(response) ||
    Object.hasOwn(response, "errors") ||
    Object.hasOwn(response, "warnings") ||
    (response.meta !== undefined &&
      (!pricingObject(response.meta) ||
        (response.meta.warnings !== undefined &&
          (!Array.isArray(response.meta.warnings) || response.meta.warnings.length !== 0))))
  )
    throw new Error("ari_task_observation_unavailable");
  const data = response.data;
  if (
    !pricingObject(data) ||
    data.id !== taskId ||
    data.type !== "task" ||
    !pricingObject(data.attributes)
  )
    throw new Error("ari_task_observation_unavailable");
  const value = data.attributes;
  const received = taskTime(value.received_at),
    executed = taskTime(value.executed_at),
    finished = taskTime(value.finished_at);
  if (
    value.id !== taskId ||
    value.task !== expectedTask ||
    value.success !== true ||
    !Array.isArray(value.errors) ||
    value.errors.length !== 0 ||
    !isDeepStrictEqual(value.payload, request) ||
    !received ||
    !executed ||
    !finished ||
    received > executed ||
    executed > finished
  )
    throw new Error("ari_task_observation_unavailable");
  return {
    kind: "task_finish_observed" as const,
    taskId,
    externalPropertyId,
    receivedAt: value.received_at as string,
    executedAt: value.executed_at as string,
    finishedAt: value.finished_at as string,
  };
}
