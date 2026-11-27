// Randomised robustness checks with a fixed seed (reproducible): nothing crashes, nothing hangs,
// and paging is lossless. Run: node test-fuzz.mjs [seed] [rounds]
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { officeToMarkdown } from "./office.mjs";
import { extract, outline, paginate, section, tidyMarkdown } from "./page.mjs";
import { isAllowed, parseRobots } from "./robots.mjs";

let seed = Number(process.argv[2] ?? 20261127);
const rounds = Number(process.argv[3] ?? 400);
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const many = (n, f) => Array.from({ length: Math.floor(rnd() * n) }, f).join("");
const timed = (label, fn, ms = 2000) => {
  const t = Date.now();
  const out = fn();
  assert.ok(Date.now() - t < ms, `${label} took ${Date.now() - t} ms`);
  return out;
};

const WORDS = ["hello", "한글", "日本語", "😀", "&amp;", "&#x27;", "<", ">", "[", "]", "(", ")", "\\", "|", "#", "*", "_", "`", "~~~", "```", "\n", " ", "​", " ", "https://x.example/a(b)c"];
const TAGS = ["p", "div", "span", "a", "b", "table", "tr", "td", "th", "h1", "h2", "h3", "ul", "li", "pre", "code", "img", "script", "style", "article", "nav", "blockquote", "br", "svg"];
const randHtml = (depth = 0) => many(8, () => {
  if (depth > 5 || rnd() < 0.4) return pick(WORDS);
  const t = pick(TAGS);
  const attrs = rnd() < 0.3 ? ` href="${pick(["#", "/x", "javascript:1", "https://e.example/" + pick(WORDS)])}" class="${pick(["mw-heading", "mw-editsection", "x"])}" id="s-${Math.floor(rnd() * 9)}"` : "";
  return rnd() < 0.1 ? `<${t}${attrs}>` : `<${t}${attrs}>${randHtml(depth + 1)}</${t}>`; // sometimes unclosed
});
const randMd = () => many(40, () => pick(["# ", "## ", "### ", "#### ", "```\n", "~~~\n", "- ", "> ", "[a](b)", "\\[x\\]", "**", "\n", "\n\n", ...WORDS]));

for (let i = 0; i < rounds; i++) {
  // HTML -> Markdown never throws or hangs, and always returns strings
  const html = rnd() < 0.5 ? randHtml() : `<html><head><title>${pick(WORDS)}</title></head><body>${randHtml()}</body></html>`;
  const r = timed("extract", () => extract(html, { links: rnd() < 0.5 }));
  for (const k of ["title", "byline", "siteName", "published", "markdown"]) assert.equal(typeof r[k], "string", k);

  // Outline/section on arbitrary Markdown
  const md = `# T\nURL: https://x.example/\n\n${randMd()}`;
  timed("outline", () => outline(md));
  // Pick a listed section the way an agent would: by its heading text, or by number when it is untitled
  const hit = /- (#\d+) (.+) \(\d[\d,]* chars\)/.exec(outline(md));
  if (hit) timed("section", () => section(md, hit[2] === "(untitled)" ? hit[1] : hit[2]));
  try { section(md, `#${1 + Math.floor(rnd() * 5)}`); } catch (e) { assert.match(e.message, /No section|no headings/); }

  // Paging is lossless: the parts, notes removed, rebuild the text exactly
  const text = randMd() + "😀".repeat(Math.floor(rnd() * 5)) + randMd();
  const size = 1 + Math.floor(rnd() * 30);
  let rebuilt = "", start = 0, guard = 0;
  while (start < text.length && guard++ < 10000) {
    const part = paginate(text, start, size);
    const m = /\n\n\[Truncated: showing characters (\d+)-(\d+) of \d+\. Call fetch_page again with start_index=(\d+) for more\.\]$/.exec(part);
    rebuilt += m ? part.slice(0, m.index) : part;
    if (!m) break;
    assert.ok(Number(m[3]) > start, "paging always moves forward");
    start = Number(m[3]);
  }
  assert.equal(rebuilt, text);

  // robots.txt: arbitrary files parse, arbitrary paths match, quickly
  const robots = many(20, () => pick(["User-agent: *\n", "User-agent: linkbrief\n", "Disallow: /", "Allow: /", "Disallow: /*x$", "Disallow:", "*", "$", "a", "\n", "# c\n", ": ", "\r\n"]));
  timed("robots", () => isAllowed(parseRobots(robots), "/" + many(10, () => pick(["a", "x", "/", "?", "$", "*"]))));

  // Office: junk bytes and junk XML give an Error, never a crash or hang
  const kind = pick(["docx", "pptx", "xlsx", "hwpx"]);
  try { officeToMarkdown(Buffer.from(Array.from({ length: Math.floor(rnd() * 200) }, () => Math.floor(rnd() * 256))), kind); } catch (e) { assert.ok(e instanceof Error); }
  const junkXml = many(30, () => pick(["<w:p>", "</w:p>", "<w:t>", "</w:t>", "<a:p>", "<a:t>", "<hp:p>", "<hp:t>", "<row r=\"1\">", "<c r=\"A1\" t=\"s\"><v>9</v></c>", "</row>", "<w:tbl>", "</w:tbl>", ...WORDS]));
  const zip = Buffer.from(zipSync({ "word/document.xml": strToU8(junkXml), "ppt/slides/slide1.xml": strToU8(junkXml), "xl/workbook.xml": strToU8(junkXml), "Contents/section0.xml": strToU8(junkXml) }));
  timed("office", () => officeToMarkdown(zip, kind));
}

// Pathological inputs for the link/image regexes (catastrophic backtracking would hang here)
for (const s of ["[".repeat(20000), "](".repeat(20000), `[${"a\\]".repeat(5000)}`, `![x](${"(".repeat(5000)}`, `[a](${"\\".repeat(20000)}`, "[a](b".repeat(5000)]) {
  timed("tidyMarkdown", () => tidyMarkdown(s, { links: false }), 1000);
}
console.log(`ok (fuzz, ${rounds} rounds)`);
