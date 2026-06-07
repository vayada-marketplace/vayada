import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./check-architecture-boundaries.mjs", import.meta.url));

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

test("fails when target product route code writes identity tables directly", () => {
  const root = createFixtureRoot({
    "apps/api/src/routes/bookingSettings.ts": `
      export async function route(db) {
        await db.execute(sql\`insert into identity.users (email) values ('owner@example.com')\`);
      }
    `,
  });

  try {
    const result = runCheck(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /identity lifecycle command/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails when target product domain code uses query-builder identity mutations", () => {
  const root = createFixtureRoot({
    "packages/domain-booking/src/owner.ts": `
      export async function createOwner(db) {
        return db.insertInto("users").values({ email: "owner@example.com" }).execute();
      }
    `,
  });

  try {
    const result = runCheck(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /identity lifecycle command/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails when target product route code writes quoted identity table names", () => {
  const root = createFixtureRoot({
    "apps/api/src/routes/bookingSettings.ts": `
      export async function route(db) {
        await db.execute(sql\`update "identity"."organization_memberships" set status = 'active'\`);
      }
    `,
  });

  try {
    const result = runCheck(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /identity lifecycle command/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails when future marketplace domain code writes identity tables directly", () => {
  const root = createFixtureRoot({
    "packages/domain-marketplace/src/adminUsers.ts": `
      export async function createUser(db) {
        await db.execute(sql\`delete from identity.users where id = 'user_001'\`);
      }
    `,
  });

  try {
    const result = runCheck(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /identity lifecycle command/);
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
