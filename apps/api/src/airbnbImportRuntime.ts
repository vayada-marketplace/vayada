import pg from "pg";
import type { AirbnbImportRoutesOptions } from "./routes/airbnbImports.js";
import { createPgAirbnbImportSourceRepository } from "./domains/airbnbImportSourceRepository.js";
import { createPgAirbnbImportApplicationRepository } from "./domains/airbnbImportApplicationRepository.js";
import { createChannexAirbnbBindingResolver } from "./integrations/channexAirbnbBinding.js";
import { createChannexAirbnbConnectionProvider } from "./integrations/channexAirbnbConnection.js";

export function loadAirbnbImportConfig(env: NodeJS.ProcessEnv) {
  const enabled = env.AIRBNB_IMPORT_ENABLED ?? "false";
  if (enabled === "false") return undefined;
  if (enabled !== "true") throw new Error("AIRBNB_IMPORT_ENABLED must be true or false");
  const environment: "staging" | "production" | null =
    env.CHANNEX_API_BASE_URL === "https://staging.channex.io"
      ? "staging"
      : env.CHANNEX_API_BASE_URL === "https://app.channex.io"
        ? "production"
        : null;
  const apiKey = env.CHANNEX_API_KEY;
  let callback: URL;
  try {
    callback = new URL(env.AIRBNB_IMPORT_CALLBACK_ORIGIN ?? "");
  } catch {
    throw new Error("AIRBNB_IMPORT_CALLBACK_ORIGIN must be an HTTPS origin");
  }
  if (
    !environment ||
    !apiKey?.trim() ||
    callback.protocol !== "https:" ||
    callback.username ||
    callback.password ||
    callback.pathname !== "/" ||
    callback.search ||
    callback.hash
  )
    throw new Error("Invalid Airbnb import provider configuration");
  return { environment, apiKey, callbackOrigin: callback.origin };
}

/** Construct only when explicitly enabled. The application supplies its existing authorized room ports. */
export function createAirbnbImportRuntime(options: {
  config: NonNullable<ReturnType<typeof loadAirbnbImportConfig>>;
  connectionString: string;
  allowedOrigins: string[];
  fetcher?: typeof fetch;
}) {
  if (!options.allowedOrigins.includes(options.config.callbackOrigin))
    throw new Error("Airbnb callback origin must be an allowed authentication origin");
  const provider = createChannexAirbnbConnectionProvider({
    ...options.config,
    fetcher: options.fetcher,
  });
  const database = new pg.Pool({ connectionString: options.connectionString });
  return {
    routes: {
      repository: createPgAirbnbImportSourceRepository(options.connectionString),
      applications: createPgAirbnbImportApplicationRepository(options.connectionString),
      allowedOrigins: [options.config.callbackOrigin],
      resolveBinding: createChannexAirbnbBindingResolver({
        ...options.config,
        database,
        fetcher: options.fetcher,
      }),
      ...provider,
    } satisfies Omit<AirbnbImportRoutesOptions, "propertyAccessRepository"> & {
      applications: ReturnType<typeof createPgAirbnbImportApplicationRepository>;
    },
    close: () => database.end(),
  };
}
