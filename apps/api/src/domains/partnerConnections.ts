import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import pg, { type PoolClient } from "pg";

import { PROPERTY_CURRENCY_SQL } from "../routes/bookingPromoCodes.js";
import { LIVE_PROMO_CODES_SQL } from "./bookingGuestModules.js";

/**
 * VAY-2436: partner apps (Creator Links first) and a hotel's one-time approval of one: the OAuth 2.0
 * authorization code flow with PKCE (RFC 6749, RFC 7636) behind /partner (contract "What Vayada
 * accepts and sends", project P-VAY-32). A partner app is a distribution.external_api_clients row with
 * the 'partner_connection' surface; a hotel's approval is a partner_connections row (migration 0544).
 *
 * Codes and tokens are random 256-bit values with a readable prefix, stored only as SHA-256 hashes.
 * They are opaque, never WorkOS tokens: a partner token can't pass the /api check (VAY-2501), and a
 * WorkOS token is never found among partner tokens.
 */

export const PARTNER_SCOPES = ["promo_codes", "bookings"] as const;
export type PartnerScope = (typeof PARTNER_SCOPES)[number];

export const ACCESS_TOKEN_TTL_SECONDS = 3_600;
export const REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 3_600;
export const AUTHORIZATION_CODE_TTL_SECONDS = 300;

const PREFIX = {
  code: "vyp_ac_",
  access: "vyp_at_",
  refresh: "vyp_rt_",
  secret: "vyp_cs_",
} as const;

export const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

export const newSecretValue = (kind: keyof typeof PREFIX) =>
  `${PREFIX[kind]}${randomBytes(32).toString("base64url")}`;

/** RFC 7636 S256: BASE64URL(SHA256(ASCII(code_verifier))). */
export const pkceChallenge = (verifier: string) =>
  createHash("sha256").update(verifier, "ascii").digest("base64url");

const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!CODE_VERIFIER.test(verifier) || !CODE_CHALLENGE.test(challenge)) return false;
  return safeEqual(pkceChallenge(verifier), challenge);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Space-separated scopes, each known and listed once; null when anything else is in it. */
export function parseScopes(value: string): PartnerScope[] | null {
  const parts = value.split(" ");
  if (parts.some((part) => !(PARTNER_SCOPES as readonly string[]).includes(part))) return null;
  if (new Set(parts).size !== parts.length) return null;
  return PARTNER_SCOPES.filter((scope) => parts.includes(scope));
}

export const formatScopes = (scopes: readonly string[]) =>
  PARTNER_SCOPES.filter((scope) => scopes.includes(scope)).join(" ");

export type PartnerApp = {
  /** distribution.external_api_clients.id */
  appId: string;
  clientId: string;
  name: string;
  redirectUris: string[];
  allowedScopes: PartnerScope[];
};

export type AuthorizationRequest = {
  app: PartnerApp;
  redirectUri: string;
  scopes: PartnerScope[];
  codeChallenge: string;
  state: string | null;
};

export type AuthorizationRequestError =
  /** Shown on Vayada's page: never redirect to an address that isn't registered (RFC 6749 4.1.2.1). */
  | { redirectable: false; error: "invalid_client" | "invalid_redirect_uri" }
  | {
      redirectable: true;
      error: "invalid_request" | "unsupported_response_type" | "invalid_scope";
      redirectTo: string;
    };

/** The authorize request's query, checked against the registered app. */
export function checkAuthorizationRequest(
  app: PartnerApp | null,
  params: Record<string, unknown>,
): { ok: true; request: AuthorizationRequest } | ({ ok: false } & AuthorizationRequestError) {
  const text = (key: string) => (typeof params[key] === "string" ? params[key] : undefined);
  if (!app || text("client_id") !== app.clientId)
    return { ok: false, redirectable: false, error: "invalid_client" };
  const redirectUri = text("redirect_uri");
  if (!redirectUri || !app.redirectUris.includes(redirectUri))
    return { ok: false, redirectable: false, error: "invalid_redirect_uri" };
  const rawState = text("state");
  const state = rawState === undefined || rawState === "" ? null : rawState;
  const fail = (error: "invalid_request" | "unsupported_response_type" | "invalid_scope") => ({
    ok: false as const,
    redirectable: true as const,
    error,
    redirectTo: authorizationRedirect(redirectUri, { error }, state),
  });
  if (state !== null && state.length > 1024) return fail("invalid_request");
  if (text("response_type") !== "code") return fail("unsupported_response_type");
  const scope = text("scope");
  const scopes = scope === undefined ? app.allowedScopes : parseScopes(scope);
  if (!scopes || scopes.length === 0 || scopes.some((s) => !app.allowedScopes.includes(s)))
    return fail("invalid_scope");
  const codeChallenge = text("code_challenge");
  if (
    text("code_challenge_method") !== "S256" ||
    !codeChallenge ||
    !CODE_CHALLENGE.test(codeChallenge)
  )
    return fail("invalid_request");
  return { ok: true, request: { app, redirectUri, scopes, codeChallenge, state } };
}

export function authorizationRedirect(
  redirectUri: string,
  values: Record<string, string>,
  state: string | null,
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  if (state !== null) url.searchParams.set("state", state);
  return url.toString();
}

export type PartnerTokenGrant = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes: PartnerScope[];
  hotel: { hotelId: string; name: string };
};

export type PartnerAccess = {
  appId: string;
  connectionId: string;
  propertyId: string;
  scopes: PartnerScope[];
};

export type PartnerHotel = {
  hotelId: string;
  name: string;
  currency: string | null;
  bookingPageUrl: string | null;
  promoCodesEnabled: boolean;
  rooms: { roomId: string; name: string }[];
};

export type PartnerConnectionSummary = {
  connectionId: string;
  appName: string;
  scopes: PartnerScope[];
  approvedAt: string;
  approvedByName: string | null;
};

export type ApprovableProperty = { propertyId: string; name: string; promoCodesEnabled: boolean };

export type PartnerConnectionsRepository = {
  /** An active partner app, by its public client id. */
  findApp(clientId: string): Promise<PartnerApp | null>;
  /** The app when the client id and secret match (HTTP Basic on the token and revoke calls). */
  authenticateClient(clientId: string, secret: string): Promise<PartnerApp | null>;
  /** Records the approval (one active connection per app and hotel) and returns a one-time code. */
  approve(input: {
    request: AuthorizationRequest;
    propertyId: string;
    approvedByUserId: string;
  }): Promise<{ code: string }>;
  exchangeCode(input: {
    app: PartnerApp;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<PartnerTokenGrant | { error: "invalid_grant" }>;
  refresh(input: {
    app: PartnerApp;
    refreshToken: string;
    scopes: PartnerScope[] | null;
  }): Promise<PartnerTokenGrant | { error: "invalid_grant" | "invalid_scope" }>;
  /** RFC 7009 with the contract's meaning: any of the app's tokens disconnects its hotel. */
  revokeByPartner(input: { app: PartnerApp; token: string }): Promise<void>;
  authenticateAccessToken(token: string): Promise<PartnerAccess | null>;
  readHotel(propertyId: string): Promise<PartnerHotel | null>;
  readApprovableProperties(propertyIds: readonly string[]): Promise<ApprovableProperty[]>;
  listConnections(propertyId: string): Promise<PartnerConnectionSummary[]>;
  /** The hotel's Disconnect: false when there is no active connection with that id at the hotel. */
  disconnect(input: { propertyId: string; connectionId: string; userId: string }): Promise<boolean>;
  close?(): Promise<void>;
};

type EndedConnection = { id: string; clientId: string; propertyId: string };

type AppRow = {
  appId: string;
  clientId: string;
  name: string;
  redirectUris: string[];
  allowedScopes: string[];
  credentialHashRef: string | null;
};

const APP_SELECT = `SELECT id::text AS "appId", public_client_id AS "clientId", client_name AS name,
         redirect_uris AS "redirectUris", allowed_scopes AS "allowedScopes",
         credential_hash_ref AS "credentialHashRef"
       FROM distribution.external_api_clients
       WHERE public_client_id = $1 AND status = 'active'
         AND 'partner_connection' = ANY(allowed_surfaces)`;

const toApp = (row: AppRow): PartnerApp => ({
  appId: row.appId,
  clientId: row.clientId,
  name: row.name,
  redirectUris: row.redirectUris,
  allowedScopes: PARTNER_SCOPES.filter((scope) => row.allowedScopes.includes(scope)),
});

const knownScopes = (scopes: readonly string[]) =>
  PARTNER_SCOPES.filter((scope) => scopes.includes(scope));

/** An https origin, else null (as the AI hotel profiles read the booking page address). */
function httpsOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function createPgPartnerConnectionsRepository(config: {
  connectionString?: string;
  pool?: pg.Pool;
  max?: number;
  now?: () => Date;
}): PartnerConnectionsRepository {
  const ownsPool = !config.pool;
  if (!config.pool && !config.connectionString?.trim())
    throw new Error("Partner connections repository needs a connection string");
  const pool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  const now = config.now ?? (() => new Date());

  async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** A refresh token keeps the family's scopes; the access token may carry fewer (RFC 6749 6). */
  async function issuePair(
    client: PoolClient,
    input: {
      connectionId: string;
      familyId: string;
      scopes: PartnerScope[];
      refreshScopes?: PartnerScope[];
      at: Date;
    },
  ) {
    const accessToken = newSecretValue("access");
    const refreshToken = newSecretValue("refresh");
    await client.query(
      `INSERT INTO distribution.partner_tokens
         (token_hash, connection_id, token_kind, family_id, scopes, expires_at, created_at)
       VALUES ($1, $3::uuid, 'access', $4::uuid, $5::text[], $6::timestamptz + make_interval(secs => $7), $6),
              ($2, $3::uuid, 'refresh', $4::uuid, $9::text[], $6::timestamptz + make_interval(secs => $8), $6)`,
      [
        sha256Hex(accessToken),
        sha256Hex(refreshToken),
        input.connectionId,
        input.familyId,
        input.scopes,
        input.at.toISOString(),
        ACCESS_TOKEN_TTL_SECONDS,
        REFRESH_TOKEN_TTL_SECONDS,
        input.refreshScopes ?? input.scopes,
      ],
    );
    return { accessToken, refreshToken };
  }

  const revokeFamily = (client: PoolClient, familyId: string, at: Date) =>
    client.query(
      `UPDATE distribution.partner_tokens SET revoked_at = $2
       WHERE family_id = $1::uuid AND revoked_at IS NULL`,
      [familyId, at.toISOString()],
    );

  /** VAY-2437: the app's active codes at the hotel are retired when it is disconnected or loses
   * promo_codes (decided 2026-10-31), so no discount stays without the partner behind it. A statement
   * of its own after the connection's UPDATE, so it sees a code made just before the disconnect; rows
   * are locked in id order, as checkout locks them. */
  const retireAppCodes = (client: PoolClient, appId: string, propertyId: string, at: string) =>
    client.query(
      `WITH doomed AS (
         SELECT id FROM booking.promo_definitions
         WHERE partner_client_id = $1::uuid AND property_id = $2::uuid AND status <> 'retired'
         ORDER BY id
         FOR UPDATE
       )
       UPDATE booking.promo_definitions promo
       SET status = 'retired', is_active = false, updated_at = $3
       FROM doomed WHERE promo.id = doomed.id`,
      [appId, propertyId, at],
    );

  /** A revoked connection: every token stops and the app's codes there are retired. */
  async function endConnection(client: PoolClient, connection: EndedConnection, at: string) {
    await client.query(
      `UPDATE distribution.partner_tokens SET revoked_at = $2
       WHERE connection_id = $1::uuid AND revoked_at IS NULL`,
      [connection.id, at],
    );
    await retireAppCodes(client, connection.clientId, connection.propertyId, at);
  }

  return {
    async findApp(clientId) {
      const row = (await pool.query<AppRow>(APP_SELECT, [clientId])).rows[0];
      return row ? toApp(row) : null;
    },

    async authenticateClient(clientId, secret) {
      const row = (await pool.query<AppRow>(APP_SELECT, [clientId])).rows[0];
      // Hash and compare even for an unknown client, so the answer takes the same time.
      const expected =
        row?.credentialHashRef?.match(/^sha256:([0-9a-f]{64})$/)?.[1] ?? "0".repeat(64);
      const matches = safeEqual(sha256Hex(secret), expected);
      return row && matches ? toApp(row) : null;
    },

    async approve({ request, propertyId, approvedByUserId }) {
      const code = newSecretValue("code");
      const at = now();
      await transaction(async (client) => {
        const connection = await client.query<{ id: string }>(
          `INSERT INTO distribution.partner_connections
             (client_id, property_id, scopes, approved_by_user_id, approved_at, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, $3::text[], $4::uuid, $5, $5, $5)
           ON CONFLICT (client_id, property_id) WHERE status = 'active'
           DO UPDATE SET scopes = EXCLUDED.scopes, approved_by_user_id = EXCLUDED.approved_by_user_id,
                         approved_at = EXCLUDED.approved_at, updated_at = EXCLUDED.updated_at
           RETURNING id::text`,
          [request.app.appId, propertyId, request.scopes, approvedByUserId, at.toISOString()],
        );
        // Approved again without promo_codes: the app can't manage its codes any more, so they go.
        if (!request.scopes.includes("promo_codes"))
          await retireAppCodes(client, request.app.appId, propertyId, at.toISOString());
        await client.query(
          `INSERT INTO distribution.partner_authorization_codes
             (code_hash, connection_id, redirect_uri, code_challenge, scopes, expires_at, created_at)
           VALUES ($1, $2::uuid, $3, $4, $5::text[], $6::timestamptz + make_interval(secs => $7), $6)`,
          [
            sha256Hex(code),
            connection.rows[0]!.id,
            request.redirectUri,
            request.codeChallenge,
            request.scopes,
            at.toISOString(),
            AUTHORIZATION_CODE_TTL_SECONDS,
          ],
        );
      });
      return { code };
    },

    async exchangeCode({ app, code, redirectUri, codeVerifier }) {
      const at = now();
      return transaction(async (client) => {
        const row = (
          await client.query<{
            connectionId: string;
            clientId: string;
            connectionStatus: string;
            redirectUri: string;
            codeChallenge: string;
            scopes: string[];
            expired: boolean;
            usedFamilyId: string | null;
            connectionScopes: string[];
            hotelId: string;
            hotelName: string;
          }>(
            `SELECT code.connection_id::text AS "connectionId", connection.client_id::text AS "clientId",
                    connection.status AS "connectionStatus", code.redirect_uri AS "redirectUri",
                    code.code_challenge AS "codeChallenge", code.scopes,
                    code.expires_at <= $2 AS expired, code.token_family_id::text AS "usedFamilyId",
                    connection.scopes AS "connectionScopes",
                    property.id::text AS "hotelId", property.display_name AS "hotelName"
             FROM distribution.partner_authorization_codes code
             JOIN distribution.partner_connections connection ON connection.id = code.connection_id
             JOIN hotel_catalog.properties property ON property.id = connection.property_id
             WHERE code.code_hash = $1
             FOR UPDATE OF code`,
            [sha256Hex(code), at.toISOString()],
          )
        ).rows[0];
        if (!row || row.clientId !== app.appId) return { error: "invalid_grant" as const };
        // A second use: stop what the first one got (RFC 6749 4.1.2).
        if (row.usedFamilyId) {
          await revokeFamily(client, row.usedFamilyId, at);
          return { error: "invalid_grant" as const };
        }
        if (
          row.expired ||
          row.connectionStatus !== "active" ||
          row.redirectUri !== redirectUri ||
          !pkceMatches(codeVerifier, row.codeChallenge)
        )
          return { error: "invalid_grant" as const };
        const scopes = knownScopes(row.scopes).filter((scope) =>
          row.connectionScopes.includes(scope),
        );
        if (scopes.length === 0) return { error: "invalid_grant" as const };
        const familyId = randomUUID();
        await client.query(
          `UPDATE distribution.partner_authorization_codes SET used_at = $2, token_family_id = $3::uuid
           WHERE code_hash = $1`,
          [sha256Hex(code), at.toISOString(), familyId],
        );
        const pair = await issuePair(client, {
          connectionId: row.connectionId,
          familyId,
          scopes,
          at,
        });
        return {
          ...pair,
          expiresIn: ACCESS_TOKEN_TTL_SECONDS,
          scopes,
          hotel: { hotelId: row.hotelId, name: row.hotelName },
        };
      });
    },

    async refresh({ app, refreshToken, scopes: requested }) {
      const at = now();
      return transaction(async (client) => {
        const row = (
          await client.query<{
            connectionId: string;
            clientId: string;
            connectionStatus: string;
            familyId: string;
            scopes: string[];
            connectionScopes: string[];
            used: boolean;
            usable: boolean;
            hotelId: string;
            hotelName: string;
          }>(
            `SELECT token.connection_id::text AS "connectionId", connection.client_id::text AS "clientId",
                    connection.status AS "connectionStatus", token.family_id::text AS "familyId",
                    token.scopes, connection.scopes AS "connectionScopes",
                    token.used_at IS NOT NULL AS used,
                    token.revoked_at IS NULL AND token.expires_at > $2 AS usable,
                    property.id::text AS "hotelId", property.display_name AS "hotelName"
             FROM distribution.partner_tokens token
             JOIN distribution.partner_connections connection ON connection.id = token.connection_id
             JOIN hotel_catalog.properties property ON property.id = connection.property_id
             WHERE token.token_hash = $1 AND token.token_kind = 'refresh'
             FOR UPDATE OF token`,
            [sha256Hex(refreshToken), at.toISOString()],
          )
        ).rows[0];
        if (!row || row.clientId !== app.appId) return { error: "invalid_grant" as const };
        // An old refresh token came back: someone else may hold it, so the whole family stops.
        if (row.used) {
          await revokeFamily(client, row.familyId, at);
          return { error: "invalid_grant" as const };
        }
        if (!row.usable || row.connectionStatus !== "active")
          return { error: "invalid_grant" as const };
        const granted = knownScopes(row.scopes);
        if (requested && requested.some((scope) => !granted.includes(scope)))
          return { error: "invalid_scope" as const };
        // The new refresh token keeps what was granted (still approved by the hotel); a narrower
        // request narrows only the access token (RFC 6749 6).
        const kept = granted.filter((scope) => row.connectionScopes.includes(scope));
        const scopes = (requested ?? kept).filter((scope) => kept.includes(scope));
        if (scopes.length === 0) return { error: "invalid_grant" as const };
        await client.query(
          `UPDATE distribution.partner_tokens SET used_at = $2 WHERE token_hash = $1`,
          [sha256Hex(refreshToken), at.toISOString()],
        );
        const pair = await issuePair(client, {
          connectionId: row.connectionId,
          familyId: row.familyId,
          scopes,
          refreshScopes: kept,
          at,
        });
        return {
          ...pair,
          expiresIn: ACCESS_TOKEN_TTL_SECONDS,
          scopes,
          hotel: { hotelId: row.hotelId, name: row.hotelName },
        };
      });
    },

    async revokeByPartner({ app, token }) {
      const at = now().toISOString();
      await transaction(async (client) => {
        const revoked = await client.query<EndedConnection>(
          `UPDATE distribution.partner_connections connection
           SET status = 'revoked', revoked_at = $3, revocation_reason = 'partner_revoked', updated_at = $3
           FROM distribution.partner_tokens token
           WHERE token.token_hash = $1 AND token.connection_id = connection.id
             AND connection.client_id = $2::uuid AND connection.status = 'active'
           RETURNING connection.id::text AS id, connection.client_id::text AS "clientId",
                     connection.property_id::text AS "propertyId"`,
          [sha256Hex(token), app.appId, at],
        );
        for (const connection of revoked.rows) await endConnection(client, connection, at);
      });
    },

    async authenticateAccessToken(token) {
      const row = (
        await pool.query<{
          appId: string;
          connectionId: string;
          propertyId: string;
          scopes: string[];
          connectionScopes: string[];
        }>(
          `SELECT connection.client_id::text AS "appId", connection.id::text AS "connectionId",
                  connection.property_id::text AS "propertyId", token.scopes,
                  connection.scopes AS "connectionScopes"
           FROM distribution.partner_tokens token
           JOIN distribution.partner_connections connection
             ON connection.id = token.connection_id AND connection.status = 'active'
           JOIN distribution.external_api_clients app
             ON app.id = connection.client_id AND app.status = 'active'
            AND 'partner_connection' = ANY(app.allowed_surfaces)
           WHERE token.token_hash = $1 AND token.token_kind = 'access'
             AND token.revoked_at IS NULL AND token.expires_at > $2`,
          [sha256Hex(token), now().toISOString()],
        )
      ).rows[0];
      if (!row) return null;
      const scopes = knownScopes(row.scopes).filter((scope) =>
        row.connectionScopes.includes(scope),
      );
      return scopes.length > 0
        ? { appId: row.appId, connectionId: row.connectionId, propertyId: row.propertyId, scopes }
        : null;
    },

    async readHotel(propertyId) {
      const row = (
        await pool.query<{
          hotelId: string;
          name: string;
          currency: string | null;
          customDomainUrl: string | null;
          bookingBaseUrl: string | null;
          promoCodesEnabled: boolean;
          rooms: { roomId: string; name: string }[];
        }>(
          `SELECT property.id::text AS "hotelId", property.display_name AS name,
                  ${PROPERTY_CURRENCY_SQL} AS currency,
                  profile.custom_domain_url AS "customDomainUrl",
                  profile.booking_base_url AS "bookingBaseUrl",
                  ${LIVE_PROMO_CODES_SQL("$1")} AS "promoCodesEnabled",
                  COALESCE((
                    SELECT json_agg(json_build_object('roomId', room_type.id::text, 'name', room_type.name)
                                    ORDER BY room_type.name, room_type.id)
                    FROM pms.room_types room_type
                    WHERE room_type.property_id = $1 AND room_type.active
                  ), '[]'::json) AS rooms
           FROM hotel_catalog.properties property
           LEFT JOIN distribution.public_hotel_bookability_profiles profile
             ON profile.property_id = property.id
            AND profile.public_visibility = 'public_safe'
            AND profile.profile_status = 'public'
            AND (profile.expires_at IS NULL OR profile.expires_at > now())
           WHERE property.id = $1`,
          [propertyId],
        )
      ).rows[0];
      if (!row) return null;
      return {
        hotelId: row.hotelId,
        name: row.name,
        currency: row.currency,
        // The hotel's own domain when it has one, else its booking page; null while it isn't public.
        bookingPageUrl: httpsOrigin(row.customDomainUrl) ?? httpsOrigin(row.bookingBaseUrl),
        promoCodesEnabled: row.promoCodesEnabled,
        rooms: row.rooms,
      };
    },

    async readApprovableProperties(propertyIds) {
      if (propertyIds.length === 0) return [];
      const result = await pool.query<ApprovableProperty>(
        `SELECT property.id::text AS "propertyId", property.display_name AS name,
                COALESCE(settings.promo_codes_enabled, TRUE) AS "promoCodesEnabled"
         FROM hotel_catalog.properties property
         LEFT JOIN booking.booking_settings settings ON settings.property_id = property.id
         WHERE property.id = ANY($1::uuid[])
         ORDER BY property.display_name, property.id`,
        [propertyIds],
      );
      return result.rows;
    },

    async listConnections(propertyId) {
      const result = await pool.query<{
        connectionId: string;
        appName: string;
        scopes: string[];
        approvedAt: Date;
        approvedByName: string | null;
      }>(
        `SELECT connection.id::text AS "connectionId", app.client_name AS "appName", connection.scopes,
                connection.approved_at AS "approvedAt", NULLIF(trim(approver.name), '') AS "approvedByName"
         FROM distribution.partner_connections connection
         JOIN distribution.external_api_clients app ON app.id = connection.client_id
         LEFT JOIN identity.users approver ON approver.id = connection.approved_by_user_id
         WHERE connection.property_id = $1::uuid AND connection.status = 'active'
         ORDER BY connection.approved_at, connection.id`,
        [propertyId],
      );
      return result.rows.map((row) => ({
        connectionId: row.connectionId,
        appName: row.appName,
        scopes: knownScopes(row.scopes),
        approvedAt: row.approvedAt.toISOString(),
        approvedByName: row.approvedByName,
      }));
    },

    async disconnect({ propertyId, connectionId, userId }) {
      const at = now().toISOString();
      return transaction(async (client) => {
        const revoked = await client.query<EndedConnection>(
          `UPDATE distribution.partner_connections
           SET status = 'revoked', revoked_at = $4, revoked_by_user_id = $3::uuid,
               revocation_reason = 'hotel_disconnected', updated_at = $4
           WHERE id = $2::uuid AND property_id = $1::uuid AND status = 'active'
           RETURNING id::text AS id, client_id::text AS "clientId", property_id::text AS "propertyId"`,
          [propertyId, connectionId, userId, at],
        );
        const connection = revoked.rows[0];
        if (!connection) return false;
        await endConnection(client, connection, at);
        return true;
      });
    },

    async close() {
      if (ownsPool) await pool.end();
    },
  };
}
