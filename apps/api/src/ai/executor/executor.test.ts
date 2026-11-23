// What a route's answer means for an AI change (VAY-2524).
import { describe, expect, it } from "vitest";

import { threadMarkDone } from "../actions/threadTriage.js";
import { classifyChangeAnswer } from "./executor.js";

const first = { mayHaveSent: false };
const takeOver = { mayHaveSent: true };
const done = {
  propertyId: "p",
  threadId: "t",
  attentionState: "done",
  followUpAt: null,
  threadVersion: 5,
};

describe("classifyChangeAnswer (VAY-2524)", () => {
  it("ends a run done with only the allow-listed answer", () => {
    expect(classifyChangeAnswer(threadMarkDone, 200, { ...done, guestName: "x" }, first)).toEqual({
      kind: "done",
      result: done,
      logOutcome: "ok",
    });
    expect(classifyChangeAnswer(threadMarkDone, 200, { other: 1 }, takeOver)).toEqual({
      kind: "done",
      result: null,
      logOutcome: "ok",
    });
  });

  it.each([
    [403, "forbidden", "denied"],
    [400, "validation_failed", "invalid"],
    [404, "thread_not_found", "refused"],
    [409, "thread_version_conflict", "refused"],
  ])("fails a first request the route refused (%s %s)", (status, code, logOutcome) => {
    expect(classifyChangeAnswer(threadMarkDone, status, { code }, first)).toEqual({
      kind: "refused",
      errorCode: code,
      logOutcome,
    });
  });

  it.each([
    [500, "read_model_unavailable"],
    [503, "unavailable"],
    [429, "rate_limited"],
    [409, "busy_try_again"],
    [409, "command_in_progress"],
    [409, "idempotency_conflict"],
    [409, "idempotency_key_conflict"],
  ])("leaves a run running when the route says try again (%s %s)", (status, code) => {
    expect(classifyChangeAnswer(threadMarkDone, status, { code }, first)).toMatchObject({
      kind: "unknown",
      errorCode: code,
    });
  });

  it("never fails a run whose earlier request may have gone out", () => {
    expect(
      classifyChangeAnswer(threadMarkDone, 409, { code: "thread_version_conflict" }, takeOver),
    ).toMatchObject({ kind: "unknown" });
    expect(classifyChangeAnswer(threadMarkDone, 403, {}, takeOver)).toMatchObject({
      kind: "unknown",
      errorCode: "http_403",
    });
  });

  it("keeps only a well-formed code", () => {
    expect(classifyChangeAnswer(threadMarkDone, 404, { code: "Not Found!" }, first)).toMatchObject({
      errorCode: "http_404",
    });
  });
});
