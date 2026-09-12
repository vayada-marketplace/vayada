import type { ChannexManagementConfig } from "../config.js";
import { verifyChannexRoomClosureIdentity } from "./channexRoomClosureIdentity.js";
import type { DistributionBookingPublicationTransaction } from "../domains/distributionBookingPublicationProjection.js";

/** No provider writes. The caller retains this transaction through closure commit.
 * The supported connected mode additionally requires a coordinated deployment
 * with management workers paused; runtime checks below never pause a worker.
 */
export async function verifyChannexRoomClosure(
  client: DistributionBookingPublicationTransaction,
  config: ChannexManagementConfig,
  scope: { propertyId: string; roomTypeId: string; from: string; through: string },
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const locked = (
    await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked",
      [`channex.management:${scope.propertyId}`],
    )
  ).rows[0]?.locked;
  if (!locked) throw new Error("channex_closure_operation_in_flight");
  // SHARE excludes worker claims (FOR UPDATE) without upgrading past other
  // PMS commands' authorization SHARE locks while holding facts/unit locks.
  await client.query("SELECT id FROM hotel_catalog.properties WHERE id=$1::uuid FOR SHARE", [
    scope.propertyId,
  ]);
  const connections = (
    await client.query<{ id: string; provider: string; status: string; externalId: string | null }>(
      `SELECT id::text,provider,connection_status AS status,external_property_id AS "externalId"
    FROM pms.channel_connections WHERE property_id=$1::uuid FOR UPDATE`,
      [scope.propertyId],
    )
  ).rows;
  const active = connections.filter((connection) => connection.status !== "disconnected");
  const mappings = (
    await client.query<{
      kind: string;
      connectionId: string;
      externalId: string;
      externalRoomId: string;
      channel: string;
    }>(
      `SELECT 'room' AS kind,connection_id::text AS "connectionId",external_room_type_id AS "externalId",external_room_type_id AS "externalRoomId",'direct' AS channel
    FROM pms.channel_room_type_mappings WHERE property_id=$1::uuid AND room_type_id=$2::uuid AND status='active'
    UNION ALL
    SELECT 'rate',connection_id::text,external_rate_plan_id,external_room_type_id,channel
    FROM pms.channel_rate_plan_mappings WHERE property_id=$1::uuid AND room_type_id=$2::uuid AND status='active'`,
      [scope.propertyId, scope.roomTypeId],
    )
  ).rows;
  if (!active.length && !mappings.length) return;
  const connection = active[0];
  if (
    active.length !== 1 ||
    connection?.provider !== "channex" ||
    connection.status !== "connected" ||
    !connection.externalId ||
    config.workerEnabled ||
    config.stagingRestrictionsPropertyId !== scope.propertyId ||
    config.apiBaseUrl?.replace(/\/$/, "") !== "https://staging.channex.io" ||
    !config.apiKey ||
    config.capabilityModes.bookingSync === "mutating"
  ) {
    throw new Error("channex_closure_mode_unsupported");
  }
  const claim = await client.query(
    `SELECT id FROM pms.channel_binding_claims WHERE property_id=$1::uuid AND provider='channex'
      AND external_property_id=$2 AND claim_state='active' FOR SHARE`,
    [scope.propertyId, connection.externalId],
  );
  const rooms = mappings.filter((mapping) => mapping.kind === "room");
  const rates = mappings.filter((mapping) => mapping.kind === "rate");
  if (
    claim.rowCount !== 1 ||
    rooms.length !== 1 ||
    rates.length === 0 ||
    mappings.some(
      (mapping) =>
        mapping.connectionId !== connection.id ||
        mapping.externalRoomId !== rooms[0]?.externalId ||
        !mapping.externalId ||
        mapping.channel !== "direct",
    )
  ) {
    throw new Error("channex_closure_mapping_unsupported");
  }
  const dates: string[] = [];
  const first = Date.parse(`${scope.from}T00:00:00Z`);
  const last = Date.parse(`${scope.through}T00:00:00Z`);
  if (
    !Number.isFinite(first) ||
    !Number.isFinite(last) ||
    last < first ||
    last - first > 365 * 86400000
  )
    throw new Error("channex_closure_horizon_invalid");
  for (let at = first; at <= last; at += 86400000)
    dates.push(new Date(at).toISOString().slice(0, 10));
  await requireEmptyQueue();
  const apiKey = config.apiKey;
  const deadline = AbortSignal.timeout(30000);
  await verifyChannexRoomClosureIdentity(
    (path) => read(new URL(path, "https://staging.channex.io")),
    {
      propertyId: connection.externalId,
      roomId: rooms[0]!.externalId,
      rateIds: rates.map((rate) => rate.externalId),
    },
  );
  for (const kind of ["availability", "restrictions"] as const) {
    const url = new URL(`/api/v1/${kind}`, "https://staging.channex.io");
    url.searchParams.set("filter[property_id]", connection.externalId);
    url.searchParams.set("filter[date][gte]", scope.from);
    url.searchParams.set("filter[date][lte]", scope.through);
    if (kind === "restrictions") url.searchParams.set("filter[restrictions]", "stop_sell");
    const body = (await read(url)) as { data?: Record<string, Record<string, unknown>> };
    const targets = kind === "availability" ? rooms : rates;
    if (
      !targets.every((target) =>
        dates.every((date) => {
          const actual = body?.data?.[target.externalId]?.[date];
          return kind === "availability"
            ? actual === 0
            : !!actual &&
                typeof actual === "object" &&
                (actual as { stop_sell?: unknown }).stop_sell === true;
        }),
      )
    )
      throw new Error("channex_closure_provider_not_closed_zero");
  }
  await requireEmptyQueue();

  async function read(url: URL): Promise<unknown> {
    try {
      const response = await fetcher(url, {
        headers: { "user-api-key": apiKey },
        redirect: "error",
        signal: AbortSignal.any([deadline, AbortSignal.timeout(15000)]),
      });
      if (!response.ok) throw new Error();
      return await response.json();
    } catch {
      throw new Error("channex_closure_readback_failed");
    }
  }

  async function requireEmptyQueue() {
    const jobs = await client.query(
      `SELECT id FROM platform.jobs WHERE property_id=$1::uuid AND queue_name='pms.channex.management'
        AND status IN ('pending','running') LIMIT 1`,
      [scope.propertyId],
    );
    if (jobs.rows.length) throw new Error("channex_closure_queue_not_empty");
  }
}
