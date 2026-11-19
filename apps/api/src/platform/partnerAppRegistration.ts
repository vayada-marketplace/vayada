import { randomBytes } from "node:crypto";

import {
  PARTNER_SCOPES,
  newSecretValue,
  sha256Hex,
  type PartnerScope,
} from "../domains/partnerConnections.js";

/**
 * VAY-2436: register a partner app (Creator Links) once per environment. Vayada keeps only the client
 * secret's SHA-256; the secret is shown once, to hand to the partner. The webhook signing secret
 * comes with the booking updates (VAY-2438).
 */
export type PartnerAppRegistration = {
  name: string;
  redirectUris: string[];
  scopes: PartnerScope[];
  webhookUrl: string | null;
  contactEmail: string | null;
  termsVersion: string;
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
  return {
    name,
    redirectUris: [...new Set(redirectUris)],
    scopes: PARTNER_SCOPES.filter((scope) => scopes.includes(scope)),
    webhookUrl,
    contactEmail: one("--contact-email"),
    termsVersion: one("--terms-version") ?? "partner-contract-2026-10-31",
    apply,
  };
}

type Queryable = {
  query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
};

/** Stores the app and returns its client id and secret, the only time the secret exists in full. */
export async function registerPartnerApp(
  db: Queryable,
  registration: Omit<PartnerAppRegistration, "apply">,
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
