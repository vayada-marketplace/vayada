import { ApiErrorResponse } from "./client";
import { sharedSetupClient } from "./sharedHotelSetupClient";

/**
 * VAY-2247: GET/POST /api/hotel-setup/properties/:propertyId/first-run (apps/api routes/hotelFirstRun.ts).
 * The server saves every default a new hotel needs from these few answers, step by step and idempotently.
 */

export const HOTEL_FIRST_RUN_STEPS = [
  "currency",
  "rooms",
  "payments",
  "pricing",
  "calendar",
  "guest_rules",
  "plan",
] as const;
export type HotelFirstRunStepId = (typeof HOTEL_FIRST_RUN_STEPS)[number];
export type HotelFirstRunStepState = "done" | "stale" | "todo" | "blocked" | "awaiting_checkout";

export type HotelFirstRunState = Readonly<{
  contractVersion: "hotel-first-run.v1";
  propertyId: string;
  steps: readonly Readonly<{ id: HotelFirstRunStepId; state: HotelFirstRunStepState }>[];
  nextStep: HotelFirstRunStepId | null;
}>;

export type HotelFirstRunRequest = Readonly<{
  room: Readonly<{ name: string; numberOfRooms: number; maxGuests: number; pricePerNight: string }>;
  pricesIncludeMandatoryCharges: boolean;
  guestPayment: "pay_at_property";
  plan: "commission" | "fixed_fee";
}>;

export type HotelFirstRunRunResult = Readonly<{
  state: HotelFirstRunState;
  ran: readonly HotelFirstRunStepId[];
  checkoutUrl: string | null;
}>;

/** A step that stopped: the code says why (e.g. mandatory_charges_declaration_required), with the state. */
export class HotelFirstRunError extends Error {
  constructor(
    readonly code: string,
    readonly step: HotelFirstRunStepId | null,
    readonly state: HotelFirstRunState | null,
  ) {
    super(code);
    this.name = "HotelFirstRunError";
  }
}

const STATES = new Set<string>(["done", "stale", "todo", "blocked", "awaiting_checkout"]);
const isStep = (value: unknown): value is HotelFirstRunStepId =>
  (HOTEL_FIRST_RUN_STEPS as readonly unknown[]).includes(value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseHotelFirstRunState(
  value: unknown,
  propertyId: string,
): HotelFirstRunState | null {
  if (
    !isRecord(value) ||
    value["contractVersion"] !== "hotel-first-run.v1" ||
    value["propertyId"] !== propertyId.toLowerCase() ||
    !Array.isArray(value["steps"]) ||
    !(value["nextStep"] === null || isStep(value["nextStep"]))
  )
    return null;
  const steps = value["steps"].map((step) =>
    isRecord(step) && isStep(step["id"]) && STATES.has(String(step["state"]))
      ? { id: step["id"], state: step["state"] as HotelFirstRunStepState }
      : null,
  );
  if (
    steps.some((step) => step === null) ||
    steps.map((step) => step!.id).join() !== HOTEL_FIRST_RUN_STEPS.join()
  )
    return null;
  return Object.freeze({
    contractVersion: "hotel-first-run.v1",
    propertyId: value["propertyId"],
    steps: Object.freeze(steps as HotelFirstRunState["steps"][number][]),
    nextStep: value["nextStep"],
  });
}

type Http = {
  get<T>(endpoint: string, options?: RequestInit): Promise<T>;
  post<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T>;
};

const path = (propertyId: string) =>
  `/api/hotel-setup/properties/${encodeURIComponent(propertyId)}/first-run`;

export function createHotelFirstRunClient(http: Http) {
  return {
    async read(propertyId: string, signal?: AbortSignal): Promise<HotelFirstRunState> {
      const state = parseHotelFirstRunState(
        await http.get<unknown>(path(propertyId), { cache: "no-store", signal }),
        propertyId,
      );
      if (!state) throw new HotelFirstRunError("invalid_first_run_state", null, null);
      return state;
    },

    async run(propertyId: string, request: HotelFirstRunRequest): Promise<HotelFirstRunRunResult> {
      let value: unknown;
      try {
        value = await http.post<unknown>(path(propertyId), request);
      } catch (error) {
        if (error instanceof ApiErrorResponse && (error.status === 409 || error.status === 422)) {
          const data = error.data as unknown as Record<string, unknown>;
          throw new HotelFirstRunError(
            typeof data["code"] === "string" ? data["code"] : "first_run_failed",
            isStep(data["step"]) ? data["step"] : null,
            parseHotelFirstRunState(data["state"], propertyId),
          );
        }
        throw error;
      }
      const state = isRecord(value) ? parseHotelFirstRunState(value["state"], propertyId) : null;
      const ran =
        isRecord(value) && Array.isArray(value["ran"]) ? value["ran"].filter(isStep) : null;
      const checkout =
        isRecord(value) && isRecord(value["checkout"]) ? value["checkout"]["url"] : null;
      if (!state || !ran) throw new HotelFirstRunError("invalid_first_run_state", null, null);
      return Object.freeze({
        state,
        ran: Object.freeze(ran),
        checkoutUrl:
          typeof checkout === "string" && checkout.startsWith("https://") ? checkout : null,
      });
    },
  };
}

export type HotelFirstRunClient = ReturnType<typeof createHotelFirstRunClient>;

/** On the same API session as the rest of hotel setup. */
export const hotelFirstRunApi = createHotelFirstRunClient(sharedSetupClient);

/**
 * Which setup screen a hotel that already exists resumes at: 3 (first room and price) until its
 * room and price are saved, 4 (how guests pay) until the plan is chosen, then 5 (go live).
 */
export function quickSetupStepForFirstRun(state: HotelFirstRunState): 3 | 4 | 5 {
  const stateOf = (id: HotelFirstRunStepId) => state.steps.find((step) => step.id === id)?.state;
  if (stateOf("rooms") !== "done" || stateOf("pricing") !== "done") return 3;
  const plan = stateOf("plan");
  if (plan !== "done" || state.nextStep !== null) return 4;
  return 5;
}
