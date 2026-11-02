import Image from "next/image";

import type { HotelSite, SiteRoom } from "@/sites/types";

import { Split } from "./Split";

/** "Stay with us": one card per room, each linking to its details row. */
export function RoomCards({ site }: { site: HotelSite }) {
  return (
    <section id="stay" className="tinted rooms">
      <div className="rooms-inner">
        <h2>{site.rooms.heading}</h2>
        <div className="room-cards">
          {site.rooms.items.map((room) => (
            <a key={room.id} href={`#${room.id}`} className="room-card">
              {/* The details row below describes the same photo. */}
              <Image
                src={room.image.src}
                alt=""
                sizes="(max-width: 599px) 100vw, (max-width: 1059px) 50vw, 280px"
              />
              <span className="room-card-name">{room.name}</span>
              <span className={room.comingSoon ? "room-card-summary soon" : "room-card-summary"}>
                {room.summary}
              </span>
              <span className="room-card-cta">
                {room.comingSoon ? "Coming soon" : `Explore ${room.name}`}
              </span>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

/** The rooms' details, photo and text alternating sides. */
export function RoomDetails({ site }: { site: HotelSite }) {
  return (
    <section className="room-details" aria-labelledby="room-details-heading">
      <h2 id="room-details-heading" className="visually-hidden">
        {site.rooms.detailsHeading}
      </h2>
      {site.rooms.items.map((room, index) => (
        <Split key={room.id} id={room.id} image={room.image} flipped={index % 2 === 1}>
          <h3>{room.name}</h3>
          {room.comingSoon && <p className="soon">Coming soon</p>}
          <p>{room.description}</p>
          <ul>
            {room.features.map((feature) => (
              <li key={feature}>{feature}</li>
            ))}
          </ul>
          {!room.comingSoon && (
            <a href={roomLink(site.bookingUrl, room)} className="button-outline">
              View rooms
            </a>
          )}
        </Split>
      ))}
    </section>
  );
}

function roomLink(bookingUrl: string, room: SiteRoom): string {
  if (!room.roomTypeId) return bookingUrl;
  const url = new URL(bookingUrl);
  url.searchParams.set("room", room.roomTypeId);
  return url.href;
}
