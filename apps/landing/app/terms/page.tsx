import { Navigation, Footer } from "@/components/layout";

const H2 = "text-2xl font-bold text-primary-800 mb-4";
const H3 = "text-xl font-semibold text-gray-900 mb-3";

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-white flex flex-col">
      <Navigation />
      <main className="flex-1 pt-20">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
          <div className="mb-8">
            <h1 className="text-4xl md:text-5xl font-bold text-primary-800 mb-4">
              Terms of Service (AGB)
            </h1>
            <p className="text-gray-600">
              <strong>Effective Date:</strong> [to be set on approval]
            </p>
          </div>

          <div className="prose prose-lg max-w-none space-y-8 text-gray-700">
            <p className="text-lg leading-relaxed">
              These Terms of Service (&quot;Terms&quot;) are a legally binding agreement between
              vayada UG (haftungsbeschränkt) (&quot;vayada,&quot; &quot;we,&quot; &quot;us,&quot;
              or &quot;our&quot;) and the hotel, villa or other accommodation business
              (&quot;Hotel,&quot; &quot;you,&quot; or &quot;your&quot;) that registers for or uses
              the vayada property management system, booking engine and related services.
            </p>
            <p className="text-lg leading-relaxed">
              By creating an account, accessing or using the Services, you confirm that you have
              read, understood and agree to be bound by these Terms. The Services are offered to
              businesses only, not to consumers.
            </p>
            <p className="text-lg leading-relaxed">
              If you are a guest booking a stay on a hotel&apos;s booking site that runs on vayada,
              your contract is with that hotel. These Terms do not apply to you; see Section 6.
            </p>

            <section className="mt-12">
              <h2 className={H2}>1. Definitions</h2>
              <div className="space-y-3">
                <p>
                  <strong>Platform:</strong> The websites, applications and technology operated by
                  vayada, including vayada.com, Booking Admin and the PMS.
                </p>
                <p>
                  <strong>Services:</strong> The property management system (PMS), the booking
                  engine with the hosted booking sites it serves, the channel connections, the
                  hotel setup and all related features, tools and support offered by vayada.
                </p>
                <p>
                  <strong>Hotel:</strong> The business that holds the account. Hotels may run one or
                  more properties from the same account.
                </p>
                <p>
                  <strong>User:</strong> Any natural person who accesses the Services on behalf of
                  a Hotel, such as an owner, manager or staff member.
                </p>
                <p>
                  <strong>Guest:</strong> A person who views a Hotel&apos;s booking site or books a
                  stay through it.
                </p>
                <p>
                  <strong>Hotel Content:</strong> Any text, images, rates, availability, policies
                  and other data a Hotel enters into or uploads to the Platform.
                </p>
              </div>
            </section>

            <section className="mt-12">
              <h2 className={H2}>2. Eligibility and Account Registration</h2>

              <div className="mt-6">
                <h3 className={H3}>2.1 Eligibility</h3>
                <p>
                  The Services are available only to businesses and to individuals who are at least
                  18 years old and act on behalf of a business. The person who registers represents
                  and warrants that they have the authority to bind the Hotel to these Terms.
                </p>
              </div>

              <div className="mt-6">
                <h3 className={H3}>2.2 Account Registration</h3>
                <div className="space-y-3">
                  <p>
                    <strong>Accurate Information:</strong> You must provide accurate, complete and
                    current information when you register and set up your property, and keep it up
                    to date. We may ask you to confirm your email address and to verify your
                    business before certain features (for example card payouts) are enabled.
                  </p>
                  <p>
                    <strong>Security:</strong> You are responsible for keeping your login details
                    confidential, for every User you invite to your account and for all activity
                    that occurs under your account. Tell us immediately if you suspect unauthorised
                    use.
                  </p>
                  <p>
                    <strong>Refusal and Suspension:</strong> vayada may refuse a registration or
                    suspend an account if information turns out to be false or misleading, or if an
                    account is used in breach of these Terms.
                  </p>
                </div>
              </div>
            </section>

            <section className="mt-12">
              <h2 className={H2}>3. The Services</h2>

              <div className="mt-6">
                <h3 className={H3}>3.1 Property Management System</h3>
                <p>
                  The PMS lets you manage rooms, rates, availability, reservations, guests and
                  related operations of your property. You decide what you enter and remain
                  responsible for the correctness of your rates, availability, policies and guest
                  records.
                </p>
              </div>

              <div className="mt-6">
                <h3 className={H3}>3.2 Booking Engine and Hosted Booking Sites</h3>
                <p>
                  The booking engine lets Guests book your property on a booking site that vayada
                  hosts for you, under a vayada address or your own domain. vayada provides the
                  software and the hosting; the booking contract is concluded between you and the
                  Guest. You are responsible for the content of your booking site, for your prices,
                  taxes, cancellation and payment policies, and for fulfilling every booking.
                </p>
              </div>

              <div className="mt-6">
                <h3 className={H3}>3.3 Third-Party Connections</h3>
                <p>
                  The Services can connect to third-party services you choose to use, such as a
                  channel manager and online travel agencies, an Airbnb listing import, or Stripe
                  for card payments and payouts. Those services run under their own terms and
                  require your own accounts with them. vayada is not responsible for their
                  availability, their fees or the way they handle your data.
                </p>
              </div>

              <div className="mt-6">
                <h3 className={H3}>3.4 Availability and Changes</h3>
                <p>
                  We work to keep the Services available at all times but cannot guarantee
                  uninterrupted operation. We may change, add or remove features, and we may
                  interrupt the Services for maintenance, security or legal reasons. Where a change
                  materially reduces the Services you pay for, we will inform you in advance.
                </p>
              </div>
            </section>

            <section className="mt-12">
              <h2 className={H2}>4. Hotel Obligations</h2>
              <p>You agree to:</p>
              <ul className="list-disc list-inside ml-4 space-y-2 mt-2">
                <li>
                  operate your property lawfully and hold every licence, registration and
                  insurance your business requires;
                </li>
                <li>
                  describe your property accurately and keep rates, availability and policies on
                  the Platform correct and up to date;
                </li>
                <li>
                  honour every booking taken through the Services at the price and under the
                  conditions shown to the Guest;
                </li>
                <li>
                  handle Guest data lawfully, inform your Guests as required by data protection law
                  and use Guest data only for the stay and your own lawful purposes;
                </li>
                <li>
                  account for all taxes and tourist levies that apply to your bookings;
                </li>
                <li>
                  not upload unlawful, misleading or infringing content, not interfere with the
                  Platform and not use it to send unsolicited messages.
                </li>
              </ul>
            </section>

            <section className="mt-12">
              <h2 className={H2}>5. Fees and Payment</h2>
              <div className="space-y-3">
                <p>
                  <strong>Plans:</strong> The Services are offered under the plans shown on our
                  pricing page or agreed with you in writing, either as a commission on bookings
                  taken through the booking engine or as a subscription. The plan you choose, its
                  price and its billing period are shown in your account.
                </p>
                <p>
                  <strong>Billing:</strong> Subscriptions are invoiced in advance for each billing
                  period. Commissions are calculated from the completed bookings of each period and
                  invoiced afterwards. All prices are net of VAT unless stated otherwise.
                </p>
                <p>
                  <strong>Card Payments:</strong> Card payments from Guests are processed by Stripe
                  on a Stripe account in your name. Guest funds are paid out to you by Stripe; our
                  fees are deducted or invoiced as described in your plan. vayada does not hold
                  Guest funds.
                </p>
                <p>
                  <strong>Late Payment:</strong> If an invoice is not paid when due, we may remind
                  you, charge statutory default interest and, after notice, suspend the Services
                  until the amount is settled.
                </p>
                <p>
                  <strong>Price Changes:</strong> We may change our prices with at least 30
                  days&apos; notice. If you do not accept a change, you may terminate before it
                  takes effect.
                </p>
              </div>
            </section>

            <section className="mt-12">
              <h2 className={H2}>6. Guest Bookings and Payments</h2>
              <p>
                Every booking made on your booking site is a contract between you and the Guest.
                vayada is not a party to that contract, does not act as a travel agent and is not
                responsible for the stay, its price, cancellations, refunds or disputes between
                you and a Guest. Guest payments are handled according to the payment methods and
                policies you configure. Refunds to Guests are your responsibility and are executed
                through the payment method the Guest used.
              </p>
            </section>

            <section className="mt-12">
              <h2 className={H2}>7. Data Protection</h2>
              <div className="space-y-3">
                <p>
                  Our{" "}
                  <a href="/privacy" className="text-primary-600 hover:text-primary-700 underline">
                    Privacy Policy
                  </a>{" "}
                  describes how we handle personal data of Users and Guests.
                </p>
                <p>
                  For Guest data and other personal data you enter into the Services, you are the
                  controller and vayada processes that data on your behalf and on your instructions
                  (Article 28 GDPR). A data processing agreement forms part of these Terms; the
                  current version is available from us on request.
                </p>
              </div>
            </section>

            <section className="mt-12">
              <h2 className={H2}>8. Intellectual Property and Content</h2>

              <div className="mt-6">
                <h3 className={H3}>8.1 Hotel Content</h3>
                <p>
                  You keep all rights in your Hotel Content. By entering it into the Platform you
                  grant vayada a non-exclusive, worldwide, royalty-free licence to host, display,
                  reproduce and transmit it as far as necessary to provide the Services, for
                  example to show your property on your booking site and to send it to the
                  channels you connect. You warrant that you hold the rights needed for this.
                </p>
              </div>

              <div className="mt-6">
                <h3 className={H3}>8.2 vayada Software</h3>
                <p>
                  The Platform, its software, design and documentation remain the property of
                  vayada or its licensors. You receive a non-exclusive, non-transferable right to
                  use them for your business during the term of these Terms. You may not copy,
                  modify, resell or reverse-engineer the Platform.
                </p>
              </div>
            </section>

            <section className="mt-12">
              <h2 className={H2}>9. Disclaimers and Limitation of Liability</h2>

              <div className="mt-6">
                <h3 className={H3}>9.1 No Warranty</h3>
                <p>
                  The Services are provided on an &quot;as is&quot; and &quot;as available&quot;
                  basis. vayada makes no warranty, express or implied, about the number of bookings
                  or the revenue you will achieve, or about the services of third parties you
                  connect to the Platform.
                </p>
              </div>

              <div className="mt-6">
                <h3 className={H3}>9.2 Limitation of Liability (Haftungsbeschränkung)</h3>
                <ul className="list-disc list-inside ml-4 space-y-2">
                  <li>
                    vayada shall only be liable for damages caused by intent or gross negligence.
                  </li>
                  <li>
                    vayada shall only be liable for typical, foreseeable damages arising from the
                    negligent breach of essential contractual obligations (cardinal obligations).
                  </li>
                  <li>Any other liability on the part of vayada is excluded.</li>
                  <li>
                    The limitations of liability above do not apply to damages resulting from injury
                    to life, body or health, or under the German Product Liability Act.
                  </li>
                  <li>
                    vayada is not liable for the actions, omissions or content of any Hotel or
                    Guest, nor for any breach of a booking contract between a Hotel and a Guest.
                  </li>
                </ul>
              </div>
            </section>

            <section className="mt-12">
              <h2 className={H2}>10. Term, Termination and Data After Termination</h2>
              <div className="space-y-3">
                <p>
                  <strong>Term:</strong> These Terms start when you register and continue until
                  terminated. Subscriptions run for the billing period shown in your account and
                  renew automatically unless terminated before the period ends.
                </p>
                <p>
                  <strong>Termination by the Hotel:</strong> You may terminate at any time from
                  your account or by writing to us; a subscription ends at the end of the current
                  billing period.
                </p>
                <p>
                  <strong>Termination by vayada:</strong> vayada may terminate or suspend your
                  access immediately, without prior notice, if you breach these Terms, provide false
                  information, fail to pay after a reminder, or engage in fraudulent or illegal
                  activity. Otherwise vayada may terminate with 30 days&apos; notice.
                </p>
                <p>
                  <strong>Your Data:</strong> After termination you can export your data from your
                  account for 30 days. We then delete your account data, except where we must keep
                  it under statutory retention periods. Bookings already confirmed to Guests remain
                  your responsibility.
                </p>
              </div>
            </section>

            <section className="mt-12">
              <h2 className={H2}>11. Changes to These Terms</h2>
              <p>
                We may update these Terms. We will inform you of material changes by email or in
                your account at least 30 days before they take effect. If you continue to use the
                Services after that date, the updated Terms apply. If you do not agree, you may
                terminate before the changes take effect.
              </p>
            </section>

            <section className="mt-12">
              <h2 className={H2}>12. Governing Law and Jurisdiction</h2>
              <div className="space-y-3">
                <p>
                  <strong>Governing Law:</strong> These Terms and any dispute or claim arising out
                  of or in connection with them or their subject matter or formation (including
                  non-contractual disputes or claims) shall be governed by and construed in
                  accordance with the laws of Germany, excluding its conflicts of law principles and
                  the UN Convention on Contracts for the International Sale of Goods (CISG).
                </p>
                <p>
                  <strong>Jurisdiction:</strong> The exclusive place of jurisdiction for all
                  disputes arising from or in connection with these Terms shall be Düsseldorf,
                  Germany, provided the Hotel is a merchant, a legal entity under public law, or a
                  special fund under public law.
                </p>
              </div>
            </section>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
