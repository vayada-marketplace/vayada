import { describe, expect, it, vi } from "vitest";

import { newPublishProgress, publishFirstPricing } from "./publishFirstPricing";

const roomTypeId = "33333333-3333-4333-8333-333333333333";
const otherRoomId = "44444444-4444-4444-8444-444444444444";

describe("publishFirstPricing", () => {
  it("publishes new rooms on top of the active publication in the editor's order", async () => {
    const { client, calls } = fakeClient();
    const current = { currency: "EUR", revision: 2, rooms: [room(otherRoomId, "kept", 3)] };
    await publishFirstPricing(client as never, current as never, [added()], newPublishProgress());

    expect(calls).toEqual([
      "terms",
      "prepare",
      "saveDraft",
      "review",
      "confirm",
      "saveDraft",
      "publish",
    ]);
    const [input, draft] = client.prepare.mock.calls[0]!;
    expect(draft).toEqual({ draftId: expect.any(String), baseRevision: 2 });
    // Existing rooms are kept; every room moves to the next revision; the staged terms are bound.
    expect(input).toEqual({
      currency: "EUR",
      rooms: [
        expect.objectContaining({ roomTypeId: otherRoomId, revision: 3 }),
        expect.objectContaining({
          roomTypeId,
          revision: 3,
          offers: [expect.objectContaining({ id: "flex", termsRevision: "terms-1" })],
        }),
      ],
    });
    expect(client.saveDraft.mock.calls[1]![0]).toMatchObject({
      expectedDraftRevision: 1,
      snapshot: { ownerReferences: { finance: "finance", charges: "charges-1" } },
    });
    // Publishing is the declaration, recorded as made by the save/publish button.
    expect(client.confirmationAction).toHaveBeenCalledWith(expect.anything(), "save_prices");
    expect(client.publicationAction.mock.calls[0]![0]).toMatchObject({
      revision: 2,
      baseRevision: 2,
      stale: false,
    });
  });

  it("republishes a stale publication with no new rooms", async () => {
    const { client, calls } = fakeClient();
    const current = {
      currency: "EUR",
      revision: 2,
      rooms: [room(otherRoomId, "kept", 2)],
      stale: true,
    };
    await publishFirstPricing(client as never, current as never, [], newPublishProgress());

    // No terms to stage: the published rooms are prepared again at the next revision.
    expect(calls).toEqual(["prepare", "saveDraft", "review", "confirm", "saveDraft", "publish"]);
    expect(client.prepare.mock.calls[0]![0]).toEqual({
      currency: "EUR",
      rooms: [
        expect.objectContaining({
          roomTypeId: otherRoomId,
          revision: 3,
          offers: [expect.objectContaining({ termsRevision: "kept" })],
        }),
      ],
    });
  });

  it("resumes after a lost response without repeating finished stages", async () => {
    const { client, calls } = fakeClient();
    client.confirm.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const progress = newPublishProgress();
    await expect(publishFirstPricing(client as never, null, [added()], progress)).rejects.toThrow(
      "Failed to fetch",
    );
    await publishFirstPricing(client as never, null, [added()], progress);

    expect(calls).toEqual([
      "terms",
      "prepare",
      "saveDraft",
      "review",
      "confirm",
      "saveDraft",
      "publish",
    ]);
    // The same confirmation action (one idempotency key) is retried.
    expect(client.confirmationAction).toHaveBeenCalledOnce();
    expect(client.confirm).toHaveBeenCalledTimes(2);
    expect(client.prepare.mock.calls[0]![1]).toMatchObject({ baseRevision: 0 });
  });

  it("keeps a draft save whose response was lost", async () => {
    const { client, calls } = fakeClient();
    client.saveDraft.mockImplementationOnce(async () => {
      calls.push("saveDraft");
      throw new TypeError("Failed to fetch");
    });
    client.readDraft.mockResolvedValueOnce({ revision: 1 });
    const progress = newPublishProgress();
    await expect(publishFirstPricing(client as never, null, [added()], progress)).rejects.toThrow(
      "Failed to fetch",
    );
    await publishFirstPricing(client as never, null, [added()], progress);
    // The landed revision 1 is read back instead of saving revision 0 again (a 409).
    expect(calls).toEqual([
      "terms",
      "prepare",
      "saveDraft",
      "review",
      "confirm",
      "saveDraft",
      "publish",
    ]);
    expect(client.readDraft).toHaveBeenCalledOnce();
  });

  it("does not declare charges for a draft that changed after this attempt saved it", async () => {
    const { client } = fakeClient();
    client.reviewCharges.mockImplementationOnce(async (draftId: string) => ({
      draftId,
      revision: 2,
      baseRevision: 2,
      sources: { room: "r", terms: "t", finance: "f" },
      snapshot: { currency: "EUR", rooms: [], ownerReferences: { finance: "finance" } },
      stale: false,
      fingerprint: "f",
      declaration: "all_mandatory_charges_included",
    }));
    await expect(
      publishFirstPricing(client as never, null, [added()], newPublishProgress()),
    ).rejects.toMatchObject({ status: 409 });
    expect(client.confirmationAction).not.toHaveBeenCalled();
  });

  it("does not declare charges when the reviewed snapshot differs from the saved one", async () => {
    const { client } = fakeClient();
    client.reviewCharges.mockImplementationOnce(async (draftId: string) => ({
      draftId,
      revision: 1,
      baseRevision: 0,
      sources: { room: "r", terms: "t", finance: "f" },
      snapshot: { currency: "CHF", rooms: [], ownerReferences: { finance: "finance" } },
      stale: false,
      fingerprint: "f",
      declaration: "all_mandatory_charges_included",
    }));
    await expect(
      publishFirstPricing(client as never, null, [added()], newPublishProgress()),
    ).rejects.toMatchObject({ status: 409 });
    expect(client.confirmationAction).not.toHaveBeenCalled();
  });

  it("refuses rooms priced in different currencies", async () => {
    const { client } = fakeClient();
    const current = { currency: "CHF", revision: 1, rooms: [] };
    await expect(
      publishFirstPricing(client as never, current as never, [added()], newPublishProgress()),
    ).rejects.toThrow("hotel currency");
    expect(client.termsAction).not.toHaveBeenCalled();
  });
});

function room(id: string, termsRevision: string, revision: number) {
  return { roomTypeId: id, currency: "EUR", revision, offers: [{ id: "flex", termsRevision }] };
}

function added() {
  return {
    configuration: room(roomTypeId, "flex", 1),
    terms: { roomTypeId, offerId: "flex", expectedRevision: null },
  } as never;
}

function fakeClient() {
  const calls: string[] = [];
  const confirm = vi.fn(async () => {
    calls.push("confirm");
    return { id: "charges-1" };
  });
  const snapshot = { currency: "EUR", rooms: [], ownerReferences: { finance: "finance" } };
  const client = {
    confirm,
    termsAction: vi.fn(() => async () => {
      calls.push("terms");
      return { revision: "terms-1" };
    }),
    prepare: vi.fn(async (..._args: unknown[]) => {
      calls.push("prepare");
      return { sources: { room: "r", terms: "t", finance: "f" }, snapshot };
    }),
    saveDraft: vi.fn(async (input: { expectedDraftRevision: number }) => {
      calls.push("saveDraft");
      return input.expectedDraftRevision + 1;
    }),
    reviewCharges: vi.fn(async (draftId: string) => {
      calls.push("review");
      return {
        draftId,
        revision: 1,
        baseRevision: 2,
        sources: { room: "r", terms: "t", finance: "f" },
        snapshot,
        stale: false,
        fingerprint: "f",
        declaration: "all_mandatory_charges_included",
      };
    }),
    confirmationAction: vi.fn(() => confirm),
    readDraft: vi.fn(async (_draftId: string): Promise<{ revision: number } | null> => null),
    publicationAction: vi.fn((..._args: unknown[]) => async () => {
      calls.push("publish");
      return { revision: 3, replayed: false };
    }),
  };
  return { client, calls };
}
