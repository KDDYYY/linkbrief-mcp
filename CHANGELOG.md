# Changelog

## 0.4.2 — 2026-11-27

- Icon: sent in the MCP server info (as a data URI, nothing fetched), in the Claude Desktop extension and in the MCP Registry entry.
- README: the Windows install command quotes `--` so PowerShell passes it through.

## 0.4.1 — 2026-11-27

- README rewritten: shorter, with reference sections folded away. No code changes.

## 0.4.0 — 2026-11-27

### Added
- **`find`:** `fetch_page` returns only the passages that mention given words or "quoted phrases", with one block of context and the headings they sit under; combine with `section`. 76–88% less than the whole page on long documents. Long lists are matched line by line.
- **llms.txt:** `fetch_site` reads a site's `/llms.txt` index first and the pages it lists next; `text/markdown` responses (`.md` docs) are read as Markdown.
- **Corporate proxies:** `HTTPS_PROXY` / `HTTP_PROXY` with `NO_PROXY`, for plain requests and the browser fallback. Behind a proxy, names the PC cannot resolve are left to the proxy unless they look internal.
- **Citable section links:** outline lists each section's HTML anchor and `section` replies include `Section link: page#anchor`.

### Fixed
- Excel dates and times are shown as ISO dates instead of serial numbers (built-in and custom formats, 1904 date system).
- A 1-character page window on an emoji no longer stalls paging (found by fuzzing).

### Tests
- `test-proxy.mjs` against a local CONNECT proxy; llms.txt, Markdown docs, `find` and anchors in the local-server and fuzz tests. 12,000 fuzz rounds; line coverage 96.7%.

## 0.3.0 — 2026-11-27

### Added
- **Developer sites through their public APIs:** GitHub issues and pull requests (description, every comment, changed files), GitHub code files (raw), Stack Overflow and other Stack Exchange questions (question plus the top 10 answers — these pages were blocked by a bot check before), Hacker News threads (comment tree), arXiv abstract pages (open the paper). `GITHUB_TOKEN` raises GitHub's limit.
- **`fetch_site`:** reads up to 30 pages under one folder of a docs site or blog, breadth-first, honouring robots.txt and pausing between requests.
- **Office documents from links:** Word (.docx), PowerPoint (.pptx), Excel (.xlsx) and Hangul (.hwpx). Old binary .hwp is reported as unsupported.
- **robots.txt:** always honoured by `fetch_site`; optional for single links with `LINKBRIEF_ROBOTS=always`.
- **Claude Desktop extension:** `npm run build:mcpb` builds `linkbrief.mcpb` for one-click install, with an optional GitHub token setting.
- **MCP Registry metadata:** `server.json` and `mcpName` (`io.github.KDDYYY/linkbrief-mcp`).

### Fixed (found in a systematic review: coverage, line-by-line reading, attack and random-input tests)
- NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`) and 6to4 (`2002::/16`) IPv6 addresses that wrap a private IPv4 address are now refused.
- Paging no longer splits emoji or other surrogate pairs.
- `~~~` code fences no longer produce fake headings in outlines.
- A blank `section` no longer returns the first section; headings made only of markup are listed as `(untitled)`.
- Titles or authors containing line breaks no longer break outline/section headers.
- GitHub PR sub-pages (`/files`, `/commits`, `/checks`) use the API.
- Excel sheets are capped at 50 columns.
- `fetch_site` stops after 45 seconds with what it has, and no longer counts robots.txt-blocked pages as "not read".
- Download timeouts give a clear message instead of "aborted".
- Hacker News comments are fetched 20 at a time.

### Tests
- `test-http.mjs`: the full fetch path (redirects, cookies, size limits, zip bombs, encodings, file types, errors, cache, robots.txt, crawling) and all MCP tools against a local server.
- `test-fuzz.mjs`: seeded random HTML, Markdown, robots.txt and Office input; paging must be lossless.
- 22 SSRF bypass spellings. Line coverage 89% → 96%.

## 0.2.0 — 2026-11-27

### Added
- **Outline and section reading:** `fetch_page` with `outline: true` returns headings with section sizes and a one-line preview; `section` returns one part. 82–91% fewer characters than the whole page on long documents.
- English-first README (Korean in README.ko.md).

### Fixed
- Wikipedia and other MediaWiki sites lost most section headings.
- Namuwiki articles were cut to one block.
- Reddit's "Prove your humanity" page is reported as a bot check.
- Empty responses (e.g. Amazon's HTTP 202) no longer crash extraction.

## 0.1.0 — 2026-11-26

First release: `fetch_page` and `fetch_pages`, Readability-based Markdown with source line, PDF text, legacy encodings, Naver Blog/Cafe handling, headless Chrome/Edge fallback, private-network blocking, 10-minute cache.
