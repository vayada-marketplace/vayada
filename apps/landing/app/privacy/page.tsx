import { Navigation, Footer } from "@/components/layout";

const H2 = "text-2xl font-bold text-primary-800 mb-4";
const H3 = "text-xl font-semibold text-gray-900 mb-3";
const TH = "border border-gray-300 px-4 py-3 text-left font-semibold text-gray-900";
const TD = "border border-gray-300 px-4 py-3";
const LINK = "text-primary-600 hover:text-primary-700 underline";

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-white flex flex-col">
      <Navigation />
      <main className="flex-1 pt-20">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
          <div className="mb-8">
            <h1 className="text-4xl md:text-5xl font-bold text-primary-800 mb-4">Privacy Policy</h1>
            <p className="text-gray-600">
              <strong>Effective Date:</strong> October 20, 2026
            </p>
          </div>

          <div className="prose prose-lg max-w-none space-y-8 text-gray-700">
            <p className="text-lg leading-relaxed">
              This Privacy Policy describes how vayada (&quot;we,&quot; &quot;us,&quot; or
              &quot;our&quot;) collects, uses and shares personal data when you visit vayada.com or
              use the vayada property management system, Booking Admin and booking engine
              (collectively, the &quot;Services&quot;) on behalf of a hotel, villa or other
              accommodation business (&quot;Hotel&quot;).
            </p>
            <p className="text-lg leading-relaxed">
              If you are visiting or booking on a hotel&apos;s booking site that runs on vayada, see{" "}
              <a href="#booking-guests" className={LINK}>
                Section 9
              </a>
              .
            </p>

            <section className="mt-12">
              <h2 className={H2}>1. Data Controller</h2>
              <p>
                The Controller (Verantwortlicher) for data processing on our online offering, within
                the meaning of the General Data Protection Regulation, is:
              </p>
              <div className="mt-4 space-y-2 text-gray-700">
                <p className="font-semibold text-gray-900">vayada UG (haftungsbeschränkt)</p>
                <p>Speditionstr. 15A</p>
                <p>40221 Düsseldorf</p>
                <p>Germany</p>
                <p className="mt-3">Represented by: Managing Director: Timo Christian Schreyer</p>
                <p>
                  Contact: E-Mail:{" "}
                  <a href="mailto:t.schreyer@vayada.com" className={LINK}>
                    t.schreyer@vayada.com
                  </a>
                </p>
                <p className="mt-3">
                  For guest data on hotel booking sites and in the PMS, the Hotel is the controller
                  and vayada is its processor; see{" "}
                  <a href="#booking-guests" className={LINK}>
                    Section 9
                  </a>
                  .
                </p>
                <p className="mt-3">
                  For full legal details, please refer to our{" "}
                  <a href="/imprint" className={LINK}>
                    Imprint
                  </a>
                  .
                </p>
              </div>
            </section>

            <section className="mt-12">
              <h2 className={H2}>2. Information We Collect</h2>
              <p>
                We collect information that identifies, relates to, describes, or is capable of
                being associated with you (&quot;Personal Data&quot;).
              </p>

              <div className="mt-6">
                <h3 className={H3}>A. Information You Provide Directly</h3>
                <p className="mb-4">
                  This information is collected when you create an account, set up a property, use
                  the Services or communicate with us.
                </p>

                <div className="overflow-x-auto mt-6">
                  <table className="min-w-full border-collapse border border-gray-300">
                    <thead>
                      <tr className="bg-gray-100">
                        <th className={TH}>Data Category</th>
                        <th className={TH}>Examples of Data Collected</th>
                        <th className={TH}>Purpose and Legal Basis</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className={`${TD} font-medium`}>Account Data</td>
                        <td className={TD}>
                          Name, email address, password, phone number, profile photo, language, and
                          the Hotel account and role you belong to.
                        </td>
                        <td className={TD}>
                          To create and secure your account and let you work in your Hotel&apos;s
                          account (Article 6(1) lit. b GDPR).
                        </td>
                      </tr>
                      <tr className="bg-gray-50">
                        <td className={`${TD} font-medium`}>Property Data</td>
                        <td className={TD}>
                          Property name, address and map location, description and photos, contact
                          details, rooms, rates, availability, policies, add-ons and the design of
                          your booking site.
                        </td>
                        <td className={TD}>
                          To run your PMS and your booking site and to send your property to the
                          channels you connect (Article 6(1) lit. b GDPR).
                        </td>
                      </tr>
                      <tr>
                        <td className={`${TD} font-medium`}>Business and Payout Data</td>
                        <td className={TD}>
                          Company details, VAT number, invoice address, the plan you chose,
                          invoices, and the Stripe account used for card payouts. Bank and identity
                          details for payouts are collected and held by Stripe, not by vayada.
                        </td>
                        <td className={TD}>
                          To bill you, pay out card payments and meet tax and accounting rules
                          (Article 6(1) lit. b and c GDPR).
                        </td>
                      </tr>
                      <tr className="bg-gray-50">
                        <td className={`${TD} font-medium`}>Guest Data</td>
                        <td className={TD}>
                          Bookings, guest names and contact details, stay details, payments and
                          messages that you enter or that arrive through your booking site or
                          connected channels.
                        </td>
                        <td className={TD}>
                          Processed on the Hotel&apos;s behalf and instructions as its processor
                          (Article 28 GDPR); see Section 9.
                        </td>
                      </tr>
                      <tr>
                        <td className={`${TD} font-medium`}>Support and Contact Data</td>
                        <td className={TD}>
                          Messages you send us through the contact form, support requests from the
                          apps, and our replies.
                        </td>
                        <td className={TD}>
                          To answer you and improve the Services (Article 6(1) lit. b and f GDPR);
                          see Section 8.
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="mt-8">
                <h3 className={H3}>B. Information Collected Automatically</h3>
                <p className="mb-4">
                  When you access our Services, we automatically collect certain data about your
                  device and activity.
                </p>

                <div className="overflow-x-auto mt-6">
                  <table className="min-w-full border-collapse border border-gray-300">
                    <thead>
                      <tr className="bg-gray-100">
                        <th className={TH}>Data Category</th>
                        <th className={TH}>Examples of Data Collected</th>
                        <th className={TH}>Purpose and Legal Basis</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className={`${TD} font-medium`}>Technical Data</td>
                        <td className={TD}>
                          IP address, browser type, operating system, the pages and actions you
                          request, timestamps and error reports, recorded in our server logs.
                        </td>
                        <td className={TD}>
                          To keep the Services secure and working and to troubleshoot errors
                          (Article 6(1) lit. f GDPR). Logs are kept for 30 days, then deleted.
                        </td>
                      </tr>
                      <tr className="bg-gray-50">
                        <td className={`${TD} font-medium`}>Login and Session Data</td>
                        <td className={TD}>
                          Session cookies and security tokens set when you sign in, including
                          through Google sign-in, and the time and origin of your sign-ins.
                        </td>
                        <td className={TD}>
                          To keep you signed in and protect your account (Article 6(1) lit. b and f
                          GDPR). These cookies are necessary and are deleted when the session ends.
                        </td>
                      </tr>
                      <tr>
                        <td className={`${TD} font-medium`}>Website Analytics (vayada.com)</td>
                        <td className={TD}>
                          Only if you accept analytics cookies: which pages of vayada.com you view,
                          your approximate country and the site you came from, collected through
                          Cloudflare Web Analytics without a persistent identifier.
                        </td>
                        <td className={TD}>
                          To understand how our website is used (Article 6(1) lit. a GDPR). You can
                          change your choice at any time in the cookie settings.
                        </td>
                      </tr>
                      <tr className="bg-gray-50">
                        <td className={`${TD} font-medium`}>Activity Records</td>
                        <td className={TD}>
                          Who changed what in a Hotel account, for example rate changes, booking
                          actions and settings, with the time of the change.
                        </td>
                        <td className={TD}>
                          To let Hotels trace changes, resolve disputes and prevent misuse (Article
                          6(1) lit. f GDPR).
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </section>

            <section className="mt-12">
              <h2 className={H2}>3. How We Use Your Information</h2>
              <p>We use your personal data for the following purposes:</p>
              <ul className="list-disc list-inside ml-4 space-y-2 mt-4">
                <li>
                  <strong>To Provide the Services:</strong> To run your account, your PMS, your
                  booking site and the hotel setup, and to let the people you invite work in your
                  Hotel account.
                </li>
                <li>
                  <strong>To Take and Manage Bookings:</strong> To receive bookings from your
                  booking site and connected channels, to process payments through the payment
                  methods you enable, and to send booking emails to you and your guests on your
                  behalf.
                </li>
                <li>
                  <strong>To Connect Your Channels:</strong> To exchange rates, availability and
                  reservations with the channel manager, online travel agencies and Airbnb listing
                  you choose to connect.
                </li>
                <li>
                  <strong>To Bill You:</strong> To calculate commissions or subscriptions, issue
                  invoices and pay out card payments through Stripe.
                </li>
                <li>
                  <strong>To Communicate:</strong> To send service-related, administrative or
                  account-specific notifications and, where you have agreed, marketing
                  communications about vayada features.
                </li>
                <li>
                  <strong>For Security and Compliance:</strong> To prevent fraud, enforce our Terms,
                  comply with legal obligations, and protect the rights and safety of vayada, its
                  Hotels and their guests.
                </li>
              </ul>
            </section>

            <section className="mt-12">
              <h2 className={H2}>4. How We Share and Disclose Your Information</h2>
              <p>We share your information in the following ways:</p>

              <div className="mt-6">
                <h3 className={H3}>A. Within Your Hotel Account</h3>
                <p>
                  The people you invite to your Hotel account see the property, bookings and guest
                  data of that account according to their role. Your name and email address are
                  visible to them as the person who made a change.
                </p>
              </div>

              <div className="mt-6">
                <h3 className={H3}>B. Service Providers</h3>
                <p className="mb-3">
                  We use third-party companies to provide the Services (&quot;Service
                  Providers&quot;). They have access to Personal Data only to perform these tasks on
                  our behalf and may not use it for any other purpose:
                </p>
                <ul className="list-disc list-inside ml-4 space-y-2">
                  <li>
                    <strong>Hosting:</strong> Amazon Web Services, European Union (Ireland), for the
                    applications, databases, file storage and server logs.
                  </li>
                  <li>
                    <strong>Sign-in:</strong> WorkOS, for your account login, password reset, email
                    verification and Google sign-in.
                  </li>
                  <li>
                    <strong>Payments:</strong> Stripe, for card payments on your booking site, your
                    payout account and our own invoicing.
                  </li>
                  <li>
                    <strong>Email:</strong> Resend, for the service and booking emails we send and
                    to deliver contact form messages and support requests to our team.
                  </li>
                  <li>
                    <strong>Team mailboxes:</strong> Google Workspace, where contact form messages
                    and support requests arrive and where we keep our email correspondence with you.
                  </li>
                  <li>
                    <strong>Channel connections:</strong> Channex, the channel manager behind the
                    online travel agency and Airbnb connections you enable, which receives your
                    rates, availability and the reservations of those channels.
                  </li>
                  <li>
                    <strong>Maps:</strong> Google Maps, which loads only on the setup and settings
                    pages where you place your property on a map and then receives your browser
                    requests under Google&apos;s own privacy policy.
                  </li>
                  <li>
                    <strong>Website analytics:</strong> Cloudflare Web Analytics on vayada.com, only
                    with your consent.
                  </li>
                </ul>
                <p className="mt-3">
                  Stripe, WorkOS, Resend and Google may process data in the United States; these
                  transfers are covered by the EU–US Data Privacy Framework or the European
                  Commission&apos;s standard contractual clauses.
                </p>
              </div>

              <div className="mt-6">
                <h3 className={H3}>C. Legal and Compliance</h3>
                <p>
                  We may disclose your information if required to do so by law or in the good faith
                  belief that such action is necessary to comply with a legal obligation, protect
                  and defend the rights or property of vayada, prevent fraud, or protect the
                  personal safety of users or the public.
                </p>
              </div>

              <p className="mt-6">
                We do not sell Personal Data, and we do not share Hotel or guest data with other
                Hotels.
              </p>
            </section>

            <section className="mt-12">
              <h2 className={H2}>5. Retention, Your Privacy Rights and Choices</h2>
              <p className="mb-4">
                We keep your account and property data for as long as your Hotel account exists and
                for 30 days after it is closed, so that you can export it. Invoices and booking
                records that tax and commercial law require us to keep are retained for the
                statutory periods (usually up to ten years, Article 6(1) lit. c GDPR). Server logs
                are deleted as described above. Messages from the contact form (see Section 8) and
                support requests from the apps are emailed to our team and deleted from our database
                90 days after you send them.
              </p>
              <p className="mb-4">You have the following rights regarding your Personal Data:</p>
              <ul className="list-disc list-inside ml-4 space-y-2">
                <li>
                  <strong>Access:</strong> You have the right to request a copy of the Personal Data
                  we hold about you.
                </li>
                <li>
                  <strong>Correction:</strong> You have the right to request that we correct any
                  inaccurate Personal Data.
                </li>
                <li>
                  <strong>Deletion:</strong> You have the right to request that we delete your
                  Personal Data, subject to certain exceptions (e.g., legal compliance).
                </li>
                <li>
                  <strong>Restriction, portability and objection:</strong> You can ask for
                  processing to be restricted, receive your data in a portable format, and object to
                  processing based on legitimate interests (Article 6(1) lit. f GDPR).
                </li>
                <li>
                  <strong>Withdraw consent:</strong> You can withdraw any consent at any time, for
                  example in the cookie settings of vayada.com, without affecting processing before
                  you withdrew it.
                </li>
                <li>
                  <strong>Opt-Out:</strong> You can opt out of marketing emails with the unsubscribe
                  link in those emails. You cannot opt out of service-related communications (e.g.,
                  account verification, security alerts).
                </li>
              </ul>
              <p className="mt-4">
                You can export your data and delete your account from the privacy settings of your
                account, or contact us using the information in Section 7. You also have the right
                to complain to a data protection supervisory authority.
              </p>
            </section>

            <section className="mt-12">
              <h2 className={H2}>6. Data Security</h2>
              <p>
                We implement reasonable security measures designed to protect the Personal Data we
                collect from unauthorized access, use, alteration, or destruction. Please note,
                however, that no method of transmission over the Internet or method of electronic
                storage is 100% secure. While we strive to use commercially acceptable means to
                protect your Personal Data, we cannot guarantee its absolute security.
              </p>
            </section>

            <section className="mt-12">
              <h2 className={H2}>7. Contact Us</h2>
              <p className="mb-4">
                If you have any questions about this Privacy Policy or our data practices, please
                contact us at:
              </p>
              <div className="space-y-2 text-gray-700">
                <p className="font-semibold text-gray-900">vayada</p>
                <p>
                  Email:{" "}
                  <a href="mailto:privacy@vayada.com" className={LINK}>
                    privacy@vayada.com
                  </a>
                </p>
                <p>Mailing Address: Speditionstraße 15A, 40221 Duesseldorf, Germany</p>
              </div>
            </section>

            <section className="mt-12">
              <h2 className={H2}>8. Contact Form and Communication</h2>

              <div className="mt-6">
                <h3 className={H3}>A. Data Processing via Contact Form</h3>
                <p className="mb-3">
                  We provide an online form on our site to allow you to contact us electronically.
                  When you submit an inquiry, we process the data you provide. The specific fields
                  collected include:
                </p>
                <ul className="list-disc list-inside ml-4 space-y-2">
                  <li>
                    <strong>Required Data:</strong> Your Name, Email Address, and your Message.
                  </li>
                  <li>
                    <strong>Optional Data:</strong> Your Phone Number, Company Name, Country, and
                    the User Category (&quot;I am a...&quot;).
                  </li>
                </ul>
              </div>

              <div className="mt-6">
                <h3 className={H3}>B. Purpose and Legal Basis</h3>
                <p className="mb-3">
                  We process this data solely for the purpose of answering your inquiry and the
                  related technical administration.
                </p>
                <p>
                  <strong>Legal Basis:</strong> Processing of this data is based on Article 6(1)
                  lit. b of the GDPR (General Data Protection Regulation), as the processing is
                  necessary for the performance of a contract or in order to take steps at your
                  request prior to entering into a contract (e.g., setting up a new Hotel account).
                </p>
              </div>

              <div className="mt-6">
                <h3 className={H3}>C. Internal Handling and International Transfer</h3>
                <p>
                  We store your inquiry in our database, hosted by Amazon Web Services in the
                  European Union (Ireland), and send it by email to the member of our team who
                  answers inquiries; our mailboxes are hosted by Google Workspace. That email goes
                  through Resend, our email service provider. Resend and Google may process it in
                  the United States; these transfers are covered by the EU–US Data Privacy Framework
                  or the European Commission&apos;s standard contractual clauses. When you or we
                  reply, the conversation continues by email.
                </p>
              </div>

              <div className="mt-6">
                <h3 className={H3}>D. Data Retention and Deletion</h3>
                <p className="mb-3">
                  We delete your inquiry from our database 90 days after you send it; our automatic
                  database backups are overwritten within seven days after that. The notification
                  email and the emails we exchange with you are kept in our mailboxes only as long
                  as we need them to handle your inquiry.
                </p>
                <p>
                  If your inquiry leads to a contract, warranty, or guarantee claim, we keep that
                  correspondence for the statutory retention periods (e.g., commercial and tax law,
                  typically up to ten years, as per Article 6(1) lit. c of the GDPR) and delete it
                  at the latest when these periods expire, without requiring a specific request from
                  you.
                </p>
              </div>

              <div className="mt-6">
                <h3 className={H3}>E. Support Requests from the Apps</h3>
                <p>
                  When you send a support request or bug report from Booking Admin or the PMS, we
                  store your message, the request type, the app and page you sent it from, your
                  name, email address and user ID, and your account&apos;s ID and name, and look up
                  the names of the hotels in your account. We handle it like a contact form inquiry:
                  it is emailed to our team through Resend, arrives in our Google Workspace
                  mailboxes, and is deleted from our database 90 days after you send it (Article
                  6(1) lit. b GDPR, to help you use the Services).
                </p>
              </div>
            </section>

            <section id="booking-guests" className="mt-12 scroll-mt-24">
              <h2 className="text-2xl font-bold text-primary-800 mb-4">
                9. Guests of Hotel Booking Sites
              </h2>
              <p className="mb-4">
                Hotels use vayada to run their own booking sites (for example
                hotel-name.booking.vayada.com, or a hotel&apos;s own domain). This section explains
                how your data is handled when you visit or book on such a site.
              </p>

              <div className="mt-6">
                <h3 className="text-xl font-semibold text-gray-900 mb-3">A. Who Is Responsible</h3>
                <p>
                  The hotel named on the booking site is the controller for your booking and for the
                  optional analytics on its booking site. vayada runs the booking site and processes
                  this data on the hotel&apos;s behalf and on its instructions (Article 28 GDPR).
                  vayada is the controller for its own server logs and for the partner-link records
                  described below. The hotel&apos;s contact details are shown at the bottom of its
                  booking site.
                </p>
              </div>

              <div className="mt-6">
                <h3 className="text-xl font-semibold text-gray-900 mb-3">
                  B. What the Booking Site Processes
                </h3>
                <ul className="list-disc list-inside ml-4 space-y-2">
                  <li>
                    <strong>Your booking:</strong> your name, email address, phone number, country,
                    stay dates, rooms, guests, extras, price and payment method, and any arrival
                    time or requests you add. The hotel uses this data to take and manage your
                    booking and to contact you about it (Article 6(1) lit. b GDPR), and keeps it as
                    long as it needs it for your stay and as tax and accounting rules require
                    (Article 6(1) lit. c GDPR).
                  </li>
                  <li>
                    <strong>Technical data:</strong> our servers log each request, including your IP
                    address, to keep the booking site secure and working. These logs are kept for 30
                    days. When you look up a booking, we also count the attempts from your IP
                    address for one minute, in memory only, to stop abuse; this count is not stored
                    (Article 6(1) lit. f GDPR).
                  </li>
                  <li>
                    <strong>Optional analytics (only if you allow it):</strong> which pages and
                    booking steps you reach, the room, extras and payment method you choose, whether
                    the booking goes through, and any error, together with a random identifier for
                    your browser tab. The hotel uses this to see where guests leave the booking.
                    These events contain no name, email address or phone number, and we do not keep
                    your IP address, or anything derived from it, with them. We keep them for 13
                    months (Article 6(1) lit. a GDPR). Your choice is saved in your browser&apos;s
                    local storage, for that hotel&apos;s booking site only.
                  </li>
                  <li>
                    <strong>Partner links:</strong> if you arrive through a link from one of the
                    hotel&apos;s referral partners, we record the partner code, the page you arrived
                    on and the site you came from, so the partner can be credited (Article 6(1) lit.
                    f GDPR).
                  </li>
                  <li>
                    <strong>Your browser:</strong> the booking site also keeps a few necessary items
                    in your browser: the currency you chose, and the booking details you are filling
                    in (for the current tab only).
                  </li>
                </ul>
              </div>

              <div className="mt-6">
                <h3 className="text-xl font-semibold text-gray-900 mb-3">
                  C. Card Payments and Other Services
                </h3>
                <p className="mb-3">
                  If you pay by card, your card details go directly to Stripe, the payment provider
                  for card payments on the booking site; neither the hotel nor vayada sees your full
                  card number. Stripe&apos;s payment form (Stripe.js) loads only when you open the
                  card payment form, and Stripe processes your data under its own{" "}
                  <a
                    href="https://stripe.com/privacy"
                    className="text-primary-600 hover:text-primary-700 underline"
                  >
                    privacy policy
                  </a>
                  . To prevent fraud, Stripe.js stores two cookies on the booking site once the card
                  payment form opens: __stripe_mid (for one year) and __stripe_sid (for 30 minutes).
                </p>
                <p className="mb-3">
                  The booking site and booking data are hosted by Amazon Web Services in the
                  European Union (Ireland). Booking emails are sent through Resend. Stripe and
                  Resend may process data in the United States; these transfers are covered by the
                  EU–US Data Privacy Framework or the European Commission&apos;s standard
                  contractual clauses.
                </p>
                <p>
                  Fonts, images and all other parts of the booking site are served by vayada. Before
                  you pay by card, the booking site does not load content from other companies, such
                  as Google Fonts.
                </p>
              </div>

              <div className="mt-6">
                <h3 className="text-xl font-semibold text-gray-900 mb-3">D. Your Rights</h3>
                <p className="mb-3">
                  You can ask for access to your data, for its correction or deletion, for its use
                  to be restricted, or to receive it in a portable format. You can object to
                  processing based on legitimate interests (Article 6(1) lit. f GDPR). You can
                  withdraw your analytics consent at any time with the &quot;Privacy choices&quot;
                  button on the booking site; this stops further events and does not affect
                  processing before you withdrew it.
                </p>
                <p>
                  Please send requests to the hotel. You can also write to us at{" "}
                  <a
                    href="mailto:privacy@vayada.com"
                    className="text-primary-600 hover:text-primary-700 underline"
                  >
                    privacy@vayada.com
                  </a>
                  , and we will pass your request on to the hotel. You also have the right to
                  complain to a data protection supervisory authority.
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
