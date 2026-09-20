import assert from "node:assert/strict";
import test from "node:test";
import { verifyImage } from "./verify-image.mjs";

test("normal and preparation source tags bind the exact immutable digest", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const source = "1".repeat(40);
  const details = (tag) => ({ imageDetails: [{ imageDigest: digest, imageTags: [tag] }] });
  for (const tag of [`next-${source}`, `next-prepare-${source}`]) {
    verifyImage(details(tag), digest, source);
    assert.throws(() => verifyImage(details(tag), `sha256:${"b".repeat(64)}`, source));
  }
  for (const tag of ["next-latest", `next-prepare-${"2".repeat(40)}`]) {
    assert.throws(() => verifyImage(details(tag), digest, source));
  }
  assert.throws(() => verifyImage({ imageDetails: [] }, digest, source));
});
