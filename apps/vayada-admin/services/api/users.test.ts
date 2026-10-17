import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}));

vi.mock("./client", () => ({
  apiClient: {
    get: mocks.get,
    post: mocks.post,
    patch: mocks.patch,
    put: mocks.put,
    delete: mocks.del,
  },
}));

import { usersService } from "./users";

describe("usersService", () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.post.mockReset();
    mocks.patch.mockReset();
    mocks.put.mockReset();
    mocks.del.mockReset();
  });

  it("lists identity users with only the filters that are set", async () => {
    mocks.get.mockResolvedValue({ users: [], total: 0 });

    await usersService.getAllUsers({ type: "hotel", search: "alpen", page: 2, page_size: 25 });

    expect(mocks.get).toHaveBeenCalledWith(
      "/api/identity/admin/users?page=2&page_size=25&type=hotel&search=alpen",
    );
  });

  it("reads the identity user and converts snake_case fields", async () => {
    mocks.get.mockResolvedValue({
      id: "user-1",
      email: "owner@example.test",
      name: "Owner",
      type: "hotel",
      status: "verified",
      email_verified: true,
      avatar: null,
      created_at: "2026-06-12T10:00:00.000Z",
      updated_at: "2026-06-13T10:00:00.000Z",
    });

    await expect(usersService.getUserById("user-1")).resolves.toMatchObject({
      id: "user-1",
      emailVerified: true,
      createdAt: "2026-06-12T10:00:00.000Z",
    });
    expect(mocks.get).toHaveBeenCalledWith("/api/identity/admin/users/user-1");
  });

  it("creates a hotel account through the identity command route without the password", async () => {
    mocks.post.mockResolvedValue({ userId: "user-2", status: "accepted", commands: [] });

    const created = await usersService.createUser({
      email: "new@example.test",
      password: "secret-password",
      name: "New Hotel",
      type: "hotel",
      status: "pending",
      emailVerified: false,
    });

    expect(mocks.post).toHaveBeenCalledWith("/api/identity/admin/users", {
      email: "new@example.test",
      name: "New Hotel",
      type: "hotel",
      status: "pending",
      emailVerified: false,
    });
    expect(created).toMatchObject({ id: "user-2", type: "hotel", status: "pending" });
  });

  it("deletes and toggles platform access through the identity command routes", async () => {
    mocks.del.mockResolvedValue({ userId: "user-3", status: "accepted", commands: [] });
    mocks.put.mockResolvedValue({ userId: "user-3", status: "accepted", commands: [] });

    await expect(usersService.deleteUser("user-3")).resolves.toMatchObject({
      deleted_user: { id: "user-3" },
    });
    await usersService.setPlatformAccess("user-3", false);

    expect(mocks.del).toHaveBeenCalledWith("/api/identity/admin/users/user-3");
    expect(mocks.put).toHaveBeenCalledWith("/api/identity/admin/users/user-3/platform-access", {
      enabled: false,
    });
  });
});
