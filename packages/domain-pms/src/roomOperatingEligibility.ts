/** Operating eligibility is distinct from retained canonical room facts/history. */
export type PmsRoomOperatingEligibility = Readonly<{
  propertyId: string;
  roomTypeId: string;
  state: "operating" | "closing" | "inactive";
  closureCommandId: string | null;
  cutoffDate: string | null;
}>;

export interface PmsRoomOperatingEligibilityReadPort {
  listRoomOperatingEligibility(propertyId: string): Promise<readonly PmsRoomOperatingEligibility[]>;
}
