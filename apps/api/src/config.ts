import { loadServerConfig } from "@vayada/backend-config";

export type ApiAuthConfig = {
  databaseUrl: string;
  workosJwksUrl: string;
  workosIssuer: string;
  workosAudience: string;
};

export type ApiAuthSessionConfig = {
  workosClientId: string;
  workosApiKey: string;
  workosWebhookSecret?: string;
  authCookieSecret: string;
  authCallbackUrl: string;
  authLogoutUrl: string;
  authAllowedOrigins: string[];
  authCookieSecure: boolean;
  authCookieDomain?: string;
};

export type ApiAskIntelligenceConfig =
  | { provider: "fixture" }
  | {
      provider: "openai";
      apiKey: string;
      model: string;
      baseUrl?: string;
      organization?: string;
      project?: string;
    };

export type ApiConfig = {
  host: string;
  port: number;
  auth?: ApiAuthConfig;
  authSession?: ApiAuthSessionConfig;
  askIntelligence: ApiAskIntelligenceConfig;
  bookingDatabaseUrl?: string;
  bookingReservationsReadDatabaseUrl?: string;
  bookingPublicApiUrl?: string;
  marketplaceDatabaseUrl?: string;
  marketplaceDiscoveryAllowedOrigins: string[];
  pmsApiUrl?: string;
  pmsPublicApiUrl?: string;
  bookingHostBase?: string;
};

function readOptionalEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function loadAuthConfig(env: NodeJS.ProcessEnv): ApiAuthConfig | undefined {
  const authKeys = [
    "AUTH_DATABASE_URL",
    "WORKOS_JWKS_URL",
    "WORKOS_ISSUER",
    "WORKOS_AUDIENCE",
  ] as const;
  const values = Object.fromEntries(authKeys.map((key) => [key, readOptionalEnv(env, key)]));
  const configuredKeys = authKeys.filter((key) => values[key]);

  if (configuredKeys.length === 0) {
    return undefined;
  }

  if (configuredKeys.length !== authKeys.length) {
    const missing = authKeys.filter((key) => !values[key]).join(", ");
    throw new Error(`Incomplete auth config; missing ${missing}`);
  }

  return {
    databaseUrl: values["AUTH_DATABASE_URL"]!,
    workosJwksUrl: values["WORKOS_JWKS_URL"]!,
    workosIssuer: values["WORKOS_ISSUER"]!,
    workosAudience: values["WORKOS_AUDIENCE"]!,
  };
}

function readOptionalCsvEnv(env: NodeJS.ProcessEnv, key: string): string[] {
  const value = readOptionalEnv(env, key);
  return value
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

function loadAuthSessionConfig(env: NodeJS.ProcessEnv): ApiAuthSessionConfig | undefined {
  const authSessionKeys = [
    "WORKOS_CLIENT_ID",
    "WORKOS_API_KEY",
    "AUTH_COOKIE_SECRET",
    "AUTH_CALLBACK_URL",
    "AUTH_LOGOUT_URL",
    "AUTH_ALLOWED_ORIGINS",
  ] as const;
  const values = Object.fromEntries(authSessionKeys.map((key) => [key, readOptionalEnv(env, key)]));
  const configuredKeys = authSessionKeys.filter((key) => values[key]);

  if (configuredKeys.length === 0) {
    return undefined;
  }

  if (configuredKeys.length !== authSessionKeys.length) {
    const missing = authSessionKeys.filter((key) => !values[key]).join(", ");
    throw new Error(`Incomplete auth session config; missing ${missing}`);
  }

  return {
    workosClientId: values["WORKOS_CLIENT_ID"]!,
    workosApiKey: values["WORKOS_API_KEY"]!,
    workosWebhookSecret: readOptionalEnv(env, "WORKOS_WEBHOOK_SECRET"),
    authCookieSecret: values["AUTH_COOKIE_SECRET"]!,
    authCallbackUrl: values["AUTH_CALLBACK_URL"]!,
    authLogoutUrl: values["AUTH_LOGOUT_URL"]!,
    authAllowedOrigins: readOptionalCsvEnv(env, "AUTH_ALLOWED_ORIGINS"),
    authCookieSecure: readOptionalEnv(env, "AUTH_COOKIE_SECURE") !== "false",
    authCookieDomain: readOptionalEnv(env, "AUTH_COOKIE_DOMAIN"),
  };
}

function loadAskIntelligenceConfig(env: NodeJS.ProcessEnv): ApiAskIntelligenceConfig {
  const provider = readOptionalEnv(env, "ASK_INTELLIGENCE_PROVIDER") ?? "fixture";
  if (provider === "fixture") return { provider };
  if (provider !== "openai") {
    throw new Error("Unsupported Ask Intelligence provider; expected fixture or openai");
  }

  const requiredKeys = ["OPENAI_API_KEY", "ASK_INTELLIGENCE_MODEL"] as const;
  const values = Object.fromEntries(requiredKeys.map((key) => [key, readOptionalEnv(env, key)]));
  const missing = requiredKeys.filter((key) => !values[key]);
  if (missing.length > 0) {
    throw new Error(`Incomplete Ask Intelligence OpenAI config; missing ${missing.join(", ")}`);
  }

  return {
    provider,
    apiKey: values["OPENAI_API_KEY"]!,
    model: values["ASK_INTELLIGENCE_MODEL"]!,
    baseUrl: readOptionalEnv(env, "OPENAI_BASE_URL"),
    organization: readOptionalEnv(env, "OPENAI_ORGANIZATION"),
    project: readOptionalEnv(env, "OPENAI_PROJECT"),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const server = loadServerConfig(env, {
    host: "0.0.0.0",
    port: 8003,
  });

  return {
    ...server,
    auth: loadAuthConfig(env),
    authSession: loadAuthSessionConfig(env),
    askIntelligence: loadAskIntelligenceConfig(env),
    bookingDatabaseUrl: readOptionalEnv(env, "BOOKING_DATABASE_URL"),
    bookingReservationsReadDatabaseUrl: readOptionalEnv(
      env,
      "BOOKING_RESERVATIONS_READ_DATABASE_URL",
    ),
    bookingPublicApiUrl: readOptionalEnv(env, "BOOKING_PUBLIC_API_URL"),
    marketplaceDatabaseUrl: readOptionalEnv(env, "MARKETPLACE_DATABASE_URL"),
    marketplaceDiscoveryAllowedOrigins: readOptionalCsvEnv(
      env,
      "MARKETPLACE_DISCOVERY_ALLOWED_ORIGINS",
    ),
    pmsApiUrl: readOptionalEnv(env, "PMS_API_URL"),
    pmsPublicApiUrl: readOptionalEnv(env, "PMS_PUBLIC_API_URL"),
    bookingHostBase: readOptionalEnv(env, "BOOKING_HOST_BASE"),
  };
}
