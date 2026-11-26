// Fetch a web page from this PC and extract its main content as Markdown.
// CLI check: node page.mjs <URL>
import dns from "node:dns/promises";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { findBrowser, renderPage } from "./browser.mjs";
import { normalizeUrl } from "./sites.mjs";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 30 * 1024 * 1024;
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
  const meta = (sel) => document.querySelector(sel)?.getAttribute("content")?.trim() || "";
  // Naver's nickname meta beats Readability's guess there ("브랜드마이.. | 블로그").
  const byline = (meta('meta[property="naverblog:nickname"]') || article?.byline || meta('meta[name="author"]')).trim();
  const siteName = (article?.siteName || meta('meta[property="og:site_name"]')).trim();
  const published = (article?.publishedTime || meta('meta[property="article:published_time"]')).trim();
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
  return { title, byline, siteName, published, markdown };
}

// "2026-10-23T09:00:00+09:00" or PDF "D:20240101120000" -> "2026-10-23"; anything else as-is.
function shortDate(s) {
  const m = /(\d{4})-?(\d{2})-?(\d{2})/.exec(s || "");
  return m ? `${m[1]}-${m[2]}-${m[3]}` : (s || "");
}

// "# title" + one line of source info + body, so Claude can cite where a summary came from.
export function formatPage({ url, title, byline, siteName, published, pages, markdown }) {
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

async function readBytes(res, max) {
  const tooBig = `Response is larger than ${max / 1048576} MB`;
  if (Number(res.headers.get("content-length")) > max) throw new Error(tooBig);
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > max) throw new Error(tooBig);
    chunks.push(chunk);
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
  const promise = Promise.resolve().then(() => (render ? fetchRendered(normalizeUrl(raw), links) : fetchUncached(raw, { links })));
  cache.delete(key); // re-insert so an expired entry moves to the newest end for eviction
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key)); // never cache failures
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return promise;
}

// Bot-check interstitials (Cloudflare etc.) are reported, never solved or bypassed.
// Not "cdn-cgi/challenge-platform" alone: Cloudflare also injects that script into normal pages (discord.com).
export function isBotWall(html) {
  return /window\._cf_chl_opt|<title>\s*(just a moment|잠시만 기다리십시오|attention required)/i.test(html);
}
const botWallError = (url) => new Error(`This site shows a bot check (e.g. Cloudflare) instead of the page; linkbrief does not bypass it: ${url}`);

async function fetchRendered(url, links) {
  await assertPublicUrl(url);
  const rendered = await renderPage(url, assertPublicUrl);
  if (isBotWall(rendered.html)) throw botWallError(rendered.url);
  if (rendered.status >= 400) throw new Error(`Fetch failed in browser: HTTP ${rendered.status} for ${rendered.url}`);
  const page = extract(rendered.html, { links });
  if (page.markdown.length < 200) throw new Error(`Page text too short even after JavaScript rendering - page may need login: ${rendered.url}`);
  return { url: rendered.url, text: formatPage({ url: rendered.url, ...page }) };
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

async function fetchPlain(raw, { links }) {
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
    } else if (/^text\/plain\b/i.test(type)) {
      page = { markdown: (await readBody(res)).trim() };
    } else {
      const html = await readBody(res);
      if (isBotWall(html)) throw botWallError(url);
      page = extract(html, { links });
      if (page.markdown.length < 200) throw browserRetryable(`Page text too short (${page.markdown.length} chars) - page may need JavaScript or login: ${url}`, url);
    }
    return { url, text: formatPage({ url, ...page }) };
  }
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
