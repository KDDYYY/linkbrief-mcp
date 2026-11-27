// Live check against real sites through the MCP server (needs internet; not part of `npm test`).
// Usage: npm run check:live [-- <url> ...]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const DEFAULT_URLS = [
  // Korean portals and blogs (official or operator accounts, not private individuals)
  "https://blog.naver.com/naverofficial/224491681766",
  "https://n.news.naver.com/article/022/0004178338",
  "https://v.daum.net/v/20261126154125458",
  "https://notice.tistory.com/2709",
  "https://brunch.co.kr/",
  "https://velog.io/@velopert/veltrends-dev-review",
  // PDFs
  "https://arxiv.org/pdf/1706.03762",
  "https://www.kcue.or.kr/_upload/high/2026/03/27/application_642e302e6e463874a6d1db2a6734851d.pdf",
  // Developer sites read through their public APIs
  "https://github.com/nodejs/node/issues/1",
  "https://github.com/modelcontextprotocol/servers/blob/main/README.md",
  "https://stackoverflow.com/questions/11227809",
  "https://news.ycombinator.com/item?id=8863",
  "https://arxiv.org/abs/1706.03762",
  // Office documents
  "https://calibre-ebook.com/downloads/demos/demo.docx",
  "https://go.microsoft.com/fwlink/?LinkID=521962",
  // Global sites
  "https://namu.wiki/w/%EA%B9%80%EC%B9%98",
  "https://github.com/modelcontextprotocol/servers",
  "https://developer.mozilla.org/en-US/docs/Web/JavaScript",
  "https://news.ycombinator.com/",
  "https://www3.nhk.or.jp/news/",
  // Bot check: expected to fail with a clear message
  "https://medium.com/",
  "https://www.reddit.com/r/ClaudeAI/",
  // Google
  "https://blog.google/",
  "https://www.google.com/search?q=kimchi",
  // Other languages (UTF-8)
  "https://en.wikipedia.org/wiki/Kimchi",
  "https://www.bbc.com/news",
  "https://fr.wikipedia.org/wiki/Kimchi",
  "https://www.lemonde.fr/",
  "https://zh.wikipedia.org/wiki/韩国泡菜",
  "https://ja.wikipedia.org/wiki/キムチ",
  "https://th.wikipedia.org/wiki/กิมจิ",
  "https://www.thairath.co.th/",
  "https://vi.wikipedia.org/wiki/Kimchi",
  "https://vnexpress.net/",
  // Legacy charsets
  "https://www.aozora.gr.jp/cards/000148/files/752_14964.html", // Shift_JIS
  "http://www.people.com.cn/", // GB2312/GBK
];

const SCRIPTS = { Hangul: /\p{Script=Hangul}/gu, Latin: /\p{Script=Latin}/gu, Han: /\p{Script=Han}/gu, Kana: /[\p{Script=Hiragana}\p{Script=Katakana}]/gu, Thai: /\p{Script=Thai}/gu };

const urls = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_URLS;
const client = new Client({ name: "live-check", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../server.mjs", import.meta.url))] }));

let failed = 0;
for (const url of urls) {
  const started = Date.now();
  const r = await client.callTool({ name: "fetch_page", arguments: { url, max_length: 100000 } });
  const text = r.content[0].text;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (r.isError) {
    failed++;
    console.log(`FAIL ${url} (${secs}s)\n     ${text}`);
    continue;
  }
  const body = text;
  const scripts = Object.entries(SCRIPTS).map(([k, re]) => [k, (body.match(re) || []).length]).filter(([, n]) => n > 50).map(([k]) => k);
  const broken = (body.match(/�/g) || []).length;
  console.log(`${broken ? "WARN" : "OK  "} ${url} (${secs}s) ${body.length} chars, scripts: ${scripts.join("+") || "-"}${broken ? `, ${broken} broken chars` : ""}`);
  console.log(`     ${body.slice(0, 160).replace(/\s+/g, " ")}`);
}
if (!process.argv.slice(2).length) {
  // fetch_pages: several links in one call, one of them failing
  const multi = ["https://notice.tistory.com/2709", "https://en.wikipedia.org/wiki/Kimchi", "https://www.google.com/search?q=x"];
  const r = await client.callTool({ name: "fetch_pages", arguments: { urls: multi, max_length_per_page: 2000 } });
  const sections = r.content[0].text.split(/^=== Page \d+ of \d+ ===$/m).filter(Boolean);
  const ok = sections.filter((s) => !s.includes("[Failed:")).length;
  console.log(`\n${ok === 2 && !r.isError ? "OK  " : "FAIL"} fetch_pages: ${sections.length} sections, ${ok} fetched, ${sections.length - ok} failed as expected`);
}
await client.close();
console.log(`\n${urls.length - failed}/${urls.length} fetched`);
