import { z } from "zod";
import { inquiryContextDigest } from "../integrations/channexInquiryPreapproval.js";

const detailsSchema = z
  .object({
    property_id: z.uuid(),
    listing_id: z.string().min(1),
    checkin_date: z.iso.date(),
    checkout_date: z.iso.date().optional(),
    nights: z.number().int().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    adults: z.number().int().positive().optional(),
    number_of_adults: z.number().int().positive().optional(),
    children: z.number().int().nonnegative().optional(),
    number_of_children: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export const airbnbInquiryEvidenceSchema = z
  .object({
    eventId: z.uuid(),
    providerPropertyId: z.uuid(),
    threadId: z.string().min(1),
    listingId: z.string().min(1),
    contextDigest: z.string().regex(/^[a-f0-9]{64}$/),
    arrivalDate: z.iso.date(),
    departureDate: z.iso.date(),
    adults: z.number().int().positive(),
    children: z.number().int().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict();
export type AirbnbInquiryEvidence = z.infer<typeof airbnbInquiryEvidenceSchema>;

/** Retain an explicit decision ID only for verified inquiry messages. Generic
 * live-feed notices and incomplete stay payloads never expose a send action. */
export function airbnbInquiryEvidence(input: {
  inquiry: boolean;
  providerChannel: string | null;
  providerPropertyId: string;
  threadId: string;
  eventId: unknown;
  bookingDetails: unknown;
}): AirbnbInquiryEvidence | null {
  if (!input.inquiry || input.providerChannel !== "airbnb") return null;
  const details = detailsSchema.safeParse(input.bookingDetails);
  if (!details.success || details.data.property_id !== input.providerPropertyId) return null;
  const d = details.data;
  if (
    (d.adults !== undefined &&
      d.number_of_adults !== undefined &&
      d.adults !== d.number_of_adults) ||
    (d.children !== undefined &&
      d.number_of_children !== undefined &&
      d.children !== d.number_of_children)
  )
    return null;
  const departure = new Date(`${d.checkin_date}T00:00:00Z`);
  departure.setUTCDate(departure.getUTCDate() + d.nights);
  if (!Number.isFinite(departure.getTime())) return null;
  const departureDate = departure.toISOString().slice(0, 10);
  if (d.checkout_date && d.checkout_date !== departureDate) return null;
  const result = airbnbInquiryEvidenceSchema.safeParse({
    eventId: input.eventId,
    providerPropertyId: input.providerPropertyId,
    threadId: input.threadId,
    listingId: d.listing_id,
    contextDigest: inquiryContextDigest(d),
    arrivalDate: d.checkin_date,
    departureDate,
    adults: d.adults ?? d.number_of_adults,
    children: d.children ?? d.number_of_children,
    currency: d.currency,
  });
  return result.success ? result.data : null;
}
