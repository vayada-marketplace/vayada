import { describe, expect, it } from "vitest";

import {
  canonicalizeJson,
  classifyManifestConsumption,
  hashExpectedDatabaseName,
  hashOrderedSourceRows,
  hashSnapshotIdentifier,
  hashSourceLedger,
  hashTargetBindingClaims,
  hashTargetRow,
} from "./channexAdoptionManifestCrypto.js";

const HASH = "0".repeat(64);
const uuid = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;

describe("Channex adoption evidence primitives", () => {
  it("implements deterministic JCS-compatible canonicalization", () => {
    expect(canonicalizeJson({ z: "é", a: "\b", "€": "x", "\r": "y", 1: "one" })).toBe(
      '{"\\r":"y","1":"one","a":"\\b","z":"é","€":"x"}',
    );
    expect(canonicalizeJson({ b: 1e30, a: -0 })).toBe('{"a":0,"b":1e+30}');
    expect(canonicalizeJson([Number.MIN_VALUE, Number.MAX_VALUE, 1e-6, 1e-7])).toBe(
      "[5e-324,1.7976931348623157e+308,0.000001,1e-7]",
    );
    const utf16Keys = { "€": 1, "\r": 1, דּ: 1, 1: 1, "😀": 1, "\u0080": 1, ö: 1 };
    expect(canonicalizeJson(utf16Keys)).toBe('{"\\r":1,"1":1,"\u0080":1,"ö":1,"€":1,"😀":1,"דּ":1}');
    expect(() => canonicalizeJson("\ud800")).toThrowError(/INVALID_UNICODE/);
    expect(() => canonicalizeJson(Number.NaN)).toThrowError(/INVALID_NUMBER/);
    expect(() => canonicalizeJson(Array(1))).toThrowError(/SPARSE_ARRAY/);
    expect(() => canonicalizeJson([, null])).toThrowError(/SPARSE_ARRAY/);
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => canonicalizeJson(cyclic)).toThrowError(/CYCLIC_JSON/);
  });

  it("hashes source and target evidence with ordered domain separation", () => {
    expect(
      hashOrderedSourceRows("pms-bookings", [
        { rowOrdinal: 1, rowChecksumSha256: HASH },
        { rowOrdinal: 3, rowChecksumSha256: "1".repeat(64) },
      ]),
    ).toBe("a1f92b421859ac010102188bc9e101595804789c76e11493e223a230cec080ac");
    expect(() =>
      hashOrderedSourceRows("pms-bookings", [
        { rowOrdinal: 2, rowChecksumSha256: HASH },
        { rowOrdinal: 1, rowChecksumSha256: HASH },
      ]),
    ).toThrowError(/INVALID_ROW_ORDER/);
    expect(hashOrderedSourceRows("pms-bookings", [])).toBe(
      "cb7f8164fb6da77fdb110c1d84fc0576b5525eb1f19b1c4bbaf0c99aeb2702f9",
    );
    expect(
      hashTargetBindingClaims([
        { id: uuid("1"), rowStateSha256: HASH },
        { id: uuid("2"), rowStateSha256: "2".repeat(64) },
      ]),
    ).toBe("a097586d1999def0d68160573c11e20378ecdb5e805acc0858a477ed98c49be9");
    expect(hashTargetBindingClaims([])).toBe(
      "8fa41faa232b2fb6f4102246098bc8a7b6e3958762e8c09cd1bfc06b00358f29",
    );
    const claims = [
      { id: uuid("1"), rowStateSha256: HASH },
      { id: uuid("2"), rowStateSha256: HASH },
    ];
    expect(() => hashTargetBindingClaims([...claims].reverse())).toThrowError(/INVALID_ROW_ORDER/);
    expect(() => hashTargetBindingClaims([claims[0], claims[0]])).toThrowError(/INVALID_ROW_ORDER/);
    expect(
      hashTargetRow({
        schema: "platform",
        table: "properties",
        primaryKey: uuid("4"),
        row: { id: uuid("4") },
      }),
    ).toBe("7f656bdc1a4bd92030582c74be1ea7004f1b30402293f0bb99d89ed557d86644");
    expect(hashSnapshotIdentifier("snapshot-1")).toBe(
      "2b113e383eab317852d40ab15ab3c21e26e5454c252931d5a7c91703b0f3776c",
    );
    expect(hashExpectedDatabaseName("pms")).toBe(
      "f42a17ad32d05121184dcc02da678007d927534fc26331ddcbe20c34e60c70b4",
    );
  });

  it("requires deterministic source-ledger ordering", () => {
    const run = {
      run_id: "vay1351-aaaaaaaaaaaaaaaaaaaaaaaa",
      environment: "staging",
      source_schema_revision: "b".repeat(40),
      cutover_freeze_proof_sha256: null,
      status: "completed",
      finished_at: "2026-09-11T10:00:00.000000Z",
    };
    const source = (source_database: string) => ({
      source_database,
      snapshot_identifier_sha256: HASH,
      expected_database_name_sha256: HASH,
      expected_schema_fingerprint: "a".repeat(32),
      actual_schema_fingerprint: "a".repeat(32),
      status: "completed",
      row_count: 0,
      checksum_sha256: HASH,
      source_snapshot_at: "2026-09-11T10:00:00.000000Z",
    });
    const table = (source_database: string, source_table: string) => ({
      source_database,
      source_schema: "public",
      source_table,
      status: "completed",
      row_count: 0,
      checksum_sha256: HASH,
    });
    const ordered = {
      run,
      sources: [source("auth"), source("pms")],
      tables: [table("auth", "users"), table("pms", "hotels")],
    };
    expect(hashSourceLedger(ordered)).toBe(
      "fa41f7922d38162c1defcd237718777e28fd8c59f533912d9d42067c855470c0",
    );
    expect(() =>
      hashSourceLedger({ ...ordered, sources: [...ordered.sources].reverse() }),
    ).toThrowError(/INVALID_ROW_ORDER/);
    expect(() =>
      hashSourceLedger({ ...ordered, tables: [ordered.tables[0], ordered.tables[0]] }),
    ).toThrowError(/INVALID_ROW_ORDER/);
  });

  it("classifies new, replayed, drifted, and failed consumptions", () => {
    expect(classifyManifestConsumption(null, HASH)).toBe("new");
    expect(classifyManifestConsumption({ payloadSha256: HASH, outcome: "succeeded" }, HASH)).toBe(
      "exact_replay",
    );
    expect(
      classifyManifestConsumption({ payloadSha256: "1".repeat(64), outcome: "succeeded" }, HASH),
    ).toBe("payload_drift");
    expect(classifyManifestConsumption({ payloadSha256: HASH, outcome: "failed" }, HASH)).toBe(
      "stored_failure",
    );
    expect(
      classifyManifestConsumption({ payloadSha256: "1".repeat(64), outcome: "failed" }, HASH),
    ).toBe("payload_drift");
  });
});
