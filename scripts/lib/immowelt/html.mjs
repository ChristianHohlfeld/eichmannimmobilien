/**
 * Sanitizer for the rich text Immowelt delivers inside <description> (escaped HTML
 * such as "Text &lt;br/&gt; Text"). Output is rebuilt from an allowlist, never
 * passed through: p, br, strong, em, ul, ol, li and http(s)/mailto/tel links.
 * Everything else is dropped (script/style including their content).
 *
 * The wording itself is never changed: no spelling fixes, no sentence removal,
 * no re-flowing. Only markup is normalised.
 */

const NAMED = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß",
  euro: "€", sup2: "²", sup3: "³", deg: "°", ndash: "–", mdash: "—", hellip: "…",
  bdquo: "„", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", sbquo: "‚", laquo: "«", raquo: "»",
  eacute: "é", egrave: "è", ecirc: "ê", agrave: "à", aacute: "á", acirc: "â", ccedil: "ç",
  iacute: "í", oacute: "ó", ocirc: "ô", uacute: "ú", ntilde: "ñ", aring: "å", oslash: "ø",
  frac12: "½", frac14: "¼", frac34: "¾", times: "×", middot: "·", bull: "•", copy: "©", reg: "®",
  trade: "™", sect: "§", para: "¶", plusmn: "±", micro: "µ", shy: "", thinsp: " ", ensp: " ", emsp: " ",
  zwnj: "", zwj: "", lrm: "", rlm: "",
};

export function decodeHtmlEntities(value) {
  const s = String(value ?? "");
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, (whole, body) => {
    if (body[0] === "#") {
      const code = /^#x/i.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
      if (code < 0x20 && code !== 0x9 && code !== 0xa && code !== 0xd) return "";
      return String.fromCodePoint(code);
    }
    return Object.prototype.hasOwnProperty.call(NAMED, body) ? NAMED[body] : whole;
  });
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const BLOCK = new Set(["p", "div", "section", "article", "table", "thead", "tbody", "tr", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "dl", "dt", "dd", "hr", "address"]);
const HEADING = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "noscript", "template", "svg", "math", "head", "title"]);
const BOLD = new Set(["b", "strong"]);
const ITALIC = new Set(["i", "em"]);

function safeHref(raw) {
  const href = decodeHtmlEntities(String(raw || "")).trim();
  if (!href || /[\u0000-\u001f\u007f\s]/.test(href)) return null;
  if (/^https?:\/\/[^\s"'<>]+$/i.test(href) || /^mailto:[^\s"'<>]+$/i.test(href) || /^tel:\+?[0-9()\-./]+$/i.test(href)) return href;
  return null;
}

function tokenize(src) {
  const tokens = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      tokens.push({ t: "text", v: src.slice(i) });
      break;
    }
    if (lt > i) tokens.push({ t: "text", v: src.slice(i, lt) });
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    const m = /^<(\/?)([A-Za-z][A-Za-z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(src.slice(lt, lt + 4096));
    if (!m) {
      // A lone "<" (e.g. "Fläche < 50 m²") is text, not markup.
      tokens.push({ t: "text", v: "<" });
      i = lt + 1;
      continue;
    }
    const name = m[2].toLowerCase();
    const rest = m[3] || "";
    const tok = { t: m[1] ? "close" : "open", name, selfClosing: /\/\s*$/.test(rest) };
    if (!m[1] && name === "a") {
      const h = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(rest);
      tok.href = h ? safeHref(h[1] ?? h[2] ?? h[3]) : null;
    }
    tokens.push(tok);
    i = lt + m[0].length;
  }
  return tokens;
}

/**
 * @param {string} input rich text as delivered (may contain markup or be plain)
 * @returns {{ html: string, text: string, blocks: object[] }}
 */
export function sanitizeRichText(input) {
  const raw = String(input ?? "").replace(/\r\n?/g, "\n");
  if (!raw.trim()) return { html: "", text: "", blocks: [] };
  const tokens = tokenize(raw);
  // Plain text (no line/blocks markup): typed line breaks are the only structure there is.
  const hasBreakMarkup = tokens.some((t) => t.t !== "text" && (t.name === "br" || t.name === "li" || BLOCK.has(t.name)));

  const blocks = [];
  let list = null; // { type, items: [] }
  let inItem = false;
  let cur = { html: "", text: "" };
  let pendingBreaks = 0;
  let open = []; // inline tags currently open in cur.html
  let skipUntil = null;

  const closeInline = () => {
    while (open.length) cur.html += `</${open.pop()}>`;
  };
  const flush = () => {
    closeInline();
    pendingBreaks = 0;
    const text = cur.text.replace(/[ \t ]+\n/g, "\n").replace(/\n+$/g, "").trim();
    const html = cur.html.replace(/(?:\s*<br>\s*)+$/g, "").trim();
    cur = { html: "", text: "" };
    if (!text) return;
    if (list && inItem) list.items.push({ html, text });
    else blocks.push({ type: "p", html, text });
  };
  const addBreak = () => {
    if (!cur.text.trim()) return; // leading breaks carry no content
    pendingBreaks++;
  };
  const addText = (value) => {
    let decoded = decodeHtmlEntities(value);
    if (hasBreakMarkup) decoded = decoded.replace(/\s*\n\s*/g, " ");
    const parts = decoded.split("\n");
    parts.forEach((part, idx) => {
      if (idx > 0) addBreak();
      const piece = part.replace(/[ \t]+/g, " ");
      if (!piece.trim()) {
        if (piece && cur.text && !/\s$/.test(cur.text)) {
          cur.text += " ";
          cur.html += " ";
        }
        return;
      }
      if (pendingBreaks >= 2) flush();
      else if (pendingBreaks === 1) {
        cur.text = cur.text.replace(/[ \t]+$/, "") + "\n";
        cur.html = cur.html.replace(/[ \t]+$/, "") + "<br>";
        pendingBreaks = 0;
      }
      const lead = !cur.text || /[\s\n]$/.test(cur.text) ? piece.replace(/^[ \t]+/, "") : piece;
      cur.text += lead;
      cur.html += escapeHtml(lead);
    });
  };

  for (const tok of tokens) {
    if (skipUntil) {
      if (tok.t === "close" && tok.name === skipUntil) skipUntil = null;
      continue;
    }
    if (tok.t === "text") {
      addText(tok.v);
      continue;
    }
    const { name } = tok;
    if (tok.t === "open" && DROP_WITH_CONTENT.has(name)) {
      if (!tok.selfClosing) skipUntil = name;
      continue;
    }
    if (name === "br") {
      addBreak();
      continue;
    }
    if (name === "ul" || name === "ol") {
      flush();
      if (tok.t === "open") {
        if (list && list.items.length) blocks.push(list);
        list = { type: name, items: [] };
        inItem = false;
      } else if (list) {
        if (list.items.length) blocks.push(list);
        list = null;
        inItem = false;
      }
      continue;
    }
    if (name === "li") {
      flush();
      if (tok.t === "open") {
        if (!list) list = { type: "ul", items: [] };
        inItem = true;
      } else inItem = false;
      continue;
    }
    if (BLOCK.has(name)) {
      flush();
      if (tok.t === "open" && HEADING.has(name)) {
        cur.html += "<strong>";
        open.push("strong");
      }
      continue;
    }
    const inline = BOLD.has(name) ? "strong" : ITALIC.has(name) ? "em" : name === "a" ? "a" : null;
    if (!inline) continue; // unknown inline tag: keep its text, drop the tag
    if (tok.t === "open") {
      if (tok.selfClosing || open.includes(inline)) continue;
      if (inline === "a") {
        if (!tok.href) continue;
        if (pendingBreaks) addText("");
        cur.html += `<a href="${escapeHtml(tok.href)}" target="_blank" rel="nofollow noopener noreferrer">`;
      } else cur.html += `<${inline}>`;
      open.push(inline);
    } else if (open.includes(inline)) {
      while (open.length) {
        const top = open.pop();
        cur.html += `</${top}>`;
        if (top === inline) break;
      }
    }
  }
  flush();
  if (list && list.items.length) blocks.push(list);

  const html = blocks
    .map((b) => (b.type === "p" ? `<p>${b.html}</p>` : `<${b.type}>${b.items.map((it) => `<li>${it.html}</li>`).join("")}</${b.type}>`))
    .join("\n");
  const text = blocks
    .map((b) => (b.type === "p" ? b.text : b.items.map((it, i) => `${b.type === "ol" ? `${i + 1}.` : "•"} ${it.text}`).join("\n")))
    .join("\n\n");
  return { html, text, blocks };
}

/** Single-line plain text (facts, titles): markup removed, whitespace collapsed. */
export function plainText(input) {
  return sanitizeRichText(input).text.replace(/\s+/g, " ").trim();
}
