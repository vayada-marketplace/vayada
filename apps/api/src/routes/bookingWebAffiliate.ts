import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import pg from "pg";

export type BookingWebAffiliateHotelResolver = {
  findProfileBySlug(slug: string): Promise<unknown | null>;
  close?(): Promise<void>;
};

type BookingWebAffiliateHotelParams = {
  slug: string;
};

type BookingWebAffiliateParams = BookingWebAffiliateHotelParams & {
  affiliateId: string;
};

type BookingWebAffiliateEmailQuery = {
  email?: string;
};

export type BookingWebAffiliateRegistrationRequest = {
  fullName?: string;
  email?: string;
  socialMedia?: string;
  userType?: "guest" | "creator" | string;
  paymentMethod?: "stripe" | "paypal" | "bank" | string;
};

export type BookingWebAffiliateStripeConnectRequest = {
  email?: string;
};

export type BookingWebAffiliateRegistrationResult = {
  id: string;
  referralCode: string;
};

export type BookingWebAffiliateStripeConnectResult = {
  onboardingUrl: string;
};

export type BookingWebAffiliateStripeConnectProvider = {
  createAffiliateOnboardingLink(input: {
    affiliateId: string;
    email: string;
    idempotencyKey: string;
    organizationId: string;
    slug: string;
  }): Promise<{
    onboardingUrl: string;
    providerAccountId: string;
  }>;
};

export type BookingWebAffiliateRepository = {
  checkEmail(slug: string, email: string): Promise<{ exists: boolean }>;
  register(
    slug: string,
    request: BookingWebAffiliateRegistrationRequest,
  ): Promise<BookingWebAffiliateRegistrationResult>;
  createStripeConnectLink(
    slug: string,
    affiliateId: string,
    request: BookingWebAffiliateStripeConnectRequest,
  ): Promise<BookingWebAffiliateStripeConnectResult>;
};

export type BookingWebAffiliateRoutesOptions = {
  hotelResolver: BookingWebAffiliateHotelResolver;
  repository: BookingWebAffiliateRepository;
};

export async function registerBookingWebAffiliateRoutes(
  app: FastifyInstance,
  options: BookingWebAffiliateRoutesOptions,
): Promise<void> {
  app.addHook("onClose", async () => {
    await options.hotelResolver.close?.();
  });

  app.get<{
    Params: BookingWebAffiliateHotelParams;
    Querystring: BookingWebAffiliateEmailQuery;
  }>("/hotels/:slug/affiliates/check-email", async (request, reply) => {
    await assertHotelExists(options.hotelResolver, request.params.slug);
    const email = normalizeEmail(request.query.email);
    if (!email) {
      throw createHttpError(400, "Email is required.");
    }

    const response = await options.repository.checkEmail(request.params.slug, email);
    reply.header("Cache-Control", "no-store");
    reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-affiliate-check-email");
    reply.header("X-Robots-Tag", "noindex");
    return response;
  });

  app.post<{
    Params: BookingWebAffiliateHotelParams;
    Body: BookingWebAffiliateRegistrationRequest;
  }>("/hotels/:slug/affiliates", async (request, reply) => {
    await assertHotelExists(options.hotelResolver, request.params.slug);
    const body = request.body ?? {};
    const email = normalizeEmail(body.email);
    const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
    if (!email) {
      throw createHttpError(400, "Email is required.");
    }
    if (!fullName) {
      throw createHttpError(400, "Full name is required.");
    }

    const response = await options.repository.register(request.params.slug, {
      ...body,
      email,
      fullName,
    });
    reply.header("Cache-Control", "no-store");
    reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-affiliate-register");
    reply.header("X-Robots-Tag", "noindex");
    return response;
  });

  app.post<{
    Params: BookingWebAffiliateParams;
    Body: BookingWebAffiliateStripeConnectRequest;
  }>("/hotels/:slug/affiliates/:affiliateId/stripe/connect", async (request, reply) => {
    await assertHotelExists(options.hotelResolver, request.params.slug);
    const email = normalizeEmail(request.body?.email);
    if (!email) {
      throw createHttpError(400, "Email is required.");
    }
    const response = await options.repository.createStripeConnectLink(
      request.params.slug,
      request.params.affiliateId,
      { ...request.body, email },
    );
    reply.header("Cache-Control", "no-store");
    reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-affiliate-stripe-connect");
    reply.header("X-Robots-Tag", "noindex");
    return response;
  });
}

type PgBookingWebAffiliateRepositoryConfig = {
  connectionString: string;
  max?: number;
  now?: () => Date;
  stripeConnectProvider?: BookingWebAffiliateStripeConnectProvider;
};

export function createPgBookingWebAffiliateRepository(
  config: PgBookingWebAffiliateRepositoryConfig,
): BookingWebAffiliateRepository {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
  });
  const now = config.now ?? (() => new Date());

  return {
    async checkEmail(slug, email) {
      const identity = stableAffiliateIdentity(slug, email);
      const result = await pool.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM identity.organization_resource_links
           WHERE product = 'affiliate'
             AND resource_type = 'affiliate'
             AND relationship = 'promotes'
             AND status = 'active'
             AND resource_id = $1
         ) AS exists`,
        [identity.affiliateId],
      );
      return { exists: result.rows[0]?.exists === true };
    },
    async register(slug, request) {
      const email = normalizeEmail(request.email);
      const fullName = typeof request.fullName === "string" ? request.fullName.trim() : "";
      if (!email) throw createHttpError(400, "Email is required.");
      if (!fullName) throw createHttpError(400, "Full name is required.");

      const identity = stableAffiliateIdentity(slug, email);
      const timestamp = now().toISOString();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO identity.users (id, email, name, status, created_at, updated_at)
           VALUES ($1, $2, $3, 'pending', $4, $4)
           ON CONFLICT (id) DO UPDATE
           SET email = EXCLUDED.email,
               name = COALESCE(NULLIF(EXCLUDED.name, ''), identity.users.name),
               updated_at = EXCLUDED.updated_at`,
          [identity.userId, email, fullName, timestamp],
        );
        await client.query(
          `INSERT INTO identity.organizations (id, kind, name, slug, status, created_at, updated_at)
           VALUES ($1, 'affiliate_partner', $2, $3, 'active', $4, $4)
           ON CONFLICT (id) DO UPDATE
           SET name = EXCLUDED.name,
               status = 'active',
               updated_at = EXCLUDED.updated_at`,
          [identity.organizationId, fullName, identity.organizationSlug, timestamp],
        );
        await client.query(
          `INSERT INTO identity.organization_memberships
             (id, organization_id, user_id, status, role_key, created_at, updated_at)
           VALUES ($1, $2, $3, 'pending', 'affiliate_owner', $4, $4)
           ON CONFLICT (organization_id, user_id) DO UPDATE
           SET status = EXCLUDED.status,
               role_key = EXCLUDED.role_key,
               updated_at = EXCLUDED.updated_at`,
          [identity.membershipId, identity.organizationId, identity.userId, timestamp],
        );
        await client.query(
          `INSERT INTO identity.organization_resource_links
             (id, organization_id, product, resource_type, resource_id, relationship, status, created_at, updated_at)
           VALUES ($1, $2, 'affiliate', 'affiliate', $3, 'promotes', 'active', $4, $4)
           ON CONFLICT (organization_id, product, resource_type, resource_id, relationship) DO UPDATE
           SET status = 'active',
               updated_at = EXCLUDED.updated_at`,
          [identity.resourceLinkId, identity.organizationId, identity.affiliateId, timestamp],
        );
        await insertRegistrationEvent(client, {
          identity,
          slug,
          email,
          request,
          timestamp,
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      return { id: identity.affiliateId, referralCode: identity.referralCode };
    },
    async createStripeConnectLink(slug, affiliateId, request) {
      const email = normalizeEmail(request.email);
      if (!email) throw createHttpError(400, "Email is required.");

      const timestamp = now().toISOString();
      const client = await pool.connect();
      try {
        const affiliate = await findAffiliateRegistration(client, {
          slug,
          affiliateId,
          email,
        });
        if (!affiliate) {
          throw createHttpError(404, "Affiliate not found for this hotel and email.");
        }
        if (!config.stripeConnectProvider) {
          throw createHttpError(503, "Stripe Connect onboarding is not configured.");
        }

        const providerAccount = await config.stripeConnectProvider.createAffiliateOnboardingLink({
          affiliateId,
          email,
          idempotencyKey: affiliateId,
          organizationId: affiliate.organizationId,
          slug,
        });
        await client.query("BEGIN");
        await insertStripeConnectEvent(client, {
          affiliateId,
          organizationId: affiliate.organizationId,
          providerAccountId: providerAccount.providerAccountId,
          timestamp,
        });
        await client.query("COMMIT");
        return { onboardingUrl: providerAccount.onboardingUrl };
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {}
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export function createPgBookingWebAffiliateHotelResolver(config: {
  connectionString: string;
  max?: number;
}): BookingWebAffiliateHotelResolver {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
  });

  return {
    async findProfileBySlug(slug) {
      const result = await pool.query<{ slug: string }>(
        `SELECT profile.canonical_slug AS slug
         FROM hotel_catalog.property_public_profile_read_model profile
         JOIN hotel_catalog.property_slugs property_slug
           ON property_slug.property_id = profile.property_id
          AND property_slug.slug = lower($1)
          AND property_slug.purpose = 'canonical'
          AND property_slug.status = 'active'
         WHERE profile.canonical_slug = lower($1)
           AND profile.profile_status NOT IN ('disabled', 'private')
         LIMIT 1`,
        [slug],
      );
      return result.rows[0] ?? null;
    },
    async close() {
      await pool.end();
    },
  };
}

async function assertHotelExists(
  repository: BookingWebAffiliateHotelResolver,
  slug: string,
): Promise<void> {
  const profile = await repository.findProfileBySlug(slug);
  if (!profile) {
    throw createHttpError(404, "Booking Web hotel profile not found.");
  }
}

async function findAffiliateRegistration(
  client: pg.PoolClient,
  input: {
    slug: string;
    affiliateId: string;
    email: string;
  },
): Promise<{ organizationId: string } | null> {
  const identity = stableAffiliateIdentity(input.slug, input.email);
  if (identity.affiliateId !== input.affiliateId) {
    return null;
  }

  const result = await client.query<{ organizationId: string }>(
    `SELECT link.organization_id AS "organizationId"
     FROM identity.organization_resource_links link
     JOIN identity.organization_memberships membership
      ON membership.organization_id = link.organization_id
      AND membership.user_id = $4
      AND membership.status IN ('pending', 'active')
      AND membership.role_key = 'affiliate_owner'
     JOIN identity.users app_user
       ON app_user.id = membership.user_id
      AND lower(app_user.email) = $3
     WHERE link.id = $1
       AND link.organization_id = $5
       AND link.product = 'affiliate'
       AND link.resource_type = 'affiliate'
       AND link.relationship = 'promotes'
       AND link.status = 'active'
       AND link.resource_id = $2
     LIMIT 1`,
    [
      identity.resourceLinkId,
      input.affiliateId,
      input.email,
      identity.userId,
      identity.organizationId,
    ],
  );
  return result.rows[0] ?? null;
}

async function insertRegistrationEvent(
  client: pg.PoolClient,
  input: {
    identity: StableAffiliateIdentity;
    slug: string;
    email: string;
    request: BookingWebAffiliateRegistrationRequest;
    timestamp: string;
  },
): Promise<void> {
  const eventKey = `marketplace.affiliate.public_registered:${input.identity.affiliateId}:v1`;
  const payload = {
    affiliateId: input.identity.affiliateId,
    referralCode: input.identity.referralCode,
    hotelSlug: input.slug,
    emailHash: sha256(input.email),
    userType: input.request.userType ?? null,
    paymentMethod: input.request.paymentMethod ?? null,
    hasSocialMedia: Boolean(input.request.socialMedia),
  };

  await client.query(
    `INSERT INTO platform.domain_events
       (
         source_system,
         event_key,
         event_type,
         event_version,
         occurred_at,
         tenant_scope,
         organization_id,
         resource_product,
         resource_type,
         resource_id,
         actor_type,
         correlation_id,
         payload,
         event_metadata,
         privacy_scope
       )
     VALUES
       ('marketplace', $1, 'marketplace.affiliate.public_registered', 1, $2,
        'organization', $3, 'marketplace', 'affiliate', $4, 'system', $5,
        $6::jsonb, $7::jsonb, 'confidential')
     ON CONFLICT (source_system, event_key) DO NOTHING`,
    [
      eventKey,
      input.timestamp,
      input.identity.organizationId,
      input.identity.affiliateId,
      eventKey,
      JSON.stringify(payload),
      JSON.stringify({ source: "booking-web-affiliate-target" }),
    ],
  );

  await client.query(
    `INSERT INTO platform.product_audit_events
       (
         audit_key,
         product,
         action,
         occurred_at,
         tenant_scope,
         organization_id,
         actor_type,
         target_resource_product,
         target_resource_type,
         target_resource_id,
         correlation_id,
         redacted_payload,
         audit_metadata,
         retention_class,
         privacy_scope
       )
     VALUES
       ($1, 'marketplace', 'marketplace.affiliate.public_registered', $2,
        'organization', $3, 'system', 'marketplace', 'affiliate', $4, $1,
        $5::jsonb, $6::jsonb, 'standard', 'confidential')
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      eventKey,
      input.timestamp,
      input.identity.organizationId,
      input.identity.affiliateId,
      JSON.stringify(payload),
      JSON.stringify({ source: "booking-web-affiliate-target" }),
    ],
  );
}

async function insertStripeConnectEvent(
  client: pg.PoolClient,
  input: {
    affiliateId: string;
    organizationId: string;
    providerAccountId: string;
    timestamp: string;
  },
): Promise<void> {
  const eventKey = `finance.affiliate.stripe_connect_link_requested:${input.affiliateId}:v1`;
  const payload = {
    affiliateId: input.affiliateId,
    provider: "stripe",
    providerAccountId: input.providerAccountId,
  };

  await client.query(
    `INSERT INTO platform.domain_events
       (
         source_system,
         event_key,
         event_type,
         event_version,
         occurred_at,
         tenant_scope,
         organization_id,
         resource_product,
         resource_type,
         resource_id,
         actor_type,
         correlation_id,
         payload,
         event_metadata,
         privacy_scope
       )
     VALUES
       ('finance', $1, 'finance.affiliate.stripe_connect_link_requested', 1, $2,
        'organization', $3, 'finance', 'payment_provider_account', $4, 'system', $1,
        $5::jsonb, $6::jsonb, 'confidential')
     ON CONFLICT (source_system, event_key) DO NOTHING`,
    [
      eventKey,
      input.timestamp,
      input.organizationId,
      input.providerAccountId,
      JSON.stringify(payload),
      JSON.stringify({ source: "booking-web-affiliate-target" }),
    ],
  );

  await client.query(
    `INSERT INTO platform.product_audit_events
       (
         audit_key,
         product,
         action,
         occurred_at,
         tenant_scope,
         organization_id,
         actor_type,
         target_resource_product,
         target_resource_type,
         target_resource_id,
         correlation_id,
         redacted_payload,
         audit_metadata,
         retention_class,
         privacy_scope
       )
     VALUES
       ($1, 'finance', 'finance.affiliate.stripe_connect_link_requested', $2,
        'organization', $3, 'system', 'finance', 'payment_provider_account', $4, $1,
        $5::jsonb, $6::jsonb, 'financial', 'confidential')
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      eventKey,
      input.timestamp,
      input.organizationId,
      input.providerAccountId,
      JSON.stringify(payload),
      JSON.stringify({ source: "booking-web-affiliate-target" }),
    ],
  );
}

type StableAffiliateIdentity = {
  affiliateId: string;
  referralCode: string;
  userId: string;
  organizationId: string;
  organizationSlug: string;
  membershipId: string;
  resourceLinkId: string;
};

function stableAffiliateIdentity(slug: string, email: string): StableAffiliateIdentity {
  const normalizedEmail = normalizeEmail(email);
  const normalizedSlug = normalizeSlug(slug);
  const key = `${normalizedSlug}:${normalizedEmail}`;
  const affiliateHash = sha256(`affiliate:${key}`);
  const emailHash = sha256(`affiliate-email:${normalizedEmail}`);

  return {
    affiliateId: `aff_${affiliateHash.slice(0, 20)}`,
    referralCode: `VA${affiliateHash.slice(0, 8).toUpperCase()}`,
    userId: uuidFromHash(`affiliate-user:${normalizedEmail}`),
    organizationId: uuidFromHash(`affiliate-organization:${normalizedEmail}`),
    organizationSlug: `affiliate-${emailHash.slice(0, 16)}`,
    membershipId: uuidFromHash(`affiliate-membership:${normalizedEmail}`),
    resourceLinkId: uuidFromHash(`affiliate-resource-link:${key}`),
  };
}

function normalizeEmail(value: unknown): string {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
    ? value.trim().toLowerCase()
    : "";
}

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase();
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function uuidFromHash(value: string): string {
  const hash = sha256(value).slice(0, 32).split("");
  hash[12] = "4";
  hash[16] = ((Number.parseInt(hash[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const hex = hash.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}

function createHttpError(statusCode: number, message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
}

type HttpError = Error & {
  statusCode: number;
};
