import { createPublicKey, type KeyObject } from "node:crypto";

import {
  SINGLE_HUMAN_DUAL_AUTHORITY_DECISION,
  type ChannexAdoptionConsumerConfig,
  type ChannexAdoptionSingleHumanAuthority,
} from "./channexAdoptionConsumer.js";

type RunnerConfigFile = {
  environment: ChannexAdoptionConsumerConfig["environment"];
  allowedExecutionPrincipals: string[];
  verificationKeys: Array<{ id: string; publicKeyPem: string; principal: string }>;
  approvalPrincipals: Record<string, string>;
  singleHumanDualAuthority: ChannexAdoptionSingleHumanAuthority | null;
};

const SPKI_PUBLIC_KEY =
  /^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/]+={0,2}\r?\n)+-----END PUBLIC KEY-----\r?\n?$/;

export function parseChannexAdoptionRunnerConfig(
  serialized: string,
  executionPrincipal: string,
): ChannexAdoptionConsumerConfig {
  const value = JSON.parse(serialized) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Runner config must be a JSON object");
  const raw = value as Partial<RunnerConfigFile>;
  if (
    Object.keys(raw).sort().join("\0") !==
    [
      "allowedExecutionPrincipals",
      "approvalPrincipals",
      "environment",
      "singleHumanDualAuthority",
      "verificationKeys",
    ]
      .sort()
      .join("\0")
  )
    throw new Error("Runner config fields are invalid");
  if (!("local staging preprod production".split(" ") as string[]).includes(raw.environment!))
    throw new Error("Runner config environment is invalid");
  if (!Array.isArray(raw.allowedExecutionPrincipals) || !raw.allowedExecutionPrincipals.every(text))
    throw new Error("Runner config execution principal allowlist is invalid");
  if (!Array.isArray(raw.verificationKeys) || raw.verificationKeys.length === 0)
    throw new Error("Runner config verification keys are required");
  if (
    !raw.approvalPrincipals ||
    typeof raw.approvalPrincipals !== "object" ||
    Array.isArray(raw.approvalPrincipals)
  )
    throw new Error("Runner config approval principals are required");

  const verificationKeys = new Map<string, KeyObject>();
  const signingPrincipals = new Map<string, string>();
  for (const key of raw.verificationKeys) {
    if (!key || !text(key.id) || !text(key.publicKeyPem) || !text(key.principal))
      throw new Error("Runner config verification key is invalid");
    if (Object.keys(key).sort().join("\0") !== ["id", "principal", "publicKeyPem"].join("\0"))
      throw new Error(`Runner config verification key ${key.id} has invalid fields`);
    if (!SPKI_PUBLIC_KEY.test(key.publicKeyPem))
      throw new Error(`Verification key ${key.id} must use an SPKI public-key PEM envelope`);
    if (verificationKeys.has(key.id)) throw new Error(`Duplicate verification key ${key.id}`);
    const publicKey = createPublicKey(key.publicKeyPem);
    if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519")
      throw new Error(`Verification key ${key.id} must be an Ed25519 public key`);
    verificationKeys.set(key.id, publicKey);
    signingPrincipals.set(key.id, key.principal);
  }
  const approvalPrincipals = new Map<string, string>();
  for (const [actorId, principal] of Object.entries(raw.approvalPrincipals)) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(actorId) ||
      !text(principal)
    )
      throw new Error("Runner config approval principal is invalid");
    approvalPrincipals.set(actorId, principal);
  }
  const singleHumanDualAuthority = parseSingleHumanAuthority(
    raw.singleHumanDualAuthority,
    approvalPrincipals,
  );
  return {
    environment: raw.environment!,
    executionPrincipal,
    allowedExecutionPrincipals: new Set(raw.allowedExecutionPrincipals),
    verificationKeys,
    signingPrincipals,
    approvalPrincipals,
    singleHumanDualAuthority,
  };
}

function parseSingleHumanAuthority(
  value: ChannexAdoptionSingleHumanAuthority | null | undefined,
  approvalPrincipals: ReadonlyMap<string, string>,
): ChannexAdoptionSingleHumanAuthority | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Runner config single-human authority is invalid");
  if (
    Object.keys(value).sort().join("\0") !==
      ["actorUserId", "decisionId", "principal"].join("\0") ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.actorUserId,
    ) ||
    !text(value.principal) ||
    value.decisionId !== SINGLE_HUMAN_DUAL_AUTHORITY_DECISION ||
    approvalPrincipals.get(value.actorUserId) !== value.principal
  )
    throw new Error("Runner config single-human authority is invalid");
  return value;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
