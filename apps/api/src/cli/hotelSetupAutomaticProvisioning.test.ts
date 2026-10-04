import { afterEach, expect, it, vi } from "vitest";
import {
  parseHotelSetupAutomaticConfiguration,
  parseHotelSetupHelperOwnerConfiguration,
  runHotelSetupAutomaticProvisioning,
} from "./hotelSetupAutomaticProvisioning.js";
import * as reconciliation from "../hotelSetupAutomaticReconciliation.js";

afterEach(() => vi.restoreAllMocks());
const env = {
  HOTEL_SETUP_AUTOMATIC_MODE: "organization",
  HOTEL_SETUP_AUTOMATIC_ADMIN_DATABASE_URL: `postgresql://vayada_admin:${"x".repeat(36)}@vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com:5432/postgres?sslmode=require`,
  NODE_EXTRA_CA_CERTS: "/runtime/rds-ca.pem",
};

it("normalizes only the exact reviewed SSM endpoint into verified TLS and the target database", () => {
  const result = parseHotelSetupAutomaticConfiguration(env);
  expect(result.mode).toBe("organization");
  const url = new URL(result.adminDatabaseUrl);
  expect(url.pathname).toBe("/vayada_target_prod");
  expect(url.search).toBe("?sslmode=verify-full");
  expect(new URL(result.databaseEndpoint).password).toBe("");
  expect(
    parseHotelSetupAutomaticConfiguration({ ...env, HOTEL_SETUP_AUTOMATIC_MODE: "property" }).mode,
  ).toBe("property");
});

it("rejects alternate hosts/logins/databases/TLS/CA, missing strong credentials and extra URL options", () => {
  for (const [from, to] of [
    ["vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com", "alternate.invalid"],
    ["vayada_admin", "vayada_next_api"],
    [":5432/", ":5433/"],
    ["/postgres?", "/other?"],
    ["sslmode=require", "sslmode=disable"],
    ["sslmode=require", "sslmode=require&options=unsafe"],
    ["x".repeat(36), "short"],
  ])
    expect(() =>
      parseHotelSetupAutomaticConfiguration({
        ...env,
        HOTEL_SETUP_AUTOMATIC_ADMIN_DATABASE_URL:
          env.HOTEL_SETUP_AUTOMATIC_ADMIN_DATABASE_URL.replace(from!, to!),
      }),
    ).toThrow();
  for (const override of [
    { HOTEL_SETUP_AUTOMATIC_MODE: "currency" },
    { NODE_EXTRA_CA_CERTS: "/arbitrary.pem" },
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
  ])
    expect(() => parseHotelSetupAutomaticConfiguration({ ...env, ...override })).toThrow();
});

it("denies source/alternate roots before discovery or any administrative access and sanitizes errors", async () => {
  const reconcile = vi.spyOn(reconciliation, "reconcileHotelSetupAutomaticScopes");
  const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
  expect(await runHotelSetupAutomaticProvisioning(env)).toBe(1);
  expect(reconcile).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({
      status: "FAIL",
      code: "hotel_setup_automatic_inspection_required",
    }),
  );
});

it("requires a separately injected fixed helper-owner credential with verified TLS", () => {
  const owner = {
    ...env,
    HOTEL_SETUP_HELPER_OWNER_DATABASE_URL: env.HOTEL_SETUP_AUTOMATIC_ADMIN_DATABASE_URL.replace(
      "vayada_admin",
      "vayada_target_prod_user",
    ).replace("/postgres?", "/vayada_target_prod?"),
  };
  const url = new URL(parseHotelSetupHelperOwnerConfiguration(owner));
  expect(url.username).toBe("vayada_target_prod_user");
  expect(url.pathname).toBe("/vayada_target_prod");
  expect(url.search).toBe("?sslmode=verify-full");
  expect(() => parseHotelSetupHelperOwnerConfiguration(env)).toThrow();
  for (const [from, to] of [
    ["vayada_target_prod_user", "vayada_admin"],
    ["rds.amazonaws.com", "alternate.invalid"],
    ["/vayada_target_prod?", "/other?"],
    [":5432/", ":5433/"],
    ["sslmode=require", "sslmode=require&options=unsafe"],
    ["x".repeat(36), "short"],
  ])
    expect(() =>
      parseHotelSetupHelperOwnerConfiguration({
        ...owner,
        HOTEL_SETUP_HELPER_OWNER_DATABASE_URL: owner.HOTEL_SETUP_HELPER_OWNER_DATABASE_URL.replace(
          from!,
          to!,
        ),
      }),
    ).toThrow();
});

it("keeps automatic and fixed manual-child CA contracts separate", () => {
  const manual = {
    ...env,
    NODE_EXTRA_CA_CERTS: "/tmp/hotel-setup-rds.pem",
    HOTEL_SETUP_HELPER_OWNER_DATABASE_URL: env.HOTEL_SETUP_AUTOMATIC_ADMIN_DATABASE_URL.replace(
      "vayada_admin",
      "vayada_target_prod_user",
    ).replace("/postgres?", "/vayada_target_prod?"),
  };
  expect(() => parseHotelSetupHelperOwnerConfiguration(manual)).toThrow();
  expect(() =>
    parseHotelSetupHelperOwnerConfiguration(manual, "/tmp/hotel-setup-rds.pem"),
  ).not.toThrow();
  expect(() =>
    parseHotelSetupHelperOwnerConfiguration(
      { ...manual, NODE_EXTRA_CA_CERTS: "/arbitrary.pem" },
      "/tmp/hotel-setup-rds.pem",
    ),
  ).toThrow();
});
