// Fetch a web page from this PC and extract its main content as Markdown.
// CLI check: node page.mjs <URL>
import dns from "node:dns/promises";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { findBrowser, renderPage, sliceImage } from "./browser.mjs";
import { officeKind, officeToMarkdown } from "./office.mjs";
import { robotsAllows } from "./robots.mjs";
import { normalizeUrl, pickFor, sites } from "./sites.mjs";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 30 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TEXT_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain|text\/(x-)?markdown)\b/i;
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
// pick: optional site rule (sites.mjs) returning the article element when Readability gets it wrong.
// MediaWiki (Wikipedia, Fandom, …) wraps each heading in div.mw-heading beside an "[edit]" link;
// Readability drops those link-heavy divs and the headings with them (15 of 18 h2 on a Wikipedia page).
function unwrapMediaWikiHeadings(document) {
  document.querySelectorAll(".mw-editsection").forEach((e) => e.remove());
  document.querySelectorAll("div.mw-heading").forEach((div) => {
    const h = div.querySelector("h1, h2, h3, h4, h5, h6");
    if (h) div.replaceWith(h);
  });
  return document;
}

// Frames given inline (iframe srcdoc: JobKorea job descriptions) are read as part of the page.
// linkedom keeps the attribute's case (React writes srcDoc) and roots a document that starts with <meta> at it.
function inlineFrames(document) {
  for (const frame of document.querySelectorAll("iframe")) {
    const src = frame.getAttribute("srcdoc") ?? frame.getAttribute("srcDoc");
    if (!src) continue;
    const div = document.createElement("div");
    div.setAttribute("data-srcdoc", "");
    div.innerHTML = parseHTML(src).document.querySelector("body")?.innerHTML ?? "";
    frame.replaceWith(div);
  }
  return document;
}

// Links with no text but a label (image maps over a poster: "지원하기", "바로가기") keep the label as their text.
function labelLinks(document) {
  for (const a of document.querySelectorAll("a[href]")) {
    // Only truly empty links: icon links (GitHub's "Permalink: …" over an svg) stay silent.
    const label = !a.children.length && !a.textContent.trim() && (a.getAttribute("aria-label") || a.getAttribute("title") || a.getAttribute("alt"));
    if (label && label.trim()) a.textContent = label.trim();
  }
  return document;
}

const prepare = (html) => labelLinks(inlineFrames(unwrapMediaWikiHeadings(parseHTML(html).document)));

// Images in the main content, as absolute URLs: icons, logos and spacers are left out by name and size.
const NOT_CONTENT_IMAGE = /logo|icon|sprite|blank|spacer|emoji|emoticon|avatar|profile|badge|btn|button|banner|loading|pixel|1x1/i;
function contentImages(html, base) {
  const urls = new Set();
  for (const img of parseHTML(`<html><body>${html}</body></html>`).document.querySelectorAll("img")) {
    const src = ["data-lazy-src", "data-src", "data-original", "src"].map((a) => img.getAttribute(a)).find((v) => v && !v.startsWith("data:"));
    const small = ["width", "height"].some((a) => Number(img.getAttribute(a)) > 0 && Number(img.getAttribute(a)) < 100);
    if (!src || small || NOT_CONTENT_IMAGE.test(src) || /\.svg(\?|$)/i.test(src)) continue;
    try {
      const u = new URL(src, base);
      if (/^https?:$/.test(u.protocol)) urls.add(u.href);
    } catch { /* relative URL without a base */ }
  }
  return [...urls];
}

export function extract(html, { links = true, pick, url } = {}) {
  // linkedom gives no documentElement for empty bodies or bare fragments (Amazon answers 202 with nothing).
  if (!/<html[\s>]/i.test(html)) html = `<html><body>${html}</body></html>`;
  let article = null;
  try { article = new Readability(prepare(html)).parse(); } catch { /* malformed page: use fallback */ }
  const document = prepare(html);
  const picked = pick?.(document);
  if (picked) article = { ...article, content: picked.innerHTML, textContent: picked.textContent };
  // Readability sometimes keeps one block of a sectioned page (job postings: 1k of 3.5k chars); <main> then holds it all.
  const main = !picked && document.querySelector("main");
  const kept = article?.textContent?.trim().length || 0;
  if (main && kept < 1500 && main.textContent.trim().length > 2 * kept) article = { ...article, content: main.innerHTML, textContent: main.textContent };
  const useArticle = picked || (article && article.textContent.trim().length >= 200);
  const title = (article?.title || document.title || "").trim();
  const meta = (sel) => document.querySelector(sel)?.getAttribute("content")?.trim() || "";
  // Naver's nickname meta beats Readability's guess there ("브랜드마이.. | 블로그").
  const byline = (meta('meta[property="naverblog:nickname"]') || article?.byline || meta('meta[name="author"]')).trim();
  const siteName = (article?.siteName || meta('meta[property="og:site_name"]')).trim();
  const published = (article?.publishedTime || meta('meta[property="article:published_time"]')).trim();
  const hrefs = [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")); // for fetch_site
  // Heading ids (lost in Markdown) so outline/section can give exact links such as page#History for citations.
  const anchors = {};
  for (const h of document.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    const id = h.id || h.querySelector("[id]")?.id;
    const key = anchorKey(h.textContent);
    if (id && key && !(key in anchors)) anchors[key] = id;
  }
  const content = useArticle ? article.content : document.body?.innerHTML || html;
  return { title, byline, siteName, published, hrefs, anchors, images: contentImages(content, url), markdown: toMarkdown(content, { links }) };
}

// HTML fragment -> tidy Markdown (also used for API bodies, which need no Readability).
export function toMarkdown(html, { links = true } = {}) {
  return tidyMarkdown(turndown.turndown(html), { links });
}

export function tidyMarkdown(markdown, { links = true } = {}) {
  markdown = markdown.replace(/!\[[^\]]*\]\((?:\\.|[^()\\]|\([^)]*\))*\)/g, ""); // images (GitHub/API Markdown)
  if (!links) markdown = markdown.replace(MD_LINK, "$1");
  return markdown
    .replace(ZERO_WIDTH, "")
    .replace(/\[\s*\]\([^)]*\)/g, "") // links left empty once icons/images were dropped
    .replace(/^([ \t]*(?:-|\d+\.)) {2,}/gm, "$1 ") // turndown pads list markers to 4 columns
    .replace(/[ \t ]+$/gm, "")
    .replace(/^[ \t ]+(?![-*+] |\d+\. )/gm, "") // stray indentation (often NBSP); keeps nested list items
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// "2026-10-23T09:00:00+09:00" or PDF "D:20240101120000" -> "2026-10-23"; anything else as-is.
function shortDate(s) {
  const m = /(\d{4})-?(\d{2})-?(\d{2})/.exec(s || "");
  return m ? `${m[1]}-${m[2]}-${m[3]}` : (s || "");
}

// "# title" + one line of source info + body, so Claude can cite where a summary came from.
export function formatPage({ url, title, byline, siteName, published, pages, markdown }) {
  // Header fields stay on one line: outline/section split the header from the body at the first blank line.
  const one = (s) => (s ? String(s).replace(/\s+/g, " ").trim() : "");
  [title, byline, siteName, published] = [title, byline, siteName, published].map(one);
  const info = [
    siteName && `Source: ${siteName}`,
    byline && `Author: ${byline}`,
    published && `Published: ${shortDate(published)}`,
    pages && `PDF, ${pages} pages`,
    `URL: ${url}`,
  ].filter(Boolean).join(" | ");
  const heading = title && !markdown.startsWith(title) ? `# ${title}\n` : "";
  return `${heading}${info}\n\n${markdown}`;
}

// ---- Outline / section reading: let the agent see a page's structure first and read only what it needs.
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
// Heading text reduced to letters and digits, to pair Markdown headings with the HTML heading ids.
const anchorKey = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const plainHeading = (s) => s.replace(MD_LINK, "$1").replace(/[*_`]/g, "").replace(/\\([[\]().#-])/g, "$1").trim();

// formatPage output is "# title\ninfo line" + blank line + body; the head is kept on every outline/section reply.
function splitHead(text) {
  const i = text.indexOf("\n\n");
  return i < 0 ? [text, ""] : [text.slice(0, i), text.slice(i + 2)];
}

// Headings of a Markdown body (ignoring code fences), each with the span up to the next heading
// of the same or higher level (= the section with its subsections) and up to the very next heading (= own text).
export function sections(md) {
  const heads = [];
  let fence = false, pos = 0;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && HEADING.exec(line);
    if (m) heads.push({ level: m[1].length, title: plainHeading(m[2]), start: pos });
    pos += line.length + 1;
  }
  return heads.map((h, i) => ({
    ...h,
    end: heads.slice(i + 1).find((n) => n.level <= h.level)?.start ?? md.length,
    ownEnd: heads[i + 1]?.start ?? md.length,
  }));
}

// anchors: heading key -> HTML id, from extract(); a section's citable link is the page URL + "#" + id.
const anchorOf = (s, anchors) => anchors?.[anchorKey(s.title)];
const pageUrlOf = (head) => /(?:^|\| )URL: (\S+)/m.exec(head)?.[1];

export function outline(text, anchors) {
  const [head, body] = splitHead(text);
  const secs = sections(body);
  if (!secs.length) return `${head}\n\n(No headings on this page; it is ${body.length.toLocaleString("en-US")} characters. Read it without outline.)`;
  const top = Math.min(...secs.map((s) => s.level));
  const rows = secs.map((s, i) => {
    const first = body.slice(s.start, s.ownEnd).split("\n").slice(1).map((l) => l.trim()).find((l) => l && !/^[|-]+$/.test(l)) || "";
    const plain = first.replace(MD_LINK, "$1").replace(/[*_`>|#]/g, "").replace(/\s+/g, " ").trim();
    const preview = plain.length > 100 ? `${plain.slice(0, 100)}…` : plain;
    const anchor = anchorOf(s, anchors);
    // Headings made only of markup ("## **") end up empty: label them so the agent picks them by number.
    return `${"  ".repeat(s.level - top)}- #${i + 1} ${s.title || "(untitled)"} (${(s.end - s.start).toLocaleString("en-US")} chars${anchor ? `, anchor=${anchor}` : ""})${preview ? `: ${preview}` : ""}`;
  });
  const cite = rows.some((r) => r.includes(", anchor=")) ? " Cite a section as its page URL + \"#\" + anchor." : "";
  return `${head}\n\nOutline: ${secs.length} sections, ${body.length.toLocaleString("en-US")} characters in total. Read one with section="#N" or its heading text.${cite}\n\n${rows.join("\n")}`;
}

// One section with its subsections, by outline number ("#3") or heading text (exact first, then partial match).
export function section(text, wanted, anchors) {
  const [head, body] = splitHead(text);
  const secs = sections(body);
  if (!secs.length) throw new Error("This page has no headings; read it without section.");
  const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const w = norm(wanted);
  if (!w) throw new Error('Give a section number like "#3" or heading text.');
  const n = /^#(\d+)$/.exec(w);
  const hit = n ? secs[Number(n[1]) - 1] : secs.find((s) => norm(s.title) === w) || secs.find((s) => norm(s.title).includes(w));
  if (!hit) {
    const list = secs.slice(0, 40).map((s, i) => `#${i + 1} ${s.title}`).join("; ");
    throw new Error(`No section matches "${wanted}". Sections: ${list}${secs.length > 40 ? "; …" : ""}`);
  }
  const anchor = anchorOf(hit, anchors);
  const pageUrl = pageUrlOf(head);
  const link = anchor && pageUrl ? `\nSection link: ${pageUrl.replace(/#.*$/, "")}#${anchor.replace(/ /g, "%20")}` : "";
  return `${head}${link}\n\n${body.slice(hit.start, hit.end).trimEnd()}`;
}

// Blank-line separated blocks of a Markdown body (a fenced code block stays one block), each tagged with
// the headings it sits under.
function blocksOf(body) {
  const blocks = [];
  const path = [];
  let cur = [];
  let fence = false;
  const flush = () => {
    const text = cur.join("\n").trim();
    cur = [];
    if (!text) return;
    const h = !fence && HEADING.exec(text.split("\n")[0]);
    if (h) {
      const level = h[1].length;
      while (path.length && path[path.length - 1].level >= level) path.pop();
      path.push({ level, title: plainHeading(h[2]) || "(untitled)" });
    }
    const where = path.map((p) => p.title);
    // A long list or table with no blank lines (Wikipedia references) would come back whole for one hit: split it by line.
    if (!h && text.length > 1200) text.split("\n").filter((l) => l.trim()).forEach((l) => blocks.push({ text: l, heading: false, path: where, line: true }));
    else blocks.push({ text, heading: Boolean(h), path: where });
  };
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && !line.trim()) flush();
    else cur.push(line);
  }
  flush();
  return blocks;
}

// Passages that mention the query: words or "quoted phrases", case-insensitive, any of them.
// Each hit comes with one block of context either side and the headings it sits under.
export function find(text, query, { context = 1, maxPassages = 20 } = {}) {
  const [head, body] = splitHead(text);
  const terms = [...query.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => (m[1] || m[2]).toLowerCase().trim()).filter(Boolean);
  if (!terms.length) throw new Error("Give words or a \"quoted phrase\" to find.");
  const blocks = blocksOf(body);
  const hits = [];
  blocks.forEach((b, i) => {
    const lower = b.text.toLowerCase();
    const score = terms.filter((t) => lower.includes(t)).length;
    if (score) hits.push({ i, score });
  });
  if (!hits.length) return `${head}\n\nNo passage mentions ${terms.map((t) => `"${t}"`).join(" or ")}. Try other words, or outline=true to see what the page covers.`;
  // Keep the best-scoring hits when there are too many, then show them in page order.
  const kept = [...hits].sort((a, b) => b.score - a.score || a.i - b.i).slice(0, maxPassages).sort((a, b) => a.i - b.i);
  const ranges = [];
  for (const { i } of kept) {
    const from = Math.max(0, i - context);
    const to = Math.min(blocks.length - 1, i + context + (blocks[i].heading ? 1 : 0)); // a matching heading brings its text
    const last = ranges[ranges.length - 1];
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else ranges.push({ from, to });
  }
  const passages = ranges.map(({ from, to }) => {
    const where = blocks[from].path.join(" › ");
    // Lines cut from one long list are rejoined with single newlines, so the list keeps its shape.
    const shown = blocks.slice(from, to + 1);
    const body = shown.map((b, k) => (k && b.line && shown[k - 1].line ? "\n" : k ? "\n\n" : "") + b.text).join("");
    return `--- ${where ? `in: ${where}` : "top of page"} ---\n${body}`;
  });
  const more = hits.length > kept.length ? ` (best ${kept.length} of ${hits.length} matching blocks shown)` : "";
  return `${head}\n\nFound ${hits.length} block${hits.length > 1 ? "s" : ""} mentioning ${terms.map((t) => `"${t}"`).join(" or ")}${more}. Read a whole part with section="<heading>".\n\n${passages.join("\n\n")}`;
}

// One window of a long text, plus a note telling Claude how to read the rest.
export function paginate(text, startIndex = 0, maxLength = 20000) {
  if (startIndex > 0 && startIndex >= text.length) return `(No more content: total length is ${text.length} characters.)`;
  let end = Math.min(text.length, startIndex + maxLength);
  // Never cut a surrogate pair (emoji, rare CJK) in half: step back, or forward when stepping back would leave nothing.
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end = end - 1 > startIndex ? end - 1 : end + 1;
  const part = text.slice(startIndex, end);
  return end < text.length
    ? `${part}\n\n[Truncated: showing characters ${startIndex}-${end} of ${text.length}. Call fetch_page again with start_index=${end} for more.]`
    : part;
}

const blocked = new net.BlockList();
for (const [a, p] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]]) blocked.addSubnet(a, p, "ipv4");
// NAT64 (64:ff9b::/96, 64:ff9b:1::/48) and 6to4 (2002::/16) can carry an IPv4 address such as 127.0.0.1.
for (const [a, p] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["2002::", 16]]) blocked.addSubnet(a, p, "ipv6");

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
// Corporate networks: like other CLI tools, send requests through HTTPS_PROXY / HTTP_PROXY, honouring NO_PROXY.
// Node's built-in fetch ignores these variables, so undici's proxy agent is installed on the first request.
export const proxyUrl = () => process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "";
let proxySetup;
function setupProxy() {
  return (proxySetup ??= proxyUrl()
    ? import("undici").then(({ EnvHttpProxyAgent, setGlobalDispatcher }) => setGlobalDispatcher(new EnvHttpProxyAgent()))
    : Promise.resolve());
}

// Behind a proxy the PC often cannot resolve outside names itself; the proxy does. Such names are let through
// unless they look internal (no dot, or an intranet suffix) — the proxy then decides what it can reach.
// shortcut: an internal host with a public-looking name is only as protected as the proxy's own rules.
const INTRANET_NAME = /(^[^.]+$)|\.(local|localdomain|internal|intranet|corp|lan|home|home\.arpa)$/i;

// Test-only: exact host:port values the guard lets through (the test suite's local server). Nothing else sets it.
export const testAllowHosts = new Set();

export async function assertPublicUrl(url) {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`Only http/https URLs are allowed: ${url}`);
  if (testAllowHosts.has(u.host)) return;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  let ips;
  try {
    ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((r) => r.address);
  } catch {
    if (proxyUrl() && !INTRANET_NAME.test(host)) return; // the proxy resolves it
    throw new Error(`Could not resolve host: ${host}`);
  }
  if (ips.some(isBlockedIp)) throw new Error(`Refusing to fetch a private or local address: ${url}`);
}

function charsetOf(contentType, head) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType || "")?.[1];
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  return fromHeader || fromMeta || "utf-8";
}

async function readBytes(res, max) {
  const tooBig = `Response is larger than ${max / 1048576} MB`;
  if (Number(res.headers.get("content-length")) > max) throw new Error(tooBig);
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of res.body ?? []) {
      size += chunk.length;
      if (size > max) throw new Error(tooBig);
      chunks.push(chunk);
    }
  } catch (err) {
    if (/abort|timeout/i.test(`${err.name} ${err.message}`)) {
      throw new Error(`Timed out after 20 s while downloading ${res.url || "the page"} (${(size / 1048576).toFixed(1)} MB received)`);
    }
    throw err;
  }
  return Buffer.concat(chunks);
}

// Reads at most MAX_BYTES and decodes with the page's charset (EUC-KR etc.).
export async function readBody(res) {
  const type = res.headers.get("content-type") || "";
  if (type && !TEXT_TYPES.test(type)) throw new Error(`Not a web page (content-type: ${type})`);
  const bytes = await readBytes(res, MAX_BYTES);
  const label = charsetOf(type, bytes.subarray(0, 4096).toString("latin1"));
  let decoder;
  try { decoder = new TextDecoder(label); } catch { decoder = new TextDecoder("utf-8"); }
  return decoder.decode(bytes).normalize("NFC"); // windows-1258 (Vietnamese) decodes tones as combining marks
}

async function get(url, cookie, extraHeaders) {
  await setupProxy();
  const once = () => fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
      ...(cookie && { Cookie: cookie }),
      ...extraHeaders,
    },
    redirect: "manual", // each hop is re-checked by assertPublicUrl
    signal: AbortSignal.timeout(20000),
  });
  // One retry: connections to some hosts (Naver) intermittently time out.
  return once().catch(once).catch((err) => {
    throw new Error(`Could not reach ${url}: ${err.cause?.code || err.cause?.message || err.message}`);
  });
}

// PDF text per page. unpdf is imported lazily so web-page users never load pdf.js.
export async function pdfToMarkdown(bytes) {
  const { getDocumentProxy, extractText, getMeta } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const info = (await getMeta(pdf).catch(() => null))?.info || {};
  const markdown = text.map((t, i) => `## Page ${i + 1}\n\n${t.replace(/[ \t]+\n/g, "\n").trim()}`).join("\n\n");
  // Office/HWP defaults such as "User" or "Administrator" are not real authors.
  const author = /^(user|admin(istrator)?|owner|unknown|microsoft.*)$/i.test(info.Author || "") ? "" : info.Author || "";
  return { title: info.Title || "", byline: author, published: info.CreationDate || "", pages: totalPages, markdown };
}

const isPdf = (type, url) => /^application\/(x-)?pdf\b/i.test(type) || (/^(application|binary)\/octet-stream\b/i.test(type) && /\.pdf$/i.test(new URL(url).pathname));

// Pages are cached briefly so reading a long page in parts (start_index) does not refetch it.
const CACHE_MS = 10 * 60 * 1000;
const CACHE_MAX = 30;
const cache = new Map();

// Returns { url, text }: "# title", a source line, then the main content as Markdown.
// render: true goes straight to the headless browser; otherwise it is only a fallback.
export function fetchText(raw, { links = true, render = false } = {}) {
  const key = `${links}|${render}|${raw}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  // Always a promise: normalizeUrl can throw (bad URL, refused site) and fetch_pages relies on rejections.
  // API-backed sites (Naver Cafe) skip the browser: rendering only yields the app's empty frame.
  const useBrowser = () => render && !loaderFor(raw);
  const promise = Promise.resolve().then(() => (useBrowser() ? fetchRendered(normalizeUrl(raw), links) : fetchUncached(raw, { links })));
  cache.delete(key); // re-insert so an expired entry moves to the newest end for eviction
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key)); // never cache failures
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return promise;
}

// Bot-check interstitials (Cloudflare etc.) are reported, never solved or bypassed.
// Not "cdn-cgi/challenge-platform" alone: Cloudflare also injects that script into normal pages (discord.com).
export function isBotWall(html) {
  return /window\._cf_chl_opt|<title>[^<]*(just a moment|잠시만 기다리십시오|attention required|prove your humanity|verify you are human|are you a robot)/i.test(html);
}
const botWallError = (url) => new Error(`This site shows a bot check (e.g. Cloudflare) instead of the page; linkbrief does not bypass it: ${url}`);

async function fetchRendered(url, links) {
  await assertPublicUrl(url);
  const rendered = await renderPage(url, assertPublicUrl);
  if (isBotWall(rendered.html)) throw botWallError(rendered.url);
  if (rendered.status >= 400) throw new Error(`Fetch failed in browser: HTTP ${rendered.status} for ${rendered.url}`);
  const page = extract(rendered.html, { links, pick: pickFor(rendered.url), url: rendered.url });
  if (page.markdown.length < 200 && !page.images.length) throw new Error(`Page text too short even after JavaScript rendering - page may need login: ${rendered.url}`);
  return result(rendered.url, page);
}

// Plain request first; pages that block it (403/429/503) or come back empty retry in a local browser.
async function fetchUncached(raw, { links }) {
  try {
    return await fetchPlain(raw, { links });
  } catch (err) {
    if (!err.browserUrl || !findBrowser()) throw err;
    return fetchRendered(err.browserUrl, links).catch((renderErr) => {
      throw /bot check/.test(renderErr.message) ? renderErr : new Error(`${err.message} (browser retry also failed: ${renderErr.message})`);
    });
  }
}

function browserRetryable(message, url) {
  return Object.assign(new Error(message), { browserUrl: url });
}

// Sites whose page is an empty app shell (Naver Cafe) are read from the JSON API the page itself uses.
// JSON from a site's public API, with the same private-address guard. Error bodies are returned too
// (Naver Cafe answers 401 with a reason) so the site loader can explain them.
export async function getJson(url, headers) {
  await assertPublicUrl(url);
  const res = await get(url, null, headers);
  const body = (await readBytes(res, MAX_BYTES)).toString("utf8");
  try { return JSON.parse(body); } catch {
    throw new Error(`Unexpected response (HTTP ${res.status}) from ${new URL(url).host}`);
  }
}

// robots.txt text for robots.mjs; any failure or non-200 answer means "no rules".
async function fetchRobotsText(url) {
  await assertPublicUrl(url);
  const res = await get(url);
  if (res.status !== 200) return "";
  return (await readBytes(res, 512 * 1024)).toString("utf8");
}
export const robotsAllow = (url) => robotsAllows(url, fetchRobotsText);
export const robotsBlocked = (url) => new Error(`robots.txt on ${new URL(url).host} asks automated tools not to read ${url}`);

// Sites read through their own API (sites.mjs `load`): Naver Cafe, GitHub issues/PRs, Stack Exchange, Hacker News.
export const loaderFor = (raw) => sites.find((s) => s.load && s.match(new URL(raw)));

async function fetchViaLoader(site, u, links) {
  const { html, markdown, ...meta } = await site.load(u, getJson);
  const md = markdown != null ? tidyMarkdown(markdown, { links }) : toMarkdown(html, { links });
  return { url: u.href, text: formatPage({ url: u.href, ...meta, markdown: md }) };
}

async function fetchPlain(raw, { links }) {
  if (process.env.LINKBRIEF_ROBOTS === "always" && !(await robotsAllow(normalizeUrl(raw)))) throw robotsBlocked(raw);
  const loader = loaderFor(raw);
  if (loader) return fetchViaLoader(loader, new URL(raw), links);
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
    if ([403, 429, 503].includes(res.status)) throw browserRetryable(`Fetch failed: HTTP ${res.status} for ${url}`, url);
    if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status} for ${url}`);
    const type = res.headers.get("content-type") || "";
    let page;
    if (isPdf(type, url)) {
      page = await pdfToMarkdown(await readBytes(res, MAX_PDF_BYTES));
      if (!page.markdown.replace(/## Page \d+/g, "").trim()) throw new Error(`PDF has no extractable text (scanned images?): ${url}`);
    } else if (officeKind(type, url)) {
      page = officeToMarkdown(await readBytes(res, MAX_PDF_BYTES), officeKind(type, url));
      if (!page.markdown) throw new Error(`Document has no text: ${url}`);
    } else if (/^text\/(plain|(x-)?markdown)\b/i.test(type)) {
      // Plain text (code files, llms.txt) and Markdown docs: links are collected before any are stripped, for fetch_site.
      const raw = (await readBody(res)).trim();
      const hrefs = [...raw.matchAll(/\]\(([^)\s]+)/g)].map((m) => m[1]);
      page = { markdown: /markdown/i.test(type) ? tidyMarkdown(raw, { links }) : raw, hrefs };
    } else {
      const html = await readBody(res);
      if (isBotWall(html)) throw botWallError(url);
      page = extract(html, { links, pick: pickFor(url), url });
      if (page.markdown.length < 200 && !page.images.length) throw browserRetryable(`Page text too short (${page.markdown.length} chars) - page may need JavaScript or login: ${url}`, url);
    }
    return result(url, page);
  }
}

// imagesOnly: the text is too thin to be the content, so the content is probably in the images (posters, job ads).
function result(url, page) {
  const images = page.images || [];
  return { url, text: formatPage({ url, ...page }), hrefs: page.hrefs, anchors: page.anchors, images, imagesOnly: images.length > 0 && page.markdown.length < 500 };
}

const IMAGE_TYPE = /^image\/(png|jpeg|gif|webp)$/;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 3.5 * 1024 * 1024; // base64 grows it to ~4.7 MB, under the 5 MB the Claude API takes

// Width and height from the file header (PNG, GIF, JPEG, WebP); null if unknown.
export function imageSize(b) {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 10 && b.toString("latin1", 0, 3) === "GIF") return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length > 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    const kind = b.toString("latin1", 12, 16);
    if (kind === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L") { const v = b.readUInt32LE(21); return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 }; }
    if (kind === "VP8X") return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

// One image through the same private-address guard as pages; the page goes along as Referer (image CDNs check it).
async function getImage(url, referer) {
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(url);
    const res = await get(url, null, referer && { Referer: referer });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) { url = new URL(location, url).href; continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const mimeType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase().replace("image/jpg", "image/jpeg");
    if (!IMAGE_TYPE.test(mimeType)) throw new Error(`not an image (${mimeType})`);
    return { bytes: await readBytes(res, MAX_IMAGE_BYTES), mimeType };
  }
  throw new Error("too many redirects");
}

// The page's content images as MCP image blocks ({ data: base64, mimeType }).
// Tall images (job ads, shop detail pages) are cut into tiles with the local browser: the model shrinks any image
// to about 1,568 px on its long side, and small text in a 942x3348 poster would become unreadable.
// Without a browser, images that fit are sent whole. Tiny ones (icons that slipped through) are skipped.
export async function loadImages(urls, referer, { maxBlocks = 8 } = {}) {
  const blocks = [];
  let skipped = 0;
  for (const url of urls) {
    if (blocks.length >= maxBlocks) { skipped++; continue; }
    try {
      const { bytes, mimeType } = await getImage(url, referer);
      const size = imageSize(bytes);
      if (size && (size.width < 200 || size.height < 100)) continue;
      const tall = size && size.height > 1600 && size.height > 1.5 * size.width;
      if ((tall || bytes.length > MAX_INLINE_IMAGE_BYTES) && findBrowser()) {
        const tiles = await sliceImage(bytes, mimeType, { maxTiles: maxBlocks - blocks.length });
        blocks.push(...tiles.map((t) => ({ data: Buffer.from(t).toString("base64"), mimeType: "image/jpeg" })));
      } else if (bytes.length <= MAX_INLINE_IMAGE_BYTES) {
        blocks.push({ data: bytes.toString("base64"), mimeType });
      } else skipped++;
    } catch { skipped++; }
  }
  return { blocks, skipped };
}

const ASSET = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|json|xml|txt|zip|gz|tgz|tar|mp4|mp3|wav|woff2?|ttf|exe|dmg|msi|apk)$/i;

// Reads up to maxPages pages under the start page's folder, breadth-first: always honours robots.txt
// and pauses between requests. fetcher/allow are injectable for tests.
// budgetMs stops early with what was read, so a slow site cannot push the reply past the agent's tool timeout.
// If the site publishes /llms.txt (an index written for language models), it is read first and the
// pages it lists are queued right after the start page, in the order listed.
export async function crawlSite(start, { maxPages = 10, links = false, delayMs = 500, budgetMs = 45000, useLlmsTxt = true, fetcher = fetchText, allow = robotsAllow } = {}) {
  const deadline = Date.now() + budgetMs;
  let timedOut = false;
  const first = new URL(normalizeUrl(start));
  first.hash = "";
  const scope = first.origin + first.pathname.replace(/[^/]*$/, "");
  const queue = [first.href];
  const seen = new Set(queue);
  const pages = [];
  const skipped = [];
  const enqueue = (href, base) => {
    let next;
    try { next = new URL(href, base); } catch { return; }
    next.hash = "";
    if (!next.href.startsWith(scope) || ASSET.test(next.pathname) || seen.has(next.href)) return;
    seen.add(next.href);
    queue.push(next.href);
  };
  let llmsTxt = null;
  const index = `${first.origin}/llms.txt`;
  if (useLlmsTxt && maxPages > 1 && index !== first.href && (await allow(index))) {
    const page = await fetcher(index, { links }).catch(() => null);
    // A real index lists Markdown links; a site that answers every path with its home page does not.
    if (page && (page.hrefs || []).length >= 3 && !/^# /.test(page.text)) {
      llmsTxt = index;
      seen.add(index);
      pages.push(page);
      for (const href of page.hrefs) enqueue(href, index);
    }
  }
  while (queue.length && pages.length < maxPages) {
    if (Date.now() > deadline) { timedOut = true; break; }
    const url = queue.shift();
    if (!(await allow(url))) { skipped.push(`${url} (robots.txt)`); continue; }
    if (pages.length && delayMs) await new Promise((r) => setTimeout(r, delayMs));
    try {
      const page = await fetcher(url, { links });
      pages.push(page);
      for (const href of page.hrefs || []) enqueue(href, page.url);
    } catch (err) {
      skipped.push(`${url} (${err.message.slice(0, 100)})`);
    }
  }
  // Only count leftovers robots.txt would let us read (rules are cached per site, so this costs no requests).
  const readable = await Promise.all(queue.map((u) => allow(u)));
  return { scope, pages, skipped, notRead: readable.filter(Boolean).length, timedOut, llmsTxt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [link, flag] = process.argv.slice(2);
  if (!link) {
    console.error("Usage: node page.mjs <URL> [--render]");
    process.exit(1);
  }
  // exitCode, not exit(): exiting while sockets close trips a libuv assertion on Windows.
  fetchText(link, { render: flag === "--render" }).then((r) => console.log(r.text), (e) => { console.error(e.message); process.exitCode = 1; });
}
