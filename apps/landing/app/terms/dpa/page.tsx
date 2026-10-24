import type { ReactNode } from "react";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import { Navigation, Footer } from "@/components/layout";

// The lawyer-approved data processing agreement (VAY-2246), sections 1–10 word for word.
// Acceptances record this version; a text change needs a new version date.
const H2 = "text-2xl font-bold text-primary-800 mb-4";
const LINK = "text-primary-600 hover:text-primary-700 underline";
const OL = "list-decimal pl-6 space-y-3";

// A table on wider screens; below md each row becomes a stacked block, so nothing scrolls sideways.
function AgreementTable({ columns, rows }: { columns: string[]; rows: ReactNode[][] }) {
  return (
    <>
      <div className="hidden md:block overflow-hidden rounded-lg border border-gray-200">
        <table className="w-full text-left text-base">
          <thead className="bg-gray-50">
            <tr>
              {columns.map((column) => (
                <th key={column} scope="col" className="px-4 py-3 font-semibold text-gray-900">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {rows.map(([head, ...cells], index) => (
              <tr key={index}>
                <th scope="row" className="px-4 py-3 align-top font-medium text-gray-900">
                  {head}
                </th>
                {cells.map((cell, cellIndex) => (
                  <td key={cellIndex} className="px-4 py-3 align-top">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="md:hidden divide-y divide-gray-200 rounded-lg border border-gray-200">
        {rows.map(([head, ...cells], index) => (
          <div key={index} className="px-4 py-4">
            <p className="font-semibold text-gray-900">{head}</p>
            <dl>
              {cells.map((cell, cellIndex) => (
                <div key={cellIndex} className="pt-2">
                  <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                    {columns[cellIndex + 1]}
                  </dt>
                  <dd>{cell}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </>
  );
}

export default function DataProcessingAgreementPage() {
  return (
    <div className="min-h-screen bg-white flex flex-col">
      <Navigation />
      <main className="flex-1 pt-20">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
          <div className="mb-8">
            <a
              href="/terms"
              className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-primary-600 hover:text-primary-700"
            >
              <ArrowLeftIcon className="h-4 w-4" aria-hidden="true" />
              Terms of Service
            </a>
            <h1 className="text-4xl md:text-5xl font-bold text-primary-800 mb-4">
              Data Processing Agreement (Annex to the Hotel Terms)
            </h1>
            <p className="text-gray-600">
              <strong>Version: </strong>October 24, 2026
            </p>
          </div>

          <div className="prose prose-lg max-w-none space-y-8 text-gray-700">
            <section className="mt-12">
              <h2 className={H2}>1. Parties and subject matter</h2>
              <ol className={OL}>
                <li>
                  <strong>Controller: </strong>the hotel or accommodation business that uses
                  vayada&apos;s services (&quot;the Hotel&quot;), as named in its vayada account.
                </li>
                <li>
                  <strong>Processor: </strong>vayada UG (haftungsbeschränkt), Speditionstr. 15A,
                  40221 Düsseldorf, Germany, represented by its managing director Timo Christian
                  Schreyer (&quot;vayada&quot;).
                </li>
                <li>
                  <strong>Subject matter: </strong>vayada processes personal data of the
                  Hotel&apos;s guests on the Hotel&apos;s behalf while providing the Booking Engine
                  (the Hotel&apos;s booking site) and the PMS (property management system) under the{" "}
                  <a href="/terms" className={LINK}>
                    hotel terms
                  </a>
                  .
                </li>
                <li>
                  <strong>Not covered: </strong>data vayada processes as its own controller, as
                  described in the{" "}
                  <a href="/privacy" className={LINK}>
                    privacy page
                  </a>
                  : its server logs, the partner-link records, and the Hotel&apos;s own account and
                  staff login data.
                </li>
                <li>
                  <strong>Order of precedence: </strong>if this agreement and the hotel terms
                  conflict on data protection, this agreement wins.
                </li>
              </ol>
            </section>

            <section className="mt-12">
              <h2 className={H2}>2. Nature, purpose and duration</h2>
              <ol className={OL}>
                <li>
                  <strong>Nature: </strong>hosting, storing, displaying and transmitting booking
                  data; taking bookings and payments; sending booking emails; showing bookings in
                  the PMS; exchanging availability and reservations with sales channels the Hotel
                  connects; and, if the guest allows it, recording booking-site analytics.
                </li>
                <li>
                  <strong>Purpose: </strong>to let the Hotel sell rooms on its own booking site,
                  manage its stays and contact its guests about their bookings. vayada uses the data
                  for no other purpose.
                </li>
                <li>
                  <strong>Duration: </strong>for as long as the Hotel uses the services, plus the
                  time needed to return or delete the data under Section 9.
                </li>
              </ol>
            </section>

            <section className="mt-12 space-y-4">
              <h2 className={H2}>3. Data and data subjects</h2>
              <p>
                The data subjects are the Hotel&apos;s guests and people who start a booking on its
                booking site. The categories match Section 9 B of the{" "}
                <a href="/privacy#booking-guests" className={LINK}>
                  privacy page
                </a>
                .
              </p>
              <AgreementTable
                columns={["Category", "Examples", "Kept for"]}
                rows={[
                  [
                    "Booking data",
                    "name, email, phone, country, stay dates, rooms, guests per room, extras, price, payment method, arrival time, requests",
                    "as the Hotel instructs, and as tax and accounting rules require",
                  ],
                  [
                    "Payment references",
                    "Stripe payment and refund IDs, amounts, status (never full card numbers)",
                    "as booking data",
                  ],
                  [
                    "Stay data in the PMS",
                    "check-in and check-out, room assignment, notes the Hotel adds",
                    "as the Hotel instructs",
                  ],
                  [
                    "Channel bookings",
                    "reservations the Hotel's connected sales channels send in",
                    "as booking data",
                  ],
                  [
                    "Optional analytics",
                    "pages and booking steps reached, choices made, a random tab identifier; no name, email, phone or IP",
                    "13 months, only with the guest's consent",
                  ],
                ]}
              />
              <p>
                No special categories of data (Article 9 GDPR) are intended. If a guest writes them
                into a free-text request, the Hotel remains responsible for that content.
              </p>
            </section>

            <section className="mt-12">
              <h2 className={H2}>4. vayada&apos;s obligations</h2>
              <ol className={OL}>
                <li>
                  <strong>Instructions: </strong>vayada processes the data only on the Hotel&apos;s
                  documented instructions. The hotel terms, this agreement and the Hotel&apos;s
                  settings and actions in the services are those instructions. If vayada thinks an
                  instruction breaks data protection law, it tells the Hotel without delay.
                </li>
                <li>
                  <strong>Confidentiality: </strong>everyone at vayada who can access the data is
                  bound to confidentiality.
                </li>
                <li>
                  <strong>Security: </strong>vayada keeps the measures in Annex 1 (Section 7) and
                  may improve them, but never lower the overall level of protection.
                </li>
                <li>
                  <strong>Assistance: </strong>vayada helps the Hotel, as far as it reasonably can,
                  with guests&apos; rights requests (Section 8), security of processing, breach
                  notifications, data protection impact assessments and consultations with
                  authorities.
                </li>
                <li>
                  <strong>Records: </strong>vayada keeps a record of the processing it carries out
                  for the Hotel (Article 30(2) GDPR).
                </li>
                <li>
                  <strong>Legal requests: </strong>if an authority demands the data, vayada informs
                  the Hotel first unless the law forbids it.
                </li>
              </ol>
            </section>

            <section className="mt-12 space-y-4">
              <h2 className={H2}>5. Sub-processors</h2>
              <p>
                The Hotel gives vayada general written authorisation to use the sub-processors
                below. vayada binds each one to the same data protection duties as this agreement
                and stays responsible for them.
              </p>
              <AgreementTable
                columns={["Sub-processor", "What it does", "Where data is processed"]}
                rows={[
                  [
                    "Amazon Web Services",
                    "hosting of the booking sites, the PMS and their databases",
                    "EU (Ireland)",
                  ],
                  ["Resend", "sending booking emails", "United States"],
                  [
                    "Stripe",
                    "card payments, only when the Hotel accepts cards",
                    "EU and United States",
                  ],
                  [
                    "Channex",
                    "exchanging availability and reservations with sales channels, only if the Hotel connects them",
                    "United Kingdom",
                  ],
                ]}
              />
              <p>
                <strong>Changes: </strong>vayada informs the Hotel at least 30 days before adding or
                replacing a sub-processor, for example by email or in Booking Admin. The Hotel may
                object on reasonable data protection grounds within that time. If the parties
                can&apos;t agree, the Hotel may end the affected service.
              </p>
              <p>
                <strong>Not sub-processors:</strong>
              </p>
              <ul className="list-disc pl-6 space-y-2">
                <li>
                  Google Maps (the guest map) loads only when a guest presses &quot;Show map&quot;
                  and processes the request under Google&apos;s own terms, so it acts as an
                  independent controller.
                </li>
                <li>
                  Cloudflare only runs vayada&apos;s domain names (DNS). Guest traffic to the
                  booking sites and the PMS goes straight to AWS and does not pass through
                  Cloudflare (checked 2026-10-24).
                </li>
              </ul>
            </section>

            <section className="mt-12 space-y-4">
              <h2 className={H2}>6. Transfers outside the EU</h2>
              <p>
                vayada stores the Hotel&apos;s data in the EU (AWS, Ireland). Resend and Stripe may
                process data in the United States; both are certified under the EU–US Data Privacy
                Framework (
                <a
                  href="https://resend.com/changelog/data-privacy-framework-certification"
                  className={LINK}
                >
                  Resend
                </a>
                ,{" "}
                <a href="https://stripe.com/legal/privacy-shield-policy" className={LINK}>
                  Stripe
                </a>
                ). Channex processes data in the United Kingdom, which the EU recognises as offering
                adequate protection. Where a certification lapses, the European Commission&apos;s
                standard contractual clauses (Decision (EU) 2021/914) apply instead.
              </p>
              <p>
                <em>
                  Checked 2026-10-24 on the providers&apos; own pages. Lawyer to confirm the UK
                  adequacy decision is still in force when hotels sign.
                </em>
              </p>
            </section>

            <section className="mt-12 space-y-4">
              <h2 className={H2}>7. Annex 1: security measures</h2>
              <p>
                These are the measures vayada keeps today, checked against the live setup on
                2026-10-24.
              </p>
              <AgreementTable
                columns={["Area", "Measure"]}
                rows={[
                  [
                    "Hosting",
                    "AWS in the EU (Ireland); the database accepts connections only from vayada's own services (firewall rules)",
                  ],
                  [
                    "Encryption",
                    "HTTPS/TLS for all traffic; the database, its backups and stored files encrypted at rest",
                  ],
                  [
                    "Separation between hotels",
                    "each hotel's data is kept apart in the database by row-level rules, so one hotel's staff can't read another's",
                  ],
                  [
                    "Access by hotel staff",
                    "logins through WorkOS; roles and property access set by the hotel's account admin in Team & Roles",
                  ],
                  [
                    "Access by vayada staff",
                    "only the people who run the service, with personal accounts and least privilege; production data changes only through reviewed migrations",
                  ],
                  [
                    "Card data",
                    "card numbers go straight to Stripe; vayada never sees or stores them",
                  ],
                  [
                    "Logging",
                    "server logs kept 30 days; analytics events hold no name, email, phone or IP",
                  ],
                  ["Abuse protection", "rate limits on booking lookups and public endpoints"],
                  [
                    "Backups and recovery",
                    "automated daily database backups, kept 7 days; the database is protected against accidental deletion",
                  ],
                  [
                    "Changes",
                    "every code change is reviewed and tested before release; releases are checked live for errors",
                  ],
                ]}
              />
            </section>

            <section className="mt-12">
              <h2 className={H2}>8. Guest requests and data breaches</h2>
              <ol className={OL}>
                <li>
                  <strong>Guest requests: </strong>if a guest asks vayada for access, correction,
                  deletion or a copy of their data, vayada passes the request to the Hotel without
                  delay and does not answer it alone. vayada helps the Hotel answer, for example by
                  exporting or deleting a booking.
                </li>
                <li>
                  <strong>Breach notification: </strong>vayada tells the Hotel without undue delay,
                  and in any case within 48 hours, after becoming aware of a personal data breach
                  affecting the Hotel&apos;s data. This leaves the Hotel time to meet its own
                  72-hour deadline (Article 33 GDPR).
                </li>
                <li>
                  <strong>What vayada reports: </strong>what happened, which data and roughly how
                  many guests are affected, the likely consequences, and what vayada has done or
                  proposes. Information that isn&apos;t known yet follows as soon as it is.
                </li>
              </ol>
            </section>

            <section className="mt-12">
              <h2 className={H2}>9. When the Hotel leaves</h2>
              <ol className={OL}>
                <li>When the services end, the Hotel can export its booking data for 30 days.</li>
                <li>
                  After that, vayada deletes the Hotel&apos;s guest data, including copies, within
                  90 days. Backups roll off within 7 days after that.
                </li>
                <li>
                  vayada keeps only what the law requires it to keep, such as invoices to the Hotel,
                  and only for as long as required.
                </li>
                <li>On request, vayada confirms the deletion in writing.</li>
              </ol>
            </section>

            <section className="mt-12">
              <h2 className={H2}>10. Audits and information</h2>
              <ol className={OL}>
                <li>
                  vayada gives the Hotel the information it needs to show that this agreement is
                  kept, for example this annex, its sub-processor list and written answers to
                  reasonable questions.
                </li>
                <li>
                  If that is not enough, the Hotel or an auditor bound to confidentiality may
                  inspect vayada&apos;s processing, with at least 30 days&apos; notice, during
                  business hours and at most once a year, unless a breach or an authority requires
                  more.
                </li>
                <li>
                  Each party bears its own costs of an audit, unless it reveals a material breach by
                  vayada.
                </li>
              </ol>
            </section>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
