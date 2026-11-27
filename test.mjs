import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import { extract, imageSize, toMarkdown, paginate, isBlockedIp, assertPublicUrl, readBody, formatPage, pdfToMarkdown, isBotWall, fetchText, outline, section, crawlSite, find } from "./page.mjs";
import { findBrowser, renderPage, sliceImage } from "./browser.mjs";

// Minimal grayscale PNG of the given size (for image tests).
const makePng = (w, h) => {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.alloc((w + 1) * h, 200))), chunk("IEND", Buffer.alloc(0))]);
};

import { parseRobots, isAllowed } from "./robots.mjs";
import { officeKind, officeToMarkdown } from "./office.mjs";
import { zipSync, strToU8 } from "fflate";
import { normalizeUrl, naverCafeIds, pickFor, sites, stackExchangeSite } from "./sites.mjs";

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

// Site adapters: Naver URL forms
const m = "https://m.blog.naver.com/PostView.naver?blogId=exampleuser&logNo=223000000001";
assert.equal(normalizeUrl("https://blog.naver.com/PostView.naver?blogId=exampleuser&logNo=223000000001"), m);
assert.equal(normalizeUrl("https://blog.naver.com/exampleuser/223000000001"), m);
assert.equal(normalizeUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
assert.throws(() => normalizeUrl("https://www.google.com/search?q=kimchi"), /block automated access/);
assert.throws(() => normalizeUrl("https://www.google.co.kr/search?q=x"), /block automated access/);
assert.equal(normalizeUrl("https://blog.google/"), "https://blog.google/");

// Naver Cafe: ids from each URL form, API response -> page, login-only posts explained
{
  const ids = (s) => naverCafeIds(new URL(s));
  assert.deepEqual(ids("https://cafe.naver.com/ArticleRead.nhn?clubid=12345678&articleid=42&referrerAllArticles=true"), { club: "12345678", article: "42" });
  assert.deepEqual(ids("https://m.cafe.naver.com/ca-fe/web/cafes/12345678/articles/42"), { club: "12345678", article: "42" });
  assert.deepEqual(ids("https://cafe.naver.com/ca-fe/cafes/12345678/articles/42?boardtype=L"), { club: "12345678", article: "42" });
  assert.equal(ids("https://cafe.naver.com/somecafe/42"), null);
  const cafe = sites.find((s) => s.name === "naver-cafe");
  assert.throws(() => cafe.api(new URL("https://cafe.naver.com/somecafe/42")), /clubid and articleid/);
  const ok = cafe.fromApi({ result: { cafe: { name: "테스트카페" }, article: { subject: "공개 글", writer: { nick: "카페회원" }, writeDate: Date.UTC(2026, 10, 1), contentHtml: "<p>본문</p>" } } });
  assert.deepEqual(ok, { html: "<p>본문</p>", title: "공개 글", byline: "카페회원", siteName: "네이버 카페 | 테스트카페", published: "2026-11-01T00:00:00.000Z" });
  // Shape seen live for a login-only post (2026-11-26)
  assert.throws(() => cafe.fromApi({ result: { errorCode: "0004", reason: "로그인하지 않았습니다.", more: { cafeId: 1 } } }), /logging in or joining the cafe \(Naver says: 로그인하지 않았습니다\.\)/);
}

// Site loaders, fed by a fake getJson keyed by URL substring
{
  const fake = (routes) => async (url) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected request ${url}`);
    return routes[key];
  };
  const site = (name) => sites.find((s) => s.name === name);
  const u = (s) => new URL(s);

  // GitHub PR: description, changed files, comments
  const gh = await site("github-issue").load(u("https://github.com/acme/tool/pull/7"), fake({
    "/issues/7/comments": [{ user: { login: "bob" }, created_at: "2026-01-02T00:00:00Z", body: "Looks good ![img](https://x/y.png)" }],
    "/pulls/7/files": [{ filename: "src/a.js", status: "modified", additions: 3, deletions: 1 }],
    "/issues/7": { title: "Fix bug", state: "open", user: { login: "amy" }, created_at: "2026-01-01T00:00:00Z", labels: [{ name: "bug" }], body: "Fixes it.", comments: 1, pull_request: {} },
  }));
  assert.equal(gh.title, "Fix bug (#7)");
  assert.equal(gh.siteName, "GitHub · acme/tool");
  assert.match(gh.markdown, /^\*\*Pull request · open\*\* · opened by @amy on 2026-01-01 · labels: bug\n\nFixes it\.\n\n## Changed files \(1\)\n\n- src\/a\.js \(modified, \+3 −1\)\n\n## Comments \(1\)\n\n### @bob · 2026-01-02\n\nLooks good/);
  await assert.rejects(site("github-issue").load(u("https://github.com/a/b/issues/1"), fake({ "/issues/1": { message: "API rate limit exceeded for 1.2.3.4." } })), /rate limit.*GITHUB_TOKEN/);
  assert.ok(!site("github-issue").match(u("https://github.com/acme/tool")), "repo home page stays a normal page");

  // GitHub code file -> raw; arXiv abstract -> PDF
  assert.equal(normalizeUrl("https://github.com/acme/tool/blob/main/src/a.js?plain=1#L3"), "https://raw.githubusercontent.com/acme/tool/main/src/a.js");
  assert.equal(normalizeUrl("https://arxiv.org/abs/1706.03762v7"), "https://arxiv.org/pdf/1706.03762v7");
  // Saramin relay view (AJAX shell) -> plain view page with the posting inline; other pages untouched
  assert.equal(normalizeUrl("https://www.saramin.co.kr/zf_user/jobs/relay/view?rec_idx=55137080&view_type=list&t_ref=main#seq=0"), "https://www.saramin.co.kr/zf_user/jobs/view?rec_idx=55137080");
  assert.equal(normalizeUrl("https://www.saramin.co.kr/zf_user/jobs/relay/view?view_type=list"), "https://www.saramin.co.kr/zf_user/jobs/relay/view?view_type=list");

  // A layout table around a data table: the data table is kept once, not flattened into one cell;
  // blocks and line breaks inside a cell are separated by a space
  {
    const md = toMarkdown(`<table><tr><td><p>We are hiring</p><table><tr><td>Role</td><td>Requirements</td></tr>
      <tr><td>Sales</td><td><p>Duties: grow revenue</p><p>Requirements: 5 years</p>English<br>Travel</td></tr></table></td></tr></table>`);
    assert.match(md, /We are hiring/);
    assert.equal((md.match(/\| Sales \|/g) || []).length, 1, md);
    assert.match(md, /\| Sales \| Duties: grow revenue Requirements: 5 years English Travel \|/);
  }

  // Stack Exchange: site names and question + answers
  assert.equal(stackExchangeSite("stackoverflow.com"), "stackoverflow");
  assert.equal(stackExchangeSite("math.stackexchange.com"), "math");
  assert.equal(stackExchangeSite("www.superuser.com"), "superuser");
  assert.equal(stackExchangeSite("mathoverflow.net"), "mathoverflow.net");
  const se = await site("stack-exchange").load(u("https://stackoverflow.com/questions/42/why-is-it"), fake({
    "/answers": { items: [{ is_accepted: true, score: 9, owner: { display_name: "Ann" }, body: "<p>Because.</p>" }] },
    "/questions/42?": { items: [{ title: "Why &quot;x&quot;?", score: 5, owner: { display_name: "Q&amp;A" }, tags: ["js"], body: "<p>Why?</p>", answer_count: 3, creation_date: 1700000000 }] },
  }));
  assert.equal(se.title, 'Why "x"?');
  assert.equal(se.byline, "Q&A");
  assert.match(se.html, /<h2>Answers \(3, top 1 by votes\)<\/h2>\n<h3>✓ Accepted answer · score 9 · Ann<\/h3><p>Because\.<\/p>/);
  assert.ok(!site("stack-exchange").match(u("https://stackoverflow.com/tags")));

  // Hacker News: nested comments, dead ones skipped
  const hn = await site("hacker-news").load(u("https://news.ycombinator.com/item?id=1"), fake({
    "/item/1.json": { id: 1, title: "Show HN: thing", by: "op", time: 1700000000, url: "https://thing.example/", kids: [2, 3], descendants: 3 },
    "/item/2.json": { id: 2, by: "c1", time: 1700000100, text: "<p>first</p>", kids: [4] },
    "/item/3.json": { id: 3, dead: true, text: "spam" },
    "/item/4.json": { id: 4, by: "c2", time: 1700000200, text: "reply" },
  }));
  assert.equal(hn.title, "Show HN: thing");
  assert.match(hn.html, /<blockquote><p><strong>c1<\/strong> · 2023-11-14<\/p><p>first<\/p><blockquote><p><strong>c2<\/strong>[^]*reply<\/blockquote><\/blockquote>/);
  assert.ok(!hn.html.includes("spam"));

  // Naver Cafe goes through load as well
  await assert.rejects(site("naver-cafe").load(u("https://cafe.naver.com/ArticleRead.nhn?clubid=12345678&articleid=42"), fake({ "cafe-articleapi": { result: { reason: "로그인하지 않았습니다." } } })), /logging in or joining/);
}

// crawlSite: stays under the start folder, skips assets and robots-blocked pages, dedupes, stops at maxPages
{
  const web = {
    "https://d.example/guide/": ["intro", "/guide/setup", "/blog/x", "https://other.example/guide/y", "/guide/logo.png", "#top", "/guide/private"],
    "https://d.example/guide/intro": ["/guide/setup", "/guide/api#auth"],
    "https://d.example/guide/setup": ["/guide/api"],
    "https://d.example/guide/api": ["/guide/more"],
  };
  const fetcher = async (url) => {
    if (!web[url]) throw new Error("HTTP 404");
    return { url, text: `# ${url}`, hrefs: web[url] };
  };
  const allow = async (url) => !url.endsWith("/private");
  const r = await crawlSite("https://d.example/guide/#start", { maxPages: 4, delayMs: 0, fetcher, allow });
  assert.equal(r.scope, "https://d.example/guide/");
  assert.deepEqual(r.pages.map((p) => p.url), ["https://d.example/guide/", "https://d.example/guide/intro", "https://d.example/guide/setup", "https://d.example/guide/api"]);
  assert.deepEqual(r.skipped, ["https://d.example/guide/private (robots.txt)"]);
  assert.equal(r.notRead, 1); // /guide/more found but over the page limit
  const all = await crawlSite("https://d.example/guide/", { maxPages: 10, delayMs: 0, fetcher, allow });
  assert.equal(all.pages.length, 4);
  assert.match(all.skipped.join(), /guide\/more \(HTTP 404\)/);
}

// Office documents, built in memory as ZIPs of XML
{
  const zip = (files) => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));
  const core = '<cp:coreProperties xmlns:dc="x" xmlns:dcterms="y"><dc:title>Quarterly &amp; Plan</dc:title><dc:creator>Kim</dc:creator><dcterms:created>2026-03-01T00:00:00Z</dcterms:created></cp:coreProperties>';

  const d = officeToMarkdown(zip({ "docProps/core.xml": core, "word/document.xml": `<w:document><w:body>
    <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Plan</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Goals</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">Ship </w:t></w:r><w:r><w:t>v2 &lt;soon&gt;</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Owner</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>Docs</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Lee</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p/></w:body></w:document>` }), "docx");
  assert.equal(d.markdown, "## Plan\n\n## Goals\n\nShip v2 <soon>\n\n| Item | Owner |\n| --- | --- |\n| Docs | Lee |");
  assert.equal(d.title, "Quarterly & Plan");
  assert.equal(d.byline, "Kim");

  const p = officeToMarkdown(zip({
    "ppt/slides/slide10.xml": "<p:sld><a:p><a:r><a:t>Ten</a:t></a:r></a:p></p:sld>",
    "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Two</a:t></a:r><a:r><a:t>!</a:t></a:r></a:p><a:p><a:r><a:t>Bullet</a:t></a:r></a:p></p:sld>",
  }), "pptx");
  assert.equal(p.markdown, "## Slide 1\n\nTwo!\n\nBullet\n\n## Slide 2\n\nTen", "slides in numeric order");

  const x = officeToMarkdown(zip({
    "xl/workbook.xml": '<workbook><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/sharedStrings.xml": "<sst><si><t>Region</t></si><si><t>Total</t></si><si><r><t>So</t></r><r><t>uth</t></r></si></sst>",
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>42</v></c></row></sheetData></worksheet>',
  }), "xlsx");
  assert.equal(x.markdown, "## Sheet: Sales\n\n| Region | Total |  |\n| --- | --- | --- |\n| South |  | 42 |");

  const h = officeToMarkdown(zip({ "Contents/section0.xml": "<hs:sec><hp:p><hp:run><hp:t>한글 문서</hp:t></hp:run></hp:p><hp:p><hp:run><hp:t>둘째 문단</hp:t></hp:run></hp:p></hs:sec>" }), "hwpx");
  assert.equal(h.markdown, "한글 문서\n\n둘째 문단");

  assert.throws(() => officeToMarkdown(Buffer.alloc(10), "hwp"), /binary \.hwp/);
  assert.equal(officeKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "https://x.example/a"), "docx");
  assert.equal(officeKind("application/octet-stream", "https://x.example/files/report.HWPX"), "hwpx");
  assert.equal(officeKind("text/html", "https://x.example/a.docx"), null, "an HTML page named .docx is still a web page");
}

// robots.txt parsing and matching
{
  const txt = [
    "User-agent: Googlebot", "Disallow: /", "",
    "User-agent: *", "Disallow: /private/", "Allow: /private/public-*", "Disallow: /*.json$", "Disallow:", "# comment",
  ].join("\n");
  const rules = parseRobots(txt);
  assert.ok(isAllowed(rules, "/docs/intro"));
  assert.ok(!isAllowed(rules, "/private/x"));
  assert.ok(isAllowed(rules, "/private/public-page"), "longer Allow wins");
  assert.ok(!isAllowed(rules, "/data/a.json"));
  assert.ok(isAllowed(rules, "/data/a.json?x=1"), "$ anchors the end");
  const mine = parseRobots("User-agent: *\nDisallow:\n\nUser-agent: linkbrief\nDisallow: /docs/");
  assert.ok(!isAllowed(mine, "/docs/a"), "our own group beats *");
  assert.ok(isAllowed(parseRobots(""), "/anything"));
  const multi = parseRobots("User-agent: a\nUser-agent: *\nDisallow: /x");
  assert.ok(!isAllowed(multi, "/x/1"), "consecutive User-agent lines share one group");
}

// SSRF bypass attempts: every alternative spelling of a private or local address is refused
for (const u of [
  "http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://127.1/", "http://127.0.0.1.:80/",
  "http://localhost./", "http://LOCALHOST/", "http://user:pass@127.0.0.1/", "http://0.0.0.0/", "http://[::]/",
  "http://[::ffff:7f00:1]/", "http://[64:ff9b::7f00:1]/", "http://[2002:7f00:1::]/", "http://[fd00:ec2::254]/",
  "http://100.64.0.1/", "http://169.254.169.254/latest/meta-data/", "http://192.168.0.1:8080/admin",
  "http://localtest.me/", // public DNS name that resolves to 127.0.0.1 (rejected either way if DNS is offline)
  "ftp://example.com/", "gopher://example.com/", "data:text/html,hi", "javascript:alert(1)",
]) await assert.rejects(assertPublicUrl(u), /private or local|Only http\/https|Could not resolve/, u);
assert.ok(!isBlockedIp("2001:4860:4860::8888"), "ordinary public IPv6 stays allowed");

// Paging never splits a surrogate pair
{
  const text = "a".repeat(9) + "😀" + "b".repeat(20);
  const first = paginate(text, 0, 10);
  assert.ok(first.startsWith("a".repeat(9) + "\n\n[Truncated: showing characters 0-9 "), first);
  assert.ok(paginate(text, 9, 10).startsWith("😀"));
  // A 1-character window on an emoji takes the whole pair instead of stalling (found by test-fuzz.mjs, seed 42)
  assert.match(paginate(text, 9, 1), /^😀\n\n\[Truncated: showing characters 9-11 of \d+\. Call fetch_page again with start_index=11/);
}

// Header fields with line breaks stay on one line; ~~~ fences hide headings
{
  const t = formatPage({ url: "https://x.example/", title: "Two\n\nlines", byline: "A\nB", markdown: "## Real\n\n~~~\n## not a heading\n~~~\n\ntext" });
  assert.match(t, /^# Two lines\nAuthor: A B \| URL: https:\/\/x\.example\/\n\n## Real/);
  assert.match(outline(t), /Outline: 1 sections/);
}

// find: words and phrases, context, heading path, big blocks split by line, no-match and empty queries
{
  const big = Array.from({ length: 60 }, (_, i) => `- reference ${i}${i === 41 ? " about pricing tiers" : ""} ${"x".repeat(20)}`).join("\n");
  const t = formatPage({ url: "https://x.example/doc", title: "Doc", markdown: [
    "Intro line.", "## Setup", "Install it.", "Then configure the API key here.", "## Pricing", "### Plans", "Free and Pro plans.", "Pro costs money.",
    "```\npricing = 1  # inside code\n\nstill code\n```", "## References", big,
  ].join("\n\n") });
  const r = find(t, 'pricing "api key"');
  assert.match(r, /^# Doc\nURL: https:\/\/x\.example\/doc\n\nFound \d+ blocks mentioning "pricing" or "api key"\./);
  assert.match(r, /--- in: Setup ---\nInstall it\.\n\nThen configure the API key here\./, "context before the hit");
  assert.match(r, /## Pricing\n\n### Plans\n\nFree and Pro plans\./, "a matching heading brings the text under it");
  assert.match(r, /```\npricing = 1  # inside code\n\nstill code\n```/, "a code block stays whole");
  assert.match(r, /--- in: References ---\n- reference 40 x+\n- reference 41 about pricing tiers/, "a long list is cut to the matching line and its neighbours");
  assert.ok(!r.includes("reference 10 "), "the rest of the long list is left out");
  assert.match(find(t, "zebra"), /No passage mentions "zebra"/);
  assert.throws(() => find(t, "   "), /words or a "quoted phrase"/);
  const many = formatPage({ url: "https://x.example/", markdown: Array.from({ length: 30 }, (_, i) => `para ${i} needle`).join("\n\n") });
  assert.match(find(many, "needle", { maxPassages: 5, context: 0 }), /\(best 5 of 30 matching blocks shown\)/);
}

// Anchors: heading ids from the HTML give citable links in outline and section
{
  const html = `<html><body><article><h1>Doc</h1>${"<p>Intro text for the anchor test.</p>".repeat(8)}
    <h2 id="History">History</h2><p>${"Old times. ".repeat(20)}</p>
    <h2><span id="s-2"></span>2. Uses &amp; more</h2><p>${"Uses text. ".repeat(20)}</p>
    <h2>No id here</h2><p>${"Plain text. ".repeat(20)}</p></article></body></html>`;
  const page = extract(html, { links: false });
  assert.deepEqual(page.anchors, { history: "History", "2usesmore": "s-2" });
  const text = formatPage({ url: "https://x.example/doc#top", ...page });
  const o = outline(text, page.anchors);
  assert.match(o, /Cite a section as its page URL \+ "#" \+ anchor\./);
  assert.match(o, /- #\d+ History \(\d+ chars, anchor=History\)/);
  assert.match(o, /- #\d+ 2\. Uses & more \(\d+ chars, anchor=s-2\)/);
  assert.match(o, /- #\d+ No id here \(\d+ chars\)/);
  assert.match(section(text, "Uses", page.anchors), /\nSection link: https:\/\/x\.example\/doc#s-2\n\n## 2\\\. Uses/); // turndown escapes "2."
  assert.ok(!section(text, "No id", page.anchors).includes("Section link"));
  assert.ok(!outline(text).includes("anchor="), "no anchors given, none shown");
}

// Excel dates: built-in and custom date/time formats, the 1904 system; money and counts stay numbers
{
  const book = (date1904) => officeToMarkdown(Buffer.from(zipSync({
    "xl/workbook.xml": strToU8(`<workbook>${date1904 ? '<workbookPr date1904="1"/>' : ""}<sheets><sheet name="D" r:id="r1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8('<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>'),
    "xl/styles.xml": strToU8('<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd hh:mm"/><numFmt numFmtId="165" formatCode="&quot;$&quot;#,##0.00"/><numFmt numFmtId="166" formatCode="[$-409]h:mm AM/PM"/></numFmts><cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="166"/></cellXfs></styleSheet>'),
    "xl/worksheets/sheet1.xml": strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>n</t></is></c><c r="B1" t="inlineStr"><is><t>d</t></is></c><c r="C1" t="inlineStr"><is><t>dt</t></is></c><c r="D1" t="inlineStr"><is><t>money</t></is></c><c r="E1" t="inlineStr"><is><t>t</t></is></c></row><row r="2"><c r="A2" s="0"><v>41640</v></c><c r="B2" s="1"><v>41640</v></c><c r="C2" s="2"><v>41640.5</v></c><c r="D2" s="3"><v>41640</v></c><c r="E2" s="4"><v>0.75</v></c></row></sheetData></worksheet>'),
  })), "xlsx").markdown.split("\n").pop();
  assert.equal(book(false), "| 41640 | 2014-01-01 | 2014-01-01 12:00 | 41640 | 18:00 |");
  assert.equal(book(true), "| 41640 | 2018-01-02 | 2018-01-02 12:00 | 41640 | 18:00 |");
}

// Headings made only of markup are listed as (untitled) and readable by number (found by test-fuzz.mjs)
{
  const t = formatPage({ url: "https://x.example/", markdown: "## **\n\nhidden body\n\n## Next\n\nmore" });
  assert.match(outline(t), /- #1 \(untitled\) \(\d+ chars\): hidden body/);
  assert.match(section(t, "#1"), /hidden body/);
}

// GitHub PR sub-pages use the API loader too
for (const p of ["/a/b/pull/1/files", "/a/b/pull/1/commits/", "/a/b/issues/9"]) assert.ok(sites.find((s) => s.name === "github-issue").match(new URL(`https://github.com${p}`)), p);
assert.ok(!sites.find((s) => s.name === "github-issue").match(new URL("https://github.com/a/b/pull/1/files/abc")));

// Excel: very wide sheets are cut to 50 columns
{
  const cells = Array.from({ length: 80 }, (_, i) => `<c r="${String.fromCharCode(65 + Math.floor(i / 26) - 1 || 64).replace("@", "")}${String.fromCharCode(65 + (i % 26))}1" t="inlineStr"><is><t>c${i}</t></is></c>`).join("");
  const wide = officeToMarkdown(Buffer.from(zipSync({
    "xl/workbook.xml": strToU8('<workbook><sheets><sheet name="W" r:id="r1"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": strToU8('<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>'),
    "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData><row r="1">${cells}</row></sheetData></worksheet>`),
  })), "xlsx");
  assert.equal(wide.markdown.split("\n")[2].split(" | ").length, 50);
}

// Hacker News: comments are fetched in batches and all arrive
{
  let inFlight = 0, peak = 0;
  const kids = Array.from({ length: 45 }, (_, i) => i + 2);
  const getJson = async (url) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    const id = Number(/item\/(\d+)\.json/.exec(url)[1]);
    return id === 1 ? { id: 1, title: "t", by: "op", time: 1, kids, descendants: 45 } : { id, by: `u${id}`, time: 1, text: `c${id}` };
  };
  const hn = await sites.find((s) => s.name === "hacker-news").load(new URL("https://news.ycombinator.com/item?id=1"), getJson);
  assert.ok(peak <= 20, `at most 20 requests at once, saw ${peak}`);
  assert.equal((hn.html.match(/<blockquote>/g) || []).length, 45);
}

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
assert.ok(isBotWall("<html><head><title>Reddit - Prove your humanity</title></head></html>")); // seen 2026-11-27

// Namuwiki: every section kept via stable s-N ids, sidebar and "[편집]" links dropped
{
  const { markdown } = extract(fixture("namuwiki.html"), { pick: pickFor("https://namu.wiki/w/test") });
  for (const s of ["개요입니다", "역사입니다", "마지막 문단입니다"]) assert.ok(markdown.includes(s), s);
  for (const junk of ["[편집]", "사이드바", "최근 변경"]) assert.ok(!markdown.includes(junk), junk);
  assert.equal(pickFor("https://example.com/"), undefined);
}

// Empty or fragment bodies do not crash extraction (Amazon answered HTTP 202 with no body)
assert.equal(extract("").markdown, "");
assert.match(extract("<p>fragment only</p>").markdown, /fragment only/);
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

// Image sizes from file headers
{
  assert.deepEqual(imageSize(makePng(321, 123)), { width: 321, height: 123 });
  const gif = Buffer.from("GIF89a\x40\x01\xc8\x00", "latin1");
  assert.deepEqual(imageSize(Buffer.concat([gif, Buffer.alloc(8)])), { width: 320, height: 200 });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x0d, 0x14, 0x03, 0xae, 0x03]);
  assert.deepEqual(imageSize(Buffer.concat([jpeg, Buffer.alloc(8)])), { width: 942, height: 3348 });
  const webp = Buffer.alloc(32); webp.write("RIFF", 0, "latin1"); webp.write("WEBPVP8X", 8, "latin1"); webp.writeUIntLE(799, 24, 3); webp.writeUIntLE(599, 27, 3);
  assert.deepEqual(imageSize(webp), { width: 800, height: 600 });
  assert.equal(imageSize(Buffer.from("not an image at all, just text")), null);
}

// Content images, inline frames, labelled links and the <main> fallback
{
  const long = "Words of the article body that make it long enough to be content. ".repeat(6);
  const p = extract(`<html><body><article><h1>T</h1><p>${long}</p>
    <img src="/media/chart.png"><img data-lazy-src="https://cdn.example.com/lazy.jpg" src="data:image/gif;base64,R0lGOD">
    <img src="/static/logo.png"><img src="/icons/x.svg"><img src="/media/dot.png" width="1" height="1"><img src="/media/chart.png">
    </article></body></html>`, { url: "https://example.com/post/1" });
  assert.deepEqual(p.images, ["https://example.com/media/chart.png", "https://cdn.example.com/lazy.jpg"], "content images: absolute, lazy src, deduped; logos, svg and 1x1 skipped");
  assert.deepEqual(extract(`<html><body><article><p>${long}</p><img src="/a.png"></article></body></html>`).images, [], "relative images need a base URL");

  const framed = extract(`<html><head><title>Job</title></head><body><nav>menu</nav><iframe srcDoc="&lt;meta charset=utf-8&gt;&lt;html&gt;&lt;body&gt;&lt;div id=jd&gt;&lt;p&gt;Duties: payroll and year-end tax settlement. ${long}&lt;/p&gt;&lt;/div&gt;&lt;/body&gt;&lt;/html&gt;"></iframe></body></html>`);
  assert.match(framed.markdown, /Duties: payroll and year-end tax settlement/, "iframe srcdoc is read as part of the page");

  const mapped = extract(`<html><body><div><img src="https://x.example/poster.jpg"><a href="https://jobs.example/apply" alt="Apply here"></a><a href="https://jobs.example/faq" aria-label="FAQ"></a></div></body></html>`, { links: true });
  assert.match(mapped.markdown, /\[Apply here\]\(https:\/\/jobs\.example\/apply\)/, "empty image-map links keep their label");
  assert.match(mapped.markdown, /\[FAQ\]/);

  const sectioned = extract(`<html><body><header>site</header><main><section><h2>About the team</h2><p>We run payroll for the company. ${"Team text. ".repeat(10)}</p></section>
    <section><h2>Duties</h2><ul><li>Payroll and bonuses</li><li>Year-end settlement</li><li>Social insurance filings</li></ul></section>
    <section><h2>Requirements</h2><ul><li>3+ years of payroll</li><li>500+ employee workplace</li></ul></section>
    <section><h2>Process</h2><ol><li>Documents</li><li>Interview</li></ol><p>${"Process details. ".repeat(20)}</p></section></main><footer>foot</footer></body></html>`);
  assert.match(sectioned.markdown, /3\+ years of payroll/, "short Readability result falls back to <main>");
  assert.match(sectioned.markdown, /About the team/);
}

// Shop category pages: hidden spec lists are dropped, the product grid is found and each card is one line
{
  const card = (i) => `<li><a href="/p/${i}"><img src="/t/${i}.jpg"><div class="info"><p>Product ${i} name</p><p>Soft and warm fabric</p><p>49,000 won</p><p>44,100 won coupon</p></div></a>
    <ul class="spec"><li class="displaynone">Model: X-${i}</li><li class="displaynone">Maker: in-house supplier and long hidden text ${"x".repeat(80)}</li></ul></li>`;
  const recommended = `<div class="reco"><h2>Recommended</h2><ul>${[1, 2].map((i) => `<li><p>Reco ${i}</p><p hidden>${"hidden spec ".repeat(40)}</p></li>`).join("")}</ul></div>`;
  const shop = `<html><head><title>Sale</title></head><body><nav><ul>${Array.from({ length: 12 }, (_, i) => `<li><a href="/c/${i}">Menu ${i}</a></li>`).join("")}</ul></nav>
    ${recommended}<p>120 products</p><ul class="grid">${Array.from({ length: 12 }, (_, i) => card(i)).join("")}</ul><footer>Shop footer</footer></body></html>`;
  const p = extract(shop, { links: false });
  assert.doesNotMatch(p.markdown, /Model: X-|Maker:|hidden spec/, "hidden elements are dropped");
  const tabs = extract(`<html><body><div><a href="/a">Top story</a></div><div class="tab" style="display: none"><a href="/b">Second tab headline that readers can open</a></div></body></html>`);
  assert.match(tabs.markdown, /Second tab headline/, "inline display:none (tab panels) is kept");
  assert.equal((p.markdown.match(/^- Product \d+ name · Soft and warm fabric · 49,000 won · 44,100 won coupon$/gm) || []).length, 12, p.markdown);
  assert.doesNotMatch(p.markdown, /Menu 3/, "menus are not taken for the grid");
  assert.match(extract(shop, { links: true }).markdown, /^- \[Product 0 name · Soft and warm fabric · 49,000 won · 44,100 won coupon\]\(\/p\/0\)$/m, "a card that is one link keeps it");

  // Items with a long block (listicles, steps) keep their paragraphs
  const long = "This step explains in detail what to do and why it matters for the result you want. ";
  const listicle = extract(`<html><body><article><h1>Guide</h1><ol>${[1, 2, 3].map((i) => `<li><h3>Step ${i}</h3><p>${long.repeat(2)}</p></li>`).join("")}</ol></article></body></html>`);
  assert.match(listicle.markdown, /Step 1\n\n/, listicle.markdown);
  assert.doesNotMatch(listicle.markdown, / · /);
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
    // Tall images are cut into overlapping JPEG tiles no taller than the tile height.
    const tiles = await sliceImage(makePng(600, 3300), "image/png", { tileHeight: 1500, overlap: 60 });
    assert.equal(tiles.length, 3);
    for (const t of tiles) {
      const size = imageSize(Buffer.from(t));
      assert.ok(size.width === 600 && size.height <= 1500, JSON.stringify(size));
    }
    assert.equal(imageSize(Buffer.from(tiles[2])).height, 3300 - 2 * 1440);
    assert.equal((await sliceImage(makePng(600, 3300), "image/png", { maxTiles: 2 })).length, 2);
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

// Outline and section reading
{
  const page = formatPage({ url: "https://x.example/doc", title: "Doc", siteName: "Example", markdown: [
    "Intro paragraph before any heading.",
    "## History",
    "**Early** days of the [project](https://x.example/p) began here.",
    "### Origins",
    "Where it started.",
    "```",
    "# not a heading inside code",
    "```",
    "## [2.](#toc) Usage",
    "How to use it.",
  ].join("\n") });
  const o = outline(page);
  assert.match(o, /^# Doc\nSource: Example \| URL: https:\/\/x\.example\/doc\n\nOutline: 3 sections, \d+ characters in total\./);
  assert.match(o, /\n- #1 History \(\d+ chars\): Early days of the project began here\.\n  - #2 Origins \(\d+ chars\): Where it started\.\n- #3 2\. Usage \(\d+ chars\): How to use it\.$/);
  assert.ok(!o.includes("not a heading"));
  const history = section(page, "history"); // case-insensitive, includes its subsection
  assert.match(history, /^# Doc\nSource: Example \| URL: https:\/\/x\.example\/doc\n\n## History\n[\s\S]*### Origins[\s\S]*not a heading inside code/);
  assert.ok(!history.includes("How to use it"));
  assert.equal(section(page, "#2").split("\n\n")[1], "### Origins\nWhere it started.\n```\n# not a heading inside code\n```");
  assert.match(section(page, "Usage"), /## \[2\.\]\(#toc\) Usage\nHow to use it\.$/); // partial match
  assert.throws(() => section(page, "Pricing"), /No section matches "Pricing"\. Sections: #1 History; #2 Origins; #3 2\. Usage/);
  // MediaWiki headings (div.mw-heading + [edit] link) survive extraction
{
  const para = (t) => `<p>${t} ${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(6)}</p>`;
  const mw = `<html><body><main><div id="content">${para("Intro.")}
    <div class="mw-heading mw-heading2"><h2 id="History">History</h2><span class="mw-editsection">[<a href="/w/index.php?action=edit&section=1">edit</a>]</span></div>${para("History text.")}
    <div class="mw-heading mw-heading2"><h2 id="Uses">Uses</h2><span class="mw-editsection">[<a href="/w/index.php?action=edit&section=2">edit</a>]</span></div>${para("Uses text.")}
  </div></main></body></html>`;
  const md = extract(mw, { links: false }).markdown;
  assert.match(md, /## History\n\nHistory text\./);
  assert.match(md, /## Uses\n\nUses text\./);
  assert.ok(!/\bedit\b/.test(md), md.slice(0, 200));
}
// PDFs: "## Page N" headings work as sections
  const pdf = formatPage({ url: "https://x.example/a.pdf", pages: 2, markdown: "## Page 1\n\nfirst page\n\n## Page 2\n\nsecond page" });
  assert.equal(section(pdf, "Page 2").split("\n\n").slice(1).join("\n\n"), "## Page 2\n\nsecond page");
  // No headings
  const flat = formatPage({ url: "https://x.example/", markdown: "just text" });
  assert.match(outline(flat), /No headings on this page/);
  assert.throws(() => section(flat, "x"), /no headings/);
}

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
