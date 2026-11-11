/**
 * Strict, dependency-free XML reader for Immowelt SOAP payloads.
 *
 * Why not the old immowelt-xml-lite: it silently repaired broken documents
 * (unclosed tags, truncated responses) and collapsed whitespace, so a cut-off
 * response could look like "fewer listings". Here a document is either
 * well-formed or the call fails.
 *
 *  - well-formedness enforced (mismatched / unclosed tags, trailing garbage)
 *  - DOCTYPE / ENTITY declarations rejected (no entity expansion, no XXE)
 *  - element order, attribute values and text whitespace preserved
 *  - size and depth limits
 */

export class XmlError extends Error {
  constructor(message, position = -1) {
    super(position >= 0 ? `XML ungültig: ${message} (Position ${position})` : `XML ungültig: ${message}`);
    this.name = "XmlError";
    this.code = "immowelt_invalid_xml";
    this.position = position;
  }
}

const PREDEFINED = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** Decode the five XML entities and numeric references. Unknown names stay literal. */
export function decodeXmlEntities(value) {
  const s = String(value ?? "");
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{0,31});/g, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
      // XML 1.0 forbids most C0 controls; never hand them on.
      if (code < 0x20 && code !== 0x9 && code !== 0xa && code !== 0xd) return "";
      return String.fromCodePoint(code);
    }
    return Object.prototype.hasOwnProperty.call(PREDEFINED, body) ? PREDEFINED[body] : whole;
  });
}

export function localName(qname) {
  const s = String(qname || "");
  const i = s.indexOf(":");
  return i >= 0 ? s.slice(i + 1) : s;
}

function isNameStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58 || c > 127;
}
function isNameChar(c) {
  return isNameStart(c) || (c >= 48 && c <= 57) || c === 45 || c === 46;
}
function isSpace(c) {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

function makeElement(name) {
  return { type: "element", name, local: localName(name), lname: localName(name).toLowerCase(), attrs: {}, children: [], text: "" };
}

/**
 * @param {string} input
 * @param {{ maxBytes?: number, maxDepth?: number }} [opts]
 * @returns {{ type: "element" }} root element
 */
export function parseXml(input, { maxBytes = 25 * 1024 * 1024, maxDepth = 256 } = {}) {
  if (typeof input !== "string") throw new XmlError("kein Text");
  if (input.length > maxBytes) throw new XmlError(`Dokument zu groß (${input.length} Zeichen)`);
  const src = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const n = src.length;
  let i = 0;
  let root = null;
  const stack = [];

  const fail = (msg, at = i) => {
    throw new XmlError(msg, at);
  };

  const readName = () => {
    const start = i;
    if (i >= n || !isNameStart(src.charCodeAt(i))) fail("Elementname erwartet");
    i++;
    while (i < n && isNameChar(src.charCodeAt(i))) i++;
    return src.slice(start, i);
  };
  const skipSpace = () => {
    while (i < n && isSpace(src.charCodeAt(i))) i++;
  };
  const appendText = (text) => {
    if (!stack.length) {
      if (text.trim()) fail("Text außerhalb des Wurzelelements");
      return;
    }
    const top = stack[stack.length - 1];
    top.text += text;
    const last = top.children[top.children.length - 1];
    if (last && last.type === "text") last.value += text;
    else top.children.push({ type: "text", value: text });
  };

  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      appendText(decodeXmlEntities(src.slice(i)));
      i = n;
      break;
    }
    if (lt > i) appendText(decodeXmlEntities(src.slice(i, lt)));
    i = lt;

    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      if (end < 0) fail("Kommentar nicht geschlossen");
      i = end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i + 9);
      if (end < 0) fail("CDATA nicht geschlossen");
      appendText(src.slice(i + 9, end));
      i = end + 3;
      continue;
    }
    if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i + 2);
      if (end < 0) fail("Verarbeitungsanweisung nicht geschlossen");
      i = end + 2;
      continue;
    }
    if (src.startsWith("<!", i)) {
      // DOCTYPE, ENTITY, ELEMENT …: never needed for SOAP, and the classic attack surface.
      fail("DOCTYPE/Deklarationen sind nicht erlaubt");
    }
    if (src.startsWith("</", i)) {
      i += 2;
      const name = readName();
      skipSpace();
      if (src.charCodeAt(i) !== 62) fail("'>' nach schließendem Tag erwartet");
      i++;
      const open = stack.pop();
      if (!open) fail(`schließendes </${name}> ohne öffnendes Tag`);
      if (open.name !== name) fail(`</${name}> schließt <${open.name}>`);
      continue;
    }

    // start tag
    i++;
    const tagStart = i - 1;
    const el = makeElement(readName());
    for (;;) {
      const before = i;
      skipSpace();
      const c = src.charCodeAt(i);
      if (i >= n) fail("Tag nicht geschlossen", tagStart);
      if (c === 62) {
        i++;
        break;
      }
      if (c === 47) {
        if (src.charCodeAt(i + 1) !== 62) fail("'/>' erwartet");
        i += 2;
        el.selfClosing = true;
        break;
      }
      if (before === i) fail("Leerraum vor Attribut erwartet");
      const attrName = readName();
      skipSpace();
      if (src.charCodeAt(i) !== 61) fail(`'=' nach Attribut ${attrName} erwartet`);
      i++;
      skipSpace();
      const quote = src.charCodeAt(i);
      if (quote !== 34 && quote !== 39) fail(`Attributwert von ${attrName} ohne Anführungszeichen`);
      const end = src.indexOf(String.fromCharCode(quote), i + 1);
      if (end < 0) fail(`Attributwert von ${attrName} nicht geschlossen`);
      const raw = src.slice(i + 1, end);
      if (raw.includes("<")) fail(`'<' im Attributwert von ${attrName}`);
      if (Object.prototype.hasOwnProperty.call(el.attrs, attrName)) fail(`Attribut ${attrName} doppelt`);
      el.attrs[attrName] = decodeXmlEntities(raw);
      i = end + 1;
    }

    if (stack.length) stack[stack.length - 1].children.push(el);
    else if (root) fail("mehr als ein Wurzelelement", tagStart);
    else root = el;

    if (!el.selfClosing) {
      stack.push(el);
      if (stack.length > maxDepth) fail("Verschachtelung zu tief");
    }
    delete el.selfClosing;
  }

  if (stack.length) throw new XmlError(`<${stack[stack.length - 1].name}> nicht geschlossen (Dokument abgeschnitten?)`, n);
  if (!root) throw new XmlError("kein Wurzelelement");
  return root;
}

/* ---------- tree helpers (namespace prefixes ignored, names case-insensitive) ---------- */

const lower = (s) => String(s || "").toLowerCase();

export function elements(node) {
  return node && Array.isArray(node.children) ? node.children.filter((c) => c.type === "element") : [];
}

export function childrenNamed(node, name) {
  const want = lower(name);
  return elements(node).filter((c) => c.lname === want);
}

export function child(node, name) {
  const want = lower(name);
  return elements(node).find((c) => c.lname === want) || null;
}

export function descendants(node, name, out = []) {
  const want = lower(name);
  for (const c of elements(node)) {
    if (c.lname === want) out.push(c);
    descendants(c, name, out);
  }
  return out;
}

export function firstDescendant(node, name) {
  const want = lower(name);
  for (const c of elements(node)) {
    if (c.lname === want) return c;
    const hit = firstDescendant(c, name);
    if (hit) return hit;
  }
  return null;
}

/** Text of the element and all descendants, document order. */
export function textContent(node) {
  if (!node) return "";
  if (node.type === "text") return node.value;
  let out = "";
  for (const c of node.children || []) out += c.type === "text" ? c.value : textContent(c);
  return out;
}

/** Direct text only (no child elements). */
export function ownText(node) {
  return node ? String(node.text || "") : "";
}

/** Attribute lookup: exact, then prefix-less and case-insensitive. Missing → null. */
export function attr(node, name) {
  if (!node || !node.attrs) return null;
  if (Object.prototype.hasOwnProperty.call(node.attrs, name)) return node.attrs[name];
  const want = lower(name);
  for (const [k, v] of Object.entries(node.attrs)) {
    if (lower(localName(k)) === want) return v;
  }
  return null;
}

/** All attributes with prefix-less names (xmlns declarations dropped). */
export function attributes(node) {
  const out = {};
  for (const [k, v] of Object.entries(node?.attrs || {})) {
    if (k === "xmlns" || k.startsWith("xmlns:")) continue;
    out[localName(k)] = v;
  }
  return out;
}

/** Compact structural outline (names + attribute names, no values) for contract probes. */
export function outline(node, depth = 0, maxDepth = 8, seen = new Map()) {
  const key = `${depth}:${node.lname}:${Object.keys(attributes(node)).sort().join(",")}`;
  seen.set(key, (seen.get(key) || 0) + 1);
  if (depth < maxDepth) for (const c of elements(node)) outline(c, depth + 1, maxDepth, seen);
  return seen;
}
