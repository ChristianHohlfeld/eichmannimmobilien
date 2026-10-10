/* Chris-Regel: keine Termin-/Baustandsangaben (Baubeginn, Fertigstellung, Bezugstermin) auf unseren Seiten.
   Immowelt-Texte bleiben SoT; beim Rendern werden nur die betroffenen Sätze ausgelassen. */
export const PROJECT_STATUS_SENTENCE_RE = /\b(Baubegin\w*|Baustart\w*|Fertigstellung\w*|fertiggestellt|Bauantrag\w*|Baugenehmigung\w*|Bezugsfertig\w*|bezugsfertig)\b/i;
export function stripProjectStatus(text) {
  const src = String(text || "");
  if (!PROJECT_STATUS_SENTENCE_RE.test(src)) return src;
  return src
    .split(/(\n+)/)
    .map((chunk) => {
      if (/^\n+$/.test(chunk)) return chunk;
      // split into sentences, keep separators
      const parts = chunk.match(/[^.!?]+(?:[.!?]+|$)/g) || [chunk];
      return parts.filter((sent) => !PROJECT_STATUS_SENTENCE_RE.test(sent)).join("").replace(/^\s+/, "");
    })
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

