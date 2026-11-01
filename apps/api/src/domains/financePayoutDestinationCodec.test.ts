import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createBankTransferCodec,
  type KmsDestinationCodecConfig,
} from "./financeBankTransferCodec.js";
import { createPayoutDestinationCodec } from "./financePayoutDestinationCodec.js";

const keyArn = "arn:aws:kms:eu-west-1:123456789012:key/12345678-abcd";
const scope = {
  propertyId: "11111111-1111-4111-8111-111111111111",
  id: "22222222-2222-4222-8222-222222222222",
  revision: 1,
};
const details = {
  accountHolder: "PT Private Holder",
  accountNumber: "0123456789",
  bankName: "Private Bank Indonesia",
  bankCode: "014",
  branchCode: "",
  bicSwift: "CENAIDJA",
  holderAddress: "Jl. Private 1, Ubud",
};

/** A local stand-in for KMS: AES-GCM with the encryption context as authenticated data. */
function kms(): KmsDestinationCodecConfig {
  const key = randomBytes(32);
  return {
    currentKeyArn: keyArn,
    allowedKeyArns: [keyArn],
    kms: {
      async encrypt(input) {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        cipher.setAAD(Buffer.from(JSON.stringify(input.EncryptionContext)));
        const encrypted = Buffer.concat([cipher.update(input.Plaintext), cipher.final()]);
        return {
          KeyId: input.KeyId,
          CiphertextBlob: Buffer.concat([iv, cipher.getAuthTag(), encrypted]),
        };
      },
      async decrypt(input) {
        const bytes = Buffer.from(input.CiphertextBlob);
        const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
        cipher.setAuthTag(bytes.subarray(12, 28));
        cipher.setAAD(Buffer.from(JSON.stringify(input.EncryptionContext)));
        return {
          KeyId: input.KeyId,
          Plaintext: Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]),
        };
      },
    },
  };
}

describe("payout destination encryption (VAY-2442)", () => {
  it("round-trips under its own purpose and keeps only the last four digits beside the ciphertext", async () => {
    const config = kms();
    const subject = createPayoutDestinationCodec(config);
    const encrypted = await subject.encrypt(scope, details);
    expect(encrypted.accountLast4).toBe("6789");
    for (const secret of Object.values(details).filter(Boolean))
      expect(JSON.stringify(encrypted)).not.toContain(secret);
    expect(await subject.decrypt(scope, encrypted)).toEqual(details);
    // The bank-transfer codec shares the key but not the purpose: it can't read a payout account.
    await expect(createBankTransferCodec(config).decrypt(scope, encrypted)).rejects.toThrow(
      /^Bank transfer destination unavailable\.$/,
    );
    await expect(subject.decrypt({ ...scope, revision: 2 }, encrypted)).rejects.toThrow(
      /^Payout destination unavailable\.$/,
    );
  });

  it("refuses invalid details without echoing them", async () => {
    const subject = createPayoutDestinationCodec(kms());
    for (const invalid of [
      { ...details, accountNumber: "12345" },
      { ...details, accountNumber: "0123456789;" },
      { ...details, accountHolder: " " },
      { ...details, bankName: "" },
      { ...details, iban: "secret" },
    ]) {
      await expect(subject.encrypt(scope, invalid)).rejects.toThrow(
        /^Payout destination unavailable\.$/,
      );
    }
  });
});
