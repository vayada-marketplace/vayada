#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function verifyImage(details, digest, source) {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest) || !/^[0-9a-f]{40}$/.test(source)) {
    throw new Error("Invalid immutable image identity");
  }
  const images = details.imageDetails ?? [];
  const tags = images[0]?.imageTags ?? [];
  if (
    images.length !== 1 ||
    images[0].imageDigest !== digest ||
    ![`next-${source}`, `next-prepare-${source}`].some((tag) => tags.includes(tag))
  ) {
    throw new Error("ECR digest does not carry the exact source tag");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [repository, digest, source] = process.argv.slice(2);
  const details = JSON.parse(
    execFileSync(
      "aws",
      [
        "ecr",
        "describe-images",
        "--repository-name",
        repository,
        "--image-ids",
        `imageDigest=${digest}`,
        "--output",
        "json",
      ],
      { encoding: "utf8" },
    ),
  );
  verifyImage(details, digest, source);
}
