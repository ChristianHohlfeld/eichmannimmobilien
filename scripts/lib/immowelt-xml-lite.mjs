/**
 * Minimal XML → object parser for Immowelt SOAP responses.
 * No external deps. Namespaces stripped from element/attribute names.
 *
 * Shape roughly compatible with fast-xml-parser:
 *   { Tag: { nested: "...", "@_attr": "v", "#text": "..." }, ... }
 */
export class XMLParser {
  constructor(options = {}) {
    this.attributeNamePrefix = options.attributeNamePrefix || "@_";
    this.textNodeName = options.textNodeName || "#text";
    this.removeNSPrefix = options.removeNSPrefix !== false;
  }

  parse(xml) {
    const tokens = tokenize(String(xml || ""));
    const root = { children: [] };
    const stack = [root];

    for (const tok of tokens) {
      if (tok.type === "pi" || tok.type === "comment") continue;
      if (tok.type === "text") {
        const parent = stack[stack.length - 1];
        const t = tok.value.replace(/\s+/g, " ");
        if (t.trim()) parent.texts = (parent.texts || "") + t;
        continue;
      }
      if (tok.type === "cdata") {
        const parent = stack[stack.length - 1];
        parent.texts = (parent.texts || "") + tok.value;
        continue;
      }
      if (tok.type === "close") {
        const name = this.#name(tok.name);
        while (stack.length > 1) {
          const node = stack.pop();
          if (node.name === name) break;
        }
        continue;
      }
      if (tok.type === "open" || tok.type === "self") {
        const name = this.#name(tok.name);
        const node = { name, attrs: {}, children: [], texts: "" };
        for (const [ak, av] of Object.entries(tok.attrs || {})) {
          node.attrs[this.attributeNamePrefix + this.#name(ak)] = av;
        }
        stack[stack.length - 1].children.push(node);
        if (tok.type === "open") stack.push(node);
      }
    }

    return this.#toObject(root);
  }

  #name(raw) {
    const s = String(raw || "");
    if (!this.removeNSPrefix) return s;
    const i = s.indexOf(":");
    return i >= 0 ? s.slice(i + 1) : s;
  }

  #toObject(node) {
    const out = {};
    // synthetic root
    if (!node.name) {
      for (const child of node.children || []) {
        this.#assign(out, child.name, this.#elementValue(child));
      }
      return out;
    }
    return this.#elementValue(node);
  }

  #elementValue(node) {
    const hasKids = (node.children || []).length > 0;
    const text = (node.texts || "").trim();
    if (!hasKids) {
      if (Object.keys(node.attrs || {}).length) {
        const o = { ...node.attrs };
        if (text) o[this.textNodeName] = text;
        return o;
      }
      return text;
    }
    const o = { ...node.attrs };
    for (const child of node.children) {
      this.#assign(o, child.name, this.#elementValue(child));
    }
    if (text) o[this.textNodeName] = text;
    return o;
  }

  #assign(obj, key, value) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      if (!Array.isArray(obj[key])) obj[key] = [obj[key]];
      obj[key].push(value);
    } else {
      obj[key] = value;
    }
  }
}


function tokenize(xml) {
  const tokens = [];
  let i = 0;
  const n = xml.length;
  while (i < n) {
    if (xml.startsWith("<!--", i)) {
      const end = xml.indexOf("-->", i + 4);
      tokens.push({ type: "comment" });
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", i)) {
      const end = xml.indexOf("]]>", i + 9);
      const value = end < 0 ? xml.slice(i + 9) : xml.slice(i + 9, end);
      tokens.push({ type: "cdata", value });
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (xml[i] === "<") {
      const end = xml.indexOf(">", i + 1);
      if (end < 0) break;
      const raw = xml.slice(i + 1, end).trim();
      i = end + 1;
      if (raw.startsWith("?")) {
        tokens.push({ type: "pi" });
        continue;
      }
      if (raw.startsWith("/")) {
        tokens.push({ type: "close", name: raw.slice(1).trim().split(/\s+/)[0] });
        continue;
      }
      const self = raw.endsWith("/");
      const body = self ? raw.slice(0, -1).trim() : raw;
      const { name, attrs } = parseOpenTag(body);
      tokens.push({ type: self ? "self" : "open", name, attrs });
      continue;
    }
    const next = xml.indexOf("<", i);
    const value = next < 0 ? xml.slice(i) : xml.slice(i, next);
    tokens.push({ type: "text", value: decodeEntities(value) });
    i = next < 0 ? n : next;
  }
  return tokens;
}

function parseOpenTag(body) {
  const m = body.match(/^([^\s/]+)([\s\S]*)$/);
  const name = m ? m[1] : body;
  const rest = m ? m[2] : "";
  const attrs = {};
  const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = re.exec(rest))) {
    attrs[match[1]] = decodeEntities(match[3] ?? match[4] ?? "");
  }
  return { name, attrs };
}

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}
