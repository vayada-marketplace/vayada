import { randomBytes } from "node:crypto";

import {
  PARTNER_SCOPES,
  newSecretValue,
  sha256Hex,
  type PartnerScope,
} from "../domains/partnerConnections.js";

import { PARTNER_SECRET_NAME } from "./partnerSecretToKeychain.js";

/**
 * VAY-2436: register a partner app (Creator Links) once per environment. Vayada keeps only the client
 * secret's SHA-256. VAY-2441: the secret goes straight into a new AWS Secrets Manager secret, never to
 * output or logs; on the Mac that hands it to the partner, `partner:secret-to-keychain` copies it into
 * the Keychain and deletes the secret (partnerSecretToKeychain.ts). The webhook signing secret comes
 * with the booking updates (VAY-2438).
 */
export type PartnerAppRegistration = {
  name: string;
  redirectUris: string[];
  scopes: PartnerScope[];
  webhookUrl: string | null;
  contactEmail: string | null;
  termsVersion: string;
  /** The new Secrets Manager secret --apply puts the client id and secret into (PARTNER_SECRET_NAME). */
  secretName: string | null;
  apply: boolean;
};

export class PartnerAppRegistrationRefusal extends Error {}

/** Return addresses must be https; plain http only for this machine (local tests). */
export function checkRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return (
      url.href === value &&
      !url.hash &&
      !url.username &&
      !url.password &&
      (url.protocol === "https:" || (url.protocol === "http:" && local))
    );
  } catch {
    return false;
  }
}

export function parsePartnerAppRegistrationArgs(argv: readonly string[]): PartnerAppRegistration {
  const values = new Map<string, string[]>();
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--apply") {
      apply = true;
      continue;
    }
    const value = argv[index + 1];
    if (!flag.startsWith("--") || value === undefined || value.startsWith("--"))
      throw new PartnerAppRegistrationRefusal(`Expected a value after ${flag}`);
    values.set(flag, [...(values.get(flag) ?? []), value]);
    index += 1;
  }
  const one = (flag: string) => {
    const found = values.get(flag) ?? [];
    if (found.length > 1) throw new PartnerAppRegistrationRefusal(`${flag} given twice`);
    return found[0] ?? null;
  };
  const known = [
    "--name",
    "--redirect-uri",
    "--scope",
    "--webhook-url",
    "--contact-email",
    "--terms-version",
    "--secret-name",
  ];
  const unknown = [...values.keys()].find((flag) => !known.includes(flag));
  if (unknown) throw new PartnerAppRegistrationRefusal(`Unknown option ${unknown}`);

  const name = one("--name")?.trim();
  if (!name) throw new PartnerAppRegistrationRefusal("--name is required");
  const redirectUris = values.get("--redirect-uri") ?? [];
  if (redirectUris.length === 0 || !redirectUris.every(checkRedirectUri))
    throw new PartnerAppRegistrationRefusal("Each --redirect-uri must be an exact https address");
  const scopes = values.get("--scope") ?? [...PARTNER_SCOPES];
  if (!scopes.every((scope) => (PARTNER_SCOPES as readonly string[]).includes(scope)))
    throw new PartnerAppRegistrationRefusal(`--scope must be one of ${PARTNER_SCOPES.join(", ")}`);
  const webhookUrl = one("--webhook-url");
  if (webhookUrl !== null && !(checkRedirectUri(webhookUrl) && webhookUrl.startsWith("https:")))
    throw new PartnerAppRegistrationRefusal("--webhook-url must be an https address");
  const secretName = one("--secret-name");
  if (secretName !== null && !PARTNER_SECRET_NAME.test(secretName))
    throw new PartnerAppRegistrationRefusal("--secret-name must look like partner-apps/prod/<app>");
  return {
    name,
    redirectUris: [...new Set(redirectUris)],
    scopes: PARTNER_SCOPES.filter((scope) => scopes.includes(scope)),
    webhookUrl,
    contactEmail: one("--contact-email"),
    termsVersion: one("--terms-version") ?? "partner-contract-2026-10-31",
    secretName,
    apply,
  };
}

/** Until VAY-2438, an app with a webhook address would have no signing secret to hand over. */
export function refuseWebhookUntilSigning(
  registration: Pick<PartnerAppRegistration, "webhookUrl">,
) {
  if (registration.webhookUrl !== null)
    throw new PartnerAppRegistrationRefusal(
      "--webhook-url needs the webhook signing secret from VAY-2438; register without it for now",
    );
}

type Queryable = {
  query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
};

/** Stores the app and returns its client id and secret, the only time the secret exists in full. */
export async function registerPartnerApp(
  db: Queryable,
  registration: Omit<PartnerAppRegistration, "apply" | "secretName">,
): Promise<{ appId: string; clientId: string; clientSecret: string }> {
  const clientId = `partner_${randomBytes(12).toString("hex")}`;
  const clientSecret = newSecretValue("secret");
  const result = await db.query<{ appId: string }>(
    `INSERT INTO distribution.external_api_clients
       (public_client_id, client_name, contact_email, status, allowed_surfaces, rate_limit_tier,
        terms_version, credential_hash_ref, credential_rotated_at, redirect_uris, allowed_scopes,
        webhook_url)
     VALUES ($1, $2, $3, 'active', ARRAY['partner_connection']::text[], 'partner', $4, $5, now(),
             $6::text[], $7::text[], $8)
     RETURNING id::text AS "appId"`,
    [
      clientId,
      registration.name,
      registration.contactEmail,
      registration.termsVersion,
      `sha256:${sha256Hex(clientSecret)}`,
      registration.redirectUris,
      registration.scopes,
      registration.webhookUrl,
    ],
  );
  return { appId: result.rows[0]!.appId, clientId, clientSecret };
}

/** Puts a new secret into the store (AWS Secrets Manager in production); never overwrites one. */
export type PartnerSecretStore = (name: string, secretString: string) => Promise<void>;

/**
 * Storing the credentials or saving the app failed after both had started, so a secret may exist for
 * an app that wasn't saved ("no") or may not have been ("unknown"). Hand a secret over only when its
 * client id has a `"registered":true` line.
 */
export class PartnerRegistrationIncomplete extends Error {
  constructor(
    readonly secretName: string,
    readonly clientId: string,
    readonly appSaved: "no" | "unknown",
    options?: ErrorOptions,
  ) {
    super(
      appSaved === "no"
        ? "The app wasn't saved. If the secret exists, delete it; don't hand it over"
        : "Whether the app was saved is unknown. Hand the secret over only if its client id is registered",
      options,
    );
  }
}

/**
 * VAY-2441: saves the app and puts its credentials into the secret store in one go. The app commits
 * only once the store holds them, so a secret never exists without its one copy, and the credentials
 * never come back to the caller, so they can't reach output or logs.
 */
export async function registerPartnerAppIntoSecretStore(
  pool: { connect(): Promise<Queryable & { release(): void }> },
  registration: Omit<PartnerAppRegistration, "apply" | "secretName">,
  secretName: string,
  storeSecret: PartnerSecretStore,
): Promise<{ appId: string; clientId: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { appId, clientId, clientSecret } = await registerPartnerApp(client, registration);
    try {
      await storeSecret(secretName, JSON.stringify({ clientId, clientSecret }));
    } catch (error) {
      // A refusal (the name is taken) stored nothing; any other failure may have stored it.
      if (error instanceof PartnerAppRegistrationRefusal) throw error;
      throw new PartnerRegistrationIncomplete(secretName, clientId, "no", { cause: error });
    }
    try {
      await client.query("COMMIT");
    } catch (error) {
      throw new PartnerRegistrationIncomplete(secretName, clientId, "unknown", { cause: error });
    }
    return { appId, clientId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
