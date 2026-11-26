import assert from "node:assert/strict";
import fs from "node:fs";
import { extract, paginate, isBlockedIp, assertPublicUrl, readBody } from "./page.mjs";
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
