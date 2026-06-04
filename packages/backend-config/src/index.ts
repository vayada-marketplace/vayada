export type EnvSource = Record<string, string | undefined>;

/** Error thrown when an environment value cannot be parsed safely. */
export class ConfigError extends Error {
  constructor(
    message: string,
    readonly key: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

export type IntegerEnvOptions = {
  defaultValue: number;
  min?: number;
  max?: number;
};

/** Reads an integer env value without silently truncating decimal strings. */
export function readIntegerEnv(env: EnvSource, key: string, options: IntegerEnvOptions): number {
  const rawValue = env[key];
  const hasRawValue = rawValue !== undefined && rawValue !== "";

  if (!Number.isInteger(options.defaultValue)) {
    throw new ConfigError(`${key} default value must be an integer`, key);
  }

  if (hasRawValue && !/^[+-]?\d+$/.test(rawValue)) {
    throw new ConfigError(`${key} must be a valid integer`, key);
  }

  const value =
    rawValue === undefined || rawValue === ""
      ? options.defaultValue
      : Number.parseInt(rawValue, 10);

  if (!Number.isInteger(value)) {
    throw new ConfigError(`${key} must be an integer`, key);
  }

  if (options.min !== undefined && value < options.min) {
    throw new ConfigError(`${key} must be at least ${options.min}`, key);
  }

  if (options.max !== undefined && value > options.max) {
    throw new ConfigError(`${key} must be at most ${options.max}`, key);
  }

  return value;
}

/**
 * Reads a string env value, treating undefined and empty string as absent so
 * callers can fall back to a known default.
 */
export function readStringEnv(env: EnvSource, key: string, defaultValue: string): string {
  const rawValue = env[key];
  return rawValue === undefined || rawValue === "" ? defaultValue : rawValue;
}

export type ServerConfig = {
  host: string;
  port: number;
};

export type ServerConfigOptions = {
  minPort?: number;
  maxPort?: number;
};

/** Loads common server host/port config from HOST and PORT env values. */
export function loadServerConfig(
  env: EnvSource,
  defaults: ServerConfig,
  options: ServerConfigOptions = {},
): ServerConfig {
  return {
    host: readStringEnv(env, "HOST", defaults.host),
    port: readIntegerEnv(env, "PORT", {
      defaultValue: defaults.port,
      min: options.minPort ?? 1,
      max: options.maxPort ?? 65535,
    }),
  };
}
