import { createHash, createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createMarketplaceCommunicationUnsubscribeTokenService } from "./marketplaceCommunicationUnsubscribeToken.js";

const OLD_SECRET = Buffer.alloc(32, 1).toString("base64url");
const NEW_SECRET = Buffer.alloc(32, 2).toString("base64url");
const ROGUE_SECRET = Buffer.alloc(32, 3).toString("base64url");
const now = new Date("2026-09-17T03:00:00.000Z");
const claims = {
  action: "unsubscribe_topic",
  channel: "email",
  deliveryId: "11111111-1111-4111-8111-111111111111",
  expiresAt: Math.floor(now.getTime() / 1_000) + 3_600,
  organizationId: "22222222-2222-4222-8222-222222222222",
  topic: "collaboration_action_required",
  userId: "33333333-3333-4333-8333-333333333333",
} as const;

function service(
  currentKeyVersion = "key-2",
  keys: Readonly<Record<string, string>> = { "key-1": OLD_SECRET, "key-2": NEW_SECRET },
) {
  return createMarketplaceCommunicationUnsubscribeTokenService({
    currentKeyVersion,
    keys,
  });
}

const signClaims = { ...claims, nonce: "AAAAAAAAAAAAAAAAAAAAAA" } as const;

describe("Marketplace communication unsubscribe token", () => {
  it("signs every required claim and returns only a SHA-256 replay digest", () => {
    const codec = service();
    const token = codec.sign(signClaims);
    const verified = codec.verify(token, now);

    expect(verified).toEqual({
      claims: {
        ...claims,
        keyVersion: "key-2",
        nonce: "AAAAAAAAAAAAAAAAAAAAAA",
      },
      tokenHash: createHash("sha256").update(token).digest("hex"),
    });
    expect(verified?.tokenHash).not.toContain(token);
    expect(token).not.toContain(claims.userId);
  });

  it("accepts retained rotation keys while signing only with the current key", () => {
    const oldToken = service("key-1", { "key-1": OLD_SECRET }).sign(signClaims);
    const rotated = service();

    expect(rotated.verify(oldToken, now)?.claims.keyVersion).toBe("key-1");
    expect(rotated.verify(rotated.sign(signClaims), now)?.claims.keyVersion).toBe("key-2");
  });

  it("uniformly rejects tampering, expiry, unknown keys, and malformed values", () => {
    const codec = service();
    const token = codec.sign(signClaims);
    const [version, payload, signature] = token.split(".") as [string, string, string];
    const tamperedSignature = `${version}.${payload}.${signature.slice(0, -1)}A`;
    const wrongAction = signPayload(
      {
        ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
        action: "unsubscribe_all",
      },
      NEW_SECRET,
    );
    const unknownKey = createMarketplaceCommunicationUnsubscribeTokenService({
      currentKeyVersion: "rogue",
      keys: { rogue: ROGUE_SECRET },
    }).sign({ ...claims, nonce: "BBBBBBBBBBBBBBBBBBBBBB" });

    for (const invalid of [
      tamperedSignature,
      wrongAction,
      unknownKey,
      "",
      "u1.not-json.signature",
      `u2.${payload}.${signature}`,
      `${version}.${payload}=.${signature}`,
      `${version}.${payload}`,
    ]) {
      expect(codec.verify(invalid, now)).toBeNull();
    }
    expect(codec.verify(token, new Date((claims.expiresAt + 1) * 1_000))).toBeNull();
    expect(codec.verify(token, new Date("invalid"))).toBeNull();
  });

  it("rejects incomplete, non-canonical, and weak signing configuration", () => {
    expect(() =>
      createMarketplaceCommunicationUnsubscribeTokenService({
        currentKeyVersion: "missing",
        keys: { other: NEW_SECRET },
      }),
    ).toThrow("Current unsubscribe key is missing");
    expect(() =>
      createMarketplaceCommunicationUnsubscribeTokenService({
        currentKeyVersion: "key-1",
        keys: { "key-1": Buffer.alloc(31).toString("base64url") },
      }),
    ).toThrow("32 bytes");
    expect(() =>
      createMarketplaceCommunicationUnsubscribeTokenService({
        currentKeyVersion: "key-1",
        keys: { "key-1": `${NEW_SECRET}=` },
      }),
    ).toThrow("Invalid unsubscribe signing key configuration");
  });
});

function signPayload(payload: unknown, encodedSecret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const input = `u1.${encoded}`;
  const signature = createHmac("sha256", Buffer.from(encodedSecret, "base64url"))
    .update(input)
    .digest("base64url");
  return `${input}.${signature}`;
}
