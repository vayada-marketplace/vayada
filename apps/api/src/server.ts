import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const app = buildApp();
const config = loadConfig();

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
