# linkbrief-mcp

[English](README.md) | **한국어**

Claude가 **내 PC에서 직접** 웹 페이지, PDF, Office 문서를 읽게 해 주는 MCP 서버입니다. 링크를 주고 "요약해 줘"라고 하면, linkbrief가 본문만 Markdown으로 가져오고 Claude가 정리합니다. Codex, Cursor 등 MCP를 지원하는 다른 도구에서도 똑같이 쓸 수 있습니다.

위키백과, 나무위키, GitHub, 개발 문서, 세계 각국 뉴스와 블로그, PDF, JavaScript로 그려지는 페이지까지 어떤 언어의 링크든 읽습니다. 다른 도구가 자주 놓치는 사이트도 따로 챙깁니다: 네이버 블로그(iframe 구조), 나무위키, 그리고 EUC-KR·Shift_JIS·GBK 같은 옛 인코딩.

![프랑스어 위키백과 글을 linkbrief로 가져와 Claude가 한국어로 요약하는 예시](docs/images/usage.png)

<sub>사용 예시: `fetch_page` 호출과 결과는 실제 linkbrief 출력이고, 요약은 Claude가 그 결과로 작성한 것입니다. (문서: 프랑스어 위키백과 「Kimchi」, CC BY-SA)</sub>

## 왜 필요한가요?

- **토큰을 95% 아낍니다.** 웹 페이지 HTML의 대부분은 메뉴·광고·스크립트·이미지 주소입니다. linkbrief는 본문만 남겨 넘깁니다. ([측정 결과](#토큰-절감-효과))
- **필요한 부분만 읽습니다.** 먼저 목차(제목·분량·첫 문장)를 보고, 필요한 문단만 골라 읽습니다. 긴 위키백과 문서라면 전체를 읽을 때보다 87% 적습니다.
- **개발자용 사이트를 제대로 읽습니다.** GitHub 이슈·PR은 댓글 전체와 변경 파일까지, Stack Overflow는 질문과 추천 답변, Hacker News는 댓글 트리 전체, arXiv 요약 페이지는 논문 본문으로 읽습니다. 문서 사이트는 한 섹션을 통째로 읽어 줍니다 (`fetch_site`).
- **문서 파일도 읽습니다.** PDF는 쪽별로, Word·PowerPoint·Excel·한글(.hwpx) 파일도 링크만 주면 됩니다.
- **막힌 사이트도 읽습니다.** Claude의 기본 웹 가져오기는 일부 사이트(예: `blog.naver.com`)가 막혀 있습니다. linkbrief는 **사용자 PC에서 일반 브라우저처럼** 요청합니다.
- **네이버 블로그가 비어 보이지 않습니다.** 본문이 iframe 안에 있어 그냥 가져오면 비어 있는데, linkbrief는 본문이 들어 있는 모바일 주소로 바꿔 읽습니다.
- **PDF, 여러 링크, JavaScript 페이지까지** 한 도구로 처리합니다.
- **API 키가 필요 없습니다.** 요약은 사용 중인 Claude가 합니다.

## 빠른 시작 (Claude Code 기준, 3단계)

**1. 설치** — 터미널에서 한 줄. npm에서 자동으로 받아 실행하므로 `npm install`을 따로 할 필요가 없습니다.

```bash
claude mcp add linkbrief -s user -- npx -y linkbrief-mcp
```

Windows(PowerShell·명령 프롬프트)에서는 `npx`를 `cmd /c`로 감싸야 연결이 안정적입니다:

```powershell
claude mcp add linkbrief -s user -- cmd /c npx -y linkbrief-mcp
```

**2. 연결 확인** — Claude Code를 다시 열고 대화창에 `/mcp`를 입력하면 연결된 MCP 서버 목록이 나옵니다. `linkbrief`가 연결됨으로 보이고 도구 `fetch_page`, `fetch_pages`가 있으면 준비 끝입니다. (터미널에서는 `claude mcp list`)

**3. 그냥 부탁하기** — 명령어를 외울 필요가 없습니다. 링크와 함께 평소처럼 말하면 Claude가 알아서 linkbrief를 불러 씁니다.

> 이 글 3줄로 요약해 줘: https://blog.naver.com/아이디/글번호

Claude Desktop(클릭 한 번 설치), Codex, Cursor 설정은 아래 [설치](#설치)를 보세요.

### 어떻게 동작하나요?

linkbrief는 **에이전트가 쓰는 도구**입니다. 무엇을 언제 읽을지는 Claude(에이전트)가 대화를 보고 스스로 정합니다.

```
사용자: "이 두 기사 비교해 줘: 링크1 링크2"
   │
   ▼
Claude(에이전트) ── 링크가 여러 개네 → fetch_pages 호출
   │                    글이 길어서 잘렸네 → fetch_page로 이어 읽기
   ▼
linkbrief (내 PC에서 실행) ── 페이지·PDF를 받아 본문만 Markdown으로 정리
   │
   ▼
Claude가 읽고 비교·요약해서 답변
```

- 링크가 하나면 `fetch_page`, 여러 개면 `fetch_pages`를 Claude가 골라 씁니다.
- 글이 길면 결과 끝의 안내를 보고 Claude가 **스스로 다음 부분을 이어서** 읽습니다.
- 처음 쓸 때 Claude가 도구 사용 허락을 물으면 허용하세요. 매번 묻지 않게 하려면 허락 창에서 "항상 허용"을 고르면 됩니다.

## 토큰 절감 효과

블로그·뉴스·위키 등 실제 국내외 페이지를 원본 HTML 그대로 넘길 때와 linkbrief 결과를 비교했습니다 (글자 수 기준, 2026-11-26 측정).

| | 원본 HTML | linkbrief 결과 |
|---|---:|---:|
| 분량 | 약 202만 자 | 약 9만 자 |
| **절감** | | **약 95% (페이지별 92~99%)** |

토큰 수는 글자 수에 대체로 비례하므로, 같은 내용을 읽는 데 드는 토큰도 이 정도 줄어듭니다. 토큰이 줄면 **사용량 한도가 덜 차고, 응답이 빨라지고, 긴 대화에서도 앞 내용을 덜 잊습니다.**

절감이 일어나는 곳:

| 방법 | 효과 |
|---|---|
| **본문만 추출** (Mozilla Readability) | 메뉴·광고·댓글·푸터·스크립트 제거 — 절감의 대부분 |
| **이미지·아이콘 제거** | 이미지 주소만으로 분량이 2배가 되는 페이지도 있습니다 |
| **링크 주소 제거** (기본값) | 링크 글자만 남김. 링크가 많은 문서에서 49~66% 추가 감소. 필요하면 `include_links`로 유지 |
| **목차 먼저, 한 문단만** | `outline`은 제목과 분량만, `section`은 한 문단만 돌려줍니다. 긴 문서에서 전체 대비 82~91% 감소 (아래 표) |
| **나눠 읽기** | 한 번에 2만 자까지만 넘기고, 더 필요할 때만 `start_index`로 이어 읽음 |
| **여러 링크는 페이지당 상한** | `fetch_pages`는 기본 페이지당 8천 자 |
| **10분 캐시** | 같은 페이지를 이어 읽을 때 다시 내려받지 않음 (두 번째 요청이 1천 분의 몇 초 만에 끝남) |

목차를 먼저 보고 한 문단만 읽을 때와 전체를 읽을 때 비교 (글자 수, 2026-11-27 측정):

| 페이지 | 전체 | 목차 + 한 문단 | 절감 |
|---|---:|---:|---:|
| 영어 위키백과 「Large language model」 | 101,576 | 8,172 + 5,021 | 87% |
| 나무위키 「김치」 | 46,131 | 2,733 + 5,355 | 82% |
| arXiv 논문 PDF (15쪽) | 39,790 | 1,638 + 1,916 | 91% |

## 설치

Node.js 22.12 이상이 필요합니다 (Node 20은 2026년 4월 지원 종료).

**Claude Code**

```bash
claude mcp add linkbrief -s user -- npx -y linkbrief-mcp
```

Windows(PowerShell·명령 프롬프트)에서는 `npx`를 `cmd /c`로 감싸야 연결이 안정적입니다:

```powershell
claude mcp add linkbrief -s user -- cmd /c npx -y linkbrief-mcp
```

**Claude Desktop, 클릭 한 번으로** — [최신 릴리스](https://github.com/KDDYYY/linkbrief-mcp/releases/latest)에서 `linkbrief.mcpb`를 내려받아 더블클릭하거나, 설정 → 확장 프로그램에 끌어다 놓으세요. GitHub 토큰(선택)도 거기서 넣을 수 있습니다.

**Claude Desktop, 설정 파일로** — `claude_desktop_config.json`에 추가 (설정 → 개발자 → 설정 편집):

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

**설치 확인** — Claude Code 대화창의 `/mcp` 또는 터미널의 `claude mcp list`에서 `linkbrief`가 연결됨(`✔ Connected`)으로 보이면 준비된 것입니다. 설치·설정을 바꾼 뒤에는 Claude를 **다시 시작**해야 적용됩니다.

## 사용 방법

Claude에게 링크와 함께 평소 말투로 부탁하면 됩니다. Claude가 알아서 linkbrief 도구를 불러 본문을 읽습니다. 처음 쓸 때 도구 사용 허락을 묻는 창이 뜨면 허용해 주세요.

**기본 요약**

> 이 글 한국어로 요약해 줘: https://blog.naver.com/아이디/글번호

**외국어 글을 한국어로** — 영어·불어·중국어·일본어·태국어·베트남어 등 어떤 언어든 됩니다.

> https://fr.wikipedia.org/wiki/Kimchi 핵심만 5줄로 한국어 정리해 줘

**PDF** — 논문, 보도자료, 보고서 링크도 그대로 주면 됩니다. 자세한 방법은 아래 [PDF 읽기](#pdf-읽기)를 보세요.

> 이 논문 핵심 기여 3가지와 실험 결과만 정리해 줘: https://arxiv.org/pdf/1706.03762

**코드 리뷰·디버깅**

> 이 PR 논의 내용 요약하고 바뀐 파일 목록 보여 줘: https://github.com/owner/repo/pull/123

> 여기서 채택된 해결책이 뭐고 왜 되는지 설명해 줘: https://stackoverflow.com/questions/11227809

**문서 사이트 한 섹션 통째로** — `fetch_site`가 시작 페이지와 같은 폴더 아래 링크를 따라 읽습니다 (최대 30쪽, robots.txt 준수).

> 파이썬 튜토리얼 읽고 한 장짜리 요약표 만들어 줘: https://docs.python.org/3/tutorial/index.html

**Office 문서** — Word·PowerPoint·Excel·한글(.hwpx) 링크도 PDF처럼 읽습니다.

> 이 발표 자료 슬라이드별로 요약해 줘: https://example.org/files/q3-review.pptx

**원하는 형식으로**

> 이 기사 3줄 요약하고, 등장하는 숫자·날짜만 표로 뽑아 줘: https://n.news.naver.com/article/...

> 이 블로그 글에서 사용한 도구와 단계별 방법만 정리해 줘: https://blog.naver.com/...

**여러 링크 한 번에** — 최대 10개까지 한 번에 읽어 비교합니다 (`fetch_pages`). 일부가 실패해도 나머지는 읽습니다.

> 이 세 기사의 논조를 비교해서 공통점과 차이점을 표로 정리해 줘: https://... https://... https://...

**출처 확인** — 결과 맨 위에 사이트·작성자·작성일·주소가 붙어 있어, 요약에 출처를 함께 달라고 할 수 있습니다.

> 요약 끝에 출처(사이트, 작성자, 날짜)도 적어 줘: https://...

**필요한 부분만** — 에이전트가 목차를 보고 필요한 문단만 골라 읽습니다. 직접 부탁해도 됩니다:

> 이 문서 목차부터 보여 주고, 역사 부분만 읽어서 정리해 줘: https://namu.wiki/w/김치

**긴 문서** — 한 번에 2만 자까지 읽고, 더 길면 Claude가 `start_index`로 이어서 읽습니다. 처음부터 끝까지 읽게 하려면:

> 이 문서 끝까지 다 읽고 장별로 요약해 줘: https://...

**링크 주소가 필요할 때** — 기본값은 링크 글자만 남겨 분량을 줄입니다. 출처 주소까지 필요하면:

> 이 페이지의 참고 링크 주소까지 포함해서 정리해 줘 (include_links 켜고): https://...

### PDF 읽기

**1. PDF 주소를 구합니다.** 웹페이지의 PDF 링크·다운로드 버튼에서 오른쪽 클릭 → **링크 주소 복사**, 또는 브라우저에 PDF가 열려 있으면 **주소창**을 복사합니다.

![PDF 링크를 복사해 Claude에 붙여 넣는 3단계](docs/images/pdf-link.png)

**2. Claude에 주소와 함께 부탁합니다.** linkbrief가 PDF를 받아 페이지별로 글자를 뽑고, Claude가 정리합니다.

![arXiv 논문 PDF를 linkbrief로 읽어 한국어 4줄로 요약하는 과정](docs/images/pdf-demo.gif)

<sub>예시: `fetch_page` 결과는 실제 linkbrief 출력(저자 이메일이 나오는 줄 앞에서 생략)이고, 요약은 Claude가 그 결과로 작성한 것입니다.</sub>

알아 두면 좋은 점:

| 상황 | 동작 |
|---|---|
| 주소가 `.pdf`로 끝나지 않음 (`download.do?id=…` 등) | 서버가 PDF를 보내 주면 자동으로 PDF로 읽습니다 |
| 결과에 `## Page 3` 같은 쪽 표시 | "몇 쪽에 나오는지", "3쪽만 요약해 줘"처럼 물어볼 수 있습니다 |
| 긴 PDF | 2만 자씩 나눠 읽습니다. "끝까지 읽고 요약해 줘"라고 하면 Claude가 이어서 읽습니다 |
| 결과 맨 위 `PDF, 15 pages` 줄 | 쪽수와 PDF에 적힌 제목·작성자·작성일이 함께 붙습니다 |
| **내 컴퓨터에 있는 PDF 파일** | linkbrief는 인터넷 주소만 읽습니다. Claude 대화창에 **파일을 직접 첨부**하세요 |
| 로그인해야 받을 수 있는 PDF, 버튼을 눌러야 받아지는 PDF | 주소만으로 받을 수 없어 읽지 못합니다. 내려받아 직접 첨부하세요 |
| 스캔한 이미지 PDF | 글자가 없어 읽지 못합니다 (`PDF has no extractable text`) |
| 30MB가 넘는 PDF | 읽지 않습니다 |

### JavaScript로 그려지는 페이지

일반 요청으로 본문이 비어 오거나 차단(403·429·503)되면, linkbrief가 **PC에 설치된 Chrome 또는 Edge를 화면 없이 띄워** 다시 읽습니다. 별도 설정은 필요 없습니다.

- 브라우저를 새로 내려받지 않습니다. 이미 설치된 Chrome·Edge를 씁니다 (선택 패키지 `puppeteer-core`).
- 매번 **빈 프로필**로 열기 때문에 내 로그인·쿠키는 쓰이지 않습니다.
- 브라우저가 페이지 안에서 보내는 모든 요청에도 내부망 차단 검사를 적용합니다.
- 끄기: 환경 변수 `LINKBRIEF_BROWSER=off`. 다른 브라우저 지정: `LINKBRIEF_BROWSER=<실행 파일 경로>`.
- Cloudflare 같은 **봇 확인 페이지는 우회하지 않고**, 그렇다고 알려 줍니다.

### 잘 안 될 때

| 증상 | 해결 |
|---|---|
| Claude가 도구를 안 쓰고 "링크를 열 수 없다"고 함 | Claude를 다시 시작했는지, `claude mcp list`에 `✔ Connected`인지 확인. "linkbrief로 읽어 줘"라고 직접 말해도 됩니다 |
| `Page text too short` | 로그인이 필요한 페이지이거나, JavaScript 페이지인데 Chrome·Edge가 없는 경우입니다 |
| `This site shows a bot check` | 사이트가 봇 확인(Cloudflare 등)을 요구합니다. linkbrief는 우회하지 않습니다 (예: Medium, Reddit, npm 웹사이트) |
| `GitHub API: API rate limit exceeded` | 환경 변수 `GITHUB_TOKEN`을 넣으세요 (Claude Desktop 확장은 설정 칸에 입력) |
| `robots.txt on … asks automated tools not to read …` | 사이트가 자동 읽기를 거부했습니다 (`fetch_site`, 또는 `LINKBRIEF_ROBOTS=always`일 때) |
| `Old binary .hwp files are not supported` | .hwpx나 PDF로 저장하거나, 파일을 직접 첨부하세요 |
| `Refusing to fetch a private or local address` | `localhost`·사내망 주소는 보안상 막혀 있습니다 |
| `PDF has no extractable text` | 스캔 이미지로 된 PDF입니다 (글자 인식 OCR은 지원 안 함) |
| `This Naver Cafe post can only be read after logging in` | 카페 회원이나 로그인한 사람만 볼 수 있는 글입니다. 글 내용을 직접 붙여 넣어 주세요 |
| `For Naver Cafe, pass the post's full URL` | 글 화면의 "URL 복사"로 `clubid`·`articleid`(또는 `/cafes/숫자/articles/숫자`)가 든 주소를 주세요 |
| `Could not reach ...` / 시간 초과 | 사이트가 느리거나 막혔습니다. 잠시 후 다시 시도하세요 (자동으로 1회 재시도합니다) |
| `Google search result pages block automated access` | Google 검색 결과 대신 결과 글의 주소를 직접 주세요 |
| 설치 시 `npx` 오류, `EBADENGINE` 경고 | Node.js 22.12 이상인지 확인: `node --version` |

## 도구

### `fetch_page` — 한 페이지 읽기

| 인자 | 기본값 | 설명 |
|---|---|---|
| `url` | (필수) | http/https 주소 (웹 페이지 또는 PDF) |
| `max_length` | 20000 | 한 번에 돌려줄 최대 글자 수 (1,000~100,000) |
| `start_index` | 0 | 긴 글의 다음 부분을 읽을 시작 위치. 잘린 경우 결과 끝에 다음 값이 안내됩니다 |
| `include_links` | false | 링크 주소까지 유지할지. 기본은 링크 글자만 남깁니다 |
| `render` | false | 처음부터 브라우저로 읽기. 보통은 필요 없습니다 (자동 대체됨) |
| `outline` | false | 제목 목차만 돌려주기 (각 문단의 분량과 첫 문장 포함) |
| `section` | — | 한 문단(하위 문단 포함)만 돌려주기: 목차 번호(`"#3"`)나 제목(`"역사"`, `"Page 4"`) |

### `fetch_site` — 문서 사이트·섹션 읽기

| 인자 | 기본값 | 설명 |
|---|---|---|
| `url` | (필수) | 시작 페이지. 이 페이지와 같은 폴더 아래 링크만 따라갑니다 |
| `max_pages` | 10 | 최대 쪽수 (1~30) |
| `max_length_per_page` | 4000 | 쪽당 최대 글자 수 (500~20,000) |
| `include_links` | false | 링크 주소까지 유지할지 |

가까운 링크부터 차례로 읽고, 요청 사이에 쉬며, robots.txt는 항상 지킵니다.

### `fetch_pages` — 여러 페이지 한 번에

| 인자 | 기본값 | 설명 |
|---|---|---|
| `urls` | (필수) | 주소 1~10개 |
| `max_length_per_page` | 8000 | 페이지당 최대 글자 수 (1,000~50,000) |
| `include_links` | false | 링크 주소까지 유지할지 |

결과는 항상 이런 모양입니다:

```
# 제목
Source: 사이트 | Author: 작성자 | Published: 2026-11-25 | URL: https://...

본문 (Markdown)
```

## 지원 현황

| 대상 | 상태 |
|---|---|
| 네이버 블로그, 네이버 뉴스, 다음 뉴스, 티스토리, 브런치, 벨로그, 다음 카페(공개 글) | ✅ |
| 위키백과(모든 언어), 나무위키, MDN·Python 문서, Google 블로그, GitHub 저장소 | ✅ |
| GitHub 이슈·PR(댓글 전체, 변경 파일), GitHub 코드 파일(원본) | ✅ GitHub API 사용 (시간당 60회, `GITHUB_TOKEN`이 있으면 더 많이) |
| Stack Overflow, Super User, Server Fault, Ask Ubuntu, *.stackexchange.com 질문 | ✅ Stack Exchange API 사용 (질문 + 추천순 답변 10개) |
| Hacker News 글·댓글, arXiv (요약 페이지 → 논문 본문) | ✅ |
| BBC, 르몽드, 슈피겔, NHK, 인민망, 타이랏, VnExpress 등 해외 뉴스 | ✅ |
| PDF (영어·한국어 확인, 페이지별 구분) | ✅ |
| Word(.docx), PowerPoint(.pptx), Excel(.xlsx, 시트당 처음 200행), 한글(.hwpx) | ✅ (Excel 날짜는 일련번호로 나옴) |
| 예전 한글 형식(.hwp) | ❌ .hwpx나 PDF로 저장해서 쓰세요 |
| JavaScript로 그려지는 페이지 | ✅ Chrome·Edge가 있으면 자동 |
| EUC-KR, Shift_JIS, EUC-JP, GBK/GB2312, Big5, TIS-620, windows-1258 | ✅ |
| 네이버 카페 | ⚠️ 로그인 없이 공개된 글만. 로그인·회원 전용 글은 읽지 않고 그렇다고 알려 줍니다 (내 계정을 쓰지 않음) |
| Medium, Reddit 등 봇 확인을 거는 사이트 (Stack Overflow는 질문 페이지 외) | ❌ 우회하지 않습니다 |
| Google 검색 결과 페이지 | ❌ Google이 자동 접근을 막습니다. Claude의 웹 검색을 쓰세요 |
| YouTube 자막, 로그인이 필요한 글, 스캔 PDF, 이미지·동영상 | ❌ |

실제 사이트 점검 결과 (`npm run check:live`, 2026-11-27) — Medium·Reddit(봇 확인)과 Google 검색은 의도적으로 거절합니다:

![국내외 36개 사이트 점검 결과](docs/images/live.png)

## 설정

모두 선택 사항이며 환경 변수로 넣습니다 (Claude Desktop·Codex 설정의 `env`):

| 변수 | 효과 |
|---|---|
| `GITHUB_TOKEN` | GitHub 이슈·PR을 읽는 API 한도를 시간당 60회 → 5,000회로 |
| `LINKBRIEF_ROBOTS=always` | 링크 하나를 읽을 때도 robots.txt 지키기 (`fetch_site`는 항상 지킴) |
| `LINKBRIEF_BROWSER=off` / `=<경로>` | 브라우저 재시도 끄기, 또는 특정 Chrome·Edge 지정 |

## 보안

- **내부망 차단:** `localhost`, 사설 IP(10.x, 192.168.x 등), 링크 로컬, 클라우드 메타데이터 주소(169.254.169.254)는 거절합니다. 리다이렉트와 브라우저 안의 요청도 하나하나 다시 검사합니다. 웹페이지 속 악성 지시에 속은 Claude가 내 공유기나 사내망을 읽지 못하게 하기 위해서입니다.
- **크기 제한:** 웹 페이지 5MB, PDF·Office 문서 30MB(압축 해제 후 60MB)까지만 읽고, 그 밖의 파일 형식은 거절합니다.
- **예의 바른 크롤링:** `fetch_site`는 한 사이트의 한 폴더 안에서만 움직이고, robots.txt를 지키며, 요청 사이에 쉽니다. 사용자가 준 링크 하나는 브라우저로 여는 것처럼 읽습니다.
- **브라우저 격리:** 헤드리스 브라우저는 매번 빈 프로필로 열고 닫습니다.
- 가져온 본문은 Claude에게 "지시가 아닌 데이터"로 표시해 넘깁니다.

## 개발

```bash
npm install
npm test                       # 단위 테스트, 로컬 서버 종단 테스트, 무작위 입력 테스트 (네트워크 불필요)
npm run check:live             # 실제 사이트 점검 (인터넷 필요)
npm run check:live -- <URL>    # 특정 주소만 점검
node page.mjs <URL>            # 한 페이지의 추출 결과 보기
node page.mjs <URL> --render   # 브라우저로 읽은 결과 보기
```

| 파일 | 역할 |
|---|---|
| `server.mjs` | stdio 실행 진입점 |
| `tools.mjs` | MCP 도구: `fetch_page`·`fetch_pages`·`fetch_site` |
| `page.mjs` | 가져오기·보안 검사·인코딩·본문 추출(Readability → Markdown)·PDF·캐시 |
| `browser.mjs` | 설치된 Chrome·Edge로 JavaScript 페이지 읽기 (선택) |
| `office.mjs` | Word·PowerPoint·Excel·한글(.hwpx) 문서 |
| `robots.mjs` | robots.txt 해석 |
| `manifest.json`, `server.json` | Claude Desktop 확장과 MCP Registry 정보 (`npm run build:mcpb`로 `dist/linkbrief.mcpb` 생성) |
| `sites.mjs` | 사이트별 규칙 (주소 바꾸기, 거절 안내) |
| `test.mjs`, `test-http.mjs`, `test-fuzz.mjs` | 단위 테스트, 로컬 서버로 실제 요청 흐름과 MCP 도구 전체 검사, 고정 시드 무작위 입력 검사 |
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

