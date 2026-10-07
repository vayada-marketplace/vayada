import { PmsPropertySelectionRequiredError } from "@/services/api/pmsPropertyClient";

// Shows the property-selection error in the selected language. Any other error keeps `message`,
// the text the page already derives for it.
export function localizedErrorText(
  error: unknown,
  message: string,
  t: (key: string) => string,
): string {
  return error instanceof PmsPropertySelectionRequiredError ? t(error.messageKey) : message;
}
