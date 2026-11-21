// The RequestContext an AI action uses when it runs a route as the signed-in user (VAY-2506).
//
// Rules (AI actions design note §5.2, plan 3.2):
// - resolved fresh from the database once per tool call, so a removed member or a changed role
//   stops the very next call;
// - only hotel accounts (`hotel_group`); platform accounts are refused;
// - never a session id, so no owner-session gate (`requireOwnerSession`) ever passes;
// - `audit.source = "agent"`, correlation id = the tool-call id, and a fresh random request id for
//   every request (tool-call ids come from AI clients and are not unique);
// - only contexts this module minted are accepted by injectAsDelegate: they are deep-frozen, and
//   expire after DELEGATED_CONTEXT_MAX_AGE_MS so a cached one stops working;
// - narrowed to the member's own properties (VAY-2567 rank 1a): the delegated context keeps only the
//   links of the properties this member may use, on top of the routes' own member check (VAY-2574),
//   and can narrow further to the action's properties. Narrowing can only take rights away.
import { randomUUID } from "node:crypto";

import { AuthError, DelegationRefusedError } from "./errors.js";
import { type IdentityRepository } from "./repository.js";
import { type AuthorizationResolver } from "./resolve.js";
import {
  type LinkedResource,
  type ProductEntitlement,
  type RequestContext,
  type RequestDelegation,
  type ResourceType,
} from "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOOL_CALL_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const LOCALE = /^[a-z]{2}(-[A-Z]{2})?$/;
const CURRENCY = /^[A-Z]{3}$/;

/** A delegated context is resolved per tool call; after this it is refused (VAY-2506 review M1). */
export const DELEGATED_CONTEXT_MAX_AGE_MS = 60_000;

/** Contexts resolveDelegatedContext returned. Nothing else can be injected as a user. */
const minted = new WeakSet<RequestContext>();

/** Link types whose resource id is a canonical property id. Every other link is dropped. */
const PROPERTY_RESOURCE_TYPES: ReadonlySet<ResourceType> = new Set([
  "property",
  "booking_hotel",
  "pms_hotel",
  "pms_property",
]);

export type DelegatedContextInput = {
  /** Internal user id (`identity.users.id`). */
  userId: string;
  /** Internal organization id; for MCP it comes from the connection row, never from a token. */
  organizationId: string;
  delegation: RequestDelegation;
  /** Narrows the delegation to these properties. It can never add one. */
  propertyIds?: readonly string[];
  locale?: string;
  currency?: string;
};

export type DelegatedContextOptions = {
  /** The same resolver the auth plugin uses for browser requests. */
  authorizationResolver: AuthorizationResolver;
  now?: () => Date;
};

/**
 * Resolves the narrowed RequestContext of an AI tool call that acts as `userId` in
 * `organizationId`. Throws AuthError when the user, account or membership is missing or not
 * active, and DelegationRefusedError for platform accounts or malformed input.
 */
export async function resolveDelegatedContext(
  repo: IdentityRepository,
  input: DelegatedContextInput,
  options: DelegatedContextOptions,
): Promise<RequestContext> {
  assertDelegatedInput(input);
  if (!repo.findUserById || !repo.findOrganizationById) {
    throw new Error("The identity repository cannot resolve delegated contexts.");
  }

  const user = await repo.findUserById(input.userId);
  if (!user || !user.workosUserId) {
    throw new AuthError("USER_NOT_FOUND", `No internal user ${input.userId}`);
  }
  if (user.status !== "active") {
    throw new AuthError("USER_SUSPENDED", `User account is ${user.status}`);
  }

  const org = await repo.findOrganizationById(input.organizationId);
  if (!org) {
    throw new AuthError("ORGANIZATION_NOT_FOUND", `No organization ${input.organizationId}`);
  }
  if (org.kind !== "hotel_group") {
    throw new DelegationRefusedError("only hotel accounts can delegate");
  }
  if (org.status !== "active") {
    throw new AuthError("ORGANIZATION_SUSPENDED", `Organization is ${org.status}`);
  }

  const membership = await repo.findActiveMembership(user.userId, org.organizationId);
  if (!membership || membership.status !== "active") {
    throw new AuthError(
      "MEMBERSHIP_NOT_FOUND",
      `No active membership for user ${user.userId} in organization ${org.organizationId}`,
    );
  }

  const resourceLinks = await repo.findLinkedResources(org.organizationId);
  const base: RequestContext = {
    actor: {
      internalUserId: user.userId,
      // No sessionId, ever: routes read any session id as proof of an owner browser session.
      providerIdentity: {
        provider: "workos",
        providerUserId: user.workosUserId,
        ...(org.workosOrgId ? { providerOrganizationId: org.workosOrgId } : {}),
      },
      email: user.email,
      name: user.name,
      status: user.status,
    },
    selectedOrganization: {
      organizationId: org.organizationId,
      ...(org.workosOrgId ? { workosOrgId: org.workosOrgId } : {}),
      name: org.name,
      kind: org.kind,
      status: org.status,
    },
    membership: {
      membershipId: membership.membershipId,
      status: membership.status,
      roleKey: membership.roleKey,
      ...(membership.workosMembershipId
        ? { workosMembershipId: membership.workosMembershipId }
        : {}),
      workosRoleSlugs: membership.workosRoleSlugs,
      permissions: [],
    },
    linkedResources: resourceLinks.map(
      (r): LinkedResource => ({
        product: r.product as LinkedResource["product"],
        resourceType: r.resourceType as LinkedResource["resourceType"],
        resourceId: r.resourceId,
        relationship: r.relationship as LinkedResource["relationship"],
        status: r.status as LinkedResource["status"],
      }),
    ),
    entitlements: [],
    locale: input.locale ?? "en",
    currency: input.currency ?? "USD",
    audit: {
      requestId: randomUUID(),
      correlationId: input.delegation.toolCallId,
      source: "agent",
      receivedAt: (options.now?.() ?? new Date()).toISOString(),
    },
    delegation: { ...input.delegation },
  };

  const authorization = await options.authorizationResolver(base);
  const resolved: RequestContext = {
    ...base,
    membership: {
      ...base.membership,
      permissions: [...authorization.permissions],
      ...(authorization.propertyAccess ? { propertyAccess: authorization.propertyAccess } : {}),
    },
    entitlements: [...(authorization.entitlements ?? [])],
  };
  const narrowed = deepFreeze(narrowDelegatedContext(resolved, input.propertyIds));
  minted.add(narrowed);
  return narrowed;
}

/** True only for a context resolveDelegatedContext returned (package-internal; not exported). */
export function isMintedDelegatedContext(context: RequestContext): boolean {
  return minted.has(context);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Keeps only what the member may use: links of the member's own properties (optionally fewer),
 * and no active entitlement tied to anything else. Suspended entitlements always stay, because
 * they only ever take access away. Idempotent: narrowing a narrowed context changes nothing.
 */
export function narrowDelegatedContext(
  context: RequestContext,
  propertyIds?: readonly string[],
): RequestContext {
  const allowed = new Set(delegatedPropertyIds(context, propertyIds));
  const access = context.membership.propertyAccess;
  return {
    ...context,
    membership: {
      ...context.membership,
      permissions: [...context.membership.permissions],
      ...(access
        ? {
            propertyAccess:
              propertyIds === undefined
                ? access
                : { ...access, mode: "assigned", assignedPropertyIds: [...allowed].sort() },
          }
        : {}),
    },
    linkedResources: context.linkedResources.filter(
      (resource) =>
        PROPERTY_RESOURCE_TYPES.has(resource.resourceType) && allowed.has(resource.resourceId),
    ),
    entitlements: context.entitlements.filter((entitlement) =>
      keepsEntitlement(entitlement, allowed),
    ),
  };
}

/** The canonical property ids a delegated context may use. */
export function delegatedPropertyIds(
  context: Pick<RequestContext, "linkedResources" | "membership">,
  propertyIds?: readonly string[],
): string[] {
  const canonical = new Set(
    context.linkedResources
      .filter(
        (resource) =>
          resource.status === "active" &&
          resource.product === "hotel_catalog" &&
          resource.resourceType === "property",
      )
      .map((resource) => resource.resourceId),
  );
  const access = context.membership.propertyAccess;
  // No property scope means the authorization resolver refused it: no property at all.
  const memberIds = !access
    ? []
    : access.mode === "all"
      ? [...canonical]
      : access.assignedPropertyIds.filter((id) => canonical.has(id));
  const narrowed =
    propertyIds === undefined ? memberIds : memberIds.filter((id) => propertyIds.includes(id));
  return [...new Set(narrowed)].sort();
}

/**
 * True only for a context `resolveDelegatedContext` could have produced: an agent context of an
 * active hotel member, without a session id, already narrowed. The auth hook refuses any other.
 */
export function isDelegatedContext(context: RequestContext): boolean {
  if (
    context.audit.source !== "agent" ||
    !context.delegation ||
    context.delegation.toolCallId !== context.audit.correlationId ||
    context.actor.providerIdentity.sessionId !== undefined ||
    context.actor.status !== "active" ||
    context.selectedOrganization.kind !== "hotel_group" ||
    context.selectedOrganization.status !== "active" ||
    context.membership.status !== "active"
  ) {
    return false;
  }
  const narrowed = narrowDelegatedContext(context);
  return (
    narrowed.linkedResources.length === context.linkedResources.length &&
    narrowed.entitlements.length === context.entitlements.length
  );
}

function keepsEntitlement(entitlement: ProductEntitlement, allowed: ReadonlySet<string>): boolean {
  if (entitlement.status !== "active" || !entitlement.resource) return true;
  return (
    PROPERTY_RESOURCE_TYPES.has(entitlement.resource.resourceType) &&
    allowed.has(entitlement.resource.resourceId)
  );
}

function assertDelegatedInput(input: DelegatedContextInput): void {
  if (!UUID.test(input.userId)) throw new DelegationRefusedError("malformed user id");
  if (!UUID.test(input.organizationId)) {
    throw new DelegationRefusedError("malformed organization id");
  }
  const { delegation } = input;
  if (!TOOL_CALL_ID.test(delegation.toolCallId)) {
    throw new DelegationRefusedError("malformed tool-call id");
  }
  const origin =
    delegation.channel === "mcp"
      ? { id: delegation.connectionId, other: delegation.conversationId }
      : delegation.channel === "in_app"
        ? { id: delegation.conversationId, other: delegation.connectionId }
        : null;
  if (!origin || !origin.id || !UUID.test(origin.id) || origin.other !== undefined) {
    throw new DelegationRefusedError("a delegation needs exactly its connection or conversation");
  }
  if (input.propertyIds && !input.propertyIds.every((id) => UUID.test(id))) {
    throw new DelegationRefusedError("malformed property id");
  }
  if (input.locale !== undefined && !LOCALE.test(input.locale)) {
    throw new DelegationRefusedError("malformed locale");
  }
  if (input.currency !== undefined && !CURRENCY.test(input.currency)) {
    throw new DelegationRefusedError("malformed currency");
  }
}
