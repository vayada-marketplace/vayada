/** Hotel-facing wording for owner blocker codes in the Booking launch review (VAY-2134).
 * Codes without an entry keep the generic message for their kind. */
export const BOOKING_LAUNCH_BLOCKER_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  // Present your hotel
  hotel_setup_in_progress: "Your hotel is being set up. Try again in a moment.",
  hotel_profile_incomplete: "Finish your hotel profile in Present your hotel.",
  hotel_public_locality_missing: "Add your hotel's city and country and show them to guests.",
  hotel_public_locality_hidden:
    "Turn on 'Show city and country publicly' so guests see where you are.",
  hotel_canonical_slug_missing: "Your hotel needs a booking page address.",
  hotel_canonical_slug_invalid:
    "Your booking page address can't be used. Contact support to change it.",
  hotel_timezone_missing: "Add your hotel's time zone in Present your hotel.",
  hotel_timezone_invalid: "Choose your hotel's time zone again in Present your hotel.",
  hotel_public_media_missing: "Add at least one hotel photo in Present your hotel.",
  hotel_public_media_processing: "Your hotel photos are still being processed.",
  hotel_public_media_unavailable:
    "A hotel photo or logo can't be shown. Upload it again in Present your hotel.",
  // Style your booking page
  booking_design_missing: "Choose your booking page style.",
  booking_design_profile_missing: "Finish your hotel profile, then review your booking page style.",
  booking_design_profile_stale: "Your hotel profile changed. Review your booking page style.",
  booking_design_cover_assignment_missing: "Choose a cover photo for your booking page.",
  booking_design_cover_assignment_stale:
    "Your cover photo changed. Review your booking page style.",
  booking_design_safe_media_missing: "Your cover photo can't be shown. Choose it again.",
  booking_design_safe_media_stale: "Your cover photo changed. Review your booking page style.",
  booking_publication_source_stale: "Your hotel details changed. Review your booking page style.",
  // Add your room types
  publishable_room_required: "Add at least one complete room type.",
  room_type_required: "Add at least one room type before publishing.",
  room_units_required: "Add at least one unit for this room type before publishing.",
  room_photo_required: "Add at least one room photo before publishing.",
  room_media_unavailable: "Review this room's photos before publishing.",
  room_amenities_review_required: "Review this room's amenities before publishing.",
  // Set your room prices
  pricing_not_published: "Save your room prices.",
  pricing_rooms_changed: "Your rooms changed after prices were saved. Save your prices again.",
  pricing_payments_changed:
    "Your payment settings changed after prices were saved. Save your prices again.",
  pricing_hotel_setup_in_progress:
    "Your prices are saved. Guests see them once your hotel is set up.",
  pricing_terms_changed: "Your rate terms changed after prices were saved. Save your prices again.",
  public_room_content_incomplete: "Every bookable room needs a saved price.",
  // Open your calendar
  operating_calendar_missing: "Open your calendar and confirm your starting availability.",
  operating_calendar_source_stale:
    "Your hotel or rooms changed. Review and save your calendar again.",
  inventory_launch_readiness_incomplete:
    "Room availability isn't prepared yet. Open your calendar to prepare it.",
  // Configure the guest experience
  guest_policy_not_configured: "Set your check-in and check-out times and guest policies.",
  // Choose how guests can pay
  payment_methods_not_configured: "Choose how guests can pay.",
  ready_payment_method_missing: "Choose at least one payment method guests can use now.",
  payment_currency_stale: "Your property currency changed. Review how guests can pay.",
  payment_settings_uncommitted: "Save your payment selection.",
  pricing_currency_unavailable:
    "Set your property currency in Pricing before saving payment methods.",
  pricing_currency_mismatch: "Your property currency changed. Review how guests can pay.",
  online_card_execution_unavailable:
    "Online card payments are waiting for verified payment execution.",
  online_card_currency_unsupported: "Online cards do not support the property's current currency.",
  provider_restricted:
    "Stripe has restricted this account. Review your Stripe account requirements.",
  provider_capability_lost:
    "Stripe card capability is unavailable. Review your Stripe account requirements.",
  bank_transfer_contract_unavailable: "Bank transfer is not available for setup.",
  billing_plan_not_selected:
    "Choose your vayada plan so guests can book. A Fixed Fee plan counts once it is active in Stripe.",
});
