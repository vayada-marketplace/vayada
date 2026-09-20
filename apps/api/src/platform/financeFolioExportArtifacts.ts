import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { createHash } from "node:crypto";
import {
  FINANCE_EXPENSE_CSV_VERSION,
  FINANCE_FOLIO_CSV_CONTENT_TYPE,
  FINANCE_FOLIO_CSV_VERSION,
  FINANCE_PROFIT_LOSS_CSV_VERSION,
} from "@vayada/domain-finance";

// prettier-ignore
export type FinanceFolioExportArtifact = { bucketName:string; storageKey:string; checksumSha256:string; sizeBytes:number };
export type FinanceFolioExportArtifactWriter = {
  bucketName: string;
  write(input: {
    exportId: string;
    body: string;
    contentType: string;
    formatVersion:
      | typeof FINANCE_FOLIO_CSV_VERSION
      | typeof FINANCE_EXPENSE_CSV_VERSION
      | typeof FINANCE_PROFIT_LOSS_CSV_VERSION;
    expiresAt: string;
  }): Promise<FinanceFolioExportArtifact>;
  close?(): void;
};

// prettier-ignore
export function createS3FinanceFolioExportArtifactWriter(config: { bucketName: string; s3Client?: S3Client }): FinanceFolioExportArtifactWriter {
  if (!config.bucketName.trim()) throw new Error("Finance folio exports require a storage bucket");
  const ownsClient = !config.s3Client;
  const s3 = config.s3Client ?? new S3Client({ requestChecksumCalculation: "WHEN_REQUIRED", requestHandler: NodeHttpHandler.create({ connectionTimeout: 5_000, requestTimeout: 30_000, socketTimeout: 30_000, throwOnRequestTimeout: true }) });
  return {
    bucketName: config.bucketName,
    async write(input) {
      if (!uuid(input.exportId) || input.contentType !== FINANCE_FOLIO_CSV_CONTENT_TYPE || ![FINANCE_FOLIO_CSV_VERSION,FINANCE_EXPENSE_CSV_VERSION,FINANCE_PROFIT_LOSS_CSV_VERSION].includes(input.formatVersion) || !instant(input.expiresAt)) throw new TypeError("Invalid Finance export artifact");
      const bytes = Buffer.from(input.body, "utf8"), digest = createHash("sha256").update(bytes).digest(), storageKey = `private/finance/financials-exports/${input.exportId}/${input.formatVersion}.csv`;
      await s3.send(new PutObjectCommand({ Bucket: config.bucketName, Key: storageKey, Body: bytes, ContentType: input.contentType, CacheControl: "private, no-store", ChecksumSHA256: digest.toString("base64"), Expires: new Date(input.expiresAt), Metadata: { "expires-at": input.expiresAt } }));
      return { bucketName: config.bucketName, storageKey, checksumSha256: digest.toString("hex"), sizeBytes: bytes.length };
    },
    close() { if (ownsClient) s3.destroy(); },
  };
}

const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const instant = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(new Date(value).getTime()) &&
  new Date(value).toISOString() === value;
