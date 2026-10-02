import { spawnSync } from "node:child_process";

/** Run the same credential fixture against source or a locally built release image. */
export function runHotelSetupPreflight(
  script: "hotelSetupReaderPreflight" | "hotelSetupPropertyPreflight",
  overrides: NodeJS.ProcessEnv,
) {
  const env = { ...process.env, ...overrides };
  const image = process.env.HOTEL_SETUP_PREFLIGHT_IMAGE;
  if (!image)
    return spawnSync(
      process.execPath,
      ["--import", "tsx", new URL(`./${script}.ts`, import.meta.url).pathname],
      { encoding: "utf8", timeout: 30_000, env },
    );
  const host = process.env.HOTEL_SETUP_PREFLIGHT_DATABASE_HOST;
  const network = process.env.HOTEL_SETUP_PREFLIGHT_NETWORK;
  const ca = process.env.NODE_EXTRA_CA_CERTS;
  if (!host || !network || !ca) throw new Error("Compiled preflight needs local network and CA");
  for (const key of [
    "HOTEL_SETUP_COMMAND_DATABASE_URL",
    "HOTEL_SETUP_COMMAND_READER_DATABASE_URL",
    "HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT",
  ]) {
    if (env[key]) {
      try {
        const url = new URL(env[key]);
        url.hostname = host;
        url.port = "5432";
        env[key] = url.href;
      } catch {
        /* Send malformed input unchanged to the real executable. */
      }
    }
  }
  env.NODE_EXTRA_CA_CERTS = env.NODE_EXTRA_CA_CERTS ? "/test-ca.crt" : "";
  const keys = [
    "HOTEL_SETUP_COMMAND_DATABASE_URL",
    "HOTEL_SETUP_COMMAND_READER_DATABASE_URL",
    "HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT",
    "HOTEL_SETUP_COMMAND_DATABASE_LOGIN",
    "HOTEL_SETUP_COMMAND_PROPERTY_ID",
    "HOTEL_SETUP_COMMAND_ORGANIZATION_ID",
    "HOTEL_SETUP_COMMAND_OPERATION",
    "NODE_EXTRA_CA_CERTS",
    "PGHOST",
    "PGPORT",
    "PGOPTIONS",
  ].filter((key) => env[key] !== undefined);
  return spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--platform",
      "linux/amd64",
      "--network",
      network,
      "--mount",
      `type=bind,src=${ca},dst=/test-ca.crt,readonly`,
      ...keys.flatMap((key) => ["--env", key]),
      "--entrypoint",
      "node",
      image,
      `apps/api/dist/cli/${script}.js`,
    ],
    { encoding: "utf8", timeout: 30_000, env },
  );
}
