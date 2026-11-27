// End-to-end tests of the real fetch path (redirects, cookies, limits, encodings, file types, robots.txt,
// crawling, cache) and of the MCP tools, against a local HTTP server. No internet needed.
import assert from "node:assert/strict";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { strToU8, zipSync } from "fflate";
import { crawlSite, fetchText, testAllowHosts } from "./page.mjs";
import { createServer } from "./tools.mjs";

process.env.LINKBRIEF_BROWSER = "off"; // the browser fallback has its own test in test.mjs

const para = (t) => `<p>${t} ${"This sentence makes the article long enough to count as real content. ".repeat(5)}</p>`;
const page = (title, body, head = "") => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body><nav>Menu Home About</nav><article><h1>${title}</h1>${body}</article><footer>Footer text</footer></body></html>`;
const makePdf = (line) => {
  const stream = `BT /F1 12 Tf 20 80 Td (${line}) Tj ET`;
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 120] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let out = "%PDF-1.4\n";
  const offsets = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
};
const docx = (text) => Buffer.from(zipSync({ "word/document.xml": strToU8(`<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`) }));
const eucKr = (n) => Buffer.concat([Buffer.from('<html><head><meta charset="euc-kr"><title>k</title></head><body><article><p>'), Buffer.from(Array(n).fill([0xc7, 0xd1, 0xb1, 0xdb]).flat()), Buffer.from("</p></article></body></html>")]);
const sjis = (n) => Buffer.concat([Buffer.from('<html><head><meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS"><title>j</title></head><body><article><p>'), Buffer.from(Array(n).fill([0x93, 0xfa, 0x96, 0x7b]).flat()), Buffer.from("</p></article></body></html>")]);

const hits = {};
const routes = {
  "/article": (req, res) => send(res, 200, "text/html", page("Plain article", para("First.") + para("Second."), '<meta name="author" content="Ann"><meta property="article:published_time" content="2026-01-02T03:04:05Z">')),
  "/redirect/1": (req, res) => redirect(res, 301, "/redirect/2"),
  "/redirect/2": (req, res) => redirect(res, 302, "/article"),
  "/loop": (req, res) => redirect(res, 302, "/loop"),
  "/to-private": (req, res) => redirect(res, 302, "http://10.1.2.3/secret"),
  "/to-file": (req, res) => redirect(res, 302, "file:///etc/passwd"),
  "/cookie": (req, res) => (/(^|; )k=v/.test(req.headers.cookie || "") ? routes["/article"](req, res) : redirect(res, 302, "/cookie", { "set-cookie": "k=v; Path=/" })),
  "/big-declared": (req, res) => { res.writeHead(200, { "content-type": "text/html", "content-length": 6 * 1024 * 1024 }); res.end(Buffer.alloc(6 * 1024 * 1024, 32)); },
  "/big-chunked": (req, res) => { res.writeHead(200, { "content-type": "text/html" }); for (let i = 0; i < 12; i++) res.write(Buffer.alloc(512 * 1024, 32)); res.end(); },
  "/euc-kr": (req, res) => send(res, 200, "text/html", eucKr(120)),
  "/sjis": (req, res) => send(res, 200, "text/html", sjis(120)),
  "/plain": (req, res) => send(res, 200, "text/plain; charset=utf-8", "line one\nline two"),
  "/json": (req, res) => send(res, 200, "application/json", "{}"),
  "/paper": (req, res) => send(res, 200, "application/pdf", makePdf("Local PDF text")),
  "/files/report.pdf": (req, res) => send(res, 200, "application/octet-stream", makePdf("Octet PDF")),
  "/files/notes.docx": (req, res) => send(res, 200, "application/octet-stream", docx("Word text from a link")),
  "/files/bomb.docx": (req, res) => send(res, 200, "application/octet-stream", Buffer.from(zipSync({ "word/document.xml": new Uint8Array(61 * 1024 * 1024).fill(32) }))),
  "/files/old.hwp": (req, res) => send(res, 200, "application/octet-stream", Buffer.from("HWP Document File")),
  "/403": (req, res) => send(res, 403, "text/html", "<html><body>Forbidden</body></html>"),
  "/500": (req, res) => send(res, 500, "text/html", "<html><body>Oops</body></html>"),
  "/botwall": (req, res) => send(res, 200, "text/html", "<html><head><title>Just a moment...</title></head><body>checking</body></html>"),
  "/short": (req, res) => send(res, 200, "text/html", "<html><body><p>tiny</p></body></html>"),
  "/robots.txt": (req, res) => send(res, 200, "text/plain", "User-agent: *\nDisallow: /docs/secret\nDisallow: /private"),
  "/private": (req, res) => routes["/article"](req, res),
  "/counted": (req, res) => { hits.counted = (hits.counted || 0) + 1; routes["/article"](req, res); },
  "/docs/": (req, res) => send(res, 200, "text/html", page("Docs home", para('<a href="intro">Intro</a> <a href="/docs/api#auth">API</a> <a href="/blog/">Blog</a> <a href="/docs/logo.png">logo</a> <a href="/docs/secret">secret</a>'))),
  "/docs/intro": (req, res) => send(res, 200, "text/html", page("Intro", para('<a href="/docs/api">API</a> <a href="/docs/">Home</a>'))),
  "/docs/api": (req, res) => send(res, 200, "text/html", page("API", "<h2>Auth</h2>" + para("Token auth.") + "<h2>Errors</h2>" + para("Error codes."))),
  "/docs/secret": (req, res) => routes["/article"](req, res),
  "/bigpart": (req, res) => send(res, 200, "text/html", page("Big", `<h2>Intro</h2>${para("Short.")}<h2>Huge</h2>${Array.from({ length: 10 }, (_, i) => para(`Chunk ${i}.`)).join("")}`)),
  "/anchored": (req, res) => send(res, 200, "text/html", page("Anchored", `<h2 id="install">Install</h2>${para("Run the installer.")}<h2 id="use">Use</h2>${para("Open the app.")}`)),
  "/long": (req, res) => send(res, 200, "text/html", page("Long", Array.from({ length: 12 }, (_, i) => `<h2>Part ${i + 1}</h2>${para(`Body ${i + 1}.`)}`).join(""))),
};
function send(res, status, type, body) {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}
function redirect(res, status, location, extra = {}) {
  res.writeHead(status, { location, ...extra });
  res.end();
}
const server = http.createServer((req, res) => {
  res.on("error", () => {}); // the client may hang up on purpose (size limits)
  (routes[new URL(req.url, "http://x").pathname] || ((q, r) => send(r, 404, "text/html", "<html><body>Not found</body></html>")))(req, res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
testAllowHosts.add(new URL(base).host);
const get = (path, opts) => fetchText(`${base}${path}`, opts);

// Normal page, metadata, links off by default in the tools (on here: default of fetchText)
{
  const r = await get("/article");
  assert.match(r.text, /^# Plain article\nAuthor: Ann \| Published: 2026-01-02 \| URL: http:\/\/127\.0\.0\.1:\d+\/article\n\n/);
  assert.ok(!r.text.includes("Menu Home") && !r.text.includes("Footer text"));
}

// Redirects: followed, capped, and re-checked at every hop
assert.match((await get("/redirect/1")).text, /URL: http:\/\/127\.0\.0\.1:\d+\/article/);
await assert.rejects(get("/loop"), /Too many redirects/);
await assert.rejects(get("/to-private"), /private or local address: http:\/\/10\.1\.2\.3\/secret/);
await assert.rejects(get("/to-file"), /Only http\/https/);
assert.match((await get("/cookie")).text, /Plain article/, "cookie set on a redirect is sent back");

// Size limits
await assert.rejects(get("/big-declared"), /larger than 5 MB/);
await assert.rejects(get("/big-chunked"), /larger than 5 MB/);
await assert.rejects(get("/files/bomb.docx"), /more than 60 MB/);

// Encodings and file types
assert.match((await get("/euc-kr")).text, /(한글){100}/);
assert.match((await get("/sjis")).text, /(日本){100}/);
assert.match((await get("/plain")).text, /\n\nline one\nline two$/);
await assert.rejects(get("/json"), /Not a web page \(content-type: application\/json\)/);
assert.match((await get("/paper")).text, /PDF, 1 pages[\s\S]*## Page 1\n\nLocal PDF text/);
assert.match((await get("/files/report.pdf")).text, /Octet PDF/);
assert.match((await get("/files/notes.docx")).text, /Source: Word document[\s\S]*Word text from a link/);
await assert.rejects(get("/files/old.hwp"), /binary \.hwp/);

// Errors and refusals
await assert.rejects(get("/403"), /HTTP 403/);
await assert.rejects(get("/500"), /HTTP 500/);
await assert.rejects(get("/nope"), /HTTP 404/);
await assert.rejects(get("/botwall"), /bot check/);
await assert.rejects(get("/short"), /too short/);

// Cache: a second read of the same URL does not hit the server; failures are not cached
await get("/counted");
await get("/counted");
assert.equal(hits.counted, 1);

// robots.txt: ignored for single links by default, honoured with LINKBRIEF_ROBOTS=always
assert.match((await get("/private")).text, /Plain article/);
process.env.LINKBRIEF_ROBOTS = "always";
await assert.rejects(get("/private?again"), /robots\.txt on 127\.0\.0\.1:\d+ asks automated tools not to read/);
delete process.env.LINKBRIEF_ROBOTS;

// Crawling for real: folder scope, robots.txt, assets, fragments
{
  const r = await crawlSite(`${base}/docs/`, { maxPages: 10, delayMs: 0, links: false });
  assert.deepEqual(r.pages.map((p) => new URL(p.url).pathname), ["/docs/", "/docs/intro", "/docs/api"]);
  assert.deepEqual(r.skipped.map((s) => s.replace(base, "")), ["/docs/secret (robots.txt)"]);
  const early = await crawlSite(`${base}/docs/`, { maxPages: 10, delayMs: 0, budgetMs: -1 });
  assert.equal(early.timedOut, true);
  assert.equal(early.pages.length, 0);
}

// llms.txt and Markdown docs, on a second local site; a third site answers every path with its home page
{
  const serve = (handler) => new Promise((r) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => r(s));
  });
  const md = (title, body) => `# ${title}\n\n${body}\n`;
  let docsBase;
  const docs = await serve((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    if (p === "/llms.txt") return send(res, 200, "text/plain; charset=utf-8", `# Docs\n\n> Index for language models.\n\n- [Start](/guide/start.md): first steps\n- [API](${docsBase}/guide/api.md): reference\n- [Outside](/other/x.md): not under /guide/\n- [Elsewhere](https://elsewhere.example/a)\n`);
    if (p === "/guide/") return send(res, 200, "text/html", page("Guide", para('<a href="/guide/start.md">Start</a>')));
    if (p === "/guide/start.md") return send(res, 200, "text/markdown; charset=utf-8", md("Start", `Install with [npm](https://npmjs.com). ${"More words for length. ".repeat(10)}`));
    if (p === "/guide/api.md") return send(res, 200, "text/markdown", md("API", "## Auth\n\nUse a token."));
    send(res, 404, "text/html", "<html><body>nope</body></html>");
  });
  docsBase = `http://127.0.0.1:${docs.address().port}`;
  testAllowHosts.add(new URL(docsBase).host);
  const spa = await serve((req, res) => send(res, 200, "text/html", page("App home", para("Same page for every path."))));
  const spaBase = `http://127.0.0.1:${spa.address().port}`;
  testAllowHosts.add(new URL(spaBase).host);

  const r = await crawlSite(`${docsBase}/guide/`, { maxPages: 10, delayMs: 0, links: false });
  assert.equal(r.llmsTxt, `${docsBase}/llms.txt`);
  assert.deepEqual(r.pages.map((p) => new URL(p.url).pathname), ["/llms.txt", "/guide/", "/guide/start.md", "/guide/api.md"]);
  const start = r.pages.find((p) => p.url.endsWith("start.md")).text;
  assert.match(start, /Install with npm\./, "Markdown links reduced to their text when include_links is off");
  assert.ok(!(await crawlSite(`${spaBase}/x/`, { maxPages: 3, delayMs: 0 })).llmsTxt, "a home page served at /llms.txt is not an index");
  assert.equal((await crawlSite(`${docsBase}/guide/`, { maxPages: 3, delayMs: 0, useLlmsTxt: false })).llmsTxt, null);
  docs.close();
  spa.close();
}

// MCP tools over an in-memory transport
{
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return { err: !!r.isError, text: r.content[0].text };
  };
  assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["fetch_page", "fetch_pages", "fetch_site"]);

  let r = await call("fetch_page", { url: `${base}/long`, outline: true });
  assert.match(r.text, /^# Long\nURL: [^\n]+\n\nOutline: 12 sections/); // the h1 is the page title, not a section
  r = await call("fetch_page", { url: `${base}/long`, section: "Part 12" });
  assert.match(r.text, /## Part 12\n\nBody 12\./);
  assert.ok(!r.text.includes("Part 11"));
  r = await call("fetch_page", { url: `${base}/bigpart`, section: "Huge", max_length: 1000 });
  assert.match(r.text, /Call fetch_page again with section="Huge" and start_index=1000 for more\.\]$/);
  r = await call("fetch_page", { url: `${base}/bigpart`, section: "Huge", max_length: 1000, start_index: 1000 });
  assert.ok(!r.text.startsWith("# Big"), "the next part continues inside the section");
  r = await call("fetch_page", { url: `${base}/long`, section: "Nope" });
  assert.ok(r.err && /No section matches "Nope"/.test(r.text));
  r = await call("fetch_page", { url: `${base}/long`, section: "   " });
  assert.ok(r.err && /section number/.test(r.text));
  r = await call("fetch_page", { url: `${base}/article`, include_links: false });
  assert.ok(!r.err);

  // find, alone and inside a section, with the paging note keeping both
  r = await call("fetch_page", { url: `${base}/long`, find: '"Body 7"' });
  assert.match(r.text, /Found 1 block mentioning "body 7"[\s\S]*--- in: Part 7 ---\n## Part 7\n\nBody 7\./);
  r = await call("fetch_page", { url: `${base}/bigpart`, section: "Huge", find: "Chunk", max_length: 1000 });
  assert.match(r.text, /Call fetch_page again with section="Huge" and find="Chunk" and start_index=\d+ for more\.\]$/);
  r = await call("fetch_page", { url: `${base}/long`, find: "nothing-like-this" });
  assert.ok(!r.err && /No passage mentions/.test(r.text));

  // anchors in outline and section
  r = await call("fetch_page", { url: `${base}/anchored`, outline: true });
  assert.match(r.text, /- #\d+ Install \(\d+ chars, anchor=install\)/);
  r = await call("fetch_page", { url: `${base}/anchored`, section: "Install" });
  assert.match(r.text, new RegExp(`Section link: ${base.replace(/\./g, "\\.")}/anchored#install`));

  r = await call("fetch_pages", { urls: [`${base}/article`, `${base}/nope`], max_length_per_page: 1000 });
  assert.ok(!r.err);
  assert.match(r.text, /=== Page 2 of 2 ===\nURL: .*\/nope\n\n\[Failed: Fetch failed: HTTP 404/);
  r = await call("fetch_pages", { urls: [`${base}/nope`, `${base}/500`] });
  assert.ok(r.err, "all failed -> isError");

  r = await call("fetch_site", { url: `${base}/docs/`, max_pages: 2, max_length_per_page: 600 });
  assert.match(r.text, /^Read 2 pages under http:\/\/127\.0\.0\.1:\d+\/docs\/ \(robots\.txt respected\)\.\n1 more linked page under it not read/);
  r = await call("fetch_site", { url: `${base}/nope/` });
  assert.ok(r.err && /No pages could be read/.test(r.text));

  r = await call("fetch_page", { url: "not a url" });
  assert.ok(r.err, "schema rejects invalid URLs");
  await client.close();
}

server.close();
console.log("ok (http)");
