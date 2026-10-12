import {
  PROPERTY_SETUP_STEP_DEFINITIONS,
  buildPropertySetupRoute,
  getActivePropertySetupStepIds,
  type PropertySetupRouteReadModel,
} from "@vayada/domain-hotels";
import { describe, expect, it } from "vitest";

import {
  createPropertySetupRouteClient,
  parsePropertySetupRouteReadModel,
  type PropertySetupRouteHttpClient,
} from "./propertySetupRouteClient";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";

describe("createPropertySetupRouteClient", () => {
  it("loads the encoded protected route and forwards RequestInit unchanged", async () => {
    const response = routeWire();
    const calls: Array<{ endpoint: string; options?: RequestInit }> = [];
    const get = async <T>(endpoint: string, options?: RequestInit): Promise<T> => {
      calls.push({ endpoint, options });
      return response as T;
    };
    const client = createPropertySetupRouteClient({ get });
    const controller = new AbortController();
    const options: RequestInit = {
      signal: controller.signal,
      headers: { "X-Request-Trace": "setup-shell" },
      cache: "no-store",
    };

    await expect(client.getRoute(propertyId.toUpperCase(), options)).resolves.toBe(response);
    expect(calls).toEqual([
      {
        endpoint: `/api/hotel-setup/properties/${propertyId.toUpperCase()}/route`,
        options,
      },
    ]);
    expect(calls[0]?.options).toBe(options);
  });

  it("preserves AbortSignal failures from the authenticated HTTP client", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Setup request was replaced.", "AbortError"));
    const get = async <T>(_endpoint: string, options?: RequestInit): Promise<T> => {
      throw options?.signal?.reason;
    };
    const client = createPropertySetupRouteClient({ get });

    await expect(client.getRoute(propertyId, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("rejects malformed route data and cross-property responses", async () => {
    const malformed = { ...routeWire(), contractVersion: "property-setup-route.v1" };
    const otherProperty = routeWire("33333333-3333-4333-8333-333333333333");

    await expect(
      createPropertySetupRouteClient(clientReturning(malformed)).getRoute(propertyId),
    ).rejects.toThrow("Property setup route data is invalid");
    await expect(
      createPropertySetupRouteClient(clientReturning(otherProperty)).getRoute(propertyId),
    ).rejects.toThrow("Property setup route data is invalid");
  });
});

describe("parsePropertySetupRouteReadModel", () => {
  it("accepts each canonical active route without mutating the wire value", () => {
    for (const selectedTracks of [
      ["creator_marketplace"],
      ["hotel_operations"],
      ["hotel_operations", "creator_marketplace"],
    ] as const) {
      const route = routeWire(propertyId, selectedTracks);
      expect(parsePropertySetupRouteReadModel(route)).toBe(route);
    }
  });

  it("fails closed for extra keys, discontinuous positions, or dishonest progress", () => {
    const route = routeWire();
    expect(parsePropertySetupRouteReadModel({ ...route, unexpected: true })).toBeNull();
    expect(
      parsePropertySetupRouteReadModel({
        ...route,
        steps: route.steps.map((step, index) => (index === 1 ? { ...step, position: 99 } : step)),
      }),
    ).toBeNull();
    expect(
      parsePropertySetupRouteReadModel({
        ...route,
        progress: { ...route.progress, complete: route.progress.complete + 1 },
      }),
    ).toBeNull();
  });

  it("follows the server's step order, so a reordered route loads during a deploy", () => {
    // An older next-api still sends Payments after Guest experience.
    const route = paymentsAfter(routeWire(propertyId, ["hotel_operations"]), "guest_experience");
    expect(route.steps.map(({ stepId }) => stepId)).toEqual([
      "present_hotel",
      "booking_design",
      "rooms",
      "pricing",
      "calendar",
      "guest_experience",
      "payments",
      "review",
    ]);
    expect(parsePropertySetupRouteReadModel(route)).toBe(route);
  });

  it("fails closed for a reordered route that is not exactly the active steps", () => {
    const route = paymentsAfter(routeWire(propertyId, ["hotel_operations"]), "guest_experience");
    const pricing = route.steps.find(({ stepId }) => stepId === "pricing")!;
    // A duplicate step in place of another active step.
    expect(
      parsePropertySetupRouteReadModel({
        ...route,
        steps: route.steps.map((step) =>
          step.stepId === "calendar" ? { ...pricing, position: step.position } : step,
        ),
      }),
    ).toBeNull();
    // A step from a track that is not selected.
    expect(
      parsePropertySetupRouteReadModel({
        ...route,
        steps: route.steps.map((step) =>
          step.stepId === "booking_design"
            ? {
                ...step,
                stepId: "marketplace_preferences",
                currentBaseRevisions: {
                  "marketplace.collaboration_preferences": "revision:0",
                },
              }
            : step,
        ),
      }),
    ).toBeNull();
    // Positions must follow the server's order, not the client's own step list.
    expect(
      parsePropertySetupRouteReadModel({
        ...route,
        steps: route.steps.map((step) => ({
          ...step,
          position: getActivePropertySetupStepIds(["hotel_operations"]).indexOf(step.stepId) + 1,
        })),
      }),
    ).toBeNull();
    // Blocker positions must point at the owning step's position in the server's order.
    expect(
      parsePropertySetupRouteReadModel({
        ...route,
        steps: route.steps.map((step) =>
          step.stepId === "payments"
            ? {
                ...step,
                blockers: step.blockers.map((blocker) => ({
                  ...blocker,
                  owningStepPosition:
                    getActivePropertySetupStepIds(["hotel_operations"]).indexOf("payments") + 1,
                })),
              }
            : step,
        ),
      }),
    ).toBeNull();
  });

  it("requires each exact current manifest without rebasing persisted draft history", () => {
    const route = routeWire();
    const step = route.steps[0]!;
    expect(
      parsePropertySetupRouteReadModel({
        ...route,
        steps: [
          { ...step, currentBaseRevisions: { "hotel_catalog.profile": "profile:1" } },
          ...route.steps.slice(1),
        ],
      }),
    ).toBeNull();
    expect(
      parsePropertySetupRouteReadModel({
        ...route,
        steps: [
          {
            ...step,
            currentBaseRevisions: { ...step.currentBaseRevisions, extra: "revision:1" },
          },
          ...route.steps.slice(1),
        ],
      }),
    ).toBeNull();
  });
});

/** The route with Payments moved after another step, renumbered, with a Payments blocker. */
function paymentsAfter(
  route: PropertySetupRouteReadModel,
  previousStepId: PropertySetupRouteReadModel["steps"][number]["stepId"],
): PropertySetupRouteReadModel {
  const payments = route.steps.find(({ stepId }) => stepId === "payments")!;
  const others = route.steps.filter(({ stepId }) => stepId !== "payments");
  const at = others.findIndex(({ stepId }) => stepId === previousStepId) + 1;
  const steps = [...others.slice(0, at), payments, ...others.slice(at)];
  return {
    ...route,
    steps: steps.map((step, index) =>
      step.stepId === "payments"
        ? {
            ...step,
            position: index + 1,
            state: "blocked" as const,
            blockers: [
              {
                code: "ready_payment_method_missing",
                product: "finance" as const,
                ownerDomain: "finance" as const,
                owningStepId: "payments" as const,
                message: "Complete at least one ready payment method.",
                kind: "user_fixable" as const,
                sourceRevision: step.sourceRevision,
                owningStepPosition: index + 1,
              },
            ],
          }
        : { ...step, position: index + 1 },
    ),
  };
}

function clientReturning(value: unknown): PropertySetupRouteHttpClient {
  return { get: async <T>() => value as T };
}

function routeWire(
  routePropertyId = propertyId,
  selectedTracks: readonly ("hotel_operations" | "creator_marketplace")[] = ["creator_marketplace"],
): PropertySetupRouteReadModel {
  return buildPropertySetupRoute({
    organizationId,
    propertyId: routePropertyId,
    selectedTracks,
    trackRevision: 1,
    session: null,
    ownerFacts: getActivePropertySetupStepIds(selectedTracks).map((stepId) => ({
      organizationId,
      propertyId: routePropertyId,
      stepId,
      state: "not_started" as const,
      sourceRevision: `${stepId}:0`,
      currentBaseRevisions: Object.fromEntries(
        PROPERTY_SETUP_STEP_DEFINITIONS.find(
          (definition) => definition.stepId === stepId,
        )!.baseRevisionKeys.map((key) => [key, "revision:0"]),
      ),
      blockers: [],
    })),
  });
}
