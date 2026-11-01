import { z } from "zod";
import {
  createKmsDestinationCodec,
  type KmsDestinationCodecConfig,
} from "./financeBankTransferCodec.js";

const required = (max: number) => z.string().trim().min(1).max(max);
const optional = (max: number) => z.string().trim().max(max);

/** The hotel's bank account that vayada Payment pays out to (VAY-2442). Codes are optional:
 * Indonesian transfers need a bank code, Sri Lankan ones a branch code, SWIFT ones a BIC. */
export const payoutDestinationDetailsSchema = z.strictObject({
  accountHolder: required(200),
  accountNumber: required(64)
    .regex(/^[A-Za-z0-9 -]+$/)
    .refine((value) => value.replace(/[ -]/g, "").length >= 6),
  bankName: required(200),
  bankCode: optional(32),
  branchCode: optional(32),
  bicSwift: optional(32),
  holderAddress: optional(500),
});
export type PayoutDestinationDetails = z.infer<typeof payoutDestinationDetailsSchema>;

/** Same KMS key as guests' bank-transfer destinations, under its own purpose: one can never
 * decrypt as the other. */
export function createPayoutDestinationCodec(config: KmsDestinationCodecConfig) {
  return createKmsDestinationCodec(config, {
    purpose: "finance-payout-destination-v1",
    schema: payoutDestinationDetailsSchema,
    unavailableMessage: "Payout destination unavailable.",
  });
}
