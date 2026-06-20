#!/usr/bin/env node
import { runBookingPublicBookabilityBackfill } from "../bookingPublicBookabilityBackfill.js";

function parseArgs(argv: string[]): {
  connectionString: string;
  slug: string;
  apply: boolean;
  confirm: string | null;
  days?: number;
} {
  const args = argv.slice(2);
  let connectionString = process.env["TARGET_DATABASE_URL"] ?? "";
  let slug = "";
  let apply = false;
  let confirm: string | null = null;
  let days: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--connection-string" && args[i + 1]) connectionString = args[++i]!;
    else if (args[i] === "--slug" && args[i + 1]) slug = args[++i]!;
    else if (args[i] === "--days" && args[i + 1]) days = Number(args[++i]);
    else if (args[i] === "--apply") apply = true;
    else if (args[i] === "--confirm" && args[i + 1]) confirm = args[++i]!;
  }

  return { connectionString, slug, apply, confirm, days };
}

const args = parseArgs(process.argv);
const normalizedSlug = args.slug.trim().toLowerCase();

if (!args.connectionString) {
  console.error("Error: TARGET_DATABASE_URL or --connection-string is required.");
  process.exit(1);
}
if (!normalizedSlug) {
  console.error("Error: --slug is required.");
  process.exit(1);
}
if (args.apply && args.confirm !== `booking-public-bookability:${normalizedSlug}`) {
  console.error(`Error: apply requires --confirm booking-public-bookability:${normalizedSlug}`);
  process.exit(1);
}

const result = await runBookingPublicBookabilityBackfill({
  connectionString: args.connectionString,
  slug: normalizedSlug,
  apply: args.apply,
  days: args.days,
});

console.log(JSON.stringify(result, null, 2));
if (!args.apply) {
  console.log("Dry run only. Re-run with --apply and the printed confirmation guard to write.");
}
