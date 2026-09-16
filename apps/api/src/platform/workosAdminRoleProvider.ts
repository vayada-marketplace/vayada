import { NotFoundException, WorkOS } from "@workos-inc/node";
import type { AdminRoleProvider } from "@vayada/backend-auth";
export function createWorkOSAdminRoleProvider(apiKey: string): AdminRoleProvider {
  const workos = new WorkOS(apiKey, { maxRetries: 0, timeout: 10_000 });
  return {
    async updateRole(input) {
      try {
        const current = await workos.userManagement.getOrganizationMembership(input.membershipId);
        if (current.organizationId !== input.organizationId || current.userId !== input.userId)
          return "binding_mismatch";
        const updated = await workos.userManagement.updateOrganizationMembership(
          input.membershipId,
          { roleSlug: input.roleSlug },
        );
        if (
          updated.organizationId !== input.organizationId ||
          updated.userId !== input.userId ||
          updated.status !== current.status ||
          (updated.roles?.length
            ? updated.roles.length !== 1 || updated.roles[0]?.slug !== input.roleSlug
            : updated.role?.slug !== input.roleSlug)
        )
          throw new Error("Provider role update not confirmed");
        return "updated";
      } catch (error) {
        if (error instanceof NotFoundException) return "absent";
        throw error;
      }
    },
  };
}
