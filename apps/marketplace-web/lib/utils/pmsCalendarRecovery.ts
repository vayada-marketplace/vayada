// An explicit PMS repair entry goes straight to canonical setup. The setup route
// and each command still authorize access.
export function isPmsCalendarRecovery(
  params: Record<string, string | string[] | undefined>,
): boolean {
  return (
    params.recovery === "pms-calendar" &&
    params.entryProduct === "pms" &&
    params.returnProduct === "pms" &&
    typeof params.propertyId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.propertyId)
  );
}
