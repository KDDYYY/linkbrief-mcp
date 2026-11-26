import assert from "node:assert/strict";
import fs from "node:fs";
import { extract, paginate, isBlockedIp, assertPublicUrl, readBody, formatPage, pdfToMarkdown, isBotWall, fetchText } from "./page.mjs";
import { findBrowser, renderPage } from "./browser.mjs";
import { normalizeUrl } from "./sites.mjs";

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

// Site adapters: Naver URL forms
const m = "https://m.blog.naver.com/PostView.naver?blogId=brandmite&logNo=224450419315";
assert.equal(normalizeUrl("https://blog.naver.com/PostView.naver?blogId=brandmite&logNo=224450419315"), m);
assert.equal(normalizeUrl("https://blog.naver.com/brandmite/224450419315"), m);
assert.equal(normalizeUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
assert.throws(() => normalizeUrl("https://www.google.com/search?q=kimchi"), /block automated access/);
assert.throws(() => normalizeUrl("https://www.google.co.kr/search?q=x"), /block automated access/);
assert.equal(normalizeUrl("https://blog.google/"), "https://blog.google/");

// Icon-only link (text hidden inside a dropped <svg>) leaves no "[](...)"
assert.ok(!extract('<body><p><a href="/home"><svg><title>home</title></svg></a> 홈 메뉴 아래 본문 텍스트</p></body>').markdown.includes("]("));

// Extraction: Naver-style page
{
  const { title, markdown } = extract(fixture("naver-blog.html"));
  assert.match(title, /테스트 글 제목/);
  assert.match(markdown, /\*\*테스트 글 제목\*\*\n\n\*\*작성자: 테스터\*\*/, "separate paragraphs stay separate");
  assert.match(markdown, /\[https:\/\/youtu\.be\/abc\?si=xyz\]\(https:\/\/youtu\.be\/abc\?si=xyz\)/, "entities decoded in links");
  assert.match(markdown, /'작은따옴표'/);
  assert.match(markdown, /&lt; 문자열/, "&amp;lt; decodes once, to &lt;");
  assert.match(markdown, /\| 구분 \| 방식 A \| 방식 B \|\n\| --- \| --- \| --- \|\n\| 작동 \| 픽셀 생성 \| 코드 \\\| 렌더링 \|/, "table without <th>");
  assert.match(markdown, /마지막 문단입니다/);
  for (const junk of ["****", "[](", "thumbnail", "should not appear", "\u200b"]) assert.ok(!markdown.includes(junk), `no ${JSON.stringify(junk)}`);
}

// Extraction: generic article drops nav, ads and footer
{
  const { title, markdown } = extract(fixture("article-with-nav.html"));
  assert.match(title, /기사 제목 테스트/);
  assert.match(markdown, /## 소제목 하나/);
  assert.match(markdown, /\*\*강조\*\*/);
  assert.match(markdown, /\[출처 링크\]\(https:\/\/example\.com\/source\)/);
  assert.match(markdown, /- 첫 번째 항목/);
  for (const junk of ["ADVERTISEMENT", "Copyright", "경제"]) assert.ok(!markdown.includes(junk), `no ${junk}`);
}

// Link stripping keeps text, including escaped brackets and parenthesised URLs
{
  const { markdown } = extract(fixture("article-with-nav.html"), { links: false });
  assert.match(markdown, /출처 링크가 유지/);
  assert.ok(!markdown.includes("example.com"));
  const wiki = '<body><article><p>Kimchi<a href="#cite_note-1">[1]</a> see <a href="https://en.wikipedia.org/wiki/Kimchi_(disambiguation)" title="Kimchi (disambiguation)">Kimchi (disambiguation)</a> and <a href="/wiki/%E9%9F%93">韓國</a>. ' + "본문 ".repeat(60) + "</p></article></body>";
  const stripped = extract(wiki, { links: false }).markdown;
  assert.match(stripped, /^Kimchi\\\[1\\\] see Kimchi \(disambiguation\) and 韓國\./, stripped);
  assert.ok(!stripped.includes("]("), stripped);
  // Literal brackets in prose before a footnote link (seen on fr.wikipedia) must survive
  const prose = '<body><article><p>le peuple Goguryeo [renvoyant au peuple coréen] est doué dans le livre des Wei<a href="#cite_note-15">[15]</a>. ' + "texte ".repeat(60) + "</p></article></body>";
  assert.match(extract(prose, { links: false }).markdown, /^le peuple Goguryeo \\\[renvoyant au peuple coréen\\\] est doué dans le livre des Wei\\\[15\\\]\./);
}

// Metadata: Naver nickname, og:site_name, published time -> one source line under the title
{
  const page = extract(fixture("naver-blog.html"));
  assert.equal(page.byline, "테스터");
  assert.equal(page.siteName, "네이버 블로그");
  const article = extract(fixture("article-with-nav.html"));
  assert.equal(article.byline, "테스트 기자");
  assert.equal(article.published, "2026-11-20T09:30:00+09:00");
  const text = formatPage({ url: "https://news.example/1", ...article });
  assert.match(text, /^# 기사 제목 테스트( - 테스트 뉴스)?\nSource: 테스트 뉴스 \| Author: 테스트 기자 \| Published: 2026-11-20 \| URL: https:\/\/news\.example\/1\n\n/, text);
  assert.equal(formatPage({ url: "https://x.example/", markdown: "본문" }), "URL: https://x.example/\n\n본문");
}

// PDF: text per page, real metadata kept, placeholder authors dropped
{
  const makePdf = (lines, info) => {
    const stream = `BT /F1 12 Tf 20 80 Td 14 TL ${lines.map((l) => `(${l}) Tj T*`).join(" ")} ET`;
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 120] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      `<< ${Object.entries(info).map(([k, v]) => `/${k} (${v})`).join(" ")} >>`,
    ];
    let out = "%PDF-1.4\n";
    const offsets = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, "latin1");
  };
  const pdf = await pdfToMarkdown(makePdf(["Hello linkbrief", "Second line"], { Title: "Test Report", Author: "Jane Doe", CreationDate: "D:20250102030405" }));
  assert.equal(pdf.pages, 1);
  assert.equal(pdf.title, "Test Report");
  assert.equal(pdf.byline, "Jane Doe");
  assert.match(pdf.markdown, /^## Page 1\n\nHello linkbrief\s+Second line/);
  assert.match(formatPage({ url: "https://x.example/a.pdf", ...pdf }), /Author: Jane Doe \| Published: 2025-01-02 \| PDF, 1 pages/);
  assert.equal((await pdfToMarkdown(makePdf(["x"], { Author: "User" }))).byline, "");
}

// Bot-check pages are detected, not treated as content
assert.ok(isBotWall('<html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script></body></html>'));
assert.ok(isBotWall("<html><head><title>잠시만 기다리십시오…</title></head></html>"));
assert.ok(!isBotWall(fixture("article-with-nav.html")));
// Cloudflare injects challenge-platform scripts into normal pages too (seen on discord.com)
assert.ok(!isBotWall(fixture("article-with-nav.html").replace("</body>", '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></body>')));

// fetchText always returns a promise, even when the URL is refused or invalid, and failures are not cached
{
  const refused = fetchText("https://www.google.com/search?q=x");
  assert.ok(refused instanceof Promise);
  await assert.rejects(refused, /block automated access/);
  await assert.rejects(fetchText("not a url"), /Invalid URL/);
  await assert.rejects(fetchText("http://127.0.0.1/", { render: true }), /private or local/);
  assert.notEqual(fetchText("https://www.google.com/search?q=x").catch(() => {}), refused, "failed fetch must not be cached");
}

// Browser discovery honours LINKBRIEF_BROWSER
{
  const saved = process.env.LINKBRIEF_BROWSER;
  process.env.LINKBRIEF_BROWSER = "off";
  assert.equal(findBrowser(), null);
  process.env.LINKBRIEF_BROWSER = "Z:\\no\\such\\browser.exe";
  assert.equal(findBrowser(), null);
  if (saved === undefined) delete process.env.LINKBRIEF_BROWSER; else process.env.LINKBRIEF_BROWSER = saved;
}

// Headless rendering (skipped when no Chrome/Edge or puppeteer-core): JS-built content appears,
// and the page's own request to a private address is blocked.
if (findBrowser() && await import("puppeteer-core").then(() => true, () => false)) {
  const html = `<html><head><title>start</title></head><body><div id="app"></div><script>
    document.getElementById("app").innerHTML = "<article><h1>CSR</h1><p>" + "rendered by script. ".repeat(30) + "</p></article>";
    fetch("http://127.0.0.1:9/secret").then(() => { document.title = "LEAKED"; }, () => { document.title = "blocked"; });
  </script></body></html>`;
  const r = await renderPage(`data:text/html,${encodeURIComponent(html)}`, assertPublicUrl).catch((err) => {
    if (/Failed to launch|sandbox/i.test(err.message)) return null; // e.g. CI runners without a usable Chrome sandbox
    throw err;
  });
  if (r) {
    assert.match(r.html, /rendered by script\. rendered by script\./);
    assert.match(r.html, /<title>blocked<\/title>/, "private request from the page must be aborted");
    // Concurrent renders are queued and both complete
    const simple = (n) => `data:text/html,${encodeURIComponent(`<p>page ${n}</p>`)}`;
    const both = await Promise.all([renderPage(simple(1), assertPublicUrl), renderPage(simple(2), assertPublicUrl)]);
    assert.match(both[0].html, /page 1/);
    assert.match(both[1].html, /page 2/);
  } else console.log("(skipped browser test: browser could not launch here)");
} else console.log("(skipped browser test: no Chrome/Edge or puppeteer-core)");

// Extraction: no article -> whole body fallback
assert.match(extract("<html><body><div>짧은 페이지</div></body></html>").markdown, /짧은 페이지/);

// Paging
const long = "가".repeat(50);
assert.equal(paginate(long, 0, 100), long);
assert.match(paginate(long, 0, 20), /^가{20}\n\n\[Truncated: showing characters 0-20 of 50\. Call fetch_page again with start_index=20/);
assert.equal(paginate(long, 40, 20), "가".repeat(10));
assert.match(paginate(long, 50, 20), /No more content/);

// Private / local addresses
for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.10", "172.20.0.1", "169.254.169.254", "0.0.0.0", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1"])
  assert.ok(isBlockedIp(ip), ip);
for (const ip of ["8.8.8.8", "23.49.204.248", "2606:4700::1111"]) assert.ok(!isBlockedIp(ip), ip);
for (const u of ["http://localhost/", "http://127.0.0.1:8080/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://169.254.169.254/latest/meta-data/", "file:///C:/Windows/win.ini"])
  await assert.rejects(assertPublicUrl(u), undefined, u);

// Body reading: charset, content-type, size
const eucKr = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]); // "한글" in EUC-KR
assert.equal(await readBody(new Response(eucKr, { headers: { "content-type": "text/html; charset=euc-kr" } })), "한글");
const metaPage = Buffer.concat([Buffer.from('<meta charset="euc-kr">'), eucKr]);
assert.ok((await readBody(new Response(metaPage, { headers: { "content-type": "text/html" } }))).endsWith("한글"));
assert.equal(await readBody(new Response("안녕", { headers: { "content-type": "text/html; charset=utf-8" } })), "안녕");
for (const [charset, bytes, text] of [
  ["shift_jis", [0x93, 0xfa, 0x96, 0x7b], "日本"],
  ["euc-jp", [0xc6, 0xfc, 0xcb, 0xdc], "日本"],
  ["gbk", [0xd6, 0xd0, 0xce, 0xc4], "中文"],
  ["gb2312", [0xd6, 0xd0, 0xce, 0xc4], "中文"],
  ["big5", [0xa4, 0xa4, 0xa4, 0xe5], "中文"],
  ["tis-620", [0xe4, 0xb7, 0xc2], "ไทย"],
  ["windows-1258", [0x56, 0x69, 0xea, 0xf2, 0x74], "Việt"], // ê + combining dot below -> NFC "ệ"
  ["iso-8859-1", [0x66, 0x72, 0x61, 0x6e, 0xe7, 0x61, 0x69, 0x73], "français"],
]) assert.equal(await readBody(new Response(Buffer.from(bytes), { headers: { "content-type": `text/html; charset=${charset}` } })), text, charset);
await assert.rejects(readBody(new Response("x", { headers: { "content-type": "image/png" } })), /Not a web page/);
await assert.rejects(readBody(new Response(Buffer.alloc(5 * 1024 * 1024 + 1), { headers: { "content-type": "text/html" } })), /larger than/);

console.log("ok");
