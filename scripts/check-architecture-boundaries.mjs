#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();

const checks = [
  {
    name: "Booking routes must not depend on PMS or channel-manager internals",
    roots: ["apps/api/src/routes"],
    include: (filePath) =>
      /(^|[/\\])booking[^/\\]*\.tsx?$/.test(filePath) ||
      filePath.includes(`${path.sep}booking${path.sep}`),
    forbidden: [
      {
        pattern: /\bPMS_DATABASE_URL\b/,
        message: "use a Booking read model/interface instead of PMS_DATABASE_URL",
      },
      {
        pattern: /\bchannex\b/i,
        message: "keep Channex behind PMS connectivity contracts",
      },
      {
        pattern:
          /\b(?:from|import)\s*(?:[^"']*?\sfrom\s*)?["'][^"']*(?:domain-pms|pms-api|[/\\]pms(?:[/\\]|$))[^"']*["']/i,
        message: "depend on a PMS boundary interface, not a PMS implementation module",
      },
      {
        pattern:
          /\bimport\(\s*["'][^"']*(?:domain-pms|pms-api|[/\\]pms(?:[/\\]|$)|channex)[^"']*["']\s*\)/i,
        message: "depend on a PMS boundary interface, not a dynamic PMS/Channex import",
      },
    ],
  },
];

const violations = [];

for (const check of checks) {
  for (const root of check.roots) {
    const absoluteRoot = path.join(repoRoot, root);
    if (!existsSync(absoluteRoot)) {
      continue;
    }

    for (const filePath of walkFiles(absoluteRoot)) {
      const relativePath = path.relative(repoRoot, filePath);
      if (!check.include(relativePath)) {
        continue;
      }

      const source = stripComments(readFileSync(filePath, "utf8"));
      const lines = source.split(/\r?\n/);
      for (const rule of check.forbidden) {
        lines.forEach((line, index) => {
          if (rule.pattern.test(line)) {
            violations.push({
              check: check.name,
              file: relativePath,
              line: index + 1,
              message: rule.message,
            });
          }
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Architecture boundary check failed:\n");
  for (const violation of violations) {
    console.error(
      `- ${violation.file}:${violation.line} ${violation.message} (${violation.check})`,
    );
  }
  console.error("\nSee engineering/booking-pms-domain-boundaries.md.");
  process.exit(1);
}

console.log("Architecture boundary check passed.");

function* walkFiles(directory) {
  for (const entry of readdirSync(directory)) {
    const fullPath = path.join(directory, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      yield* walkFiles(fullPath);
    } else if (/\.[cm]?[jt]sx?$/.test(entry)) {
      yield fullPath;
    }
  }
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => "\n".repeat(match.split(/\r?\n/).length - 1))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}
