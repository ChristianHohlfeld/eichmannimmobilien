/**
 * Short "Vormerken" form (Neubau Allmannsdorf): Name + Telefon required, E-Mail optional.
 * Posts via js/vormerk.js to the Forms API /contact (anliegen = Vormerkung Neubau Allmannsdorf, lang).
 * Used by the project generator (allmannsdorf.html), the home hero, the flyer modal and /en/ pages.
 */
const T = {
  de: {
    title: "Provisionsfrei vormerken",
    sub: "Helmut Eichmann meldet sich persönlich bei Ihnen.",
    name: "Name",
    phone: "Telefon",
    phonePh: "Für den Rückruf",
    email: "E-Mail (optional)",
    note: (p) => `Hinweise zur Verarbeitung Ihrer Angaben: <a href="${p}datenschutz.html">Datenschutzerklärung</a>. Durch das Absenden kommt kein Maklervertrag zustande.`,
    submit: "Vormerken",
    ok: "Vielen Dank – Ihre Vormerkung ist angekommen. Helmut Eichmann meldet sich persönlich bei Ihnen.",
    err: 'Senden hat gerade nicht geklappt. Bitte rufen Sie an: <a href="tel:+491705225568">+49 170 522 5568</a>.',
  },
  en: {
    title: "Register your interest",
    sub: "Helmut Eichmann will get back to you personally.",
    name: "Name",
    phone: "Phone",
    phonePh: "With country code, e.g. +41 …",
    email: "E-mail (optional)",
    note: (p) => EN_PRIVACY(p),
    submit: "Register interest",
    ok: "Thank you – your registration of interest has been received. Helmut Eichmann will get back to you personally.",
    err: 'Your message could not be sent. Please call: <a href="tel:+491705225568">+49 170 522 5568</a>.',
  },
};

export function vormerkFormHtml({ id = "vormerk", location = "inline", lang = "de", prefix = "", heading = "h2", indent = "" } = {}) {
  const t = T[lang] || T.de;
  const html = `<form class="vormerk-form" id="${id}" data-vormerk-form data-form-location="${location}" action="https://forms.digitalisierungsplanung.de/v1/immobilieneichmann/contact" method="POST">
  <${heading} class="vormerk-title">${t.title}</${heading}>
  <p class="vormerk-sub">${t.sub}</p>
  <input type="hidden" name="anliegen" value="Vormerkung Neubau Allmannsdorf">
  <input type="hidden" name="lang" value="${lang}">
  <input type="checkbox" name="botcheck" class="hp-field" tabindex="-1" autocomplete="off" aria-hidden="true">
  <div class="vormerk-fields">
    <div class="form-group">
      <label for="${id}-name">${t.name} *</label>
      <input type="text" id="${id}-name" name="name" required autocomplete="name">
    </div>
    <div class="form-group">
      <label for="${id}-phone">${t.phone} *</label>
      <input type="tel" id="${id}-phone" name="phone" required autocomplete="tel" inputmode="tel" placeholder="${t.phonePh}">
    </div>
    <div class="form-group">
      <label for="${id}-email">${t.email}</label>
      <input type="email" id="${id}-email" name="email" autocomplete="email">
    </div>
  </div>
  <button type="submit" class="btn btn-accent vormerk-submit">${t.submit}</button>
  <p class="vormerk-note">${t.note(prefix)}</p>
  <p class="vormerk-success" role="status" hidden>${t.ok}</p>
  <p class="vormerk-error" role="alert" hidden>${t.err}</p>
</form>`;
  return indent ? html.split("\n").map((l) => indent + l).join("\n") : html;
}

/** Short English privacy note under EN forms (the full privacy policy is in German). */
export function EN_PRIVACY(p = "/") {
  return `Privacy: your details are sent via our form service to Helmut Eichmann (Immobilien Eichmann, Konstanz) and used solely to answer your enquiry and contact you about it – never for advertising. Details and your rights: <a href="${p}datenschutz.html" hreflang="de">privacy policy (German)</a>. Submitting this form does not create a brokerage agreement.`;
}
