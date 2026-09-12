import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { PreparedHotelImportPanel } from "../../packages/product-onboarding/src/PreparedHotelImportPanel";
import { createClient, listings, readLedger, resetLedger } from "./client";
import "./style.css";
function App() {
  const [step, setStep] = useState("start");
  const [scenario, setScenario] = useState("normal");
  const [chosen, setChosen] = useState<string[]>([]);
  const [saved, setSaved] = useState(readLedger);
  const client = useMemo(
    () =>
      createClient(
        {
          contractVersion: "prepared-hotel-import.v1",
          property: {},
          rooms: listings.filter((room) => chosen.includes(room.id)),
        },
        scenario,
        setSaved,
      ),
    [chosen, scenario],
  );
  return (
    <main>
      <header>
        <span>VAYADA · LOCAL TEST</span>
        <h1>Try hotel import</h1>
        <p>
          Simulated Airbnb connection. No Airbnb login, network API, real hotel, or synchronization.
        </p>
      </header>
      <aside>
        Uses the shared review editor. Saves only to this tab’s session storage; close the tab to
        discard. This does not test real authorization, database writes, or server duplicate
        protection.
      </aside>
      {step === "start" && (
        <section>
          <h2>1. Connect</h2>
          <label>
            Test scenario
            <select value={scenario} onChange={(event) => setScenario(event.target.value)}>
              <option value="normal">Normal import</option>
              <option value="empty">Account without listings</option>
              <option value="connection-error">Connection fails</option>
              <option value="partial-failure">One save fails once</option>
              <option value="lost-response">Save succeeds but response is lost</option>
            </select>
          </label>
          <button onClick={() => setStep("authorize")}>Connect Airbnb (simulated)</button>
        </section>
      )}
      {step === "authorize" && (
        <section>
          <h2>2. Simulated authorization</h2>
          <p>This screen represents the return from Airbnb; it collects no credentials.</p>
          <button onClick={() => setStep(scenario === "connection-error" ? "error" : "listings")}>
            Simulate approval
          </button>
          <button onClick={() => setStep("start")}>Cancel connection</button>
        </section>
      )}
      {step === "error" && (
        <section>
          <p role="alert">Connection failed. No listings were imported.</p>
          <button onClick={() => setStep("start")}>Try connection again</button>
        </section>
      )}
      {step === "listings" && (
        <section>
          <h2>3. Choose listings</h2>
          {scenario === "empty" ? (
            <p>No listings found. You can continue setting up your hotel manually.</p>
          ) : (
            <>
              <p>
                Both listings have no photos. The loft also has missing facts; nothing is invented.
              </p>
              {listings.map((room) => (
                <label className="listing" key={room.id}>
                  <input
                    type="checkbox"
                    checked={chosen.includes(room.id)}
                    onChange={() =>
                      setChosen((current) =>
                        current.includes(room.id)
                          ? current.filter((id) => id !== room.id)
                          : [...current, room.id],
                      )
                    }
                  />
                  {room.name}
                  <small>No photo supplied</small>
                </label>
              ))}
              <button disabled={!chosen.length} onClick={() => setStep("review")}>
                Review selected listings
              </button>
            </>
          )}
          <button onClick={() => setStep("start")}>Back to connection</button>
        </section>
      )}
      {step === "review" && (
        <>
          {chosen.every((id) => saved.results[`room:${id}`]?.status === "applied") && (
            <p role="status">
              All selected listings are already saved locally. Your saved edits are preserved.
            </p>
          )}
          <PreparedHotelImportPanel client={client} propertyId="synthetic-hotel" roomsOnly />
          <button
            onClick={() => {
              setStep("listings");
            }}
          >
            Back to listings
          </button>
        </>
      )}
      <section aria-label="Saved synthetic rooms">
        <h2>Saved locally: {Object.keys(saved.rooms).length} rooms</h2>
        <p>No stock, rates, availability, or publication created.</p>
        {Object.values(saved.rooms).map((room) => (
          <p key={room.id}>
            {room.name} · {room.maxGuests} guests
          </p>
        ))}
      </section>
      <button
        onClick={() => {
          resetLedger();
          setSaved(readLedger());
          setChosen([]);
          setStep("start");
        }}
      >
        Reset local test
      </button>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
