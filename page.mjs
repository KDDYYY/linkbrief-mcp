// Fetch a web page from this PC and extract its main content as Markdown.
// CLI check: node page.mjs <URL>
import dns from "node:dns/promises";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { normalizeUrl } from "./sites.mjs";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TEXT_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain)\b/i;
const ZERO_WIDTH = /[​-‍﻿]/g;

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
// Images, embeds and widgets are noise for an LLM reader (Naver thumbnails alone doubled the size).
// A rule, not turndown.remove(): built-in rules such as "image" win over remove().
turndown.addRule("drop", {
  filter: ["script", "style", "noscript", "svg", "img", "picture", "video", "audio", "iframe", "form", "button", "select"],
  replacement: () => "",
});
// Links and bold/italic with no visible text (Naver spacers, image-only links) would print as "[](#)" or "****".
turndown.addRule("emptyInline", {
  filter: (node) => /^(A|B|STRONG|I|EM)$/.test(node.nodeName) && !node.textContent.replace(ZERO_WIDTH, "").trim(),
  replacement: () => "",
});
// Pipe table from any <table>; the first row becomes the header since Korean CMSs rarely use <th>.
turndown.addRule("table", {
  filter: "table",
  replacement(_content, node) {
    const rows = Array.from(node.getElementsByTagName("tr")).map((tr) =>
      Array.from(tr.childNodes).filter((c) => c.nodeName === "TD" || c.nodeName === "TH")
        .map((c) => c.textContent.replace(ZERO_WIDTH, "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim()))
      .filter((r) => r.some(Boolean));
    const width = Math.max(0, ...rows.map((r) => r.length));
    if (!width) return "";
    // One-column "tables" are layout (news photo captions), not data.
    if (width === 1) return `\n\n${rows.map((r) => r[0].replace(/\\\|/g, "|")).join("\n\n")}\n\n`;
    const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
    return `\n\n${[line(rows[0]), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n")}\n\n`;
  },
});

// "[text](url "title")" -> "text". Handles escaped brackets and one level of parentheses in URLs.
// A link never starts at an escaped "\[" (literal bracket in the prose), and its text has no bare "[".
const MD_LINK = /(?<!\\)\[((?:\\.|[^[\]\\])*)\]\((?:\\.|[^()\\]|\([^)]*\))*\)/g;

// Main content via Readability; falls back to the whole <body> when it finds no article.
// links: false keeps only link text; URLs often outweigh the prose (percent-encoded wiki links).
export function extract(html, { links = true } = {}) {
  let article = null;
  try { article = new Readability(parseHTML(html).document).parse(); } catch { /* malformed page: use fallback */ }
  const { document } = parseHTML(html);
  const useArticle = article && article.textContent.trim().length >= 200;
  const title = (article?.title || document.title || "").trim();
  let markdown = turndown.turndown(useArticle ? article.content : document.body?.innerHTML || html);
  if (!links) markdown = markdown.replace(MD_LINK, "$1");
  markdown = markdown
    .replace(ZERO_WIDTH, "")
    .replace(/\[\s*\]\([^)]*\)/g, "") // links left empty once icons/images were dropped
    .replace(/^([ \t]*(?:-|\d+\.)) {2,}/gm, "$1 ") // turndown pads list markers to 4 columns
    .replace(/[ \t ]+$/gm, "")
    .replace(/^[ \t ]+(?![-*+] |\d+\. )/gm, "") // stray indentation (often NBSP); keeps nested list items
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, markdown };
}

// One window of a long text, plus a note telling Claude how to read the rest.
export function paginate(text, startIndex = 0, maxLength = 20000) {
  if (startIndex > 0 && startIndex >= text.length) return `(No more content: total length is ${text.length} characters.)`;
  const end = Math.min(text.length, startIndex + maxLength);
  const part = text.slice(startIndex, end);
  return end < text.length
    ? `${part}\n\n[Truncated: showing characters ${startIndex}-${end} of ${text.length}. Call fetch_page again with start_index=${end} for more.]`
    : part;
}

const blocked = new net.BlockList();
for (const [a, p] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]]) blocked.addSubnet(a, p, "ipv4");
for (const [a, p] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]]) blocked.addSubnet(a, p, "ipv6");

export function isBlockedIp(ip) {
  // IPv4-mapped IPv6: "::ffff:127.0.0.1", or "::ffff:7f00:1" as new URL() writes it
  const dotted = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (dotted) ip = dotted[1];
  else if (hex) {
    const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
    ip = [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
  }
  return blocked.check(ip, net.isIPv6(ip) ? "ipv6" : "ipv4");
}

// Refuse loopback, LAN, link-local and cloud-metadata addresses so a prompt-injected page
// cannot make Claude read the user's internal network.
// shortcut: fetch() resolves DNS again, so a DNS-rebinding host could still slip through; pin the IP via an undici dispatcher if that matters.
export async function assertPublicUrl(url) {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`Only http/https URLs are allowed: ${url}`);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => {
    throw new Error(`Could not resolve host: ${host}`);
  })).map((r) => r.address);
  if (ips.some(isBlockedIp)) throw new Error(`Refusing to fetch a private or local address: ${url}`);
}

function charsetOf(contentType, head) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType || "")?.[1];
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  return fromHeader || fromMeta || "utf-8";
}

// Reads at most MAX_BYTES and decodes with the page's charset (EUC-KR etc.).
export async function readBody(res) {
  const type = res.headers.get("content-type") || "";
  if (type && !TEXT_TYPES.test(type)) throw new Error(`Not a web page (content-type: ${type})`);
  if (Number(res.headers.get("content-length")) > MAX_BYTES) throw new Error(`Page is larger than ${MAX_BYTES / 1048576} MB`);
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error(`Page is larger than ${MAX_BYTES / 1048576} MB`);
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const label = charsetOf(type, bytes.subarray(0, 4096).toString("latin1"));
  let decoder;
  try { decoder = new TextDecoder(label); } catch { decoder = new TextDecoder("utf-8"); }
  return decoder.decode(bytes).normalize("NFC"); // windows-1258 (Vietnamese) decodes tones as combining marks
}

function get(url, cookie) {
  const once = () => fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
      ...(cookie && { Cookie: cookie }),
    },
    redirect: "manual", // each hop is re-checked by assertPublicUrl
    signal: AbortSignal.timeout(20000),
  });
  // One retry: connections to some hosts (Naver) intermittently time out.
  return once().catch(once).catch((err) => {
    throw new Error(`Could not reach ${url}: ${err.cause?.code || err.cause?.message || err.message}`);
  });
}

// Returns { url, text } where text is "# title" plus the page's main content in Markdown.
export async function fetchText(raw, { links = true } = {}) {
  let url = normalizeUrl(raw);
  // Some sites (Brunch) set a cookie and redirect to the same URL; without it they loop forever.
  // shortcut: cookies are kept per host for this one request only and ignore Path/Domain/Expires.
  const jar = new Map();
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(url);
    const host = new URL(url).host;
    const res = await get(url, jar.get(host) && [...jar.get(host)].map(([k, v]) => `${k}=${v}`).join("; "));
    for (const c of res.headers.getSetCookie()) {
      const [, k, v] = c.match(/^([^=;\s]+)=([^;]*)/) || [];
      if (k) jar.set(host, (jar.get(host) || new Map()).set(k, v));
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects: ${raw}`);
      url = normalizeUrl(new URL(location, url).href);
      continue;
    }
    if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status} for ${url}`);
    const isPlain = /^text\/plain\b/i.test(res.headers.get("content-type") || "");
    const body = await readBody(res);
    const { title, markdown } = isPlain ? { title: "", markdown: body.trim() } : extract(body, { links });
    if (markdown.length < 200) throw new Error(`Page text too short (${markdown.length} chars) - page may need JavaScript or login: ${url}`);
    return { url, text: title && !markdown.startsWith(title) ? `# ${title}\n\n${markdown}` : markdown };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const link = process.argv[2];
  if (!link) {
    console.error("Usage: node page.mjs <URL>");
    process.exit(1);
  }
  fetchText(link).then((r) => console.log(r.text), (e) => { console.error(e.message); process.exit(1); });
}
