// Only Node built-ins here: the laptop command runs without the backend packages being built.
import { execFile, spawn } from "node:child_process";

/**
 * VAY-2441: on the Mac that hands a partner app's credentials to the partner (Flamur's, for Creator
 * Links), copy them from the Secrets Manager secret the registration made into the macOS Keychain,
 * check them there, and only then delete the secret for good. Each value goes into the item the
 * toolbox's set-key uses (service "toolbox-env", account = the partner's setting name), readable with
 *   security find-generic-password -s toolbox-env -a VAYADA_CLIENT_SECRET -w
 * The values never reach output, logs or a command line.
 */
export const KEYCHAIN_SERVICE = "toolbox-env";

/** Where partner app credentials wait for their handover, e.g. partner-apps/prod/creator-links-test. */
export const PARTNER_SECRET_NAME = /^partner-apps\/[a-z0-9-]+\/[a-z0-9-]+$/;

/** The credentials' keys, the partner's setting names (Creator Links' .env.example) and their shape. */
const SETTINGS = [
  { key: "clientId", account: "VAYADA_CLIENT_ID", shape: /^partner_[0-9a-f]{24}$/ },
  { key: "clientSecret", account: "VAYADA_CLIENT_SECRET", shape: /^vyp_cs_[A-Za-z0-9_-]{43}$/ },
  // Only for an app registered with a webhook address (VAY-2438).
  {
    key: "webhookSigningSecret",
    account: "VAYADA_WEBHOOK_SECRET",
    shape: /^vyp_ws_[A-Za-z0-9_-]{43}$/,
  },
] as const;

export type PartnerSecretSource = {
  /** The secret's text. */
  read(name: string): Promise<string>;
  /** Deletes the secret for good, without a recovery window. */
  delete(name: string): Promise<void>;
};

export type Keychain = {
  write(account: string, value: string): Promise<void>;
  /** The stored value, or null when there is none. */
  read(account: string): Promise<string | null>;
};

/** Our own errors: their messages never hold a value, so they may be printed. */
export class PartnerSecretHandoverError extends Error {}

/** Never echoes the secret's text: a malformed secret could be the secret itself. */
function readCredentials(text: string): Array<{ account: string; value: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new PartnerSecretHandoverError("The secret doesn't hold a partner app's credentials");
  const record = parsed as Record<string, unknown>;
  // Not even the unexpected keys' names are shown: they come from the secret.
  if (Object.keys(record).some((key) => !SETTINGS.some((s) => s.key === key)))
    throw new PartnerSecretHandoverError("The secret holds unexpected keys");
  const credentials: Array<{ account: string; value: string }> = [];
  for (const { key, account, shape } of SETTINGS) {
    const value = record[key];
    if (value === undefined && key === "webhookSigningSecret") continue;
    if (typeof value !== "string" || !shape.test(value))
      throw new PartnerSecretHandoverError(`The secret's ${key} is missing or malformed`);
    credentials.push({ account, value });
  }
  return credentials;
}

export async function copyPartnerSecretToKeychain({
  secretName,
  source,
  keychain,
}: {
  secretName: string;
  source: PartnerSecretSource;
  keychain: Keychain;
}): Promise<{ clientId: string; stored: string[]; replaced: string[]; leftOver: string[] }> {
  if (!PARTNER_SECRET_NAME.test(secretName))
    throw new PartnerSecretHandoverError("--secret-name must look like partner-apps/prod/<app>");
  const credentials = readCredentials(await source.read(secretName));
  // Say what this overwrites, and which setting an earlier app left that this app doesn't replace.
  const replaced: string[] = [];
  const leftOver: string[] = [];
  for (const { account } of SETTINGS) {
    const before = await keychain.read(account);
    const next = credentials.find((c) => c.account === account);
    if (before !== null && next && before !== next.value) replaced.push(account);
    if (before !== null && !next) leftOver.push(account);
  }
  for (const { account, value } of credentials) await keychain.write(account, value);
  for (const { account, value } of credentials)
    if ((await keychain.read(account)) !== value)
      throw new PartnerSecretHandoverError(
        `The Keychain doesn't hold ${account} as copied; the secret was kept`,
      );
  await source.delete(secretName);
  return {
    clientId: credentials.find((c) => c.account === "VAYADA_CLIENT_ID")!.value,
    stored: credentials.map((c) => c.account),
    replaced,
    leftOver,
  };
}

/** One line for `security -i`, the way set-key writes: the value goes on stdin, never into argv. */
export function keychainAddCommand(account: string, value: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(account) || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new PartnerSecretHandoverError(`Refusing to write ${account}: unexpected characters`);
  return `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${account} -w "${value}"\n`;
}

export function macosKeychain(security = "/usr/bin/security"): Keychain {
  return {
    write: (account, value) =>
      new Promise((resolve, reject) => {
        const line = keychainAddCommand(account, value);
        // stdout and stderr are dropped: `security -i` may echo the line it was given.
        const child = spawn(security, ["-i"], { stdio: ["pipe", "ignore", "ignore"] });
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0
            ? resolve()
            : reject(new PartnerSecretHandoverError(`security failed writing ${account}`)),
        );
        child.stdin.end(line);
      }),
    read: (account) =>
      new Promise((resolve) => {
        execFile(
          security,
          ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
          (error, stdout) => resolve(error ? null : stdout.replace(/\n$/, "")),
        );
      }),
  };
}
