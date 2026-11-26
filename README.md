# linkbrief-mcp

Claude가 **내 PC에서 직접** 웹 페이지를 읽게 해 주는 MCP 서버입니다. 링크를 주고 "요약해 줘"라고 하면, linkbrief가 본문을 Markdown으로 가져오고 Claude가 정리합니다.

한국 사이트에 맞춰 만들었습니다: 네이버 블로그(iframe 구조), 다음·네이버 뉴스, 티스토리, 브런치, 그리고 EUC-KR 같은 옛 인코딩. 영어·불어·중국어·일본어·태국어·베트남어 페이지도 깨지지 않고 읽습니다.

[English](#english)

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

**Cursor 등 다른 MCP 클라이언트** — 명령 `npx -y linkbrief-mcp`를 stdio 서버로 등록하면 됩니다.

설치 후 Claude를 다시 시작하고 이렇게 말해 보세요:

> 이 글 한국어로 요약해 줘: https://blog.naver.com/아이디/글번호

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

## 보안

- **내부망 차단:** `localhost`, 사설 IP(10.x, 192.168.x 등), 링크 로컬, 클라우드 메타데이터 주소(169.254.169.254)는 거절합니다. 리다이렉트도 단계마다 다시 검사합니다. 웹페이지 속 악성 지시에 속은 Claude가 내 공유기나 사내망을 읽지 못하게 하기 위해서입니다.
- **크기 제한:** 5MB까지만 읽고, HTML·텍스트가 아닌 응답은 거절합니다.
- 가져온 본문은 Claude에게 "지시가 아닌 데이터"로 표시해 넘깁니다.
- 알려진 한계: DNS 리바인딩 공격은 완전히 막지 못합니다(검사와 실제 접속 사이에 DNS가 다시 조회됨).

## 주의

linkbrief는 사용자 본인 PC에서 사용자를 대신해 페이지를 읽는 도구입니다. 각 사이트의 이용약관과 robots.txt, 저작권은 사용자가 지켜야 합니다. 가져온 글을 재배포하지 마세요.

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

**Tool `fetch_page`:** `url` (required), `max_length` (default 20000), `start_index` (for reading the next part of long pages), `include_links` (default `false`: keep link text only).

**Safety:** refuses localhost, private/link-local networks and cloud metadata addresses (re-checked on every redirect), reads at most 5 MB, and accepts HTML/text only. DNS rebinding is not fully prevented.

**Not supported:** Google Search result pages (Google blocks automated access), pages behind a login, JavaScript-only pages, PDFs.

You are responsible for following each site's terms of use and copyright. Development: `npm test` (offline), `npm run check:live` (real sites). Site-specific rules live in `sites.mjs`. License: MIT.
