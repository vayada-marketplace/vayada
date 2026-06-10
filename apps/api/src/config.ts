import { loadServerConfig } from "@vayada/backend-config";

export type ApiAuthConfig = {
  databaseUrl: string;
  workosJwksUrl: string;
  workosIssuer: string;
  workosAudience: string;
};

export type ApiConfig = {
  host: string;
  port: number;
  auth?: ApiAuthConfig;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const server = loadServerConfig(env, {
    host: "0.0.0.0",
    port: 8003,
  });

  return {
    ...server,
    auth: loadAuthConfig(env),
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
