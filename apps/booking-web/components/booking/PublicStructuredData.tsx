"use client";

import type { Hotel, RoomType } from "@/lib/types";
import {
  BOOKING_WEB_STRUCTURED_DATA_ID,
  buildPublicHotelStructuredData,
} from "@/lib/structuredData";

export default function PublicStructuredData({
  hotel,
  rooms,
  locale,
}: {
  hotel: Hotel;
  rooms: RoomType[];
  locale: string;
}) {
  const structuredData = buildPublicHotelStructuredData({ hotel, rooms, locale });

  return (
    <script
      id={BOOKING_WEB_STRUCTURED_DATA_ID}
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
    />
  );
}
