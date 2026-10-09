import type { IdentityCohortScope } from "./productionIdentityCohortScope.js";
import type {
  IdentityMigrationBlocker,
  IdentitySourceRow,
} from "./productionIdentityDisposition.js";
import type { ProductionMigrationSourceLink } from "./productionBookingTypes.js";

export type PmsTargetRecord = {
  targetProduct: "pms" | "platform";
  targetTable: string;
  targetId: string;
  sourceDatabase: "pms";
  sourceTable: string;
  sourceId: string;
  sourceChecksum: string;
  sourceUpdatedAt: string | null;
  mutable: boolean;
  row: Record<string, unknown>;
};

export type ExistingPmsTargetRecord = {
  targetProduct: string;
  targetTable: string;
  targetId: string;
  updatedAt: string | null;
  row: Record<string, unknown>;
};

export type PmsPropertyLink = {
  sourceId: string;
  propertyId: string;
  relationship: string;
  status: string;
  migrationRunId: string | null;
  migrationDisposition?: "canonical" | "private_quarantine" | null;
  ownerStatus: string | null;
};

export type PmsTargetBooking = {
  id: string;
  propertyId: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  roomCount: number;
  currency: string;
  lifecycleStatus: string;
  updatedAt: string | null;
  migrationRunId: string | null;
};

export type PmsMediaReference = {
  mediaObjectId: string;
  propertyId: string | null;
  sourceTable: string;
  sourceRowId: string;
  sourceUrl: string;
  purpose: "pms.room_type.media" | "pms.messaging.attachment";
  visibility: "public" | "private";
  lifecycleStatus: string;
  publicApproved: boolean;
  publicUrl: string | null;
  storageKey: string;
};

export type PmsMediaQuarantine = {
  sourceTable: string;
  sourceRowId: string;
  sourceField: string;
  sourceValueSha256: string;
  purpose: "pms.room_type.media" | "pms.messaging.attachment";
  reasonCode: "INVALID_HTTPS_URL" | "INVALID_STRING_ARRAY";
};

/** VAY-1362: catalog and tenancy facts of the run's PMS properties for setup completeness. */
export type PmsCohortPropertyState = {
  propertyId: string;
  profileRevision: number;
  timeZone: string | null;
  /** Active hotel organizations holding both native property links. */
  organizationIds: string[];
  /** Revision 1 of the operating calendar as stored, if any. */
  storedCalendar: {
    idempotencyKeyId: string;
    organizationId: string;
    profileRevision: number;
    timeZone: string;
    scheduleMode: string;
    periods: Array<{ startsOn: string; endsOn: string }>;
    defaultMinimumStayNights: number;
    createdByUserId: string;
    createdAt: string;
    bindings: Array<{
      roomTypeId: string;
      sourceRoomFactsRevision: number;
      sourceRoomUnitsRevision: number;
      physicalCapacityCount: number;
      startingSellableLimitCount: number;
    }>;
  } | null;
};

export type ProductionPmsTargetState = {
  propertyLinks: PmsPropertyLink[];
  cohortProperties?: PmsCohortPropertyState[];
  bookings: PmsTargetBooking[];
  userIds: string[];
  media?: PmsMediaReference[];
  mediaQuarantines?: PmsMediaQuarantine[];
  /** All runs, conflict detection only; not authorization to reuse a media object. */
  attachmentMediaSourceIds?: string[];
  /** @deprecated Retained for older plan fixtures; media gates use source-bound references. */
  mediaIds: string[];
  records: ExistingPmsTargetRecord[];
  provenance: ProductionMigrationSourceLink[];
  blockers?: IdentityMigrationBlocker[];
};

export type PmsBuildContext = {
  sourceRunId: string;
  snapshotAt: string;
  completedAt: string;
  rows: IdentitySourceRow[];
  target: ProductionPmsTargetState;
  blockers: IdentityMigrationBlocker[];
  rowsByTable: Map<string, IdentitySourceRow[]>;
  propertyByHotel: Map<string, string>;
  ownerStatusByHotel: Map<string, "active" | "suspended" | "archived">;
  /** VAY-1362: the run's approved cohort; null or absent means no cohort. */
  cohort?: IdentityCohortScope | null;
  hotelById: Map<string, IdentitySourceRow>;
  bookingById: Map<string, IdentitySourceRow>;
  targetBookingById: Map<string, PmsTargetBooking>;
  roomTypeById: Map<string, IdentitySourceRow>;
  roomById: Map<string, IdentitySourceRow>;
  connectionByHotel: Map<string, IdentitySourceRow>;
  linkedGroupByRoomType: Map<string, string>;
  userIds: Set<string>;
  mediaIds: Set<string>;
  mediaBySource: Map<string, PmsMediaReference>;
  effectiveRoomTypeActiveById: Map<string, boolean>;
};

export type PmsRoomBuild = {
  records: PmsTargetRecord[];
  flexiblePlanByRoomType: Map<string, string>;
  channelPlanByMapping: Map<string, string>;
  /** VAY-1362: cohort room types stored in the native room-facts shape. */
  nativeFactsRoomTypes?: Set<string>;
};

export type PmsAssignmentBuild = {
  records: PmsTargetRecord[];
  assignmentByBookingPosition: Map<string, string>;
};

export type ProductionPmsPlan = {
  sourceRunId: string;
  checksum: string;
  /** VAY-1362: the carried cohort properties, which the apply locks and may activate. */
  cohortPropertyIds?: string[];
  records: PmsTargetRecord[];
  writes: PmsTargetRecord[];
  provenance: ProductionMigrationSourceLink[];
  blockers: IdentityMigrationBlocker[];
  parity: {
    /** VAY-1362: days each calendared cohort room type must cover (else 366). */
    expectedInventoryDaysByRoomType?: Record<string, number>;
    sourceTableCounts: Record<string, number>;
    targetTableCounts: Record<string, number>;
    sourceCountsByProperty: Record<string, Record<string, number>>;
    targetCountsByProperty: Record<string, Record<string, number>>;
    futureInventoryByProperty: Record<
      string,
      { days: number; assigned: number; blocked: number; available: number; stopSell: number }
    >;
    expectedActiveRoomTypesByProperty: Record<string, string[]>;
    actualActiveRoomTypesByProperty: Record<string, string[]>;
    futureInventoryByRoomType: Record<
      string,
      {
        propertyId: string;
        roomTypeId: string;
        firstStayDate: string;
        lastStayDate: string;
        distinctDays: number;
        rows: number;
      }
    >;
  };
  counts: {
    sourceRows: number;
    plannedRecords: number;
    inserts: number;
    updates: number;
    unchanged: number;
    preservedNewerTarget: number;
    preservedTargetDeletions: number;
  };
};
