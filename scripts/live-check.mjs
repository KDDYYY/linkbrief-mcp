// Live check against real sites through the MCP server (needs internet; not part of `npm test`).
// Usage: npm run check:live [-- <url> ...]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const DEFAULT_URLS = [
  // Korean portals and blogs
  "https://blog.naver.com/brandmite/224450419315",
  "https://n.news.naver.com/article/022/0004178338",
  "https://v.daum.net/v/20261126154125458",
  "https://notice.tistory.com/2709",
  "https://brunch.co.kr/",
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
  const body = text.replace(/^URL: .*\n\n/, "");
  const scripts = Object.entries(SCRIPTS).map(([k, re]) => [k, (body.match(re) || []).length]).filter(([, n]) => n > 50).map(([k]) => k);
  const broken = (body.match(/�/g) || []).length;
  console.log(`${broken ? "WARN" : "OK  "} ${url} (${secs}s) ${body.length} chars, scripts: ${scripts.join("+") || "-"}${broken ? `, ${broken} broken chars` : ""}`);
  console.log(`     ${body.slice(0, 160).replace(/\s+/g, " ")}`);
}
await client.close();
console.log(`\n${urls.length - failed}/${urls.length} fetched`);
