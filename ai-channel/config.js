/* AI Channel — integration settings.
   Fill these in with details supplied by LLPA. Leave a value empty ("") until it is confirmed:
   the site then shows an honest "not connected yet" state instead of pretending to work.
   Never put API keys or secrets in this file: it is public. */
window.AIC_CONFIG = {
  /* AI Training: the externally managed course database, shown as an embed. */
  trainingEmbed: {
    url: "",                    // TRAINING_EMBED_URL, e.g. "https://provider.example/embed/llpa-courses"
    title: "AI courses from LLPA members",
    minHeight: 900,             // px; the provider may resize the frame itself
    openInNewTabAllowed: false  // set true only if the provider permits linking to the catalog directly
  },
  /* Advisory & Consulting: where the inquiry form sends requests (LLPA team workflow: CRM, queue or ticketing).
     The endpoint must accept a JSON POST and return 2xx only after the request is stored. */
  advisory: {
    endpoint: ""                // ADVISORY_ENDPOINT, e.g. "https://api.example.org/aichannel/advisory"
  },
  /* Contact and legal pages. */
  contact: { email: "" },       // CONTACT_EMAIL: a monitored LLPA team address
  legal: { privacyUrl: "", termsUrl: "", cookiesUrl: "" },
  /* Analytics: events carry no personal data. Set a sink to forward them, e.g. to a consent-aware analytics tool. */
  analytics: { enabled: false }
};
