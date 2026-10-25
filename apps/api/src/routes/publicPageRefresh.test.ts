import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { refreshPublicPageAfterSaves } from "./publicPageRefresh.js";

describe("booking page refresh after saves (VAY-2129)", () => {
  async function app(refresh: (propertyId: string, request: FastifyRequest) => Promise<void>) {
    const server = Fastify({ logger: false });
    await server.register(
      async (scoped) => {
        refreshPublicPageAfterSaves(scoped, ["PUT /properties/:propertyId/profile"], refresh);
        scoped.put("/properties/:propertyId/profile", async (request, reply) =>
          (request.query as { fail?: string }).fail ? reply.status(409).send({}) : { ok: true },
        );
        scoped.get("/properties/:propertyId/profile", async () => ({ ok: true }));
        scoped.put("/properties/:propertyId/other", async () => ({ ok: true }));
      },
      { prefix: "/api/hotel-setup" },
    );
    return server;
  }

  it("refreshes after a successful listed save only, and never fails the request", async () => {
    const refresh = vi.fn(async (_propertyId: string, _request: FastifyRequest) => undefined);
    const server = await app(refresh);
    const put = (url: string) => server.inject({ method: "PUT", url });
    try {
      expect((await put("/api/hotel-setup/properties/p-1/profile")).statusCode).toBe(200);
      expect((await put("/api/hotel-setup/properties/p-2/profile?fail=1")).statusCode).toBe(409);
      expect((await put("/api/hotel-setup/properties/p-3/other")).statusCode).toBe(200);
      await server.inject({ method: "GET", url: "/api/hotel-setup/properties/p-4/profile" });
      await vi.waitFor(() => expect(refresh.mock.calls.map(([id]) => id)).toEqual(["p-1"]));
      refresh.mockRejectedValueOnce(new Error("projection unavailable"));
      expect((await put("/api/hotel-setup/properties/p-5/profile")).statusCode).toBe(200);
      await vi.waitFor(() => expect(refresh).toHaveBeenLastCalledWith("p-5", expect.anything()));
    } finally {
      await server.close();
    }
  });
});
