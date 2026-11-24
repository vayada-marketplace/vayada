import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  copyPartnerSecretToKeychain,
  keychainAddCommand,
  macosKeychain,
  type Keychain,
  type PartnerSecretSource,
} from "./partnerSecretToKeychain.js";

const NAME = "partner-apps/prod/creator-links-test";
const credentials = {
  clientId: `partner_${"ab12".repeat(6)}`,
  clientSecret: `vyp_cs_${"S".repeat(42)}-`,
};
const webhookSigningSecret = `vyp_ws_${"W".repeat(42)}_`;

function fakes(text: string, { keepWrites = true, before = {} as Record<string, string> } = {}) {
  const store = new Map<string, string>(Object.entries(before));
  const deleted: string[] = [];
  const keychain: Keychain = {
    write: async (account, value) => {
      if (keepWrites) store.set(account, value);
    },
    read: async (account) => store.get(account) ?? null,
  };
  const source: PartnerSecretSource = {
    read: async (name) => (name === NAME ? text : Promise.reject(new Error("not found"))),
    delete: async (name) => {
      deleted.push(name);
    },
  };
  return { store, deleted, keychain, source };
}

describe("copying a partner app's credentials into the Keychain (VAY-2441)", () => {
  it("copies the client id and secret, checks them, then deletes the secret, showing no value", async () => {
    const { store, deleted, keychain, source } = fakes(JSON.stringify(credentials));
    const result = await copyPartnerSecretToKeychain({ secretName: NAME, source, keychain });
    expect(Object.fromEntries(store)).toEqual({
      VAYADA_CLIENT_ID: credentials.clientId,
      VAYADA_CLIENT_SECRET: credentials.clientSecret,
    });
    expect(deleted).toEqual([NAME]);
    expect(result).toEqual({
      clientId: credentials.clientId,
      stored: ["VAYADA_CLIENT_ID", "VAYADA_CLIENT_SECRET"],
      replaced: [],
      leftOver: [],
    });
    expect(JSON.stringify(result)).not.toContain(credentials.clientSecret);
  });

  it("copies the webhook signing secret too when the app has one", async () => {
    const { store, keychain, source } = fakes(
      JSON.stringify({ ...credentials, webhookSigningSecret }),
    );
    await copyPartnerSecretToKeychain({ secretName: NAME, source, keychain });
    expect(store.get("VAYADA_WEBHOOK_SECRET")).toBe(webhookSigningSecret);
  });

  it("says which settings it replaced and which an earlier app left behind", async () => {
    const { store, keychain, source } = fakes(JSON.stringify(credentials), {
      before: {
        VAYADA_CLIENT_ID: credentials.clientId,
        VAYADA_CLIENT_SECRET: `vyp_cs_${"O".repeat(43)}`,
        VAYADA_WEBHOOK_SECRET: webhookSigningSecret,
      },
    });
    const result = await copyPartnerSecretToKeychain({ secretName: NAME, source, keychain });
    expect(result).toMatchObject({
      replaced: ["VAYADA_CLIENT_SECRET"],
      leftOver: ["VAYADA_WEBHOOK_SECRET"],
    });
    expect(store.get("VAYADA_CLIENT_SECRET")).toBe(credentials.clientSecret);
    expect(JSON.stringify(result)).not.toContain(webhookSigningSecret);
  });

  it("keeps the secret when the Keychain doesn't hold what was written", async () => {
    const { deleted, keychain, source } = fakes(JSON.stringify(credentials), { keepWrites: false });
    await expect(
      copyPartnerSecretToKeychain({ secretName: NAME, source, keychain }),
    ).rejects.toThrow("The Keychain doesn't hold VAYADA_CLIENT_ID as copied; the secret was kept");
    expect(deleted).toEqual([]);
  });

  it("writes nothing for a secret that isn't a partner app's credentials, and never quotes it", async () => {
    for (const text of [
      credentials.clientSecret,
      JSON.stringify([credentials]),
      JSON.stringify({ clientId: credentials.clientId }),
      JSON.stringify({ ...credentials, clientSecret: "short" }),
      JSON.stringify({ ...credentials, password: "x" }),
      JSON.stringify({ ...credentials, [credentials.clientSecret]: "x" }),
    ]) {
      const { store, deleted, keychain, source } = fakes(text);
      const error = await copyPartnerSecretToKeychain({ secretName: NAME, source, keychain }).then(
        () => null,
        (caught: unknown) => caught as Error,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).not.toContain(credentials.clientSecret);
      expect(error?.message).not.toContain("password");
      expect(store.size).toBe(0);
      expect(deleted).toEqual([]);
    }
  });

  it("only takes secret names under partner-apps/", async () => {
    const { keychain, source } = fakes(JSON.stringify(credentials));
    await expect(
      copyPartnerSecretToKeychain({ secretName: "prod/stripe", source, keychain }),
    ).rejects.toThrow(/--secret-name/);
  });

  it("writes the Keychain line the way set-key does and refuses characters that could break it", () => {
    expect(keychainAddCommand("VAYADA_CLIENT_ID", credentials.clientId)).toBe(
      `add-generic-password -U -s toolbox-env -a VAYADA_CLIENT_ID -w "${credentials.clientId}"\n`,
    );
    expect(() => keychainAddCommand("VAYADA_CLIENT_ID", 'x" -A "')).toThrow(
      /unexpected characters/,
    );
    expect(() => keychainAddCommand("lower", "x")).toThrow(/unexpected characters/);
  });
});

describe("the macOS Keychain adapter (VAY-2441)", () => {
  // A stand-in for /usr/bin/security that keeps the lines it gets on stdin and its arguments.
  let dir: string;
  let security: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "vay2441-keychain-"));
    security = join(dir, "security");
    await writeFile(
      security,
      [
        "#!/bin/sh",
        `echo "$*" >> "${dir}/argv"`,
        `if [ "$1" = "-i" ]; then cat >> "${dir}/stdin"; exit 0; fi`,
        `sed -n "s/^add-generic-password -U -s $3 -a $5 -w \\"\\(.*\\)\\"$/\\1/p" "${dir}/stdin" | tail -n 1 | grep . || exit 44`,
        "",
      ].join("\n"),
    );
    await chmod(security, 0o755);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("hands the value to security on stdin, never as an argument, and reads it back", async () => {
    const keychain = macosKeychain(security);
    await keychain.write("VAYADA_CLIENT_SECRET", credentials.clientSecret);
    expect(await keychain.read("VAYADA_CLIENT_SECRET")).toBe(credentials.clientSecret);
    expect(await keychain.read("VAYADA_WEBHOOK_SECRET")).toBeNull();
    expect(await readFile(join(dir, "argv"), "utf8")).not.toContain(credentials.clientSecret);
  });
});
