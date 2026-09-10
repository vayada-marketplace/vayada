import type { ExternalChangePresentationPort } from "../domains/booking/externalChangePresentation.js";
import { presentChannexAlteration } from "../domains/channexAlterationPresentation.js";

/** Composition adapter; available even while external decision writes are disabled. */
export const externalBookingChanges: ExternalChangePresentationPort = {
  isManaged(changes) {
    return typeof changes === "object" && changes !== null &&
      Object.prototype.hasOwnProperty.call(changes, "channex");
  },
  project: presentChannexAlteration,
};
