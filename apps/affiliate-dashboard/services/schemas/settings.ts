import { z } from "zod";

export const PAYOUT_PROVIDERS = ["stripe", "bank_transfer", "manual"] as const;
export const PAYOUT_SCHEDULES = ["monthly", "manual", "threshold"] as const;

export type PayoutProvider = (typeof PAYOUT_PROVIDERS)[number];
export type PayoutSchedule = (typeof PAYOUT_SCHEDULES)[number];

export const settingsSchema = z
  .object({
    payoutProvider: z.enum(PAYOUT_PROVIDERS),
    payoutCurrency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, {
        message: "Use a 3-letter currency code",
      }),
    payoutSchedule: z.enum(PAYOUT_SCHEDULES),
    payoutThresholdAmount: z.string(),
  })
  .superRefine((data, ctx) => {
    const threshold = data.payoutThresholdAmount.trim();
    if (data.payoutSchedule !== "threshold") return;
    if (!threshold) {
      ctx.addIssue({
        path: ["payoutThresholdAmount"],
        code: "custom",
        message: "Threshold amount is required",
      });
    } else if (!/^\d+(\.\d{1,2})?$/.test(threshold)) {
      ctx.addIssue({
        path: ["payoutThresholdAmount"],
        code: "custom",
        message: "Enter a valid amount",
      });
    }
  });

export type SettingsFormValues = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: SettingsFormValues = {
  payoutProvider: "stripe",
  payoutCurrency: "EUR",
  payoutSchedule: "monthly",
  payoutThresholdAmount: "",
};
