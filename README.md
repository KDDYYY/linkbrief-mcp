# linkbrief-mcp

Claude가 **내 PC에서 직접** 웹 페이지를 읽게 해 주는 MCP 서버입니다. 링크를 주고 "요약해 줘"라고 하면, linkbrief가 본문을 Markdown으로 가져오고 Claude가 정리합니다. Codex, Cursor 등 MCP를 지원하는 다른 도구에서도 똑같이 쓸 수 있습니다.

한국 사이트에 맞춰 만들었습니다: 네이버 블로그(iframe 구조), 다음·네이버 뉴스, 티스토리, 브런치, 그리고 EUC-KR 같은 옛 인코딩. 영어·불어·중국어·일본어·태국어·베트남어 페이지도 깨지지 않고 읽습니다.

[English](#english)

![프랑스어 위키백과 글을 linkbrief로 가져와 Claude가 한국어로 요약하는 예시](docs/images/usage.png)

<sub>사용 예시: `fetch_page` 호출과 결과는 실제 linkbrief 출력이고, 요약은 Claude가 그 결과로 작성한 것입니다. (문서: 프랑스어 위키백과 「Kimchi」, CC BY-SA)</sub>

## 왜 필요한가요?

- Claude의 기본 웹 가져오기는 일부 사이트(예: `blog.naver.com`)가 막혀 있습니다. linkbrief는 **사용자 PC에서 일반 브라우저처럼** 요청하므로 이런 제한을 받지 않습니다.
- 네이버 블로그는 본문이 iframe 안에 있어 그냥 가져오면 비어 있습니다. linkbrief는 본문이 들어 있는 모바일 주소로 바꿔 읽습니다.
- 메뉴·광고·이미지 주소를 걷어내고 본문만 Markdown으로 넘겨 토큰을 아낍니다(위키백과 기준 약 50~65% 감소).
- API 키가 필요 없습니다. 요약은 사용 중인 Claude가 합니다.

## 설치

Node.js 20 이상이 필요합니다.

**Claude Code**

```bash
claude mcp add linkbrief -s user -- npx -y linkbrief-mcp
```

**Claude Desktop** — `claude_desktop_config.json`에 추가 (설정 → 개발자 → 설정 편집):

```json
{
  "mcpServers": {
    "linkbrief": { "command": "npx", "args": ["-y", "linkbrief-mcp"] }
  }
}
```

**Codex (OpenAI)** — `~/.codex/config.toml`에 추가 (Codex CLI·IDE 확장·앱 공통):

```toml
[mcp_servers.linkbrief]
command = "npx"
args = ["-y", "linkbrief-mcp"]
```

Windows에서 `npx`를 찾지 못하면 `command = "cmd"`, `args = ["/c", "npx", "-y", "linkbrief-mcp"]`로 바꾸세요. Codex CLI가 있다면 `codex mcp add linkbrief -- npx -y linkbrief-mcp`로도 등록할 수 있습니다.

**Cursor 등 다른 MCP 클라이언트** — 명령 `npx -y linkbrief-mcp`를 stdio 서버로 등록하면 됩니다.

**소스에서 직접 설치** — npm을 거치지 않고 GitHub 코드를 그대로 쓰려면:

```bash
git clone https://github.com/KDDYYY/linkbrief-mcp.git
cd linkbrief-mcp
npm install
claude mcp add linkbrief -s user -- node "$(pwd)/server.mjs"
```

Windows PowerShell에서는 마지막 줄을 `claude mcp add linkbrief -s user -- node "$PWD\server.mjs"` 로 바꾸세요.

**설치 확인** — `claude mcp list`에 `linkbrief: ... ✔ Connected`가 보이면 준비된 것입니다. 설치·설정을 바꾼 뒤에는 Claude를 **다시 시작**해야 적용됩니다.

## 사용 방법

Claude에게 링크와 함께 평소 말투로 부탁하면 됩니다. Claude가 알아서 `fetch_page`를 불러 본문을 읽습니다. 처음 쓸 때 도구 사용 허락을 묻는 창이 뜨면 허용해 주세요.

**기본 요약**

> 이 글 한국어로 요약해 줘: https://blog.naver.com/아이디/글번호

**외국어 글을 한국어로** — 영어·불어·중국어·일본어·태국어·베트남어 등 어떤 언어든 됩니다.

> https://fr.wikipedia.org/wiki/Kimchi 핵심만 5줄로 한국어 정리해 줘

**원하는 형식으로**

> 이 기사 3줄 요약하고, 등장하는 숫자·날짜만 표로 뽑아 줘: https://n.news.naver.com/article/...

> 이 블로그 글에서 사용한 도구와 단계별 방법만 정리해 줘: https://blog.naver.com/...

**여러 링크 비교**

> 이 두 글의 주장을 비교해서 공통점과 차이점을 알려 줘: https://... https://...

**긴 문서** — 한 번에 2만 자까지 읽고, 더 길면 Claude가 `start_index`로 이어서 읽습니다. 처음부터 끝까지 읽게 하려면:

> 이 문서 끝까지 다 읽고 장별로 요약해 줘: https://...

**링크 주소가 필요할 때** — 기본값은 링크 글자만 남겨 분량을 줄입니다. 출처 주소까지 필요하면:

> 이 페이지의 참고 링크 주소까지 포함해서 정리해 줘 (include_links 켜고): https://...

### 잘 안 될 때

| 증상 | 해결 |
|---|---|
| Claude가 도구를 안 쓰고 "링크를 열 수 없다"고 함 | Claude를 다시 시작했는지, `claude mcp list`에 `✔ Connected`인지 확인. "linkbrief로 읽어 줘"라고 직접 말해도 됩니다 |
| `Page text too short` | JavaScript로만 내용을 그리거나 로그인이 필요한 페이지입니다 (지원 안 함) |
| `Refusing to fetch a private or local address` | `localhost`·사내망 주소는 보안상 막혀 있습니다 |
| `Could not reach ...` / 시간 초과 | 사이트가 느리거나 막혔습니다. 잠시 후 다시 시도하세요 (자동으로 1회 재시도합니다) |
| `Google search result pages block automated access` | Google 검색 결과 대신 결과 글의 주소를 직접 주세요 |
| 설치 시 `npx` 오류 | Node.js 20 이상인지 확인: `node --version` |

## 도구: `fetch_page`

| 인자 | 기본값 | 설명 |
|---|---|---|
| `url` | (필수) | http/https 주소 |
| `max_length` | 20000 | 한 번에 돌려줄 최대 글자 수 (1,000~100,000) |
| `start_index` | 0 | 긴 글의 다음 부분을 읽을 시작 위치. 잘린 경우 결과 끝에 다음 값이 안내됩니다 |
| `include_links` | false | 링크 주소까지 유지할지. 기본은 링크 글자만 남깁니다 |

## 지원 현황

| 대상 | 상태 |
|---|---|
| 네이버 블로그, 네이버 뉴스, 다음 뉴스, 티스토리, 브런치 | ✅ |
| 위키백과, BBC, 르몽드, 인민망, 타이랏, VnExpress 등 일반 기사·문서 | ✅ |
| EUC-KR, Shift_JIS, EUC-JP, GBK/GB2312, Big5, TIS-620, windows-1258 | ✅ |
| Google 검색 결과 페이지 | ❌ Google이 자동 접근을 막습니다. Claude의 웹 검색을 쓰세요 |
| 로그인이 필요한 글 (네이버 카페 등), JavaScript로만 그려지는 페이지 | ❌ |
| PDF, 이미지, 동영상 | ❌ 웹 페이지(HTML·텍스트)만 |

실제 사이트 점검 결과 (`npm run check:live`, 2026-11-26) — Google 검색은 의도적으로 거절합니다:

![국내외 19개 사이트 점검 결과](docs/images/live.png)

## 보안

- **내부망 차단:** `localhost`, 사설 IP(10.x, 192.168.x 등), 링크 로컬, 클라우드 메타데이터 주소(169.254.169.254)는 거절합니다. 리다이렉트도 단계마다 다시 검사합니다. 웹페이지 속 악성 지시에 속은 Claude가 내 공유기나 사내망을 읽지 못하게 하기 위해서입니다.
- **크기 제한:** 5MB까지만 읽고, HTML·텍스트가 아닌 응답은 거절합니다.
- 가져온 본문은 Claude에게 "지시가 아닌 데이터"로 표시해 넘깁니다.

## 개발

```bash
npm install
npm test             # 오프라인 테스트 (네트워크 불필요)
npm run check:live   # 실제 사이트 점검 (인터넷 필요)
npm run check:live -- https://example.com/글   # 특정 주소만 점검
node page.mjs <URL>  # 한 페이지의 추출 결과 보기
```

| 파일 | 역할 |
|---|---|
| `server.mjs` | MCP 서버, `fetch_page` 도구 정의 |
| `page.mjs` | 가져오기·보안 검사·인코딩·본문 추출(Readability → Markdown) |
| `sites.mjs` | 사이트별 규칙 (주소 바꾸기, 거절 안내) |
| `fixtures/` | 테스트용 HTML (실제 글이 아닌, 구조만 본뜬 직접 작성한 내용) |

### 사이트 추가하기

`sites.mjs`의 `sites` 배열에 규칙을 추가하고 `test.mjs`에 테스트를 넣어 주세요.

```js
{
  name: "example",
  match: (u) => u.hostname === "example.com",
  rewrite: (u) => u.href.replace("/view/", "/print/"),   // 본문을 담은 주소로 바꾸기
  // refuse: "이 사이트는 ...라서 가져올 수 없습니다",    // 또는 이유를 알리고 거절
}
```

테스트용 HTML이 필요하면 실제 글을 복사하지 말고, 그 사이트의 HTML 구조만 본떠 직접 쓴 내용으로 `fixtures/`에 넣어 주세요.

## 라이선스

MIT

---

## English

**linkbrief-mcp** is an MCP server that lets Claude read web pages **from your own computer** and returns the main content as Markdown, so Claude can summarize it. It is tuned for Korean sites (Naver Blog's iframe layout, Daum/Naver News, Tistory, Brunch) and legacy charsets (EUC-KR, Shift_JIS, EUC-JP, GBK, Big5, TIS-620, windows-1258), and works for pages in any language.

**Install (Claude Code):** `claude mcp add linkbrief -s user -- npx -y linkbrief-mcp`
**Claude Desktop:** add `"linkbrief": { "command": "npx", "args": ["-y", "linkbrief-mcp"] }` under `mcpServers`.
**Codex:** add `[mcp_servers.linkbrief]` with `command = "npx"` and `args = ["-y", "linkbrief-mcp"]` to `~/.codex/config.toml`.

**Tool `fetch_page`:** `url` (required), `max_length` (default 20000), `start_index` (for reading the next part of long pages), `include_links` (default `false`: keep link text only).

**Safety:** refuses localhost, private/link-local networks and cloud metadata addresses (re-checked on every redirect), reads at most 5 MB, and accepts HTML/text only.

**Not supported:** Google Search result pages (Google blocks automated access), pages behind a login, JavaScript-only pages, PDFs.

Development: `npm test` (offline), `npm run check:live` (real sites). Site-specific rules live in `sites.mjs`. License: MIT.
