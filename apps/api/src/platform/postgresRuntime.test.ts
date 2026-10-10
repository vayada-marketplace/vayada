import pg from "pg";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { createAirbnbAlterationRuntime } from "../airbnbAlterationRuntime.js";
import { loadConfig } from "../config.js";
import { createPgFinanceExpenseCategoryRepository } from "../domains/financeExpenseCategoryRepository.js";
import { createPgFinanceManualExpenseRepository } from "../domains/financeManualExpenseRepository.js";
import {
  cachedHealthCheck,
  installPostgresPoolRuntime,
  isPostgresUnavailableError,
} from "./postgresRuntime.js";

describe("PostgreSQL runtime capacity", () => {
  it("keeps the Airbnb decision journal physically separate under server pool sharing", async () => {
    const OriginalPool = pg.Pool;
    const pools = installPostgresPoolRuntime(pg);
    const base = loadConfig({});
    const runtime = createAirbnbAlterationRuntime({
      connectionString: "postgresql://example/target",
      config: {
        ...base,
        airbnbAlterations: { propertyIds: ["10090000-0000-4000-8000-000000000001"] },
        channexManagement: {
          ...base.channexManagement,
          apiBaseUrl: "https://staging.channex.io",
          apiKey: "synthetic",
        },
      },
    })!;
    try {
      expect(pools.snapshot()).toMatchObject({ physicalPoolCount: 2, maxConnections: 9 });
      await runtime.close();
      expect(pools.snapshot().physicalPoolCount).toBe(0);
    } finally {
      await pools.close();
      Object.defineProperty(pg, "Pool", {
        configurable: true,
        writable: true,
        value: OriginalPool,
      });
    }
  });
  it("shares and bounds equivalent pools while preserving client-specific timeouts", async () => {
    const postgres = { Pool: pg.Pool };
    const runtime = installPostgresPoolRuntime(postgres);
    const first = new postgres.Pool({ connectionString: "postgresql://example/target", max: 20 });
    const second = new postgres.Pool({ connectionString: "postgresql://example/target", max: 2 });
    const specialized = new postgres.Pool({
      connectionString: "postgresql://example/target",
      statement_timeout: 5_000,
    });
    const discrete = [() => "first", () => "second"].map(
      (password) =>
        new postgres.Pool({ host: "example", database: "target", user: "vayada", password }),
    );
    const encodings = ["UTF8", "LATIN1"].map(
      (client_encoding) => new postgres.Pool({ host: "example", client_encoding }),
    );
    expect(first).not.toBe(second);
    expect(first.options.max).toBe(8);
    expect(first.options.connectionTimeoutMillis).toBe(3_000);
    expect(specialized.options.max).toBe(1);
    expect(runtime.snapshot()).toMatchObject({ physicalPoolCount: 6, maxConnections: 41 });
    await first.end();
    expect(runtime.snapshot().physicalPoolCount).toBe(6);
    await second.end();
    expect(runtime.snapshot().physicalPoolCount).toBe(5);
    await specialized.end();
    await Promise.all([...discrete, ...encodings].map((pool) => pool.end()));
  });
  it.each([
    Object.assign(new Error("too many connections"), { code: "53300" }),
    Object.assign(new Error("terminating connection due to administrator command"), {
      code: "57P01",
    }),
    new Error("Client has encountered a connection error and is not queryable"),
    new Error("timeout expired"),
    new Error("timeout exceeded when trying to connect"),
    new Error("Connection terminated due to connection timeout"),
  ])("recognizes bounded connection acquisition failures", (error) => {
    expect(isPostgresUnavailableError(error)).toBe(true);
  });
  it("does not misclassify a non-PostgreSQL connection timeout", () => {
    expect(
      isPostgresUnavailableError(
        new Error(
          "the request socket did not establish a connection with the server within the configured timeout",
        ),
      ),
    ).toBe(false);
  });
  it("applies sharing to repositories that imported pg before installation", async () => {
    const OriginalPool = pg.Pool;
    const runtime = installPostgresPoolRuntime(pg);
    const category = createPgFinanceExpenseCategoryRepository("postgresql://example/target");
    const expense = createPgFinanceManualExpenseRepository("postgresql://example/target");
    try {
      expect(runtime.snapshot()).toMatchObject({ physicalPoolCount: 1, maxConnections: 8 });
    } finally {
      await Promise.all([category.close(), expense.close()]);
      Object.defineProperty(pg, "Pool", {
        configurable: true,
        writable: true,
        value: OriginalPool,
      });
    }
  });
  it("removes listeners owned by short-lived leases", async () => {
    const postgres = { Pool: pg.Pool };
    const runtime = installPostgresPoolRuntime(postgres);
    const keeper = new postgres.Pool({ connectionString: "postgresql://example/target" });
    for (let index = 0; index < 12; index += 1) {
      const transient = new postgres.Pool({ connectionString: "postgresql://example/target" });
      transient.on("error", () => undefined);
      await transient.end();
    }
    // Only the runtime's own idle-client listener remains.
    expect(keeper.listenerCount("error")).toBe(1);
    expect(runtime.snapshot()).toMatchObject({ physicalPoolCount: 1, maxConnections: 8 });
    await keeper.end();
  });
  it("survives connection errors on idle and checked-out clients", async () => {
    const postgres = { Pool: pg.Pool };
    const runtime = installPostgresPoolRuntime(postgres);
    const warnings: object[] = [];
    const stopTelemetry = runtime.startTelemetry({
      info: () => undefined,
      warn: (fields) => warnings.push(fields),
    });
    const pool = new postgres.Pool({ connectionString: "postgresql://example/target" });
    const terminated = Object.assign(
      new Error("terminating connection due to administrator command"),
      { code: "57P01" },
    );
    const dropped = new Error("Connection terminated unexpectedly");
    try {
      expect(() => pool.emit("error", terminated)).not.toThrow();
      const client = new pool.options.Client!();
      expect(() => client.emit("error", dropped)).not.toThrow();
      expect(isPostgresUnavailableError(dropped)).toBe(true);
      expect(warnings).toEqual([{ code: null, error: "Connection terminated unexpectedly" }]);
    } finally {
      stopTelemetry();
      await pool.end();
    }
  });
  it("classifies a refused runtime connection as unavailable", async () => {
    const postgres = { Pool: pg.Pool };
    installPostgresPoolRuntime(postgres);
    const pool = new postgres.Pool({ connectionString: "postgresql://vayada@127.0.0.1:1/target" });
    try {
      const error = await pool.query("SELECT 1").then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(error).toMatchObject({ code: "ECONNREFUSED" });
      expect(isPostgresUnavailableError(error)).toBe(true);
      expect(
        isPostgresUnavailableError(Object.assign(new Error("refused"), { code: "ECONNREFUSED" })),
      ).toBe(false);
    } finally {
      await pool.end();
    }
  });
  it("caches the database probe and shares one in-flight check", async () => {
    let time = 0;
    let probes = 0;
    let answer = true;
    const check = cachedHealthCheck(
      async () => {
        probes += 1;
        if (!answer) throw new Error("connect ECONNREFUSED");
      },
      5_000,
      () => time,
    );
    expect(await Promise.all([check(), check()])).toEqual([true, true]);
    expect(probes).toBe(1);
    answer = false;
    time = 4_999;
    expect(await check()).toBe(true);
    time = 5_000;
    expect(await check()).toBe(false);
    answer = true;
    time = 10_000;
    expect(await check()).toBe(true);
    expect(probes).toBe(3);
  });
  it("reports an unreachable database through its own probe connection", async () => {
    const postgres = { Pool: pg.Pool };
    const runtime = installPostgresPoolRuntime(postgres);
    const check = runtime.healthCheck("postgresql://vayada@127.0.0.1:1/target");
    try {
      expect(await check()).toBe(false);
      expect(runtime.snapshot().physicalPoolCount).toBe(0);
    } finally {
      await runtime.close();
    }
  });
  it("keeps permanent connect failures out of the unavailable classification", async () => {
    class RejectingClient extends pg.Client {
      override connect(): Promise<pg.Client>;
      override connect(callback: (error: Error) => void): void;
      override connect(callback?: (error: Error) => void): Promise<pg.Client> | void {
        const failure = Object.assign(new Error("password authentication failed"), {
          code: "28P01",
        });
        if (!callback) return Promise.reject(failure);
        callback(failure);
      }
    }
    const postgres = { Pool: pg.Pool };
    installPostgresPoolRuntime(postgres);
    const pool = new postgres.Pool({
      connectionString: "postgresql://example/target",
      Client: RejectingClient,
    });
    try {
      const error = await pool.query("SELECT 1").then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(error).toMatchObject({ code: "28P01" });
      expect(isPostgresUnavailableError(error)).toBe(false);
    } finally {
      await pool.end();
    }
  });
  it("returns a typed 503 when PostgreSQL cannot acquire a connection", async () => {
    const app = buildApp({ logger: false });
    app.get("/__test/database-unavailable", async () => {
      throw Object.assign(new Error("too many connections"), { code: "53300" });
    });
    const response = await app.inject({ method: "GET", url: "/__test/database-unavailable" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      statusCode: 503,
      error: "Service Unavailable",
      message: "Database is temporarily unavailable",
      code: "database_unavailable",
    });
    await app.close();
  });
});
