import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@vayada/domain-hotels": fileURLToPath(
        new URL("../../packages/domain-hotels/src/index.ts", import.meta.url),
      ),
    },
  },
  server: { host: "127.0.0.1", strictPort: true, allowedHosts: ["pms.localhost"] },
});
