import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AuthorizationError, type PropertyAccessRepository } from "@vayada/backend-authorization";
import { bookingCustomDomainLockKey } from "@vayada/domain-booking";
import pg from "pg";
import type { QueryResult, QueryResultRow } from "pg";

import {
  BOOKING_CUSTOM_DOMAIN_CNAME_TARGET,
  type BookingCustomDomainCheckResult,
  type BookingCustomDomainVerifier,
} from "../domains/bookingCustomDomainVerification.js";
import { projectPropertyPublicProfile } from "../platform/propertyPublicProfileProjection.js";
import { enforcePropertyRoutePolicy, enforceRoutePolicy } from "./policy.js";

export type BookingCustomDomainStatus = "not_configured" | "pending" | "verified" | "failed";
export type BookingCustomDomainSslStatus = "not_configured" | "pending" | "active" | "failed";

export type BookingCustomDomainDnsRecord = {
  type: "CNAME" | "TXT";
  name: string;
  value: string;
  status: "pending" | "verified" | "failed";
  /** The name as typed in the hotel's DNS panel ("booking"), known after a check. */
  host?: string;
};

export type BookingCustomDomainState = {
  hotelId: string;
  propertyId: string;
  domain: string | null;
  verificationStatus: "pending" | "verified" | "failed" | "disabled" | null;
  verifiedAt?: string | Date | null;
  updatedAt?: string | Date | null;
  /** The Cloudflare hostname that next-api's check registered for this domain (VAY-2580). */
  cloudflareHostnameId?: string | null;
};

export type BookingCustomDomainResponse = {
  hotelId: string;
  propertyId: string;
  configured: boolean;
  domain: string | null;
  status: BookingCustomDomainStatus;
  sslStatus: BookingCustomDomainSslStatus;
  dnsRecords: BookingCustomDomainDnsRecord[];
  verificationErrors: string[];
  /** Why the domain is not verified yet, from the last check (VAY-2568); null otherwise. */
  verificationIssue: BookingCustomDomainCheckResult["issue"];
  checkedAt: string | null;
  updatedAt: string | null;
};

export type UpsertBookingCustomDomainBody = {
  domain: string;
};

export type BookingCustomDomainRepository = {
  resolveCanonicalPropertyId(hotelId: string): Promise<string | null>;
  findByPropertyId(propertyId: string): Promise<BookingCustomDomainState | null>;
  upsertForPropertyId(propertyId: string, domain: string): Promise<BookingCustomDomainState | null>;
  deleteForPropertyId(propertyId: string): Promise<boolean>;
  /** Stores a check's outcome for the property's current hostname; null when it changed since.
   * `registeredHostnameId` is the Cloudflare hostname the check registered, kept on the row. */
  recordCheckResult(
    propertyId: string,
    domain: string,
    status: BookingCustomDomainCheckResult["status"],
    registeredHostnameId?: string,
  ): Promise<BookingCustomDomainState | null>;
  /** Whether any property has this hostname saved (VAY-2580). */
  isHostnameSaved(hostname: string): Promise<boolean>;
  /** Re-projects the public profile read model, which carries the verified domain. */
  projectPublicProfile(propertyId: string): Promise<void>;
  close?(): Promise<void>;
};

export type BookingCustomDomainRouteOptions = {
  verifier?: BookingCustomDomainVerifier;
  /** Republishes a live booking page, so its custom domain follows the verified one. */
  refreshPublicPage?: (propertyId: string, request: FastifyRequest) => Promise<void>;
};

export type BookingCustomDomainPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  end(): Promise<void>;
};

type BookingHotelParams = {
  hotelId: string;
};

type BookingCustomDomainError = {
  statusCode: 401 | 403 | 404 | 422 | 500;
  code:
    | "unauthenticated"
    | "missing_permission"
    | "missing_entitlement"
    | "inactive_entitlement"
    | "missing_resource_access"
    | "invalid_payload"
    | "not_found"
    | "read_model_unavailable"
    | "write_model_unavailable";
  category: "authentication" | "authorization" | "validation" | "read_model" | "write_model";
  message: string;
  details?: unknown;
};

type TargetCustomDomainRow = {
  propertyId: string;
  domain: string | null;
  verificationStatus: "pending" | "verified" | "failed" | "disabled" | null;
  verifiedAt: string | Date | null;
  updatedAt: string | Date | null;
  cloudflareHostnameId?: string | null;
};

const TARGET_BOOKING_CUSTOM_DOMAIN_SCOPED_PROPERTY_CTE = `scoped_property_candidates AS (
  SELECT property_id
  FROM hotel_catalog.property_source_links
  WHERE source_system = 'booking'
    AND source_table = 'booking_hotels'
    AND source_id = $1
    AND relationship = 'canonical_input'
    AND status = 'active'
  UNION
  SELECT property.id AS property_id
  FROM hotel_catalog.properties property
  WHERE property.id::text = $1
),
scoped_property AS (
  SELECT min(property_id::text)::uuid AS property_id
  FROM scoped_property_candidates
  HAVING count(*) = 1
)`;

const TARGET_BOOKING_CUSTOM_DOMAIN_CANONICAL_PROPERTY_CTE = `scoped_property AS (
  SELECT property.id AS property_id FROM hotel_catalog.properties property
  WHERE property.id = $1::uuid
)`;

class BookingCustomDomainConflictError extends Error {
  constructor() {
    super("Domain is already connected to another property.");
    this.name = "BookingCustomDomainConflictError";
  }
}

export function createTargetBookingCustomDomainRepository(config: {
  connectionString: string;
  max?: number;
  pool?: BookingCustomDomainPool;
}): BookingCustomDomainRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Target booking custom-domain repository connectionString must not be empty");
  }

  const ownsPool = !config.pool;
  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });

  return {
    async resolveCanonicalPropertyId(hotelId) {
      return findPropertyIdByBookingHotelId(pool, hotelId);
    },
    async findByPropertyId(propertyId) {
      const result = await pool.query<TargetCustomDomainRow>(
        `WITH ${TARGET_BOOKING_CUSTOM_DOMAIN_CANONICAL_PROPERTY_CTE}
         SELECT
           scoped_property.property_id::text AS "propertyId",
           domain.hostname AS "domain",
           domain.verification_status AS "verificationStatus",
           domain.verified_at AS "verifiedAt",
           domain.updated_at AS "updatedAt",
           domain.cloudflare_hostname_id AS "cloudflareHostnameId"
         FROM scoped_property
         LEFT JOIN LATERAL (
           SELECT hostname, verification_status, verified_at, updated_at, cloudflare_hostname_id
           FROM hotel_catalog.property_domains
           WHERE property_id = scoped_property.property_id
             AND verification_status <> 'disabled'
           ORDER BY canonical_when_verified DESC, updated_at DESC
           LIMIT 1
         ) domain ON TRUE`,
        [propertyId],
      );

      return result.rows[0] ? toState(propertyId, result.rows[0]) : null;
    },
    async upsertForPropertyId(propertyId, domain) {
      const normalizedDomain = normalizeDomain(domain);
      if (!normalizedDomain) {
        throw new Error("Domain must be normalized before persistence.");
      }

      if (!(await findCanonicalPropertyId(pool, propertyId))) return null;

      const existing = await pool.query<{ propertyId: string }>(
        `SELECT property_id::text AS "propertyId"
         FROM hotel_catalog.property_domains
         WHERE hostname = $1
         LIMIT 1`,
        [normalizedDomain],
      );
      const existingPropertyId = existing.rows[0]?.propertyId;
      if (existingPropertyId && existingPropertyId !== propertyId) {
        throw new BookingCustomDomainConflictError();
      }

      const result = await pool.query<TargetCustomDomainRow>(
        `WITH safety_lock AS MATERIALIZED (
           SELECT pg_advisory_xact_lock(hashtextextended($3,0))
         ),
         clear_public_profile AS (
           UPDATE hotel_catalog.property_public_profile_read_model
              SET property_domain_id = NULL,
                  verified_custom_domain = NULL,
                  projected_at = now()
            WHERE property_id = $1::uuid
              AND EXISTS (SELECT 1 FROM safety_lock)
         ),
         delete_old_domains AS (
           DELETE FROM hotel_catalog.property_domains
            WHERE property_id = $1::uuid
              AND hostname <> $2
              AND EXISTS (SELECT 1 FROM safety_lock)
         )
         INSERT INTO hotel_catalog.property_domains (
           property_id,
           hostname,
           verification_status,
           canonical_when_verified,
           verified_at,
           updated_at
         )
         SELECT $1::uuid, $2, 'pending', FALSE, NULL, now()
         FROM safety_lock
         ON CONFLICT (hostname) DO UPDATE
            SET verification_status = 'pending',
                canonical_when_verified = FALSE,
                verified_at = NULL,
                updated_at = now()
          WHERE hotel_catalog.property_domains.property_id = EXCLUDED.property_id
         RETURNING
           property_id::text AS "propertyId",
           hostname AS "domain",
           verification_status AS "verificationStatus",
           verified_at AS "verifiedAt",
           updated_at AS "updatedAt",
           cloudflare_hostname_id AS "cloudflareHostnameId"`,
        [propertyId, normalizedDomain, bookingCustomDomainLockKey(propertyId)],
      );

      if (!result.rows[0]) {
        throw new BookingCustomDomainConflictError();
      }

      return toState(propertyId, result.rows[0]);
    },
    async deleteForPropertyId(propertyId) {
      const result = await pool.query<{ propertyId: string }>(
        `WITH ${TARGET_BOOKING_CUSTOM_DOMAIN_CANONICAL_PROPERTY_CTE},
         safety_lock AS MATERIALIZED (
           SELECT pg_advisory_xact_lock(hashtextextended($2,0))
         ),
         clear_public_profile AS (
           UPDATE hotel_catalog.property_public_profile_read_model profile
              SET property_domain_id = NULL,
                  verified_custom_domain = NULL,
                  projected_at = now()
             FROM scoped_property
            WHERE profile.property_id = scoped_property.property_id
              AND EXISTS (SELECT 1 FROM safety_lock)
         ),
         delete_domains AS (
           DELETE FROM hotel_catalog.property_domains domain
            USING scoped_property, safety_lock
            WHERE domain.property_id = scoped_property.property_id
         )
         SELECT scoped_property.property_id::text AS "propertyId"
         FROM scoped_property, safety_lock`,
        [propertyId, bookingCustomDomainLockKey(propertyId)],
      );

      return Boolean(result.rows[0]);
    },
    async recordCheckResult(propertyId, domain, status, registeredHostnameId) {
      const result = await pool.query<TargetCustomDomainRow>(
        `WITH safety_lock AS MATERIALIZED (
           SELECT pg_advisory_xact_lock(hashtextextended($4,0))
         )
         UPDATE hotel_catalog.property_domains
            SET verification_status = $3::text,
                canonical_when_verified = ($3::text = 'verified'),
                verified_at = CASE WHEN $3::text = 'verified' THEN now() END,
                cloudflare_hostname_id = COALESCE($5::text, cloudflare_hostname_id),
                updated_at = now()
          WHERE property_id = $1::uuid
            AND hostname = $2
            AND verification_status <> 'disabled'
            AND EXISTS (SELECT 1 FROM safety_lock)
         RETURNING
           property_id::text AS "propertyId",
           hostname AS "domain",
           verification_status AS "verificationStatus",
           verified_at AS "verifiedAt",
           updated_at AS "updatedAt",
           cloudflare_hostname_id AS "cloudflareHostnameId"`,
        [
          propertyId,
          domain,
          status,
          bookingCustomDomainLockKey(propertyId),
          registeredHostnameId ?? null,
        ],
      );
      const row = result.rows[0];
      return row ? toState(propertyId, row) : null;
    },
    async isHostnameSaved(hostname) {
      const result = await pool.query(
        `SELECT 1 FROM hotel_catalog.property_domains WHERE hostname = $1 LIMIT 1`,
        [hostname],
      );
      return result.rows.length > 0;
    },
    async projectPublicProfile(propertyId) {
      await projectPropertyPublicProfile(pool, { propertyId });
    },
    async close() {
      if (ownsPool) {
        await pool.end();
      }
    },
  };
}

export async function registerBookingCustomDomainRoutes(
  app: FastifyInstance,
  repository: BookingCustomDomainRepository,
  propertyAccessRepository: PropertyAccessRepository,
  options: BookingCustomDomainRouteOptions = {},
): Promise<void> {
  const authorizedPropertyIds = new WeakMap<FastifyRequest, string>();
  // A live page shows the verified domain (and booking-web redirects to it), so every change of
  // the verified domain republishes it. Fire and forget, like settings saves; failures are logged.
  const refreshPublicPage = (propertyId: string, request: FastifyRequest) => {
    options
      .refreshPublicPage?.(propertyId, request)
      .catch((error: unknown) =>
        request.log.warn(
          { err: error, propertyId },
          "Booking page refresh after a custom-domain change failed",
        ),
      );
  };
  // A removed or replaced domain's Cloudflare hostname goes with it, if next-api's check registered
  // it (VAY-2580); the old booking-api's hostnames are never touched. Awaited, so the hotel can add
  // the domain again right after; a Cloudflare failure is logged (status and codes only) and the
  // removal stands.
  const releaseHostname = async (
    domain: string | null,
    hostnameId: string | null | undefined,
    propertyId: string,
    request: FastifyRequest,
  ) => {
    if (!domain || !hostnameId || !options.verifier) return;
    const context = { propertyId, domain, hostnameId };
    try {
      // Saved again meanwhile (another tab, or another hotel): its check may already use it.
      if (await repository.isHostnameSaved(domain)) {
        request.log.warn(
          context,
          "Kept a removed custom domain's Cloudflare hostname: saved again",
        );
        return;
      }
      const outcome = await options.verifier.release(hostnameId);
      request.log.info(
        { ...context, outcome },
        outcome === "deleted"
          ? "Deleted a removed custom domain's Cloudflare hostname"
          : "A removed custom domain's Cloudflare hostname was already gone",
      );
    } catch (error) {
      request.log.warn(
        { ...context, err: error },
        "Deleting a removed custom domain's Cloudflare hostname failed",
      );
    }
  };
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const { hotelId } = request.params as BookingHotelParams;
    const propertyId = await enforceBookingCustomDomainAccess(
      request,
      hotelId,
      repository,
      propertyAccessRepository,
    );
    if (typeof propertyId !== "string") {
      sendBookingCustomDomainError(reply, propertyId);
      return;
    }
    authorizedPropertyIds.set(request, propertyId);
  };

  app.addHook("onClose", async () => {
    await repository.close?.();
  });

  app.get<{ Params: BookingHotelParams }>(
    "/hotels/:hotelId/custom-domain",
    { onRequest: authorize },
    async (request, reply) => {
      const { hotelId } = request.params;
      const propertyId = authorizedPropertyIds.get(request)!;

      let state: BookingCustomDomainState | null;
      try {
        state = await repository.findByPropertyId(propertyId);
      } catch {
        return sendBookingCustomDomainError(reply, {
          statusCode: 500,
          code: "read_model_unavailable",
          category: "read_model",
          message: "Booking custom-domain status is unavailable.",
        });
      }

      if (!state) {
        return sendBookingCustomDomainError(reply, {
          statusCode: 404,
          code: "not_found",
          category: "read_model",
          message: "Booking custom-domain target not found.",
        });
      }

      return toBookingCustomDomainResponse({ ...state, hotelId });
    },
  );

  app.put<{ Params: BookingHotelParams; Body: unknown }>(
    "/hotels/:hotelId/custom-domain",
    { onRequest: authorize },
    async (request, reply) => {
      const { hotelId } = request.params;
      const propertyId = authorizedPropertyIds.get(request)!;

      const parsed = parseUpsertBookingCustomDomainBody(request.body);
      if (!parsed.ok) {
        return sendBookingCustomDomainError(reply, {
          statusCode: 422,
          code: "invalid_payload",
          category: "validation",
          message: "Booking custom-domain payload is invalid.",
          details: parsed.details,
        });
      }

      // Saving the verified domain again keeps it verified (and on the live page) as it is.
      const previous = await repository.findByPropertyId(propertyId).catch(() => null);
      if (previous?.domain === parsed.value.domain && previous.verificationStatus === "verified") {
        return toBookingCustomDomainResponse({ ...previous, hotelId });
      }

      let state: BookingCustomDomainState | null;
      try {
        state = await repository.upsertForPropertyId(propertyId, parsed.value.domain);
      } catch (error) {
        if (error instanceof BookingCustomDomainConflictError) {
          return sendBookingCustomDomainError(reply, {
            statusCode: 422,
            code: "invalid_payload",
            category: "validation",
            message: "Booking custom-domain payload is invalid.",
            details: [error.message],
          });
        }

        return sendBookingCustomDomainError(reply, {
          statusCode: 500,
          code: "write_model_unavailable",
          category: "write_model",
          message: "Booking custom-domain could not be saved.",
        });
      }

      if (!state) {
        return sendBookingCustomDomainError(reply, {
          statusCode: 404,
          code: "not_found",
          category: "write_model",
          message: "Booking custom-domain target not found.",
        });
      }

      if (previous?.domain && previous.domain !== state.domain) {
        await releaseHostname(previous.domain, previous.cloudflareHostnameId, propertyId, request);
      }
      // The verified domain was replaced: the live page must stop using it. When unsure, refresh.
      if (!previous || previous.verificationStatus === "verified") {
        refreshPublicPage(propertyId, request);
      }
      return toBookingCustomDomainResponse({ ...state, hotelId });
    },
  );

  app.post<{ Params: BookingHotelParams }>(
    "/hotels/:hotelId/custom-domain/check",
    { onRequest: authorize },
    async (request, reply) => {
      const { hotelId } = request.params;
      const propertyId = authorizedPropertyIds.get(request)!;

      let state: BookingCustomDomainState | null;
      try {
        state = await repository.findByPropertyId(propertyId);
      } catch {
        return sendBookingCustomDomainError(reply, {
          statusCode: 500,
          code: "read_model_unavailable",
          category: "read_model",
          message: "Booking custom-domain status is unavailable.",
        });
      }
      if (!state) {
        return sendBookingCustomDomainError(reply, {
          statusCode: 404,
          code: "not_found",
          category: "read_model",
          message: "Booking custom-domain target not found.",
        });
      }

      // A verified domain stays verified; there is nothing to check without one.
      const status = toContractStatus(state);
      if ((status !== "pending" && status !== "failed") || !state.domain) {
        return toBookingCustomDomainResponse({ ...state, hotelId });
      }

      const domain = state.domain;
      let result: BookingCustomDomainCheckResult;
      try {
        if (!options.verifier) throw new Error("Custom-domain verification is not configured.");
        result = await options.verifier.check(domain, propertyId);
      } catch (error) {
        request.log.warn({ err: error, propertyId, domain }, "Booking custom-domain check failed");
        result = {
          status: status === "failed" ? "failed" : "pending",
          issue: { code: "check_unavailable", foundTarget: null },
          recordHost: null,
          errors: ["The domain could not be checked right now. Try again in a few minutes."],
        };
      }

      if (result.issue?.code === "routing_pending") {
        // Vayada's turn: platform's next_booking_custom_domains needs "<domain>" for this property.
        request.log.warn(
          { propertyId, domain },
          "Custom domain is ready in Cloudflare but not routed to the new booking frontend",
        );
      }

      if (
        result.issue?.code !== "check_unavailable" &&
        (result.status !== state.verificationStatus || result.registeredHostnameId)
      ) {
        let recorded: BookingCustomDomainState | null;
        try {
          recorded = await repository.recordCheckResult(
            propertyId,
            domain,
            result.status,
            result.registeredHostnameId,
          );
        } catch (error) {
          request.log.error(
            { err: error, propertyId, domain, registeredHostnameId: result.registeredHostnameId },
            "Booking custom-domain check could not be saved",
          );
          return sendBookingCustomDomainError(reply, {
            statusCode: 500,
            code: "write_model_unavailable",
            category: "write_model",
            message: "Booking custom-domain check could not be saved.",
          });
        }
        // The hotel replaced or removed the domain meanwhile: a hostname this check registered for it
        // goes too, and the answer is what is stored now.
        if (!recorded) {
          await releaseHostname(domain, result.registeredHostnameId, propertyId, request);
          const current = await repository.findByPropertyId(propertyId).catch(() => null);
          if (current) return toBookingCustomDomainResponse({ ...current, hotelId });
          return sendBookingCustomDomainError(reply, {
            statusCode: 404,
            code: "not_found",
            category: "read_model",
            message: "Booking custom-domain target not found.",
          });
        }
        state = recorded;
        // After the reply, best effort: the read model (PUT/DELETE clear it), then the live page.
        if (recorded.verificationStatus === "verified") {
          void repository
            .projectPublicProfile(propertyId)
            .catch((error: unknown) =>
              request.log.warn(
                { err: error, propertyId },
                "Public profile projection after a custom-domain check failed",
              ),
            )
            .then(() => refreshPublicPage(propertyId, request));
        }
      }

      const response = toBookingCustomDomainResponse({ ...state, hotelId });
      return {
        ...response,
        dnsRecords: response.dnsRecords.map((record) =>
          result.recordHost ? { ...record, host: result.recordHost } : record,
        ),
        verificationErrors: result.errors.length > 0 ? result.errors : response.verificationErrors,
        verificationIssue: result.issue,
        checkedAt: new Date().toISOString(),
      } satisfies BookingCustomDomainResponse;
    },
  );

  app.delete<{ Params: BookingHotelParams }>(
    "/hotels/:hotelId/custom-domain",
    { onRequest: authorize },
    async (request, reply) => {
      const { hotelId } = request.params;
      const propertyId = authorizedPropertyIds.get(request)!;

      const previous = await repository.findByPropertyId(propertyId).catch(() => null);
      let deleted: boolean;
      try {
        deleted = await repository.deleteForPropertyId(propertyId);
      } catch {
        return sendBookingCustomDomainError(reply, {
          statusCode: 500,
          code: "write_model_unavailable",
          category: "write_model",
          message: "Booking custom-domain could not be removed.",
        });
      }

      if (!deleted) {
        return sendBookingCustomDomainError(reply, {
          statusCode: 404,
          code: "not_found",
          category: "write_model",
          message: "Booking custom-domain target not found.",
        });
      }

      if (previous) {
        await releaseHostname(previous.domain, previous.cloudflareHostnameId, propertyId, request);
      }
      if (!previous || previous.verificationStatus === "verified") {
        refreshPublicPage(propertyId, request);
      }
      return reply.code(204).send();
    },
  );
}

async function findPropertyIdByBookingHotelId(
  pool: BookingCustomDomainPool,
  hotelId: string,
): Promise<string | null> {
  const result = await pool.query<{ propertyId: string }>(
    `WITH ${TARGET_BOOKING_CUSTOM_DOMAIN_SCOPED_PROPERTY_CTE}
     SELECT property_id::text AS "propertyId"
     FROM scoped_property`,
    [hotelId],
  );

  return result.rows[0]?.propertyId ?? null;
}

async function findCanonicalPropertyId(
  pool: BookingCustomDomainPool,
  propertyId: string,
): Promise<string | null> {
  const result = await pool.query<{ propertyId: string }>(
    `SELECT property.id::text AS "propertyId" FROM hotel_catalog.properties property WHERE property.id = $1::uuid`,
    [propertyId],
  );

  return result.rows[0]?.propertyId ?? null;
}

async function enforceBookingCustomDomainAccess(
  request: FastifyRequest,
  hotelId: string,
  repository: BookingCustomDomainRepository,
  propertyAccessRepository: PropertyAccessRepository,
): Promise<BookingCustomDomainError | string> {
  try {
    enforceRoutePolicy(request, { permission: "booking.settings.manage" });
    const propertyId = await repository.resolveCanonicalPropertyId(hotelId);
    if (!propertyId) throw new AuthorizationError();
    await enforcePropertyRoutePolicy(
      request,
      {
        permission: "booking.settings.manage",
        property: {
          propertyId,
          targetResource: { product: "booking", resourceType: "booking_hotel" },
        },
        entitlement: {
          product: "booking",
          key: "booking-engine",
          resource: {
            product: "booking",
            resourceType: "booking_hotel",
            resourceId: hotelId,
          },
        },
        resource: {
          product: "booking",
          resourceType: "booking_hotel",
          resourceId: hotelId,
          allowedRelationships: ["owner", "operator"],
        },
      },
      propertyAccessRepository,
    );
    return propertyId;
  } catch (error) {
    const contractError = toBookingCustomDomainAccessError(error, request, hotelId);
    if (contractError) return contractError;
    request.log.error({ err: error }, "Booking custom-domain property access read failed");
    return {
      statusCode: 500,
      code: "read_model_unavailable",
      category: "read_model",
      message: "Booking custom-domain access is unavailable.",
    };
  }
}

function toBookingCustomDomainAccessError(
  error: unknown,
  request: FastifyRequest,
  hotelId: string,
): BookingCustomDomainError | null {
  if (!isStatusError(error)) return null;

  if (error.statusCode === 401) {
    return {
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    };
  }

  if (error.statusCode !== 403) return null;

  const code = toBookingCustomDomainAuthorizationCode(error.message, request, hotelId);
  return {
    statusCode: 403,
    code,
    category: "authorization",
    message: toBookingCustomDomainAuthorizationMessage(code),
  };
}

function toBookingCustomDomainAuthorizationCode(
  message: string,
  request: FastifyRequest,
  hotelId: string,
): Extract<
  BookingCustomDomainError["code"],
  "missing_permission" | "missing_entitlement" | "inactive_entitlement" | "missing_resource_access"
> {
  const normalized = message.toLowerCase();
  if (normalized.includes("permission")) return "missing_permission";
  if (normalized.includes("entitlement")) {
    return hasInactiveBookingEntitlement(request, hotelId)
      ? "inactive_entitlement"
      : "missing_entitlement";
  }
  return "missing_resource_access";
}

function toBookingCustomDomainAuthorizationMessage(
  code: Extract<
    BookingCustomDomainError["code"],
    | "missing_permission"
    | "missing_entitlement"
    | "inactive_entitlement"
    | "missing_resource_access"
  >,
): string {
  switch (code) {
    case "missing_permission":
      return "Missing required booking settings permission.";
    case "inactive_entitlement":
      return "Booking engine entitlement is not active.";
    case "missing_entitlement":
      return "Missing active booking engine entitlement.";
    case "missing_resource_access":
      return "Missing booking hotel access.";
  }
}

function hasInactiveBookingEntitlement(request: FastifyRequest, hotelId: string): boolean {
  return (
    request.authContext?.entitlements.some((entitlement) => {
      if (entitlement.product !== "booking" || entitlement.key !== "booking-engine") {
        return false;
      }
      if (entitlement.status === "active") return false;
      if (!entitlement.resource) return true;
      return (
        entitlement.resource.product === "booking" &&
        entitlement.resource.resourceType === "booking_hotel" &&
        entitlement.resource.resourceId === hotelId
      );
    }) ?? false
  );
}

function parseUpsertBookingCustomDomainBody(
  body: unknown,
): { ok: true; value: UpsertBookingCustomDomainBody } | { ok: false; details: string[] } {
  if (!isPlainRecord(body)) {
    return { ok: false, details: ["body must be a JSON object."] };
  }

  const keys = Object.keys(body);
  const details: string[] = [];
  if (keys.some((key) => key !== "domain")) {
    details.push("unknown fields are not allowed.");
  }

  const domain = body.domain;
  if (typeof domain !== "string") {
    details.push("domain must be a string.");
  } else {
    const normalizedDomain = normalizeDomain(domain);
    if (!normalizedDomain) {
      details.push(
        "domain must be a hostname, not a URL, path, wildcard, localhost, IP, or vayada.com address.",
      );
    }
  }

  if (details.length > 0) return { ok: false, details };
  return { ok: true, value: { domain: normalizeDomain(domain as string)! } };
}

function toBookingCustomDomainResponse(
  state: BookingCustomDomainState,
): BookingCustomDomainResponse {
  const status = toContractStatus(state);
  const configured = status !== "not_configured";
  const domain = configured ? state.domain : null;
  const updatedAt = configured ? toIso(state.updatedAt) : null;
  const checkedAt = configured ? toIso(state.verifiedAt ?? state.updatedAt) : null;

  return {
    hotelId: state.hotelId,
    propertyId: state.propertyId,
    configured,
    domain,
    status,
    sslStatus: toSslStatus(status),
    dnsRecords: domain
      ? [
          {
            type: "CNAME",
            name: domain,
            value: BOOKING_CUSTOM_DOMAIN_CNAME_TARGET,
            status: status === "verified" ? "verified" : status === "failed" ? "failed" : "pending",
          },
        ]
      : [],
    verificationErrors:
      status === "failed" ? ["Domain verification failed. Check DNS records."] : [],
    verificationIssue: null,
    checkedAt,
    updatedAt,
  };
}

function toState(hotelId: string, row: TargetCustomDomainRow): BookingCustomDomainState {
  return {
    hotelId,
    propertyId: row.propertyId,
    domain: row.domain,
    verificationStatus: row.verificationStatus,
    verifiedAt: row.verifiedAt,
    updatedAt: row.updatedAt,
    cloudflareHostnameId: row.cloudflareHostnameId ?? null,
  };
}

function toContractStatus(state: BookingCustomDomainState): BookingCustomDomainStatus {
  if (!state.domain || !state.verificationStatus || state.verificationStatus === "disabled") {
    return "not_configured";
  }
  if (state.verificationStatus === "verified") return "verified";
  if (state.verificationStatus === "failed") return "failed";
  return "pending";
}

function toSslStatus(status: BookingCustomDomainStatus): BookingCustomDomainSslStatus {
  if (status === "verified") return "active";
  if (status === "failed") return "failed";
  if (status === "pending") return "pending";
  return "not_configured";
}

function normalizeDomain(value: string): string | null {
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  if (!domain || domain.length > 253) return null;
  if (
    domain.includes("://") ||
    domain.includes("/") ||
    domain.includes("?") ||
    domain.includes("#") ||
    domain.startsWith("*.") ||
    domain === "localhost" ||
    domain.endsWith(".localhost") ||
    // Vayada's own addresses (a hotel's *.next-booking.vayada.com page included) are not custom.
    domain === "vayada.com" ||
    domain.endsWith(".vayada.com") ||
    /^[\d.]+$/.test(domain)
  ) {
    return null;
  }

  const label = "(?!-)[a-z0-9-]{1,63}(?<!-)";
  const hostname = new RegExp(`^${label}(\\.${label})*\\.[a-z]{2,63}$`);
  return hostname.test(domain) ? domain : null;
}

function toIso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function sendBookingCustomDomainError(
  reply: FastifyReply,
  error: BookingCustomDomainError,
): FastifyReply {
  return reply.status(error.statusCode).send(error);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isStatusError(error: unknown): error is Error & { statusCode: number } {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  );
}
