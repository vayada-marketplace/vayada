import { readChannexResponse } from "./channexResponseBody.js";

export type ChannexAriWarningReason =
  | "invalid_tasks"
  | "root_errors"
  | "root_warnings"
  | "invalid_meta"
  | "invalid_warnings"
  | "provider_warnings";

/** Allowlisted response observation, never delivery completion or permission to retry.
 * https://docs.channex.io/api-v.1-documentation/ari
 */
export function sanitizeChannexAriResponse(input: {
  httpStatus: number;
  providerRequestId?: string | null;
  body: string;
}) {
  if (!Number.isInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599)
    throw new Error("Invalid Channex receipt status");
  const id = input.providerRequestId;
  const base = {
    httpStatus: input.httpStatus,
    providerRequestId: typeof id === "string" && /^[A-Za-z0-9._:-]{1,512}$/.test(id) ? id : null,
    taskIds: [] as string[],
    hasWarnings: true,
    warningReason: null as ChannexAriWarningReason | null,
  };
  if (Buffer.byteLength(input.body, "utf8") > 65536)
    return { ...base, outcome: "body_limit" as const };
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body);
  } catch {
    return { ...base, outcome: "invalid_json" as const };
  }
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const data = object(parsed) ? parsed.data : null;
  const tasks =
    Array.isArray(data) &&
    data.length > 0 &&
    data.length <= 100 &&
    data.every(
      (task) =>
        object(task) &&
        task.type === "task" &&
        typeof task.id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(task.id),
    )
      ? data.map((task) => task.id as string)
      : [];
  // Preserve no partial task list and fail closed on duplicate identities.
  const validTasks = tasks.length > 0 && new Set(tasks).size === tasks.length;
  // First blocker only; never copy provider warning text or echoed values.
  let warningReason: ChannexAriWarningReason | null = null;
  if (!validTasks || !object(parsed)) warningReason = "invalid_tasks";
  else if (Object.hasOwn(parsed, "errors")) warningReason = "root_errors";
  else if (Object.hasOwn(parsed, "warnings")) warningReason = "root_warnings";
  else if (!object(parsed.meta)) warningReason = "invalid_meta";
  else if (!Object.hasOwn(parsed.meta, "warnings")) {
    // Observed original Channex acceptance omits warnings on explicit Success.
    if (parsed.meta.message !== "Success") warningReason = "invalid_warnings";
  } else if (!Array.isArray(parsed.meta.warnings)) warningReason = "invalid_warnings";
  else if (parsed.meta.warnings.length !== 0) warningReason = "provider_warnings";
  return {
    ...base,
    outcome: "complete_json" as const,
    taskIds: validTasks ? tasks : [],
    hasWarnings: warningReason !== null,
    warningReason,
  };
}

/** Fetch itself is bounded by the future dispatcher; this bounds response consumption. */
export function readChannexAriResponse(response: Response) {
  return readChannexResponse(response, sanitizeChannexAriResponse);
}
