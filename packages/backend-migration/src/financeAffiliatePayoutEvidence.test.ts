import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0086_finance_affiliate_payout_payment_evidence.sql"),
  "utf8",
);

// VAY-2272: 0498 dropped the payout evidence tables; the grant and entitlement 0086 added stay.
describe("Finance affiliate payout evidence migration", () => {
  it("adds the Platform Finance command grant and scoped entitlement", () => {
    expect(migration).toContain("'platform.finance.manage'");
    expect(migration).toContain("'platform_admin', 'platform.finance.manage'");
    expect(migration).toContain("'finance_manager', 'platform.finance.manage'");
    expect(migration).toContain("'platform', 'finance-admin', 'active'");
    expect(migration).toContain("'platform', 'platform', 'vayada'");
  });
});
