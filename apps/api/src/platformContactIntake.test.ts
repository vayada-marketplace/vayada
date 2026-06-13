import { injectJson } from "@vayada/backend-test";
import { describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import {
  createPgPlatformContactIntakeRepository,
  PL1_NON_MEDIA_CONTRACT_VERSION,
  type PlatformContactIntakePool,
  type PlatformContactIntakeRepository,
  type PlatformContactIntakeResponse,
} from "./routes/platformContactIntake.js";

describe("platform contact intake routes", () => {
  it("accepts public contact submissions through the PL1 intake contract", async () => {
    const submissions: string[] = [];
    const app = buildContactIntakeApp({
      repository: {
        async submitContact({ payload }) {
          submissions.push(`${payload.email}:${payload.userType}`);
          return contactResponse();
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/contact",
      payload: {
        name: "Lina Creator",
        email: "LINA@EXAMPLE.COM",
        user_type: "creator",
        message: "I want to partner with Vayada.",
      },
      headers: { origin: "https://landing.localhost" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("https://landing.localhost");
    const body = JSON.parse(response.body) as PlatformContactIntakeResponse;
    expect(body).toMatchObject({
      contractVersion: PL1_NON_MEDIA_CONTRACT_VERSION,
      status: "accepted",
    });
    expect(submissions).toEqual(["lina@example.com:creator"]);
  });

  it("rejects invalid public contact submissions before writing intake", async () => {
    const app = buildContactIntakeApp({
      repository: {
        async submitContact() {
          throw new Error("repository should not be called");
        },
      },
    });

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/contact",
      payload: { name: "Missing Email", message: "Hello" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      code: "invalid_request",
      category: "validation",
    });
  });
});

describe("platform contact intake target repository", () => {
  it("persists domain event, email job, and audit rows in one transaction", async () => {
    const pool = createContactPool();
    const repository = createPgPlatformContactIntakeRepository({
      connectionString: "postgres://target",
      pool,
    });

    const response = await repository.submitContact({
      requestId: "req_contact_001",
      receivedAt: "2026-06-13T21:00:00.000Z",
      payload: {
        name: "Lina Creator",
        email: "lina@example.com",
        phone: null,
        company: "Creator Studio",
        country: "DE",
        userType: "creator",
        message: "I want to partner with Vayada.",
      },
    });

    expect(response.contractVersion).toBe(PL1_NON_MEDIA_CONTRACT_VERSION);
    expect(response.command.idempotencyKey).toMatch(/^platform\.contact_submission:/);
    expect(pool.queries[0]).toBe("BEGIN");
    expect(pool.queries.some((query) => query.includes("INSERT INTO platform.domain_events"))).toBe(
      true,
    );
    expect(pool.queries.some((query) => query.includes("INSERT INTO platform.jobs"))).toBe(true);
    expect(
      pool.queries.some((query) => query.includes("INSERT INTO platform.product_audit_events")),
    ).toBe(true);
    expect(pool.queries).toContain("COMMIT");
    expect(pool.queries.at(-1)).toBe("release");
  });
});

function buildContactIntakeApp(options: {
  repository: PlatformContactIntakeRepository;
}): ReturnType<typeof buildApp> {
  return buildApp({
    logger: false,
    platformContactIntake: {
      repository: options.repository,
      allowedOrigins: ["https://landing.localhost"],
    },
  });
}

function contactResponse(): PlatformContactIntakeResponse {
  return {
    contractVersion: PL1_NON_MEDIA_CONTRACT_VERSION,
    command: {
      contractVersion: PL1_NON_MEDIA_CONTRACT_VERSION,
      idempotencyKey: "platform.contact_submission:test:v1",
      receivedAt: "2026-06-13T21:00:00.000Z",
    },
    intakeId: "contact_test",
    eventId: "event_contact_001",
    jobId: "job_contact_001",
    status: "accepted",
  };
}

function createContactPool(): PlatformContactIntakePool & { queries: string[] } {
  const queries: string[] = [];
  const client = {
    async query<T>(text: string): Promise<{ rows: T[] }> {
      queries.push(text.trim());
      if (text.includes("INSERT INTO platform.domain_events")) {
        return { rows: [{ eventId: "00000000-0000-0000-0000-000000000001" } as T] };
      }
      if (text.includes("INSERT INTO platform.jobs")) {
        return { rows: [{ jobId: "00000000-0000-0000-0000-000000000002" } as T] };
      }
      return { rows: [] };
    },
    release() {
      queries.push("release");
    },
  };

  return {
    queries,
    async connect() {
      return client as never;
    },
    async query<T>(): Promise<{ rows: T[] }> {
      throw new Error("Expected transaction client query");
    },
    async end() {
      queries.push("end");
    },
  };
}
