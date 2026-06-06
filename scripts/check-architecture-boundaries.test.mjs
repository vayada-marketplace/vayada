import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const scriptPath = new URL("./check-architecture-boundaries.mjs", import.meta.url).pathname;

test("passes clean Booking route and domain files", () => {
  const root = createFixtureRoot({
    "apps/api/src/routes/bookingReservations.ts": `
      import { enforceRoutePolicy } from "./policy.js";
      export const route = () => enforceRoutePolicy;
    `,
    "packages/domain-booking/src/index.ts": `
      import type { PmsReservationSink } from "@vayada/domain-pms";
      export type BookingHandoff = PmsReservationSink;
    `,
  });

  try {
    const result = runCheck(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Architecture boundary check passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails when Booking route code uses a PMS database URL", () => {
  const root = createFixtureRoot({
    "apps/api/src/routes/bookingReservations.ts": `
      export const connectionString = process.env.PMS_DATABASE_URL;
    `,
  });

  try {
    const result = runCheck(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PMS_DATABASE_URL/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails when Booking domain code imports PMS implementation modules", () => {
  const root = createFixtureRoot({
    "packages/domain-booking/src/index.ts": `
      import { createVayadaPmsAdapter } from "@vayada/domain-pms/adapters/vayada";
      export const adapter = createVayadaPmsAdapter;
    `,
  });

  try {
    const result = runCheck(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PMS implementations/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails when Booking domain code imports Channex", () => {
  const root = createFixtureRoot({
    "packages/domain-booking/src/index.ts": `
      import { channexClient } from "../integrations/channex/client";
      export const client = channexClient;
    `,
  });

  try {
    const result = runCheck(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Channex/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails when route code uses product database env names even without a booking filename", () => {
  const root = createFixtureRoot({
    "apps/api/src/routes/reservations.ts": `
      export const connectionString = process.env.PMS_DATABASE_URL;
    `,
  });

  try {
    const result = runCheck(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /product database URLs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails when Booking code uses query-builder PMS table names", () => {
  const root = createFixtureRoot({
    "packages/domain-booking/src/readModel.ts": `
      export async function listBlocks(db) {
        return db.selectFrom("room_blocks").selectAll().execute();
      }
    `,
  });

  try {
    const result = runCheck(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /table names/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails when Booking code uses schema-qualified PMS SQL table names", () => {
  const root = createFixtureRoot({
    "packages/domain-booking/src/readModel.ts": `
      export async function listBlocks(db) {
        return db.execute(sql\`select * from pms.room_blocks\`);
      }
    `,
  });

  try {
    const result = runCheck(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /table names/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails when Booking domain code imports sibling PMS domain modules", () => {
  const root = createFixtureRoot({
    "apps/api/src/domains/booking/handoff.ts": `
      import { createReservation } from "../pms/reservations";
      export const handoff = createReservation;
    `,
    "apps/api/src/domains/pms/reservations.ts": `
      export const createReservation = () => {};
    `,
  });

  try {
    const result = runCheck(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PMS implementations/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails when Booking domain code requires PMS implementation modules", () => {
  const root = createFixtureRoot({
    "packages/domain-booking/src/index.cts": `
      const adapter = require("@vayada/domain-pms/adapters/vayada");
      module.exports = adapter;
    `,
  });

  try {
    const result = runCheck(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PMS implementations/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function createFixtureRoot(files) {
  const root = mkdtempSync(path.join(tmpdir(), "vayada-boundaries-"));

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents);
  }

  return root;
}

function runCheck(root) {
  return spawnSync(process.execPath, [scriptPath, "--root", root], {
    encoding: "utf8",
  });
}
