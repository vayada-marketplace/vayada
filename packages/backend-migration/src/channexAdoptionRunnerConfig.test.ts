import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { parseChannexAdoptionRunnerConfig } from "./channexAdoptionRunnerConfig.js";

const ACTOR = "19630000-0000-4000-8000-000000000001";

describe("Channex adoption runner config", () => {
  it("accepts an Ed25519 SPKI public key and rejects PKCS#8 private material", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const config = (publicKeyPem: string) =>
      JSON.stringify({
        environment: "production",
        allowedExecutionPrincipals: ["iam:migration-runner"],
        verificationKeys: [
          { id: "migration-production-2026-01", publicKeyPem, principal: "kms:manifest-signer" },
        ],
        approvalPrincipals: { [ACTOR]: "user:migration-owner" },
        singleHumanDualAuthority: {
          actorUserId: ACTOR,
          principal: "user:migration-owner",
          decisionId: "VAY-1320@2026-09-12",
        },
      });
    const publicPem = publicKey.export({ format: "pem", type: "spki" }).toString();
    expect(
      parseChannexAdoptionRunnerConfig(config(publicPem), "iam:migration-runner")
        .verificationKeys.get("migration-production-2026-01")
        ?.export({ format: "pem", type: "spki" })
        .toString(),
    ).toBe(publicPem);
    expect(
      parseChannexAdoptionRunnerConfig(config(publicPem), "iam:migration-runner")
        .singleHumanDualAuthority,
    ).toEqual({
      actorUserId: ACTOR,
      principal: "user:migration-owner",
      decisionId: "VAY-1320@2026-09-12",
    });

    const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(() =>
      parseChannexAdoptionRunnerConfig(config(privatePem), "iam:migration-runner"),
    ).toThrowError(/SPKI public-key PEM envelope/);
  });
});
