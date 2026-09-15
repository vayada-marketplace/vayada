import { parseLegacyOwnerSetupCommand } from "./legacyOwnerSetupCommand.js";
import { verifyLegacyOwnerSetupSignature } from "./legacyOwnerSetupSignature.js";

/** Pure protected request check. Does not authenticate evidence artifacts,
 * read approvals or grant authority. Never log the returned contact fields. */
export function verifyLegacyOwnerSetupRequest(
  input: {
    commandPayload: string;
    envelopePayload: string;
    detachedSignature: string;
    verificationKeys: Parameters<typeof verifyLegacyOwnerSetupSignature>[0]["verificationKeys"];
  },
  expected: Parameters<typeof parseLegacyOwnerSetupCommand>[1],
  now: Date,
) {
  try {
    const parsed = parseLegacyOwnerSetupCommand(input.commandPayload, expected, now);
    const { envelope } = verifyLegacyOwnerSetupSignature({
      canonicalPayload: input.envelopePayload,
      detachedSignature: input.detachedSignature,
      verificationKeys: input.verificationKeys,
      expectedCommandSha256: parsed.commandSha256,
      environment: expected.environment,
      now,
    });
    for (const field of ["commandId", "environment", "issuedAt", "expiresAt"] as const)
      if (envelope[field] !== parsed.command[field]) throw new Error();
    return {
      outcome: "signed_command_matches_requires_current_evidence" as const,
      executable: false as const,
      command: parsed.command,
      commandSha256: parsed.commandSha256,
      envelope,
    };
  } catch {
    throw new Error("LEGACY_OWNER_SETUP_REQUEST_INVALID");
  }
}
