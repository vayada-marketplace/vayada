// VAY-2504: mocked staff AI budget answers for the Vayada Admin AI budgets specs.
export const harbour = "6f1c2a4e-0000-4000-8000-000000000002";
export const alpenrose = "6f1c2a4e-0000-4000-8000-000000000005";
const hotel = (
  organizationId: string,
  name: string,
  limitUsd: number,
  usedUsd: number,
  calls: number,
  updatedAt: string | null,
  status = "active",
) => ({
  organizationId,
  name,
  status,
  monthlyLimitMicroUsd: Math.round(limitUsd * 1_000_000),
  custom: updatedAt !== null,
  usedMicroUsd: Math.round(usedUsd * 1_000_000),
  calls,
  updatedAt,
});
export const overviewFixture = {
  month: "2026-11-01",
  defaultMonthlyLimitMicroUsd: 0,
  totalUsedMicroUsd: 18_570_000,
  accounts: [
    hotel(
      "6f1c2a4e-0000-4000-8000-000000000001",
      "Villa Serena Canggu",
      10,
      10,
      4812,
      "2026-11-03T08:00:00.000Z",
    ),
    hotel(harbour, "Harbour House Lisbon", 25, 6.41, 3077, "2026-11-12T09:30:00.000Z"),
    hotel(
      "6f1c2a4e-0000-4000-8000-000000000003",
      "Alpine Lodge",
      5,
      1.62,
      802,
      "2026-11-18T10:00:00.000Z",
    ),
    hotel(
      "6f1c2a4e-0000-4000-8000-000000000004",
      "Casa Lumen",
      5,
      0.54,
      211,
      "2026-11-20T16:45:00.000Z",
    ),
    hotel(alpenrose, "Hotel Alpenrose Munich", 0, 0, 0, null),
    hotel(
      "6f1c2a4e-0000-4000-8000-000000000006",
      "Seaview Guesthouse Galle",
      0,
      0,
      0,
      null,
      "suspended",
    ),
    hotel("6f1c2a4e-0000-4000-8000-000000000007", "Ubud Rice Terrace Retreat", 0, 0, 0, null),
  ],
};
