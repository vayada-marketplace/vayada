import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type {
  MarketplaceCommunicationUnsubscribeClaims,
  MarketplaceCommunicationUnsubscribeTokenPort,
  VerifiedMarketplaceCommunicationUnsubscribeToken,
} from "@vayada/domain-marketplace";

const TOKEN_VERSION = "u1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const KEY_VERSION = /^[A-Za-z0-9_-]{1,64}$/;

export type MarketplaceCommunicationUnsubscribeTokenConfig = {
  currentKeyVersion: string;
  /** Base64url-encoded secrets. Every decoded key must contain at least 32 bytes. */
  keys: Readonly<Record<string, string>>;
};
export type MarketplaceCommunicationUnsubscribeTokenService =
  MarketplaceCommunicationUnsubscribeTokenPort & {
    sign(
      claims: Omit<MarketplaceCommunicationUnsubscribeClaims, "keyVersion" | "nonce"> & {
        nonce?: string;
      },
    ): string;
  };

export function createMarketplaceCommunicationUnsubscribeTokenService(
  config: MarketplaceCommunicationUnsubscribeTokenConfig,
): MarketplaceCommunicationUnsubscribeTokenService {
  if (!KEY_VERSION.test(config.currentKeyVersion)) throw new Error("Invalid current key version");
  const keys = new Map(
    Object.entries(config.keys).map(([version, encoded]) => {
      if (!KEY_VERSION.test(version) || !canonicalBase64url(encoded)) {
        throw new Error("Invalid unsubscribe signing key configuration");
      }
      const key = Buffer.from(encoded, "base64url");
      if (key.length < 32) throw new Error("Unsubscribe signing keys must contain 32 bytes");
      return [version, key] as const;
    }),
  );
  if (!keys.has(config.currentKeyVersion)) throw new Error("Current unsubscribe key is missing");
  return {
    sign(input) {
      const claims: MarketplaceCommunicationUnsubscribeClaims = {
        action: input.action,
        channel: input.channel,
        deliveryId: input.deliveryId,
        expiresAt: input.expiresAt,
        keyVersion: config.currentKeyVersion,
        nonce: input.nonce ?? randomBytes(16).toString("base64url"),
        organizationId: input.organizationId,
        topic: input.topic,
        userId: input.userId,
      };
      if (!validClaims(claims)) throw new TypeError("Invalid unsubscribe token claims");
      const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
      const signingInput = `${TOKEN_VERSION}.${payload}`;
      const signature = createHmac("sha256", keys.get(config.currentKeyVersion)!)
        .update(signingInput, "utf8")
        .digest("base64url");
      return `${signingInput}.${signature}`;
    },

    verify(token, now) {
      if (!validDate(now) || token.length < 1 || token.length > 4_096) return null;
      const parts = token.split(".");
      if (
        parts.length !== 3 ||
        parts[0] !== TOKEN_VERSION ||
        !canonicalBase64url(parts[1]!) ||
        !canonicalBase64url(parts[2]!)
      )
        return null;
      let value: unknown;
      try {
        value = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
      } catch {
        return null;
      }
      const claims = parseClaims(value);
      const key = claims ? keys.get(claims.keyVersion) : undefined;
      if (!claims || !key || claims.expiresAt <= Math.floor(now.getTime() / 1_000)) return null;
      const expected = createHmac("sha256", key)
        .update(`${TOKEN_VERSION}.${parts[1]}`, "utf8")
        .digest();
      const received = Buffer.from(parts[2]!, "base64url");
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
      return Object.freeze({
        claims,
        tokenHash: createHash("sha256").update(token, "utf8").digest("hex"),
      }) satisfies VerifiedMarketplaceCommunicationUnsubscribeToken;
    },
  };
}

function parseClaims(value: unknown): MarketplaceCommunicationUnsubscribeClaims | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = [
    "action",
    "channel",
    "deliveryId",
    "expiresAt",
    "keyVersion",
    "nonce",
    "organizationId",
    "topic",
    "userId",
  ] as const;
  if (
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    return null;
  const claims = value as unknown as MarketplaceCommunicationUnsubscribeClaims;
  return validClaims(claims) ? Object.freeze({ ...claims }) : null;
}

function validClaims(value: MarketplaceCommunicationUnsubscribeClaims): boolean {
  return (
    value.action === "unsubscribe_topic" &&
    value.channel === "email" &&
    UUID.test(value.deliveryId) &&
    Number.isSafeInteger(value.expiresAt) &&
    value.expiresAt > 0 &&
    KEY_VERSION.test(value.keyVersion) &&
    BASE64URL.test(value.nonce) &&
    value.nonce.length >= 22 &&
    value.nonce.length <= 128 &&
    UUID.test(value.organizationId) &&
    value.topic === "collaboration_action_required" &&
    UUID.test(value.userId)
  );
}

function canonicalBase64url(value: string): boolean {
  return BASE64URL.test(value) && Buffer.from(value, "base64url").toString("base64url") === value;
}
const validDate = (value: Date): boolean => !Number.isNaN(value.getTime());
