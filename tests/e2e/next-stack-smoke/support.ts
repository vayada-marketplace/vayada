import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { APIRequestContext, Locator, Page } from "@playwright/test";

const WORKOS_ORIGIN = "https://api.workos.com";

export const NEXT_STACK_ORIGINS = Object.freeze({
  api: "https://next-api.vayada.com",
  bookingAdmin: "https://next-booking-admin.vayada.com",
  pms: "https://next-pms.vayada.com",
  platformAdmin: "https://next-admin.vayada.com",
});

export type SmokeEnvironment = {
  emailDomain: string;
  password: string;
  recoveryPropertyId?: string;
  recoveryReceipt?: string;
  recoveryRunId?: string;
  runId: string;
  workosApiKey: string;
};

export type AuthSession = {
  accessToken: string;
  csrfToken: string;
  organizationId: string;
  workosOrganizationId: string;
  organizationKind: "hotel_group";
  resources?: Record<string, string[]>;
  user: { id: string; email: string; workosUserId?: string };
};

export type SyntheticUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: "hotel" | "staff";
};

export type SyntheticPlatformAdmin = {
  accessToken: string;
  email: string;
  membershipId: string;
  userId: string;
};

export class JsonApi {
  constructor(
    private readonly request: APIRequestContext,
    private readonly origin: string,
    private readonly authorization?: string,
    private readonly nativeFetch: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async json<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    route: string,
    body?: unknown,
    headers: Record<string, string> = {},
    timeout?: number,
  ): Promise<T> {
    const response = await this.send(method, route, body, headers, timeout);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `${method} ${route} returned ${response.status}: ${safeError(text, this.authorization ? [this.authorization] : [])}`,
      );
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${method} ${route} returned invalid JSON.`);
    }
  }

  async deleteIfPresent(route: string): Promise<void> {
    const response = await this.send("DELETE", route);
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `DELETE ${route} returned ${response.status}: ${safeError(await response.text(), this.authorization ? [this.authorization] : [])}`,
      );
    }
  }

  private async send(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    route: string,
    body?: unknown,
    headers: Record<string, string> = {},
    timeout?: number,
  ): Promise<{ ok: boolean; status: number; text(): Promise<string> }> {
    const url = new URL(route, this.origin).toString();
    try {
      if (this.authorization) {
        return await this.nativeFetch(url, {
          method,
          ...(timeout === 0 ? {} : { signal: AbortSignal.timeout(timeout ?? 30_000) }),
          headers: {
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            authorization: this.authorization,
            ...headers,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      }
      const response = await this.request.fetch(url, {
        method,
        ...(timeout === undefined ? {} : { timeout }),
        headers,
        ...(body === undefined ? {} : { data: body }),
      });
      return {
        ok: response.ok(),
        status: response.status(),
        text: () => response.text(),
      };
    } catch {
      throw new Error(`${method} ${route} request failed.`);
    }
  }
}

export function loadSmokeEnvironment(): SmokeEnvironment {
  if (process.env.E2E_NEXT_STACK_SMOKE !== "1") {
    throw new Error("Set E2E_NEXT_STACK_SMOKE=1 to acknowledge the live next-stack smoke.");
  }
  if (process.env.NEXT_STACK_SMOKE_ENV !== "next") {
    throw new Error("NEXT_STACK_SMOKE_ENV must be exactly 'next'.");
  }

  const workosApiKey = required("WORKOS_API_KEY");
  if (!workosApiKey.startsWith("sk_")) {
    throw new Error("WORKOS_API_KEY must be a WorkOS secret key.");
  }
  if (
    !workosApiKey.startsWith("sk_test_") &&
    process.env.NEXT_STACK_SMOKE_ALLOW_LIVE_WORKOS !== "1"
  ) {
    throw new Error(
      "The deployed next stack uses live WorkOS; set NEXT_STACK_SMOKE_ALLOW_LIVE_WORKOS=1 to acknowledge synthetic user creation and deletion.",
    );
  }
  const password = required("NEXT_STACK_SMOKE_PASSWORD");
  if (password.length < 12) {
    throw new Error("NEXT_STACK_SMOKE_PASSWORD must contain at least 12 characters.");
  }
  const emailDomain = required("NEXT_STACK_SMOKE_EMAIL_DOMAIN").toLowerCase();
  if (!/^[a-z0-9.-]+\.test$/.test(emailDomain)) {
    throw new Error("NEXT_STACK_SMOKE_EMAIL_DOMAIN must use the reserved .test suffix.");
  }
  const recoveryRunId = process.env.NEXT_STACK_SMOKE_RECOVERY_RUN_ID?.trim();
  const recoveryPropertyId = process.env.NEXT_STACK_SMOKE_RECOVERY_PROPERTY_ID?.trim();
  const recoveryReceipt = process.env.NEXT_STACK_SMOKE_RECOVERY_RECEIPT?.trim();
  const recoveryValueCount = [recoveryRunId, recoveryPropertyId, recoveryReceipt].filter(
    Boolean,
  ).length;
  if (recoveryValueCount !== 0 && recoveryValueCount !== 3) {
    throw new Error("Provide all three next-stack smoke recovery values or none.");
  }
  if (recoveryRunId && !/^\d{14}-[a-f0-9]{8}$/.test(recoveryRunId)) {
    throw new Error("NEXT_STACK_SMOKE_RECOVERY_RUN_ID is invalid.");
  }
  if (
    recoveryPropertyId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      recoveryPropertyId,
    )
  ) {
    throw new Error("NEXT_STACK_SMOKE_RECOVERY_PROPERTY_ID must be a UUID.");
  }
  if (recoveryReceipt && !/^[a-f0-9]{64}$/.test(recoveryReceipt)) {
    throw new Error("NEXT_STACK_SMOKE_RECOVERY_RECEIPT is invalid.");
  }
  if (
    recoveryRunId &&
    recoveryPropertyId &&
    recoveryReceipt &&
    !validSmokeRecoveryReceipt(workosApiKey, recoveryRunId, recoveryPropertyId, recoveryReceipt)
  ) {
    throw new Error("The next-stack smoke recovery receipt does not match this property and run.");
  }

  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return {
    emailDomain,
    password,
    ...(recoveryPropertyId ? { recoveryPropertyId } : {}),
    ...(recoveryReceipt ? { recoveryReceipt } : {}),
    ...(recoveryRunId ? { recoveryRunId } : {}),
    runId: `${timestamp}-${randomBytes(4).toString("hex")}`,
    workosApiKey,
  };
}

export function smokeRecoveryReceipt(
  environment: Pick<SmokeEnvironment, "workosApiKey">,
  runId: string,
  propertyId: string,
): string {
  return createHmac("sha256", environment.workosApiKey)
    .update(`vayada-next-smoke-recovery:v1:${runId}:${propertyId}`)
    .digest("hex");
}

function validSmokeRecoveryReceipt(
  workosApiKey: string,
  runId: string,
  propertyId: string,
  receipt: string,
): boolean {
  const expected = Buffer.from(smokeRecoveryReceipt({ workosApiKey }, runId, propertyId), "hex");
  return timingSafeEqual(expected, Buffer.from(receipt, "hex"));
}

export function syntheticPlatformAdminEmail(
  environment: SmokeEnvironment,
  runId = environment.runId,
): string {
  return `qa-next-platform-${runId}@${environment.emailDomain}`;
}

function syntheticIdentity(
  environment: SmokeEnvironment,
  role: SyntheticUser["role"],
  qualifier = "",
): Pick<SyntheticUser, "email" | "firstName" | "lastName"> {
  return {
    firstName: role === "hotel" ? "Harper" : "Sam",
    lastName: `Smoke ${environment.runId.slice(-8)}`,
    email: `qa-next-${qualifier ? `${qualifier}-` : ""}${role}-${environment.runId}@${environment.emailDomain}`,
  };
}

/**
 * Signs a hotel owner up the way a new hotel does (VAY-2270): Booking Admin /signup, the email
 * code (read from WorkOS, which sent it), then the account details step of /setup. The signup
 * creates the owner's hotel group. Stops on the first run's "Your hotel" step (VAY-2247,
 * ONBOARDING_V2_ENABLED), or on the older setup wizard's track choice, and says which.
 */
export async function signUpSyntheticHotelOwner(
  page: Page,
  request: APIRequestContext,
  environment: SmokeEnvironment,
  qualifier = "",
  phone = "+49 30 5550102",
): Promise<{ user: SyntheticUser; session: AuthSession; flow: "first_run" | "wizard" }> {
  const identity = syntheticIdentity(environment, "hotel", qualifier);
  await page.goto(`${NEXT_STACK_ORIGINS.bookingAdmin}/signup`);
  await page.getByLabel("Email address").fill(identity.email);
  await fillSecret(page.getByLabel("Password", { exact: true }), environment.password);
  // VAY-2246: a new hotel accepts the hotel terms and the data processing agreement at sign-up.
  await page
    .getByRole("checkbox", { name: /I accept the Terms and the Data Processing Agreement/ })
    .check();
  const signupResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/auth/password/signup" &&
      response.request().method() === "POST",
    { timeout: 45_000 },
  );
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  const signupResponse = await signupResponsePromise;
  const signupBody = await signupResponse.text();
  let pending: Record<string, unknown>;
  try {
    pending = record(JSON.parse(signupBody));
  } catch {
    throw new Error(
      `Booking Admin signup returned ${signupResponse.status()}: ${safeError(signupBody)}`,
    );
  }
  // The body carries a pending authentication token, so errors name only the status and state.
  if (pending.state !== "email_verification_required") {
    throw new Error(
      `Booking Admin signup returned ${signupResponse.status()} with state ${String(pending.state)}.`,
    );
  }
  const verification = await workosApi(request, environment.workosApiKey).json<
    Record<string, unknown>
  >(
    "GET",
    `/user_management/email_verification/${encodeURIComponent(stringField(pending, "emailVerificationId"))}`,
  );
  await page.waitForURL(
    (url) => url.origin === NEXT_STACK_ORIGINS.bookingAdmin && url.pathname === "/verify-email",
    { timeout: 45_000 },
  );
  await fillSecret(page.getByLabel("Verification code"), stringField(verification, "code"));
  await page.getByRole("button", { name: "Verify email", exact: true }).click();

  // The first run asks for the same details on its own first step, then opens "Your hotel"
  // instead of the wizard's track choice.
  const flow = await submitAccountDetails(page, identity, phone);
  if (flow === "first_run") {
    await page.getByRole("heading", { name: "Your hotel", level: 1 }).waitFor({ timeout: 45_000 });
  } else {
    await page
      .getByRole("heading", { name: "Choose how you’ll use vayada" })
      .waitFor({ timeout: 45_000 });
  }

  const session = await readAuthSession(page, "booking-admin");
  const userIds = await workosUserIdsForEmail(request, environment.workosApiKey, identity.email);
  if (userIds.length !== 1) {
    throw new Error(
      `Expected one WorkOS user for the synthetic hotel owner, found ${userIds.length}.`,
    );
  }
  return { user: { ...identity, id: userIds[0]!, role: "hotel" }, session, flow };
}

/**
 * Fills the account details a new hotel owner gives after the email code and submits them: the
 * first run's "Hi! Who's setting up the hotel?" step (VAY-2247), or the older setup wizard's form.
 * Returns which one it was, so the caller waits for that flow's next step.
 */
export async function submitAccountDetails(
  page: Page,
  identity: Pick<SyntheticUser, "firstName" | "lastName">,
  phone: string,
): Promise<"first_run" | "wizard"> {
  await page.getByLabel("First name").fill(identity.firstName, { timeout: 60_000 });
  await page.getByLabel("Last name").fill(identity.lastName);
  if (await page.getByRole("heading", { name: "Hi! Who's setting up the hotel?" }).isVisible()) {
    // By role: the label's text is "Your phone*" (a hidden required mark), so an exact label match
    // finds nothing, and the country button next to it is named "Your phone country: …".
    await page.getByRole("textbox", { name: "Your phone", exact: true }).fill(phone);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    return "first_run";
  }
  await page.getByLabel("Phone number").fill(phone);
  await page.getByRole("button", { name: "Continue to hotel setup" }).click();
  return "wizard";
}

export async function createSyntheticUser(
  request: APIRequestContext,
  environment: SmokeEnvironment,
  role: SyntheticUser["role"],
  qualifier = "",
): Promise<SyntheticUser> {
  const { firstName, lastName, email } = syntheticIdentity(environment, role, qualifier);
  const api = workosApi(request, environment.workosApiKey);
  const user = await api.json<Record<string, unknown>>("POST", "/user_management/users", {
    email,
    password: environment.password,
    first_name: firstName,
    last_name: lastName,
    email_verified: true,
  });
  return { id: stringField(user, "id"), email, firstName, lastName, role };
}

export async function createSyntheticPlatformAdmin(
  request: APIRequestContext,
  environment: SmokeEnvironment,
  runId = environment.runId,
): Promise<SyntheticPlatformAdmin> {
  const email = syntheticPlatformAdminEmail(environment, runId);
  const workos = workosApi(request, environment.workosApiKey);
  const user = await workos.json<Record<string, unknown>>("POST", "/user_management/users", {
    email,
    password: environment.password,
    first_name: "Parker",
    last_name: `Smoke ${runId.slice(-8)}`,
    email_verified: true,
  });
  const userId = stringField(user, "id");
  await primePlatformIdentity(request, email, environment.password);
  const organizations = await workos.json<Record<string, unknown>>(
    "GET",
    "/organizations?limit=100",
  );
  const platformOrganizations = arrayField(organizations, "data")
    .map(record)
    .filter((organization) => {
      const metadata = organization.metadata;
      return (
        organization.organization_kind === "platform" ||
        (metadata !== null &&
          typeof metadata === "object" &&
          !Array.isArray(metadata) &&
          (metadata as Record<string, unknown>).organization_kind === "platform")
      );
    });
  if (platformOrganizations.length !== 1) {
    throw new Error(
      `Expected one WorkOS platform organization, found ${platformOrganizations.length}.`,
    );
  }
  const membership = await workos.json<Record<string, unknown>>(
    "POST",
    "/user_management/organization_memberships",
    {
      user_id: userId,
      organization_id: stringField(platformOrganizations[0]!, "id"),
      role_slug: "admin",
    },
  );
  const membershipId = stringField(membership, "id");
  const accessToken = await waitForPlatformAdminLogin(request, email, environment.password);
  return { accessToken, email, membershipId, userId };
}

export async function authenticateSyntheticPlatformAdmin(
  request: APIRequestContext,
  account: SyntheticPlatformAdmin,
  password: string,
): Promise<string> {
  return waitForPlatformAdminLogin(request, account.email, password);
}

export async function fillSecret(locator: Locator, value: string): Promise<void> {
  await locator.evaluate((element, secret) => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
      throw new Error("Secret target must be an input or textarea.");
    }
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!setter) throw new Error("Secret target does not support value assignment.");
    element.focus();
    setter.call(element, secret);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

/**
 * Creates the Vayada identity of a user who has no hotel yet, so a staff invitation can activate
 * it: a PMS password login creates the identity before it checks the workspace, then answers
 * "hotel_workspace_required" (VAY-2270; the Marketplace login used to do this).
 */
export async function primeSyntheticIdentity(
  request: APIRequestContext,
  user: SyntheticUser,
  password: string,
): Promise<void> {
  const response = await request.post(`${NEXT_STACK_ORIGINS.pms}/auth/password/login`, {
    headers: { origin: NEXT_STACK_ORIGINS.pms },
    data: { email: user.email, password, surface: "pms-web" },
  });
  const body = await response.text();
  if (response.ok()) return;
  let state: unknown;
  try {
    state = record(JSON.parse(body)).state;
  } catch {
    state = undefined;
  }
  if (response.status() === 403 && state === "hotel_workspace_required") return;
  throw new Error(`PMS identity priming returned ${response.status()}: ${safeError(body)}`);
}

export async function loginPms(page: Page, user: SyntheticUser, password: string): Promise<void> {
  await authenticateSyntheticPmsUser(page.context().request, user, password);
  await page.goto(`${NEXT_STACK_ORIGINS.pms}/login`);
}

export async function authenticateSyntheticPmsUser(
  request: APIRequestContext,
  user: SyntheticUser,
  password: string,
): Promise<string> {
  const response = await request.post(`${NEXT_STACK_ORIGINS.pms}/auth/password/login`, {
    headers: { origin: NEXT_STACK_ORIGINS.pms },
    data: { email: user.email, password, surface: "pms-web" },
  });
  const body = await response.text();
  if (!response.ok()) {
    throw new Error(`PMS password login returned ${response.status()}: ${safeError(body)}`);
  }
  return stringField(record(JSON.parse(body)), "accessToken");
}

export async function readAuthSession(
  page: Page,
  surface: "booking-admin" | "pms-web",
): Promise<AuthSession> {
  const result = await page.evaluate(async (requestedSurface) => {
    const response = await fetch(`/auth/session?surface=${requestedSurface}`, {
      credentials: "include",
    });
    return { status: response.status, body: await response.text() };
  }, surface);
  if (result.status !== 200) {
    throw new Error(`${surface} session returned ${result.status}: ${safeError(result.body)}`);
  }
  const session = JSON.parse(result.body) as Partial<AuthSession>;
  for (const field of [
    "accessToken",
    "csrfToken",
    "organizationId",
    "workosOrganizationId",
  ] as const) {
    if (!session[field]) throw new Error(`${surface} session is missing ${field}.`);
  }
  if (session.organizationKind !== "hotel_group") {
    throw new Error(`${surface} session has the wrong organization kind.`);
  }
  return session as AuthSession;
}

export function targetApi(request: APIRequestContext, accessToken: string): JsonApi {
  return new JsonApi(request, NEXT_STACK_ORIGINS.api, `Bearer ${accessToken}`);
}

export function publicApi(request: APIRequestContext): JsonApi {
  return new JsonApi(request, NEXT_STACK_ORIGINS.api);
}

export function workosApi(request: APIRequestContext, apiKey: string): JsonApi {
  return new JsonApi(request, WORKOS_ORIGIN, `Bearer ${apiKey}`);
}

export async function workosOrganizationsForUser(
  request: APIRequestContext,
  apiKey: string,
  userId: string,
): Promise<string[]> {
  const response = await workosApi(request, apiKey).json<Record<string, unknown>>(
    "GET",
    `/user_management/organization_memberships?user_id=${encodeURIComponent(userId)}&limit=100`,
  );
  return arrayField(response, "data")
    .map(record)
    .map((membership) => stringField(membership, "organization_id"));
}

export async function workosMembershipIdsForUser(
  request: APIRequestContext,
  apiKey: string,
  userId: string,
): Promise<string[]> {
  const response = await workosApi(request, apiKey).json<Record<string, unknown>>(
    "GET",
    `/user_management/organization_memberships?user_id=${encodeURIComponent(userId)}&limit=100`,
  );
  return arrayField(response, "data")
    .map(record)
    .map((membership) => stringField(membership, "id"));
}

export async function workosUserIdsForEmail(
  request: APIRequestContext,
  apiKey: string,
  email: string,
): Promise<string[]> {
  const response = await workosApi(request, apiKey).json<Record<string, unknown>>(
    "GET",
    `/user_management/users?email=${encodeURIComponent(email)}&limit=100`,
  );
  return arrayField(response, "data")
    .map(record)
    .filter((user) => user.email === email)
    .map((user) => stringField(user, "id"));
}

export function futureStay(): { checkIn: string; checkOut: string } {
  const checkIn = new Date();
  checkIn.setUTCDate(checkIn.getUTCDate() + 60);
  const checkOut = new Date(checkIn);
  checkOut.setUTCDate(checkOut.getUTCDate() + 2);
  return { checkIn: dateOnly(checkIn), checkOut: dateOnly(checkOut) };
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object response.");
  }
  return value as Record<string, unknown>;
}

export function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== "string" || !result) throw new Error(`Response is missing ${field}.`);
  return result;
}

export function numberField(value: Record<string, unknown>, field: string): number {
  const result = value[field];
  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw new Error(`Response is missing numeric ${field}.`);
  }
  return result;
}

export function recordField(
  value: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  return record(value[field]);
}

export function arrayField(value: Record<string, unknown>, field: string): unknown[] {
  const result = value[field];
  if (!Array.isArray(result)) throw new Error(`Response is missing ${field}.`);
  return result;
}

async function waitForPlatformAdminLogin(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<string> {
  const deadline = Date.now() + 45_000;
  let latest = "identity sync pending";
  while (Date.now() < deadline) {
    const response = await request.post(`${NEXT_STACK_ORIGINS.platformAdmin}/auth/password/login`, {
      headers: { origin: NEXT_STACK_ORIGINS.platformAdmin },
      data: { email, password, surface: "platform-admin" },
    });
    const body = await response.text();
    if (response.ok()) {
      return stringField(record(JSON.parse(body)), "accessToken");
    }
    latest = `${response.status()}: ${safeError(body)}`;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Synthetic platform-admin login did not become ready: ${latest}`);
}

async function primePlatformIdentity(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<void> {
  const response = await request.post(`${NEXT_STACK_ORIGINS.platformAdmin}/auth/password/login`, {
    headers: { origin: NEXT_STACK_ORIGINS.platformAdmin },
    data: { email, password, surface: "platform-admin" },
  });
  if (response.status() !== 403) {
    throw new Error(
      `Expected first platform login to fail closed with 403, received ${response.status()}: ${safeError(await response.text())}`,
    );
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function safeError(value: string, extraSecrets: string[] = []): string {
  let safe = value;
  const configured = ["NEXT_STACK_SMOKE_PASSWORD", "WORKOS_API_KEY"].flatMap((name) => {
    const secret = process.env[name]?.trim();
    return secret ? [secret] : [];
  });
  for (const secret of [...configured, ...extraSecrets]) {
    const token = secret.replace(/^Bearer\s+/i, "");
    const variants = new Set([
      secret,
      token,
      encodeURIComponent(secret),
      encodeURIComponent(token),
      JSON.stringify(secret).slice(1, -1),
      JSON.stringify(token).slice(1, -1),
      Buffer.from(secret).toString("base64"),
      Buffer.from(token).toString("base64"),
    ]);
    for (const variant of [...variants].sort((left, right) => right.length - left.length)) {
      if (variant.length >= 8) safe = safe.replaceAll(variant, "[REDACTED]");
    }
  }
  return safe.replace(/[\r\n]+/g, " ").slice(0, 800) || "empty response";
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}
