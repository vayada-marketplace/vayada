import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  PreparedHotelImportPanel,
  type PreparedImportClient,
  type PreparedImportResponse,
} from "../../packages/product-onboarding/src/PreparedHotelImportPanel";
import { listings } from "./client";
import "./style.css";
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  if (!response.ok) {
    const error = new Error(`Local API returned ${response.status}`);
    throw Object.assign(error, { data: await response.json().catch(() => ({})) });
  }
  return response.json();
}
function App() {
  const [propertyId, setPropertyId] = useState("");
  const [step, setStep] = useState(0);
  const [chosen, setChosen] = useState<string[]>([]);
  const [rooms, setRooms] = useState<{ id: string; name: string }[]>([]);
  const [allSaved, setAllSaved] = useState(false);
  const [error, setError] = useState("");
  const client = useMemo<PreparedImportClient>(
    () => ({
      async get<T>(path: string) {
        const result = await request<PreparedImportResponse>(path);
        setRooms(result.existingRooms ?? []);
        setAllSaved(
          chosen.length > 0 &&
            chosen.every((id) => result.import?.results[`room:${id}`]?.status === "applied"),
        );
        if (result.import)
          result.import.data.rooms = result.import.data.rooms.filter((room) =>
            chosen.includes(room.id),
          );
        return result as T;
      },
      post: request,
    }),
    [chosen],
  );
  useEffect(() => {
    request<{ propertyId: string }>("/api/import-demo")
      .then(async ({ propertyId }) => {
        setPropertyId(propertyId);
        const result = await request<PreparedImportResponse>(
          `/api/hotel-setup/properties/${propertyId}/import`,
        );
        setRooms(result.existingRooms ?? []);
      })
      .catch(() => setError("Local database API is unavailable."));
  }, []);
  return (
    <main>
      <header>
        <span>VAYADA · LOCAL DATABASE TEST</span>
        <h1>Try hotel import</h1>
      </header>
      <aside>
        Airbnb and sign-in are simulated. The shared onboarding review editor uses the real import
        API and an isolated PostgreSQL database. This is not the complete hotel signup page.
      </aside>
      {error && <p role="alert">{error}</p>}
      {step === 0 && (
        <button disabled={!propertyId} onClick={() => setStep(1)}>
          Connect Airbnb (simulated)
        </button>
      )}
      {step === 1 && (
        <section>
          <h2>Simulated authorization</h2>
          <button onClick={() => setStep(2)}>Simulate approval</button>
          <button onClick={() => setStep(0)}>Cancel connection</button>
        </section>
      )}
      {step === 2 && (
        <section>
          <h2>Choose listings</h2>
          {listings.map((room) => (
            <label className="listing" key={room.id}>
              <input
                type="checkbox"
                checked={chosen.includes(room.id)}
                onChange={() =>
                  setChosen((ids) =>
                    ids.includes(room.id) ? ids.filter((id) => id !== room.id) : [...ids, room.id],
                  )
                }
              />
              {room.name}
            </label>
          ))}
          <button disabled={!chosen.length} onClick={() => setStep(3)}>
            Review selected listings
          </button>
        </section>
      )}
      {step === 3 && (
        <>
          {allSaved && (
            <p role="status">
              Selected listings are already saved. Your saved edits are preserved.
            </p>
          )}
          <PreparedHotelImportPanel client={client} propertyId={propertyId} roomsOnly />
          <button onClick={() => setStep(2)}>Back to listings</button>
        </>
      )}
      <section>
        <h2>
          Saved in PostgreSQL: {rooms.length} room {rooms.length === 1 ? "type" : "types"}
        </h2>
        {rooms.map((room) => (
          <p key={room.id}>{room.name}</p>
        ))}
        <p>
          Records persist across tabs and server restarts. No physical rooms, rates, availability,
          or publication created.
        </p>
      </section>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
