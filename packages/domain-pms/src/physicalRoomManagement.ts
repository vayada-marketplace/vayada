import type { RoomFactsCommandAudit } from "./roomFacts.js";

export type PhysicalRoomStatus = "available" | "maintenance" | "out_of_order";
export type PhysicalRoomChanges = {
  operationalLabel?: string;
  floor?: string | null;
  status?: PhysicalRoomStatus;
};
export type ManagePhysicalRoomCommand = {
  organizationId: string;
  propertyId: string;
  roomTypeId: string;
  expectedRevision: number;
  idempotencyKey: string;
  audit: RoomFactsCommandAudit;
  /**
   * An AI request's limits, checked again inside the transaction; null for a person (VAY-2522).
   * Same shape as backend-auth's AuthorityNarrowing.
   */
  narrowing: { readonly access: "read" | "change"; readonly propertyIds: readonly string[] } | null;
} & (
  | { action: "create"; changes: PhysicalRoomChanges & { operationalLabel: string } }
  | { action: "update"; roomUnitId: string; changes: PhysicalRoomChanges }
  | { action: "retire"; roomUnitId: string }
);
export type ManagePhysicalRoomResult =
  | {
      ok: true;
      response: {
        propertyId: string;
        roomTypeId: string;
        roomUnitId: string;
        roomUnitsRevision: number;
        outcome: "created" | "updated" | "retired";
      };
    }
  | {
      ok: false;
      error: {
        code:
          | "setup_scope_unavailable"
          | "room_type_not_found"
          | "room_unit_not_found"
          | "room_units_revision_conflict"
          | "idempotency_key_conflict"
          | "operational_label_conflict"
          | "physical_room_protected"
          | "room_capacity_limit";
        message: string;
        currentRevision?: number;
        blockers?: string[];
      };
    };
export type PhysicalRoomManagementPort = {
  managePhysicalRoom(command: ManagePhysicalRoomCommand): Promise<ManagePhysicalRoomResult>;
};
