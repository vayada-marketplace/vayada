import { CreateInvalidationCommand, type CloudFrontClient } from "@aws-sdk/client-cloudfront";
import { describe, expect, it, vi } from "vitest";

import {
  createCloudFrontMediaInvalidator,
  MAX_MEDIA_INVALIDATION_PATHS,
  publicMediaCdnPath,
} from "./platformMediaCdnInvalidation.js";

const distributionId = "E2EXAMPLE12345";

function fakeCloudFront(response: unknown = { Invalidation: { Id: "I2EXAMPLE" } }) {
  const send = vi.fn(async (_command: unknown) => response);
  return { client: { send } as unknown as Pick<CloudFrontClient, "send">, send };
}

function sentInput(send: ReturnType<typeof fakeCloudFront>["send"], call = 0) {
  const command = send.mock.calls[call]![0];
  expect(command).toBeInstanceOf(CreateInvalidationCommand);
  return (command as CreateInvalidationCommand).input;
}

describe("public media CDN invalidation", () => {
  it("maps a public storage key to the path the CDN serves", () => {
    expect(publicMediaCdnPath("public/media/abc123/original_safe/v1.webp")).toBe(
      "/media/abc123/original_safe/v1.webp",
    );
  });

  it.each([
    "private/media/abc123/original/sha256-x.pdf",
    "staging/session/file.jpg",
    "public/",
    "public/media//v1.webp",
    "public/media/../private/v1.webp",
    "public/media/a b/v1.webp",
  ])("refuses %s", (storageKey) => {
    expect(() => publicMediaCdnPath(storageKey)).toThrow();
  });

  it("invalidates the sorted, deduplicated paths of one batch", async () => {
    const { client, send } = fakeCloudFront();
    const invalidator = createCloudFrontMediaInvalidator({ distributionId, client });

    await expect(
      invalidator.invalidatePublicObjects([
        "public/media/b/original_safe/v1.webp",
        "public/media/a/thumbnail/v1.webp",
        "public/media/b/original_safe/v1.webp",
      ]),
    ).resolves.toEqual({ invalidationId: "I2EXAMPLE" });

    expect(send).toHaveBeenCalledTimes(1);
    expect(sentInput(send)).toEqual({
      DistributionId: distributionId,
      InvalidationBatch: {
        CallerReference: expect.stringMatching(/^vayada-media-[0-9a-f]{64}$/),
        Paths: {
          Quantity: 2,
          Items: ["/media/a/thumbnail/v1.webp", "/media/b/original_safe/v1.webp"],
        },
      },
    });
  });

  it("reuses the caller reference for a retried batch and changes it for another", async () => {
    const { client, send } = fakeCloudFront();
    const invalidator = createCloudFrontMediaInvalidator({ distributionId, client });

    await invalidator.invalidatePublicObjects(["public/media/a/v1.webp", "public/media/b/v1.webp"]);
    await invalidator.invalidatePublicObjects(["public/media/b/v1.webp", "public/media/a/v1.webp"]);
    await invalidator.invalidatePublicObjects(["public/media/a/v1.webp"]);

    const references = [0, 1, 2].map(
      (call) => sentInput(send, call).InvalidationBatch!.CallerReference,
    );
    expect(references[1]).toBe(references[0]);
    expect(references[2]).not.toBe(references[0]);
  });

  it("refuses empty, oversized and non-public batches before calling CloudFront", async () => {
    const { client, send } = fakeCloudFront();
    const invalidator = createCloudFrontMediaInvalidator({ distributionId, client });
    const tooMany = Array.from(
      { length: MAX_MEDIA_INVALIDATION_PATHS + 1 },
      (_, index) => `public/media/m${index}/v1.webp`,
    );

    await expect(invalidator.invalidatePublicObjects([])).rejects.toThrow("No public media paths");
    await expect(invalidator.invalidatePublicObjects(tooMany)).rejects.toThrow("At most 1000");
    await expect(
      invalidator.invalidatePublicObjects(["public/media/a/v1.webp", "private/media/a/v1.webp"]),
    ).rejects.toThrow("Only public media");
    expect(send).not.toHaveBeenCalled();
  });

  it("accepts exactly the maximum batch", async () => {
    const { client, send } = fakeCloudFront();
    const invalidator = createCloudFrontMediaInvalidator({ distributionId, client });
    const keys = Array.from(
      { length: MAX_MEDIA_INVALIDATION_PATHS },
      (_, index) => `public/media/m${index}/v1.webp`,
    );

    await invalidator.invalidatePublicObjects(keys);

    expect(sentInput(send).InvalidationBatch!.Paths!.Quantity).toBe(MAX_MEDIA_INVALIDATION_PATHS);
  });

  it("fails when CloudFront returns no invalidation ID", async () => {
    const { client } = fakeCloudFront({});
    const invalidator = createCloudFrontMediaInvalidator({ distributionId, client });

    await expect(invalidator.invalidatePublicObjects(["public/media/a/v1.webp"])).rejects.toThrow(
      "no invalidation ID",
    );
  });

  it("leaves an injected client open on close", () => {
    const { client } = fakeCloudFront();
    const invalidator = createCloudFrontMediaInvalidator({ distributionId, client });

    expect(() => invalidator.close()).not.toThrow();
  });

  it.each(["", "e2example12345", "D2EXAMPLE12345", "E2EXAMPLE-12345", "arn:aws:cloudfront::1:x"])(
    "refuses the distribution ID %j",
    (id) => {
      expect(() => createCloudFrontMediaInvalidator({ distributionId: id })).toThrow(
        "not a CloudFront distribution ID",
      );
    },
  );
});
