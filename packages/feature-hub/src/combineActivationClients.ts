import type { FeatureActivationClient, ModuleActivationsResponse } from "./types";

/** Inbox and Reviews are stored as PMS navigation modules, apart from Financials (VAY-2078). */
export const PMS_NAVIGATION_MODULE_IDS = ["inbox", "reviews"] as const;

export type ActivationSource = {
  client: FeatureActivationClient;
  /** Modules this store owns; omit for the store that takes every other module. */
  modules?: readonly string[];
  /** A failed read of an optional store drops its modules instead of failing the hub. */
  optional?: boolean;
};

/**
 * Reads several module stores as one Feature Hub list and sends each switch to the store that owns
 * the module. A failed required read fails the list, so the page shows its load error; a failed
 * optional read only leaves that store's modules out. Manage rights stay per store: switching
 * Inbox does not need the Financials Owner permission.
 */
export function combineActivationClients(sources: ActivationSource[]): FeatureActivationClient {
  return {
    async list(): Promise<ModuleActivationsResponse> {
      const results = await Promise.allSettled(sources.map(({ client }) => client.list()));
      const responses = results.flatMap((result, index) => {
        if (result.status === "fulfilled") return [result.value];
        if (sources[index]?.optional) return [];
        throw result.reason;
      });
      const manageableModules = responses.flatMap(
        (response) =>
          response.manageableModules ?? (response.canManage ? response.supportedModules : []),
      );
      return {
        hotelId: responses[0]?.hotelId ?? "",
        canManage: manageableModules.length > 0,
        supportedModules: responses.flatMap((response) => response.supportedModules),
        activeModules: responses.flatMap((response) => response.activeModules),
        activations: responses.flatMap((response) => response.activations),
        manageableModules,
      };
    },
    async update(moduleId, isActive) {
      const owner =
        sources.find(({ modules }) => modules?.includes(moduleId)) ??
        sources.find(({ modules }) => !modules);
      if (!owner) throw new Error(`No module store owns ${moduleId}.`);
      return owner.client.update(moduleId, isActive);
    },
  };
}
