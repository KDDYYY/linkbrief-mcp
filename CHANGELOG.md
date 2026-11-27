# Changelog

## 0.3.0 — 2026-11-27

### Added
- **Developer sites through their public APIs:** GitHub issues and pull requests (description, every comment, changed files), GitHub code files (raw), Stack Overflow and other Stack Exchange questions (question plus the top 10 answers — these pages were blocked by a bot check before), Hacker News threads (comment tree), arXiv abstract pages (open the paper). `GITHUB_TOKEN` raises GitHub's limit.
- **`fetch_site`:** reads up to 30 pages under one folder of a docs site or blog, breadth-first, honouring robots.txt and pausing between requests.
- **Office documents from links:** Word (.docx), PowerPoint (.pptx), Excel (.xlsx) and Hangul (.hwpx). Old binary .hwp is reported as unsupported.
- **robots.txt:** always honoured by `fetch_site`; optional for single links with `LINKBRIEF_ROBOTS=always`.
- **Claude Desktop extension:** `npm run build:mcpb` builds `linkbrief.mcpb` for one-click install, with an optional GitHub token setting.
- **MCP Registry metadata:** `server.json` and `mcpName` (`io.github.KDDYYY/linkbrief-mcp`).

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
