import { AuthorizationError } from "@vayada/backend-authorization";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  end: vi.fn(),
  release: vi.fn(),
  authority: vi.fn(),
  sync: vi.fn(),
  repo: vi.fn(),
  command: vi.fn(),
  assign: vi.fn(),
  close: vi.fn(),
  pool: vi.fn(),
  routing: vi.fn(),
  generate: vi.fn(),
}));
vi.mock("pg", () => ({
  default: {
    Pool: class {
      constructor(config: unknown) {
        mocks.pool(config);
      }
      query = mocks.query;
      connect = async () => ({ query: mocks.query, release: mocks.release });
      end = mocks.end;
    },
  },
}));
vi.mock("./platform/hotelSetupProfileWriter.js", () => ({
  lockHotelSetupOwnerAuthority: mocks.authority,
}));
vi.mock("./routes/marketplaceAdmin.js", () => ({ syncPropertyOfferReadModels: mocks.sync }));
vi.mock("./platform/platformMediaS3.js", () => ({
  createS3PlatformMediaAdapter: () => ({ generateVariants: mocks.generate }),
}));
vi.mock("./platform/platformMediaRepository.js", () => ({
  createPgPlatformMediaRepository: mocks.repo,
}));
vi.mock("./domains/propertyMediaCommandRepository.js", () => ({
  createPgS3PropertyMediaCommandRepository: mocks.command,
}));
import { createOrdinaryHotelSetupLogoRuntime } from "./hotelSetupLogoRuntime.js";
const propertyId = "11111111-1111-4111-8111-111111111111",
  organizationId = "22222222-2222-4222-8222-222222222222",
  actorUserId = "33333333-3333-4333-8333-333333333333";
const defaults = { repository: {}, targetResolver: {}, finalizer: {} } as never;
function runtime() {
  return createOrdinaryHotelSetupLogoRuntime({
    connectionString: "postgresql://api",
    lookup: { query: mocks.routing } as never,
    defaults,
    serving: {
      bucketName: "owned",
      cdnBaseUrl: "https://images.example.com",
      cdnOriginHost: "origin.example.com",
      publicPathPrefix: "media",
      publicCacheControl: "public,max-age=31536000,immutable",
      privateDownloadTtlSeconds: 300,
      privateDownloadMaxTtlSeconds: 900,
    },
  });
}
const context = {
  selectedOrganization: { organizationId, kind: "hotel_group" },
  actor: { internalUserId: actorUserId, providerIdentity: { sessionId: "owner-session" } },
  membership: { roleKey: "hotel_owner", permissions: ["hotel_catalog.setup.manage"] },
} as any;
const logoRequest = {
  purpose: "property.logo",
  resource: { product: "hotel_catalog", resourceType: "property", resourceId: propertyId },
  files: [],
} as any;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.authority.mockResolvedValue(true);
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.repo.mockReturnValue({ findUploadSession: vi.fn() });
  mocks.command.mockReturnValue({ assignLogo: mocks.assign, close: mocks.close });
  mocks.assign.mockResolvedValue({ ok: true });
});
describe("request-bound ordinary logo runtime", () => {
  it.each(["acknowledged", "unknown_reconciled", "unknown_unconfirmed"])(
    "records private artifact before storage after %s COMMIT",
    async (outcome) => {
      const r = runtime();
      const ports = await r.uploads.resolveRequestPersistence!({
        operation: "create",
        context,
        request: logoRequest,
      });
      const artifact = {
        variantName: "original_safe",
        visibility: "private",
        storageKey: "private/media/exact",
        contentType: "image/webp",
        sizeBytes: 10,
        publicCdnUrl: null,
      };
      mocks.generate.mockImplementation(async (input) => {
        await input.beforeWriteVariant(artifact);
        return [artifact];
      });
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.startsWith("UPDATE")) return { rows: [{ id: propertyId }], rowCount: 1 };
        if (sql.startsWith("SELECT id"))
          return {
            rows: outcome === "unknown_unconfirmed" ? [] : [{ id: propertyId }],
            rowCount: 1,
          };
        if (sql === "COMMIT" && outcome !== "acknowledged") {
          if (mocks.query.mock.calls.filter(([q]) => q === "COMMIT").length === 2)
            throw new Error("lost commit acknowledgement");
        }
        return { rows: [] };
      });
      const generation = ports.finalizer!.generateVariants({
        session: { sessionId: propertyId } as any,
        file: { sessionFile: { mediaId: propertyId } } as any,
        fileIndex: 0,
        policy: {} as any,
      });
      if (outcome === "unknown_unconfirmed")
        await expect(generation).rejects.toThrow("requires inspection");
      else await expect(generation).resolves.toEqual([artifact]);
      expect(
        mocks.query.mock.calls.some(([sql]) => sql.includes("private_artifact_manifest")),
      ).toBe(true);
      await ports.close();
    },
  );
  it("binds current actor before acquisition and rechecks on the repository's transaction client", async () => {
    const ports = await runtime().uploads.resolveRequestPersistence!({
      operation: "create",
      context,
      request: logoRequest,
    });
    expect(mocks.pool).toHaveBeenCalledWith({ connectionString: "postgresql://api", max: 1 });
    expect(mocks.query.mock.calls.map((c) => c[0])).toEqual(["BEGIN", "COMMIT"]);
    const scoped = mocks.repo.mock.calls[0]![0];
    const client = { query: vi.fn() };
    await scoped.authorizeWriteTransaction(client);
    expect(mocks.authority).toHaveBeenLastCalledWith(
      client,
      { propertyId, organizationId, actorUserId },
      ["hotel_catalog.setup.manage"],
    );
    expect(ports.targetResolver).toBe(ports.repository);
    await ports.close();
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });
  it("routes finalize only through actor/org/purpose scoped session metadata", async () => {
    mocks.routing.mockResolvedValue({ rows: [{ propertyId }] });
    const ports = await runtime().uploads.resolveRequestPersistence!({
      operation: "finalize",
      context,
      sessionId: propertyId,
    });
    expect(mocks.routing.mock.calls[0]![0]).toContain("requested_purpose='property.logo'");
    expect(mocks.routing.mock.calls[0]![1]).toEqual([propertyId, actorUserId, organizationId]);
    expect(mocks.authority).toHaveBeenCalledOnce();
    await ports.close();
  });
  it("keeps the shared persistence for other sessions and purposes without a request pool", async () => {
    mocks.routing.mockResolvedValue({ rows: [] });
    const finalize = await runtime().uploads.resolveRequestPersistence!({
      operation: "finalize",
      context,
      sessionId: propertyId,
    });
    const gallery = await runtime().uploads.resolveRequestPersistence!({
      operation: "create",
      context,
      request: { ...logoRequest, purpose: "property.gallery_image" },
    });
    for (const ports of [finalize, gallery]) expect(ports).toMatchObject(defaults);
    await expect(
      runtime().uploads.resolveRequestPersistence!({
        operation: "create",
        context,
        request: { ...logoRequest, resource: { ...logoRequest.resource, product: "pms" } },
      }),
    ).rejects.toThrow("Invalid logo target");
    expect(mocks.pool).not.toHaveBeenCalled();
  });
  it("denies a non-Owner session before opening a request pool", async () => {
    await expect(
      runtime().uploads.resolveRequestPersistence!({
        operation: "create",
        context: { ...context, membership: { ...context.membership, roleKey: "hotel_manager" } },
        request: logoRequest,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(mocks.pool).not.toHaveBeenCalled();
  });
  it("closes failed acquisition and never falls back", async () => {
    mocks.authority.mockResolvedValue(false);
    await expect(
      runtime().uploads.resolveRequestPersistence!({
        operation: "create",
        context,
        request: logoRequest,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(mocks.query.mock.calls.map((c) => c[0])).toEqual(["BEGIN", "ROLLBACK"]);
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(mocks.repo).not.toHaveBeenCalled();
  });
  it("awaits assignment replay/publication before closing publisher and request pool", async () => {
    const r = runtime();
    await r.assignments.assignLogo({
      propertyId,
      organizationId,
      actorUserId,
      idempotencyKey: "logo",
      expectedProfileRevision: 1,
      logoMediaObjectId: propertyId,
      audit: {},
    } as any);
    const cfg = mocks.command.mock.calls[0]![0];
    await cfg.authorizeTransaction({ query: vi.fn() });
    expect(mocks.authority).toHaveBeenCalledTimes(2);
    expect(cfg.syncReadModels).toBe(mocks.sync);
    expect(mocks.assign.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.close.mock.invocationCallOrder[0]!,
    );
    expect(mocks.close.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.end.mock.invocationCallOrder[0]!,
    );
    await expect(r.assignments.runPublicationBatch()).rejects.toThrow("request persistence");
  });
});
