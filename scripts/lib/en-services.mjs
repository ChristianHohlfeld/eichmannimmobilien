/**
 * English service pages (local SEO, counterpart of PR #96). Content only – rendered by scripts/build-en-pages.mjs.
 * Rules: only verifiable facts (contact, address, commission wording from the exposés, Allmannsdorf commission-free),
 * no numbers beyond contact data / listing data, nothing about planning permission or construction status, no countdowns,
 * no claim about the language Helmut answers in (existing contact wording only: "will get back to you personally").
 * Pairs: hreflang de/en, x-default = en (data/sot/pages.json "x_default": "en").
 */
const GBP = "https://maps.google.com/?cid=833589220849724025";
const IMMOWELT = "https://www.immowelt.de/profil/3b18336c6a2e401da38e9cc20268270d";
export const EN_SERVICE_LINKS = { GBP, IMMOWELT };

const A = (href, text) => `<a href="${href}">${text}</a>`;
const L = {
  agent: A("/en/real-estate-agent-konstanz.html", "real estate agent in Konstanz"),
  valuation: A("/en/property-valuation-konstanz.html", "property valuation in Konstanz"),
  sellHouse: A("/en/sell-house-konstanz.html", "selling a house in Konstanz"),
  sellFlat: A("/en/sell-apartment-konstanz.html", "selling an apartment in Konstanz"),
  buyFlat: A("/en/buy-apartment-konstanz.html", "buying an apartment in Konstanz"),
  mfh: A("/en/multi-family-house-konstanz.html", "multi-family houses in Konstanz"),
  peters: A("/en/petershausen.html", "Petershausen"),
  services: A("/en/services.html", "all services"),
  abroad: A("/en/buying-from-abroad.html", "buying from abroad"),
  allm: A("/en/allmannsdorf.html", "New-build Allmannsdorf"),
  contact: A("/en/contact.html", "contact form"),
};
const P = (...xs) => xs.map((x) => `        <p>${x}</p>`).join("\n");
const sec = (h2, body, alt = false) => `    <section class="section${alt ? " section-alt" : ""}">
      <div class="container narrow prose">
        <h2>${h2}</h2>
${body}
      </div>
    </section>`;
const DOCS_NOTE = "Please note that official documents in Germany – land register extract, energy performance certificate, declaration of division, minutes of owners' meetings and the notarial purchase contract – are in German.";

/** filter on the English listing model (name, e.g. "B9: 4-room apartment in Konstanz-Wollmatingen") */
export const EN_SERVICES = [
  {
    key: "agent", de: "/immobilienmakler-konstanz.html", en: "/en/real-estate-agent-konstanz.html", deFile: "immobilienmakler-konstanz.html",
    crumb: "Real estate agent Konstanz", nav: "Real estate agent",
    title: "Real Estate Agent Konstanz | Immobilien Eichmann",
    desc: "Real estate agent in Konstanz: Helmut Eichmann – selling, valuation and buying on Lake Constance, personally. Call or WhatsApp +49 170 522 5568.",
    kicker: "Agent · Konstanz &amp; Lake Constance", h1: "Real Estate Agent in Konstanz",
    lead: "Immobilien Eichmann is your real estate agent in Konstanz: personal brokerage for selling and buying property in Konstanz and around Lake Constance.",
    body: [
      sec("What you can expect from a real estate agent in Konstanz", P(
        "Anyone who wants to sell or buy property in Konstanz needs, above all, a contact person who is easy to reach and knows the local market. At Immobilien Eichmann you deal directly with Helmut Eichmann – from the first call and the viewing to the appointment at the notary.",
        `For owners, the work usually starts with a market assessment – see ${L.valuation}. After that it is about documents, the exposé and finding the right buyers. Whether you are ${L.sellHouse} or ${L.sellFlat}: you get clear progress updates instead of silence.`,
        `For buyers, all current properties are shown directly on this website, for example apartments in Wollmatingen and ${L.peters}, a three-family house among the ${L.mfh}, and the commission-free ${L.allm}. If you live outside Germany, read our notes on ${L.abroad}.`)),
      sec("How we work", `        <ul class="check-list">
          <li><strong>Consultation:</strong> clarify your goal for the sale, purchase or project and agree the next step.</li>
          <li><strong>Assessment:</strong> a market-based price orientation through our ${A("/en/property-valuation-konstanz.html", "property valuation")} or a direct sales strategy.</li>
          <li><strong>Marketing:</strong> exposé, property portals including Immowelt, and direct contact with interested buyers.</li>
          <li><strong>Support:</strong> viewings, negotiation and coordination up to the notary.</li>
        </ul>
${P(`An overview of everything we do is on the page ${L.services}.`)}`, true),
    ],
    faq: [
      ["What does a real estate agent in Konstanz actually do?", "The agent assesses the market price, prepares documents and the exposé, approaches suitable buyers, organises viewings and accompanies the negotiation and the notary appointment. At Immobilien Eichmann, Helmut Eichmann does this personally."],
      ["How much does the agent cost?", "When you buy, the buyer's commission is stated in the exposé of each property; New-build Allmannsdorf is commission-free for buyers. For sellers, the terms are discussed openly in the first conversation, before any agreement is made."],
      ["Which documents do I need to sell?", "Usually the land register extract, floor plans, living area calculation, energy performance certificate and, for apartments, the declaration of division and the minutes of the owners' meetings. We clarify together what is missing. These documents are in German."],
      ["How do I reach you fastest?", "By phone or WhatsApp on +49 170 522 5568, on the landline +49 7531 9228848 or via the contact form. Appointments in Konstanz by arrangement."],
    ],
  },
  {
    key: "valuation", de: "/immobilienbewertung-konstanz.html", en: "/en/property-valuation-konstanz.html", deFile: "immobilienbewertung-konstanz.html",
    crumb: "Property valuation Konstanz", nav: "Valuation",
    title: "Property Valuation Konstanz | Immobilien Eichmann",
    desc: "Property valuation in Konstanz: a personal market assessment before selling or after an inheritance – no online tool, no formal appraisal. +49 170 522 5568.",
    kicker: "Valuation · Konstanz &amp; Lake Constance", h1: "Property Valuation in Konstanz",
    lead: "Property valuation in Konstanz: Immobilien Eichmann gives owners in Konstanz and around Lake Constance a personal, practical market assessment – before a sale, after an inheritance or simply for orientation.",
    body: [
      sec("What the valuation is – and what it is not", P(
        "Our assessment is based on local comparisons and current demand. Helmut Eichmann looks at your house or apartment on site and places location, condition and demand in context. You then receive a comprehensible price range that works as the basis for a sale.",
        "<strong>Important:</strong> this is an estate agent's market assessment for selling and brokerage. It is not a formal valuation report (Verkehrswertgutachten under § 194 BauGB) and not a certified expert service. For court, tax or financing purposes, please commission an independent chartered surveyor.")),
      sec("Methods in brief", `        <ul class="check-list">
          <li><strong>Comparison approach:</strong> derived from comparable properties in a similar location, size and condition – typical for apartments in Konstanz.</li>
          <li><strong>Income approach:</strong> based on sustainable rental income, for example for let properties or investments.</li>
          <li><strong>Cost approach:</strong> land value plus building costs, less age and condition – often relevant for single-family houses.</li>
        </ul>
${P(`If you decide to sell afterwards, the next step follows seamlessly: ${L.sellHouse} or ${L.sellFlat}. If not, you still have a well-founded orientation. To understand the whole process, see ${L.agent}.`)}`, true),
    ],
    faq: [
      ["Is the valuation a formal appraisal?", "No. It is an estate agent's market assessment for selling and brokerage, not a formal valuation report. For court, tax office or bank, please commission a chartered surveyor."],
      ["What do you need from me?", "Address, living area, plot size, year of construction, floor plans and details of modernisations. Anything you do not have to hand we clarify at the appointment."],
      ["Do I have to sell with you afterwards?", "No. The market assessment is non-binding."],
      ["Do you also value apartments and multi-family houses?", "Yes – houses, apartments and multi-family houses in Konstanz and around Lake Constance."],
    ],
  },
  {
    key: "sellHouse", de: "/haus-verkaufen-konstanz.html", en: "/en/sell-house-konstanz.html", deFile: "haus-verkaufen-konstanz.html",
    crumb: "Sell a house in Konstanz", nav: "Sell a house",
    title: "Sell a House Konstanz | Immobilien Eichmann",
    desc: "Sell a house in Konstanz: from the first conversation to the notary, personally supported by Helmut Eichmann on Lake Constance. Call +49 170 522 5568.",
    kicker: "Selling · Konstanz &amp; Lake Constance", h1: "Sell a House in Konstanz",
    lead: "Want to sell a house in Konstanz? Immobilien Eichmann supports you personally from the first conversation to the notary – with realistic pricing, complete documents and suitable buyers.",
    body: [
      sec("What matters when you sell a house in Konstanz", P(
        "Selling a house is rarely routine. Often it is a parental home, an inheritance or a move. That is why every sale starts with a calm conversation about your goal and your time frame. If you cannot yet judge the price, a " + A("/en/property-valuation-konstanz.html", "property valuation in Konstanz") + " is the first step.",
        "After that we take care of photos, the exposé and approaching buyers – on this website, on our Immowelt profile and through direct contacts. Viewings only take place with buyers who have been checked in advance. You decide who you sell to.",
        `If your house has more than one residential unit, also read our page on ${L.mfh}. Selling an apartment instead? See ${L.sellFlat}.`)),
      sec("The sale in five steps", `        <ol class="check-list">
          <li><strong>First conversation:</strong> goals, time frame and key details – by phone or on site in Konstanz.</li>
          <li><strong>Market assessment:</strong> location, condition and demand.</li>
          <li><strong>Preparation:</strong> photos, exposé and key data for portals and direct buyers.</li>
          <li><strong>Buyers:</strong> filtering enquiries, coordinating viewings, collecting feedback and offers.</li>
          <li><strong>Completion:</strong> support up to the notarial certification of the contract.</li>
        </ol>
${P(DOCS_NOTE)}`, true),
    ],
    faq: [
      ["How long does it take to sell a house in Konstanz?", "That depends on location, condition, price and documents. We only give a serious estimate after the viewing, not before."],
      ["Do I have to renovate before selling?", "Usually not. Tidying up and fixing small defects is often enough. Whether a larger measure is worthwhile is discussed after the viewing."],
      ["Which documents do I need?", "Land register extract, cadastral map, floor plans, living area calculation, energy performance certificate and proof of modernisations. We help to obtain missing documents. These documents are in German."],
      ["Can I sell my house while I still live in it?", "Yes. Viewings are arranged with you, and the moving-out date is set in the purchase contract."],
    ],
  },
  {
    key: "sellFlat", de: "/wohnung-verkaufen-konstanz.html", en: "/en/sell-apartment-konstanz.html", deFile: "wohnung-verkaufen-konstanz.html",
    crumb: "Sell an apartment in Konstanz", nav: "Sell an apartment",
    title: "Sell an Apartment Konstanz | Immobilien Eichmann",
    desc: "Sell an apartment in Konstanz – owner-occupied or let – with personal support from Helmut Eichmann up to the notary. Call +49 170 522 5568.",
    kicker: "Selling · Konstanz &amp; Lake Constance", h1: "Sell an Apartment in Konstanz",
    lead: "Sell an apartment in Konstanz – owner-occupied or let – with Immobilien Eichmann, personally supported up to the notary appointment.",
    body: [
      sec("Selling a condominium in Konstanz", P(
        "Selling an apartment raises different questions from selling a house: what about the owners' association, the maintenance reserve and planned work on the common property? Buyers ask exactly these questions. That is why we put these documents together from the start, so buyers can decide quickly.",
        `First we talk about your goal and time frame. With a ${A("/en/property-valuation-konstanz.html", "property valuation")} we set a realistic asking price. Then come photos, the exposé and marketing on this website, on our Immowelt profile and to registered buyers. Viewings only take place with checked buyers, and Helmut Eichmann accompanies you up to the notary appointment.`,
        `If the apartment is let, we approach investors specifically; the tenancy passes to the buyer. If you live in it yourself, we agree viewings and the moving-out date with you. Selling a whole house instead? Read ${L.sellHouse}. An overview of ${L.services} is also available.`)),
      sec("Good to know", P(DOCS_NOTE, `Looking for your next home? See ${L.buyFlat}.`), true),
    ],
    faq: [
      ["Which documents do I need to sell an apartment?", "Land register extract, declaration of division, floor plan, living area calculation, energy performance certificate, the economic plan, the latest service charge statements and the minutes of the owners' meetings. If the apartment is let, also the tenancy agreement."],
      ["Can I sell a let apartment?", "Yes. The tenancy agreement remains in place and passes to the buyer. Let apartments mainly appeal to investors."],
      ["What is my apartment worth?", "We clarify this with a non-binding market assessment on site. Location, condition, floor, view and the situation of the owners' association all play a role."],
      ["Do I need the property manager's consent?", "That depends on the declaration of division. Some require the manager's consent to a sale; we check this with you in advance."],
    ],
  },
  {
    key: "buyFlat", de: "/wohnung-kaufen-konstanz.html", en: "/en/buy-apartment-konstanz.html", deFile: "wohnung-kaufen-konstanz.html",
    crumb: "Buy an apartment in Konstanz", nav: "Buy an apartment",
    title: "Buy an Apartment Konstanz | Immobilien Eichmann",
    desc: "Buy an apartment in Konstanz: current apartments, maisonettes and penthouses from Immobilien Eichmann, each with its own English page. +49 170 522 5568.",
    kicker: "Buying · Konstanz &amp; Lake Constance", h1: "Buy an Apartment in Konstanz",
    lead: "Looking to buy an apartment in Konstanz? Here you find the current apartments, maisonettes and penthouses offered by Immobilien Eichmann, each with price, rooms and living area.",
    listings: { heading: "Current apartments for sale in Konstanz", filter: (m) => /apartment|maisonette|penthouse/i.test(m.name) },
    body: [
      sec("How to find your apartment", P(
        "Compare price, location and floor plan on the property pages below. Send a short enquiry by form, phone or e-mail and Helmut Eichmann will get back to you personally. Viewings take place on site in Konstanz, with clear information on condition and running costs, and you are accompanied up to the notary.",
        `Districts such as Wollmatingen and Allmannsdorf are in demand with owner-occupiers and investors; current apartments in ${L.peters} are listed on their own page. Buyers can register their interest in the ${L.allm} commission-free.`,
        `Prices are in euros. The full exposés and all contract documents are in German; for buyers living outside Germany we have collected notes on ${L.abroad}. Investors may also want to look at ${L.mfh}.`)),
    ],
    faq: [
      ["Is there a buyer's commission?", "The buyer's commission is stated for each property. New-build Allmannsdorf is commission-free for buyers."],
      ["Are the exposés available in English?", "Each property has an English summary page. The full exposé and the official documents are in German."],
      ["How do I arrange a viewing?", "Call or WhatsApp +49 170 522 5568, or use the enquiry form on the property page. Appointments by arrangement."],
      ["Can I register for future apartments?", "Yes – tell us what you are looking for by phone or via the contact form."],
    ],
  },
  {
    key: "mfh", de: "/mehrfamilienhaus-konstanz.html", en: "/en/multi-family-house-konstanz.html", deFile: "mehrfamilienhaus-konstanz.html",
    crumb: "Multi-family house Konstanz", nav: "Multi-family house",
    title: "Multi-Family House Konstanz | Immobilien Eichmann",
    desc: "Buy a multi-family house in Konstanz: current offers from Immobilien Eichmann for owner-occupiers and investors on Lake Constance. +49 170 522 5568.",
    kicker: "Investment · Konstanz", h1: "Buy a Multi-Family House in Konstanz",
    lead: "Buying a multi-family house in Konstanz – for owner-occupiers, families and investors: here are the current offers from Immobilien Eichmann.",
    listings: { heading: "Current multi-family houses in Konstanz", filter: (m) => /family house|multi-family/i.test(m.name) },
    body: [
      sec("A multi-family house as an investment or for the family", P(
        "Anyone buying a multi-family house in Konstanz usually has one of two goals: several generations under one roof, or an investment with rental income. Both work, but the checks are different from those for an apartment.")),
      sec("What to check before you buy", P(
        "For a let building, the tenancy agreements, the list of tenants and the service charge statements are as important as location and condition. Ask about modernisations, the energy performance certificate and the condition of roof, heating and pipes. Helmut Eichmann puts the available documents together for you and organises the viewing. " + DOCS_NOTE.replace("Please note that o", "O"),
        `Do you own a multi-family house yourself and are thinking of selling? Then everything starts with a ${A("/en/property-valuation-konstanz.html", "property valuation")}; the process is described under ${L.sellHouse}. Apartments for sale are listed under ${L.buyFlat}.`), true),
    ],
    faq: [
      ["Which documents do I receive before buying?", "The exposé with the key data and, on request, the available documents such as floor plans, the energy performance certificate and, if let, details of the tenancies. These documents are in German."],
      ["Is there a buyer's commission?", "The buyer's commission is stated in the exposé of each property."],
      ["Can I view the house?", "Yes, after a short arrangement. Call or write via the contact form."],
    ],
  },
  {
    key: "peters", de: "/petershausen.html", en: "/en/petershausen.html", deFile: "petershausen.html",
    crumb: "Petershausen", nav: "Petershausen",
    title: "Property Petershausen Konstanz | Immobilien Eichmann",
    desc: "Property in Konstanz-Petershausen: current properties for sale and personal advice on buying and selling with Helmut Eichmann. +49 170 522 5568.",
    kicker: "District · Petershausen", h1: "Property in Petershausen, Konstanz",
    lead: "Property in Petershausen, Konstanz: current properties for sale from Immobilien Eichmann and personal advice on site.",
    listings: { heading: "Current properties for sale in Petershausen", filter: (m) => /petershausen/i.test(m.name) },
    body: [
      sec("Living in Konstanz-Petershausen", P(
        "Petershausen lies on the right bank of the Rhine in Konstanz, with its own railway station and short distances to the city centre. The current offers from Immobilien Eichmann in Petershausen are listed on this page.",
        "Each property has its own English page with price, rooms, living area and commission, plus an enquiry form. Send a short enquiry or call, and Helmut Eichmann will get back to you personally with the exposé and a viewing appointment. Prices are in euros; the full exposé and the contract documents are in German.")),
      sec("Selling in Petershausen", P(
        `Do you own an apartment or a house in Petershausen and want to know what it is worth? Helmut Eichmann assesses the market price on site. Read more on ${A("/en/property-valuation-konstanz.html", "property valuation in Konstanz")}, ${A("/en/sell-apartment-konstanz.html", "selling an apartment")} and ${A("/en/sell-house-konstanz.html", "selling a house")}.`,
        `Looking elsewhere in the city? See ${L.buyFlat}, the ${L.allm} or our page as ${L.agent}.`), true),
    ],
    faq: [
      ["Are there current offers in Petershausen?", "The current properties are listed on this page. All offers in Konstanz are on the English home page."],
      ["Can I register for future offers in Petershausen?", "Yes – call or tell us via the contact form what you are looking for."],
      ["Do you also value property in Petershausen?", "Yes, the market assessment is non-binding and takes place on site."],
    ],
  },
  {
    key: "services", de: "/leistungen.html", en: "/en/services.html", deFile: "leistungen.html",
    crumb: "Services", nav: "Services",
    title: "Real Estate Services Konstanz | Immobilien Eichmann",
    desc: "Real estate services in Konstanz: selling houses and apartments, valuation, buying apartments and multi-family houses, new-build sales – with Helmut Eichmann.",
    kicker: "Services · Konstanz &amp; Lake Constance", h1: "Real Estate Services in Konstanz",
    lead: "Real estate services in Konstanz: selling, brokerage, valuation and new-build sales on Lake Constance – personally with Helmut Eichmann.",
    overview: true,
    body: [
      sec("Selling and brokerage in Konstanz", P(
        `The focus is on selling houses and apartments in Konstanz and around Lake Constance. Helmut Eichmann assesses the market price, prepares documents and the exposé, approaches buyers, conducts viewings and accompanies you up to the notary. As a ${L.agent} he mediates between owners and buyers so both sides know where they stand.`,
        `For buyers, all current offers are shown with their own English page – see ${L.buyFlat}, ${L.mfh} and the district page ${L.peters}. Buyers living outside Germany will find notes on ${L.abroad}.`)),
      sec("New-build sales", P(
        `For developers, Immobilien Eichmann handles the sales of new-build projects, currently ${L.allm}. Buyers can register their interest there commission-free.`,
        "Contracts and official documents are in German; Helmut Eichmann will get back to you personally with every enquiry."), true),
    ],
    faq: [
      ["Which services does Immobilien Eichmann offer?", "Selling and brokerage of houses and apartments, property valuation as a market assessment, sales of new-build projects and support for buyers, including buyers from abroad."],
      ["Which area do you cover?", "Konstanz with all its districts and the Lake Constance region."],
      ["How do I start?", "The easiest way is a call on +49 170 522 5568 or a message via the contact form. Helmut Eichmann will get back to you personally."],
    ],
  },
];
