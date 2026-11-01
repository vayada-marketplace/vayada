import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// VAY-2442: card readiness is read from finance.online_card_readiness_by_provider, which adds
// vayada Payment. The old view stays only for what can't move: the Channex worker attests its
// definition and holds a column grant on it, and the published-price check reads its currency
// gate (which the new view doesn't change). A new reader of the old view would leave vayada out.
it("reads card readiness only through the per-provider view", () => {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const readers = (readdirSync(root, { recursive: true }) as string[])
    .filter((file) => file.endsWith(".ts") && !/\.test\.ts$|\.fixtures\.ts$/.test(file))
    .filter((file) =>
      /finance\.online_card_readiness(?![_a-zA-Z.])/.test(readFileSync(root + file, "utf8")),
    )
    .map((file) => file.replaceAll("\\", "/"))
    .sort();
  expect(readers).toEqual([
    "domains/financeReplacementPricingReadiness.ts",
    "jobs/channexManagementWorkerBoundary.ts",
    "jobs/channexManagementWorkerPrivileges.ts",
  ]);
});
