import { loadServerConfig } from "@vayada/backend-config";

export type ApiConfig = {
  host: string;
  port: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return loadServerConfig(env, {
    host: "0.0.0.0",
    port: 8003,
  });
}
