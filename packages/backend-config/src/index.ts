export type EnvSource = Record<string, string | undefined>;

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

export function readIntegerEnv(env: EnvSource, key: string, options: IntegerEnvOptions): number {
  const rawValue = env[key];
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

export function readStringEnv(env: EnvSource, key: string, defaultValue: string): string {
  const rawValue = env[key];
  return rawValue === undefined || rawValue === "" ? defaultValue : rawValue;
}

export type ServerConfig = {
  host: string;
  port: number;
};

export function loadServerConfig(env: EnvSource, defaults: ServerConfig): ServerConfig {
  return {
    host: readStringEnv(env, "HOST", defaults.host),
    port: readIntegerEnv(env, "PORT", {
      defaultValue: defaults.port,
      min: 1,
      max: 65535,
    }),
  };
}
