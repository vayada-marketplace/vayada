import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
  release: vi.fn(),
  attest: vi.fn(),
  scope: vi.fn(),
  repo: vi.fn(),
  command: vi.fn(),
  assign: vi.fn(),
  close: vi.fn(),
  pool: vi.fn(),
  routing: vi.fn(),
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
vi.mock("./hotelSetupCommandCredentials.js", () => ({
  createHotelSetupLogoCredentialResolver: () => mocks.resolve,
}));
vi.mock("./hotelSetupLogoPrivileges.js", () => ({ assertHotelSetupLogoPrivileges: mocks.attest }));
vi.mock("./hotelSetupCommandScope.js", () => ({ assertHotelSetupLogoScope: mocks.scope }));
vi.mock("./platform/platformMediaS3.js", () => ({ createS3PlatformMediaAdapter: () => ({}) }));
vi.mock("./platform/platformMediaRepository.js", () => ({
  createPgPlatformMediaRepository: mocks.repo,
}));
vi.mock("./domains/propertyMediaCommandRepository.js", () => ({
  createPgS3PropertyMediaCommandRepository: mocks.command,
}));
import { createHotelSetupLogoRuntime } from "./hotelSetupLogoRuntime.js";
const propertyId = "11111111-1111-4111-8111-111111111111",
  organizationId = "22222222-2222-4222-8222-222222222222",
  actorUserId = "33333333-3333-4333-8333-333333333333";
function runtime() {
  return createHotelSetupLogoRuntime(
    {
      assignments: { query: mocks.routing },
      readNativeSecret: vi.fn(),
      databaseEndpoint: "unused",
      secretPrefix: "unused",
    },
    {
      bucketName: "owned",
      cdnBaseUrl: "https://images.example.com",
      cdnOriginHost: "origin.example.com",
      publicPathPrefix: "media",
      publicCacheControl: "public,max-age=31536000,immutable",
      privateDownloadTtlSeconds: 300,
      privateDownloadMaxTtlSeconds: 900,
    },
  );
}
const context = {
  selectedOrganization: { organizationId },
  actor: { internalUserId: actorUserId },
} as any;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolve.mockResolvedValue("native-secret-url");
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.repo.mockReturnValue({ findUploadSession: vi.fn() });
  mocks.command.mockReturnValue({ assignLogo: mocks.assign, close: mocks.close });
  mocks.assign.mockResolvedValue({ ok: true });
});
describe("request-bound native logo runtime", () => {
  it("binds current actor before acquisition and rechecks on the repository's transaction client", async () => {
    const r = runtime();
    const ports = await r.uploads.resolveRequestPersistence!({
      operation: "create",
      context,
      request: {
        purpose: "property.logo",
        resource: { product: "hotel_catalog", resourceType: "property", resourceId: propertyId },
        files: [],
      },
    });
    expect(mocks.resolve).toHaveBeenCalledWith(propertyId, organizationId, actorUserId);
    expect(mocks.query.mock.calls.map((c) => c[0])).toEqual(["BEGIN", "COMMIT"]);
    const native = mocks.repo.mock.calls[0]![0];
    const client = { query: vi.fn() };
    await native.authorizeWriteTransaction(client);
    expect(mocks.attest).toHaveBeenLastCalledWith(client);
    expect(mocks.scope).toHaveBeenLastCalledWith(client, {
      propertyId,
      organizationId,
      actorUserId,
    });
    expect(ports.targetResolver).toBe(ports.repository);
    await ports.close();
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });
  it("routes finalize only through actor/org/purpose scoped reader metadata", async () => {
    mocks.routing.mockResolvedValue({ rows: [{ propertyId }] });
    const ports = await runtime().uploads.resolveRequestPersistence!({
      operation: "finalize",
      context,
      sessionId: propertyId,
    });
    expect(mocks.routing.mock.calls[0]![0]).toContain("requested_purpose='property.logo'");
    expect(mocks.routing.mock.calls[0]![1]).toEqual([propertyId, actorUserId, organizationId]);
    expect(mocks.resolve).toHaveBeenCalledWith(propertyId, organizationId, actorUserId);
    await ports.close();
  });
  it("does not fetch credentials for a foreign session or invalid purpose", async () => {
    mocks.routing.mockResolvedValue({ rows: [] });
    await expect(
      runtime().uploads.resolveRequestPersistence!({
        operation: "finalize",
        context,
        sessionId: propertyId,
      }),
    ).rejects.toThrow("Missing logo session");
    await expect(
      runtime().uploads.resolveRequestPersistence!({
        operation: "create",
        context,
        request: {
          purpose: "property.gallery_image",
          resource: { product: "hotel_catalog", resourceType: "property", resourceId: propertyId },
          files: [],
        },
      }),
    ).rejects.toThrow("Invalid logo target");
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.pool).not.toHaveBeenCalled();
  });
  it("closes failed acquisition and never falls back", async () => {
    mocks.attest.mockRejectedValue(new Error("revoked"));
    await expect(
      runtime().uploads.resolveRequestPersistence!({
        operation: "create",
        context,
        request: {
          purpose: "property.logo",
          resource: { product: "hotel_catalog", resourceType: "property", resourceId: propertyId },
          files: [],
        },
      }),
    ).rejects.toThrow("revoked");
    expect(mocks.query.mock.calls.map((c) => c[0])).toEqual(["BEGIN", "ROLLBACK"]);
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(mocks.repo).not.toHaveBeenCalled();
  });
  it("awaits assignment replay/publication before closing publisher and native pool", async () => {
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
    const query = vi.fn();
    await cfg.syncReadModels({ query }, { propertyId });
    expect(query).toHaveBeenCalledWith(
      "SELECT platform.sync_hotel_setup_logo_read_models($1::uuid)",
      [propertyId],
    );
    expect(mocks.assign.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.close.mock.invocationCallOrder[0]!,
    );
    expect(mocks.close.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.end.mock.invocationCallOrder[0]!,
    );
    await expect(r.assignments.runPublicationBatch()).rejects.toThrow("request persistence");
  });
});
