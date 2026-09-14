import pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPgAirbnbImportSourceRepository } from "./domains/airbnbImportSourceRepository.js";
import { createPgAirbnbImportApplicationRepository } from "./domains/airbnbImportApplicationRepository.js";
import type { PreparedHotelImport } from "@vayada/domain-hotels";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("durable Airbnb source", () => {
  const scope = {
    actorUserId: randomUUID(),
    organizationId: randomUUID(),
    propertyId: randomUUID(),
  };
  const otherProperty = randomUUID();
  const binding = {
    environment: "staging" as const,
    groupId: randomUUID(),
    externalPropertyId: randomUUID(),
  };
  const data: PreparedHotelImport = {
    contractVersion: "prepared-hotel-import.v1",
    property: {},
    rooms: ["one", "two"].map((id) => ({
      id: `abb_${id}`,
      name: `Fixture ${id}`,
      description: "",
      maxGuests: 2,
      maxAdults: null,
      maxChildren: null,
      bedType: "",
      bedQuantity: null,
      bathroomType: "",
      sizeSquareMetres: null,
    })),
  };
  const db = new pg.Client({ connectionString: url });
  const repository = createPgAirbnbImportSourceRepository(url ?? "postgresql://disabled");
  const applications = createPgAirbnbImportApplicationRepository(url ?? "postgresql://disabled");
  let connected = false;
  beforeAll(async () => {
    if (url !== "postgresql://postgres@127.0.0.1:59709/vay1009_import_test")
      throw new Error("Requires the reserved local VAY-1009 test database");
    await db.connect();
    connected = true;
    await db.query("INSERT INTO identity.users(id,email,status) VALUES($1,$2,'active')", [
      scope.actorUserId,
      `${scope.actorUserId}@example.test`,
    ]);
    await db.query(
      "INSERT INTO identity.organizations(id,kind,name,slug,status) VALUES($1::uuid,'hotel_group','Source test',$1::text,'active')",
      [scope.organizationId],
    );
    await db.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Source test'),($2::uuid,$2::text,'Other source test')",
      [scope.propertyId, otherProperty],
    );
  });
  afterAll(async () => {
    try {
      if (!connected) return;
      await db.query(
        `DELETE FROM hotel_catalog.airbnb_import_applications WHERE source_id IN
        (SELECT id FROM hotel_catalog.airbnb_import_sources WHERE organization_id=$1)`,
        [scope.organizationId],
      );
      await db.query("DELETE FROM hotel_catalog.airbnb_import_sources WHERE organization_id=$1", [
        scope.organizationId,
      ]);
      await db.query("DELETE FROM hotel_catalog.properties WHERE id=ANY($1::uuid[])", [
        [scope.propertyId, otherProperty],
      ]);
      await db.query("DELETE FROM identity.organizations WHERE id=$1", [scope.organizationId]);
      await db.query("DELETE FROM identity.users WHERE id=$1", [scope.actorUserId]);
    } finally {
      await Promise.allSettled([repository.close(), applications.close(), db.end()]);
    }
  });
  it("persists the binding and only a digest of the random state", async () => {
    const attempt = await repository.begin(scope, binding);
    expect(attempt.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await repository.pending(scope, attempt.state)).toEqual({
      ...binding,
      sourceId: attempt.sourceId,
    });
    const row = (
      await db.query(
        "SELECT state_hash,expires_at-created_at AS lifetime FROM hotel_catalog.airbnb_import_sources WHERE id=$1",
        [attempt.sourceId],
      )
    ).rows[0];
    expect(row.state_hash).toBe(createHash("sha256").update(attempt.state).digest("hex"));
    expect(row.lifetime.minutes).toBe(20);
    expect(await repository.find(scope, attempt.sourceId)).toBeNull();
  });
  it.each(["actorUserId", "organizationId", "propertyId"] as const)(
    "rejects callbacks and reads in the wrong %s scope",
    async (key) => {
      const attempt = await repository.begin(scope, binding);
      const wrong = { ...scope, [key]: randomUUID() };
      expect(await repository.pending(wrong, attempt.state)).toBeNull();
      expect(await repository.complete(wrong, attempt.state, randomUUID(), data)).toBeNull();
      expect(await repository.complete(scope, attempt.state, randomUUID(), data)).toBe(
        attempt.sourceId,
      );
      expect(await repository.find(wrong, attempt.sourceId)).toBeNull();
    },
  );
  it("expires pending attempts and rejects unknown or malformed states", async () => {
    const attempt = await repository.begin(scope, binding);
    await db.query(
      "UPDATE hotel_catalog.airbnb_import_sources SET created_at=now()-interval '30 minutes',expires_at=now()-interval '10 minutes' WHERE id=$1",
      [attempt.sourceId],
    );
    for (const state of [attempt.state, "bad", "x".repeat(43)]) {
      expect(await repository.pending(scope, state)).toBeNull();
      expect(await repository.complete(scope, state, randomUUID(), data)).toBeNull();
    }
  });
  it("allows one concurrent completion and preserves the snapshot on replay", async () => {
    const attempt = await repository.begin(scope, binding);
    const channel = randomUUID();
    const result = await Promise.all(
      Array.from({ length: 4 }, () => repository.complete(scope, attempt.state, channel, data)),
    );
    expect(result.filter(Boolean)).toEqual([attempt.sourceId]);
    expect(await repository.pending(scope, attempt.state)).toBeNull();
    expect(
      await repository.complete(scope, attempt.state, randomUUID(), {
        ...data,
        property: { displayName: "Changed" },
      }),
    ).toBeNull();
    await db.query(
      "UPDATE hotel_catalog.airbnb_import_sources SET created_at=now()-interval '30 minutes',expires_at=now()-interval '10 minutes' WHERE id=$1",
      [attempt.sourceId],
    );
    const reopened = createPgAirbnbImportSourceRepository(url!);
    try {
      expect(await reopened.find(scope, attempt.sourceId)).toEqual({
        ...binding,
        sourceId: attempt.sourceId,
        channelId: channel,
        data,
      });
    } finally {
      await reopened.close();
    }
  });
  it("cannot bind one channel to another source or property", async () => {
    const first = await repository.begin(scope, binding);
    const channel = randomUUID();
    await repository.complete(scope, first.state, channel, data);
    const otherScope = { ...scope, propertyId: otherProperty };
    const second = await repository.begin(otherScope, {
      ...binding,
      externalPropertyId: randomUUID(),
    });
    await expect(repository.complete(otherScope, second.state, channel, data)).rejects.toThrow(
      "airbnb_source_already_bound",
    );
    expect(await repository.pending(otherScope, second.state)).not.toBeNull();
    expect(await repository.find(otherScope, first.sourceId)).toBeNull();
  });
  it("rejects invalid snapshots without consuming the attempt", async () => {
    const attempt = await repository.begin(scope, binding);
    await expect(
      repository.complete(scope, attempt.state, randomUUID(), {
        ...data,
        rooms: [{}],
      } as PreparedHotelImport),
    ).rejects.toThrow("invalid_airbnb_import_snapshot");
    expect(await repository.pending(scope, attempt.state)).not.toBeNull();
  });
  async function completedSource() {
    const attempt = await repository.begin(scope, binding);
    await repository.complete(scope, attempt.state, randomUUID(), data);
    return { ...scope, sourceId: attempt.sourceId };
  }
  it("serializes concurrent application and persists receipts across reopening", async () => {
    const target = await completedSource();
    const saved = { itemId: "room:abb_one", status: "applied" as const, resourceId: randomUUID() };
    let executions = 0;
    const execute = async (source: NonNullable<Awaited<ReturnType<typeof applications.find>>>) => {
      if (source.results[saved.itemId]) return [source.results[saved.itemId]!];
      executions++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return [saved];
    };
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        applications.apply(
          { ...target, sourceId: index % 2 ? target.sourceId.toUpperCase() : target.sourceId },
          execute,
        ),
      ),
    );
    expect(results).toEqual(Array.from({ length: 4 }, () => [saved]));
    expect(executions).toBe(1);
    const reopened = createPgAirbnbImportApplicationRepository(url!);
    try {
      expect(await reopened.find(target)).toEqual({
        sourceId: target.sourceId,
        propertyId: scope.propertyId,
        data,
        results: { [saved.itemId]: saved },
      });
    } finally {
      await reopened.close();
    }
  });
  it.each(["actorUserId", "organizationId", "propertyId", "sourceId"] as const)(
    "denies application outside the exact %s scope",
    async (key) => {
      const target = { ...(await completedSource()), [key]: randomUUID() };
      const execute = vi.fn(async () => []);
      expect(await applications.find(target)).toBeNull();
      await expect(applications.apply(target, execute)).rejects.toThrow("import_not_available");
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it("rejects incomplete sources before executing commands", async () => {
    const attempt = await repository.begin(scope, binding);
    const target = { ...scope, sourceId: attempt.sourceId };
    const execute = vi.fn(async () => []);
    expect(await applications.find(target)).toBeNull();
    await expect(applications.apply(target, execute)).rejects.toThrow("import_not_available");
    expect(execute).not.toHaveBeenCalled();
  });
  it("persists successes only and preserves original room identities on retry", async () => {
    const target = await completedSource();
    const first = { itemId: "room:abb_one", status: "applied" as const, resourceId: randomUUID() };
    const second = { itemId: "room:abb_two", status: "applied" as const, resourceId: randomUUID() };
    await applications.apply(target, async () => [
      first,
      { itemId: second.itemId, status: "failed", error: "synthetic_failure" },
    ]);
    expect((await applications.find(target))?.results).toEqual({ [first.itemId]: first });
    expect(
      await applications.apply(target, async () => [
        { ...first, resourceId: randomUUID() },
        second,
      ]),
    ).toEqual([first, second]);
    expect((await applications.find(target))?.results).toEqual({
      [first.itemId]: first,
      [second.itemId]: second,
    });
    expect((await repository.find(scope, target.sourceId))?.data).toEqual(data);
  });
  it("releases its lock after executor failure and leaves failed work retryable", async () => {
    const target = await completedSource();
    await expect(
      applications.apply(target, async () => {
        throw new Error("synthetic_failure");
      }),
    ).rejects.toThrow("synthetic_failure");
    expect((await applications.find(target))?.results).toEqual({});
    await expect(applications.apply(target, async () => [])).resolves.toEqual([]);
  });
});
