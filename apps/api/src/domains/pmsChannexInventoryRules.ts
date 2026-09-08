import {
  inventoryRulesOverlap,
  parseInventoryRules,
  type ChannexConnectedChannel,
  type ChannexInventoryRule,
  type ChannexInventoryRulesInput,
} from "@vayada/domain-pms-channex";
import type { ChannexManagementQueryClient } from "../jobs/pmsChannexManagementWorkerStore.js";

export async function validateInventoryRules(
  client: Pick<ChannexManagementQueryClient, "query">,
  propertyId: string,
  input: ChannexInventoryRulesInput,
): Promise<string | null> {
  if (!parseInventoryRules(input)) return "Invalid dates, weekdays, identifiers or numeric values.";
  const connection = await client.query<{
    metadata: {
      connectedChannels?: ChannexConnectedChannel[];
      inventoryRules?: { operationId: string; rules: ChannexInventoryRule[] };
    };
  }>(
    `SELECT connection_metadata AS metadata FROM pms.channel_connections
    WHERE property_id = $1::uuid AND provider = 'channex' FOR UPDATE`,
    [propertyId],
  );
  const metadata = connection.rows[0]?.metadata;
  if ((metadata?.inventoryRules?.operationId ?? null) !== input.expectedOperationId)
    return "Inventory rules changed. Refresh before saving again.";
  const channels = metadata?.connectedChannels ?? [];
  if (
    input.rules.some((rule) =>
      rule.channelIds.some(
        (id) => !channels.some((channel) => channel.externalChannelId === id && channel.isActive),
      ),
    )
  )
    return "Select active channels belonging to this property. Refresh channel mappings first.";
  const rooms = await client.query<{ id: string }>(
    `SELECT mapping.room_type_id::text AS id
    FROM pms.channel_room_type_mappings mapping
    JOIN pms.channel_connections connection ON connection.id = mapping.connection_id
      AND connection.property_id = mapping.property_id AND connection.provider = 'channex'
    JOIN pms.room_types room ON room.id = mapping.room_type_id AND room.property_id = mapping.property_id
    WHERE mapping.property_id = $1::uuid AND mapping.status = 'active' AND room.active`,
    [propertyId],
  );
  if (
    input.rules.some((rule) =>
      rule.roomTypeIds.some((id) => !rooms.rows.some((room) => room.id === id)),
    )
  )
    return "Select active mapped room types belonging to this property.";
  if (
    input.rules.some((rule, index) =>
      input.rules.slice(index + 1).some((other) => inventoryRulesOverlap(rule, other)),
    )
  )
    return "Rules cannot overlap for the same channel, room type and date. Edit or remove the conflicting rule.";
  return null;
}
