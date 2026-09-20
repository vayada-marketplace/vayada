import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readChannexAriResponse, sanitizeChannexAriResponse } from "./channexAriReceipt.js";

describe("Channex ARI response evidence", () => {
  const task = randomUUID();
  const valid = { data: [{ type: "task", id: task }], meta: { warnings: [] } };
  const read = (body: unknown, status = 200) =>
    sanitizeChannexAriResponse({
      httpStatus: status,
      providerRequestId: "request:1",
      body: JSON.stringify(body),
    });
  it("retains only bounded task IDs and response metadata without declaring completion", () => {
    expect(
      read({ ...valid, secret: "not retained", data: [{ ...valid.data[0], token: "hidden" }] }),
    ).toEqual({
      outcome: "complete_json",
      httpStatus: 200,
      providerRequestId: "request:1",
      taskIds: [task],
      hasWarnings: false,
      warningReason: null,
    });
    expect(read(valid, 500)).toMatchObject({ httpStatus: 500, taskIds: [task] });
    expect(
      sanitizeChannexAriResponse({
        httpStatus: 200,
        body: "{}",
        providerRequestId: "secret with spaces",
      }).providerRequestId,
    ).toBeNull();
  });
  it("accepts the retained provider Success envelope with omitted warnings", () => {
    expect(read({ data: valid.data, meta: { message: "Success" } })).toMatchObject({
      taskIds: [task],
      hasWarnings: false,
      warningReason: null,
    });
  });
  it.each([
    {},
    { message: "success" },
    { message: "Success", warnings: null },
    { message: "Success", warnings: {} },
    { message: "Success", warnings: "" },
    { message: "Success", warnings: ["rejected"] },
  ])("does not infer clean acceptance from ambiguous metadata", (meta) => {
    expect(read({ data: valid.data, meta }).hasWarnings).toBe(true);
  });
  it.each([
    [null, "invalid_tasks"],
    [{ ...valid, data: [], errors: "secret" }, "invalid_tasks"],
    [{ ...valid, errors: "secret", warnings: [] }, "root_errors"],
    [{ ...valid, warnings: "secret", meta: null }, "root_warnings"],
    [{ ...valid, meta: null }, "invalid_meta"],
    [{ ...valid, meta: {} }, "invalid_warnings"],
    [{ ...valid, meta: { warnings: "secret" } }, "invalid_warnings"],
    [
      { ...valid, meta: { warnings: [{ warning: "secret", token: "secret" }] } },
      "provider_warnings",
    ],
  ])("classifies the first blocker without retaining provider content", (body, reason) => {
    const result = read(body);
    expect(result).toMatchObject({ hasWarnings: true, warningReason: reason });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("keeps non-JSON body failures separate from warning classification", async () => {
    expect(sanitizeChannexAriResponse({ httpStatus: 200, body: "{" })).toMatchObject({
      outcome: "invalid_json",
      hasWarnings: true,
      warningReason: null,
    });
    expect(await readChannexAriResponse(new Response(Uint8Array.of(255)))).toMatchObject({
      outcome: "body_interrupted",
      hasWarnings: true,
      warningReason: null,
    });
  });
  it.each([
    {},
    null,
    { data: [] },
    { ...valid, meta: null },
    { ...valid, meta: {} },
    { ...valid, errors: null },
    { ...valid, warnings: [] },
    { ...valid, meta: { warnings: ["secret rejection text"] } },
    { ...valid, meta: { warnings: "malformed" } },
  ])("retains warnings or ambiguous envelopes conservatively", (body) => {
    expect(read(body).hasWarnings).toBe(true);
    expect(JSON.stringify(read(body))).not.toContain("secret rejection text");
  });
  it.each(
    [
      [{ type: "task", id: "malformed" }],
      [valid.data[0], valid.data[0]],
      [valid.data[0], { type: "rate_plan", id: randomUUID() }],
      Array.from({ length: 101 }, () => ({ type: "task", id: randomUUID() })),
    ].map((data) => ({ data })),
  )("never retains partial, duplicate or oversized task lists", ({ data }) => {
    expect(read({ ...valid, data })).toMatchObject({ taskIds: [], hasWarnings: true });
  });
  it("bounds malformed and oversized bodies", () => {
    for (const [body, outcome] of [
      ["{", "invalid_json"],
      ["x".repeat(65537), "body_limit"],
    ])
      expect(sanitizeChannexAriResponse({ httpStatus: 200, body })).toMatchObject({
        outcome,
        taskIds: [],
        hasWarnings: true,
      });
  });
  it("reads split UTF-8 streams and rejects interrupted, oversized and reused responses", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ ...valid, ignored: "é" }));
    const response = new Response(
      new ReadableStream({
        start(c) {
          for (const byte of bytes) c.enqueue(Uint8Array.of(byte));
          c.close();
        },
      }),
    );
    expect(await readChannexAriResponse(response)).toMatchObject({
      taskIds: [task],
      hasWarnings: false,
    });
    expect(await readChannexAriResponse(response)).toMatchObject({
      outcome: "body_interrupted",
      taskIds: [],
    });
    expect(await readChannexAriResponse(new Response(Uint8Array.of(255)))).toMatchObject({
      outcome: "body_interrupted",
      taskIds: [],
      hasWarnings: true,
    });
    expect(await readChannexAriResponse(new Response("x".repeat(65537)))).toMatchObject({
      outcome: "body_limit",
      taskIds: [],
    });
  });
});
