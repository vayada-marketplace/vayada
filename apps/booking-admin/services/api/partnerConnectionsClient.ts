import { ApiErrorResponse, omitHotelContext, type ApiClient } from "./client";
import { sharedSetupClient } from "./sharedHotelSetupClient";

/** VAY-2436: connecting a partner app (Creator Links first) to a hotel once, and disconnecting it. */
export type PartnerScope = "promo_codes" | "bookings";

export type PartnerAuthorizationRequest = {
  app: { name: string };
  scopes: PartnerScope[];
  /** The hotels the signed-in person may connect the app to. */
  properties: { propertyId: string; name: string; promoCodesEnabled: boolean }[];
};

/** A request Vayada can't show: an error on the page, or back to the app at `redirectTo`. */
export class PartnerAuthorizationRequestError extends Error {
  constructor(
    readonly code: string,
    readonly redirectTo: string | null,
  ) {
    super(code);
    this.name = "PartnerAuthorizationRequestError";
  }
}

export type PartnerConnection = {
  connectionId: string;
  appName: string;
  scopes: PartnerScope[];
  approvedAt: string;
  approvedByName: string | null;
};

type Http = Pick<ApiClient, "get" | "post" | "delete">;

const SCOPES: readonly string[] = ["promo_codes", "bookings"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const scopes = (v: unknown): PartnerScope[] | null =>
  Array.isArray(v) && v.every((s) => typeof s === "string" && SCOPES.includes(s))
    ? (v as PartnerScope[])
    : null;
const connectionsPath = (propertyId: string) => {
  if (!UUID.test(propertyId)) throw new Error("Choose a valid property first.");
  return `/api/booking/properties/${propertyId.toLowerCase()}/partner-connections`;
};

/** Only an http(s) address the API gave back: the app's registered return address. */
function redirectTarget(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const url = new URL(v);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function requestError(error: unknown): never {
  if (error instanceof ApiErrorResponse && error.status === 400) {
    const data = error.data as Record<string, unknown>;
    if (typeof data.code === "string")
      throw new PartnerAuthorizationRequestError(data.code, redirectTarget(data.redirectTo));
  }
  throw error;
}

export function createPartnerConnectionsClient(http: Http) {
  return {
    /** The approval page's request, as the app sent it in the address. */
    async loadAuthorization(query: URLSearchParams): Promise<PartnerAuthorizationRequest> {
      let v: unknown;
      try {
        v = await http.get<unknown>(`/api/booking/partner-authorizations?${query.toString()}`, {
          ...omitHotelContext,
          cache: "no-store",
        });
      } catch (error) {
        requestError(error);
      }
      const app = record(v) && record(v.app) ? v.app : null;
      const asked = record(v) ? scopes(v.scopes) : null;
      const properties = record(v) && Array.isArray(v.properties) ? v.properties : null;
      if (
        !app ||
        typeof app.name !== "string" ||
        !asked ||
        !properties ||
        !properties.every(
          (p) =>
            record(p) &&
            typeof p.propertyId === "string" &&
            typeof p.name === "string" &&
            typeof p.promoCodesEnabled === "boolean",
        )
      )
        throw new Error("The connection request could not be loaded.");
      return {
        app: { name: app.name },
        scopes: asked,
        properties: properties as PartnerAuthorizationRequest["properties"],
      };
    },

    /** Allow or Cancel: where to send the browser next (always the app's registered address). */
    async decide(
      query: URLSearchParams,
      decision: "allow" | "deny",
      propertyId: string | null,
    ): Promise<string> {
      let v: unknown;
      try {
        v = await http.post<unknown>(
          "/api/booking/partner-authorizations",
          { authorization: Object.fromEntries(query), decision, propertyId },
          omitHotelContext,
        );
      } catch (error) {
        requestError(error);
      }
      const target = record(v) ? redirectTarget(v.redirectTo) : null;
      if (!target) throw new Error("The connection could not be completed.");
      return target;
    },

    async list(
      propertyId: string,
    ): Promise<{ connections: PartnerConnection[]; canManage: boolean }> {
      const v = await http.get<unknown>(connectionsPath(propertyId), { cache: "no-store" });
      const list = record(v) && Array.isArray(v.connections) ? v.connections : null;
      if (!record(v) || typeof v.canManage !== "boolean" || !list)
        throw new Error("The connected apps could not be loaded.");
      const connections = list.flatMap((c) =>
        record(c) &&
        typeof c.connectionId === "string" &&
        typeof c.appName === "string" &&
        typeof c.approvedAt === "string" &&
        scopes(c.scopes) &&
        (c.approvedByName === null || typeof c.approvedByName === "string")
          ? [
              {
                connectionId: c.connectionId,
                appName: c.appName,
                scopes: scopes(c.scopes)!,
                approvedAt: c.approvedAt,
                approvedByName: c.approvedByName as string | null,
              },
            ]
          : [],
      );
      return { connections, canManage: v.canManage };
    },

    async disconnect(propertyId: string, connectionId: string): Promise<void> {
      if (!UUID.test(connectionId)) throw new Error("Unknown connection.");
      await http.delete<void>(`${connectionsPath(propertyId)}/${connectionId.toLowerCase()}`);
    },
  };
}

export const partnerConnectionsClient = createPartnerConnectionsClient(sharedSetupClient);
