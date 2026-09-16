import React from "react";
import { act, create } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { useTeamWrite } from "./useTeamWrite";
import { ApiErrorResponse } from "@/services/api/client";

it("reuses the command key after an uncertain response and creates a new key for changed input", async () => {
  let state!: ReturnType<typeof useTeamWrite>;
  function Probe() {
    state = useTeamWrite();
    return null;
  }
  const view = create(<Probe />);
  const write = vi
    .fn()
    .mockRejectedValueOnce(new Error("Disconnected"))
    .mockResolvedValue(undefined);
  await act(async () => {
    expect(await state.run({ name: "Night" }, write)).toBe(false);
  });
  expect(state.error).toContain("could not be confirmed");
  await act(async () => {
    expect(await state.run({ name: "Night" }, write)).toBe(true);
  });
  expect(write.mock.calls[0]?.[1]).toBe(write.mock.calls[1]?.[1]);
  await act(async () => {
    await state.run({ name: "Day" }, write);
  });
  expect(write.mock.calls[2]?.[1]).not.toBe(write.mock.calls[1]?.[1]);
  view.unmount();
});
it("prevents concurrent submission and shows conflicts without hiding them as success", async () => {
  let state!: ReturnType<typeof useTeamWrite>;
  function Probe() {
    state = useTeamWrite();
    return null;
  }
  const view = create(<Probe />);
  let reject!: (cause: Error) => void;
  const write = vi.fn(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = state.run({}, write);
  });
  await act(async () => {
    expect(await state.run({}, write)).toBe(false);
    reject(new ApiErrorResponse(409, { code: "revision_conflict" }));
    await pending;
  });
  expect(write).toHaveBeenCalledOnce();
  expect(state.error).toContain("changed since");
  expect(state.busy).toBe(false);
  view.unmount();
});
