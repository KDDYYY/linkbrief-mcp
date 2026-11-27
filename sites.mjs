// Site adapters: per-site fixes that generic extraction cannot handle.
// To add a site: push { name, match: (URL) => boolean, rewrite?: (URL) => string, refuse?: string }
// and add a test in test.mjs. `refuse` explains why a page cannot be fetched instead of returning a block page.
// A site better read through its public API gives `load(URL, getJson) -> { html | markdown, title, byline,
// siteName, published }` (throw with a reason when unreadable); getJson(url, headers) applies the usual safety checks.
// A site where Readability picks the wrong block can give `pick(document) -> element` holding the article.

export const pickFor = (url) => sites.find((s) => s.pick && s.match(new URL(url)))?.pick;

const decodeHtml = (s) => String(s ?? "")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const isoDay = (seconds) => new Date(seconds * 1000).toISOString();

// Optional token raises GitHub's limit from 60 to 5,000 requests per hour.
const githubHeaders = () => ({ Accept: "application/vnd.github+json", ...(process.env.GITHUB_TOKEN && { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }) });
async function githubJson(getJson, url) {
  const json = await getJson(url, githubHeaders());
  if (json && !Array.isArray(json) && json.message) {
    const hint = /rate limit/i.test(json.message) ? " Set GITHUB_TOKEN to raise the limit (60 requests/hour without one)." : "";
    throw new Error(`GitHub API: ${json.message}${hint}`);
  }
  return json;
}

// Stack Exchange API site name from a host: stackoverflow.com -> stackoverflow, math.stackexchange.com -> math.
export function stackExchangeSite(host) {
  host = host.replace(/^www\./, "");
  if (host.endsWith(".stackexchange.com")) return host.slice(0, -".stackexchange.com".length);
  return host === "mathoverflow.net" ? host : host.replace(/\.com$/, "");
}

// Naver Cafe article ids from the URL forms the site uses.
export function naverCafeIds(u) {
  const club = u.searchParams.get("clubid");
  const article = u.searchParams.get("articleid");
  if (club && article) return { club, article }; // cafe.naver.com/ArticleRead.nhn?clubid=..&articleid=..
  const m = /\/cafes\/(\d+)\/articles\/(\d+)/.exec(u.pathname); // (m.)cafe.naver.com/ca-fe/(web/)cafes/{club}/articles/{id}
  return m ? { club: m[1], article: m[2] } : null;
}

export const sites = [
  {
    // The article page is an empty app shell; its body comes from this API, which answers only for
    // posts readable without a login. Login/member-only posts are reported, never fetched with an account.
    // shortcut: the success shape (result.article.contentHtml etc.) is the API's documented one but was only
    // seen live for a login-only post; recheck with a public post if Naver changes it.
    name: "naver-cafe",
    match: (u) => /^(m\.)?cafe\.naver\.com$/.test(u.hostname),
    api(u) {
      const ids = naverCafeIds(u);
      if (!ids) throw new Error("For Naver Cafe, pass the post's full URL that contains its numbers (clubid and articleid), e.g. from the post's 'URL 복사'.");
      return `https://apis.naver.com/cafe-web/cafe-articleapi/v2.1/cafes/${ids.club}/articles/${ids.article}?useCafeId=true`;
    },
    headers: { Referer: "https://cafe.naver.com/" },
    async load(u, getJson) {
      return this.fromApi(await getJson(this.api(u), this.headers));
    },
    fromApi(json) {
      const r = json?.result || {};
      const a = r.article;
      if (!a?.contentHtml) {
        const reason = r.reason || r.message || json?.errorMessage || "no article in the response";
        throw new Error(`This Naver Cafe post can only be read after logging in or joining the cafe (Naver says: ${reason}). linkbrief does not use your account.`);
      }
      return {
        html: a.contentHtml,
        title: a.subject || "",
        byline: a.writer?.nick || "",
        siteName: r.cafe?.name ? `네이버 카페 | ${r.cafe.name}` : "네이버 카페",
        published: a.writeDate ? new Date(a.writeDate).toISOString() : "",
      };
    },
  },
  {
    // Issue and PR pages are heavy apps; the API gives the description, every comment and the changed files.
    name: "github-issue",
    match: (u) => u.hostname === "github.com" && /^\/[^/]+\/[^/]+\/(issues|pull)\/\d+\/?$/.test(u.pathname),
    async load(u, getJson) {
      const [, owner, repo, , num] = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/.exec(u.pathname);
      const base = `https://api.github.com/repos/${owner}/${repo}`;
      const issue = await githubJson(getJson, `${base}/issues/${num}`);
      const isPr = Boolean(issue.pull_request);
      const [comments, files] = await Promise.all([
        issue.comments ? githubJson(getJson, `${base}/issues/${num}/comments?per_page=100`) : [],
        isPr ? githubJson(getJson, `${base}/pulls/${num}/files?per_page=100`) : [],
      ]);
      const labels = issue.labels?.map((l) => l.name).join(", ");
      const out = [
        `**${isPr ? "Pull request" : "Issue"} · ${issue.state}** · opened by @${issue.user?.login} on ${issue.created_at?.slice(0, 10)}${labels ? ` · labels: ${labels}` : ""}`,
        issue.body?.trim() || "_No description._",
      ];
      if (files.length) {
        out.push(`## Changed files (${files.length}${files.length === 100 ? "+" : ""})`,
          files.map((f) => `- ${f.filename} (${f.status}, +${f.additions} −${f.deletions})`).join("\n"));
      }
      if (comments.length) {
        out.push(`## Comments (${issue.comments}${issue.comments > comments.length ? `, first ${comments.length} shown` : ""})`);
        for (const c of comments) out.push(`### @${c.user?.login} · ${c.created_at?.slice(0, 10)}`, c.body?.trim() || "");
      }
      return { markdown: out.join("\n\n"), title: `${issue.title} (#${num})`, byline: issue.user?.login, siteName: `GitHub · ${owner}/${repo}`, published: issue.created_at };
    },
  },
  {
    // Code file pages -> the raw file (served as text/plain).
    name: "github-blob",
    match: (u) => u.hostname === "github.com" && /^\/[^/]+\/[^/]+\/blob\//.test(u.pathname),
    rewrite: (u) => u.href.replace(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\//, "https://raw.githubusercontent.com/$1/$2/").replace(/[?#].*$/, ""),
  },
  {
    // The sites answer non-browsers with a bot check; the official API (no key, 300 requests/day) has the content.
    name: "stack-exchange",
    match: (u) => /(^|\.)(stackoverflow|serverfault|superuser|askubuntu|stackexchange)\.com$|^mathoverflow\.net$/.test(u.hostname) && /^\/questions\/\d+/.test(u.pathname),
    async load(u, getJson) {
      const id = /^\/questions\/(\d+)/.exec(u.pathname)[1];
      const site = stackExchangeSite(u.hostname);
      const api = `https://api.stackexchange.com/2.3/questions/${id}`;
      const [q, a] = await Promise.all([
        getJson(`${api}?site=${site}&filter=withbody`),
        getJson(`${api}/answers?site=${site}&filter=withbody&sort=votes&order=desc&pagesize=10`),
      ]);
      if (q.error_message || !q.items?.length) throw new Error(`Stack Exchange API: ${q.error_message || "question not found"}`);
      const question = q.items[0];
      const answers = a.items || [];
      const html = [
        `<p><strong>Question</strong> · score ${question.score} · asked by ${decodeHtml(question.owner?.display_name)} · tags: ${question.tags?.join(", ")}</p>`,
        question.body,
        `<h2>Answers (${question.answer_count}${question.answer_count > answers.length ? `, top ${answers.length} by votes` : ""})</h2>`,
        ...answers.map((x) => `<h3>${x.is_accepted ? "✓ Accepted answer" : "Answer"} · score ${x.score} · ${decodeHtml(x.owner?.display_name)}</h3>${x.body}`),
      ].join("\n");
      return { html, title: decodeHtml(question.title), byline: decodeHtml(question.owner?.display_name), siteName: u.hostname.replace(/^www\./, ""), published: isoDay(question.creation_date) };
    },
  },
  {
    // The item page shows a flat, truncated thread; the official API gives the story and the comment tree.
    name: "hacker-news",
    match: (u) => u.hostname === "news.ycombinator.com" && u.pathname === "/item" && /^\d+$/.test(u.searchParams.get("id") || ""),
    async load(u, getJson) {
      const item = (id) => getJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
      const story = await item(u.searchParams.get("id"));
      if (!story) throw new Error("Hacker News item not found");
      // Breadth-first so the top of every thread comes first; capped to keep the reply and request count small.
      const MAX = 150;
      const byId = new Map();
      let level = story.kids || [];
      while (level.length && byId.size < MAX) {
        const batch = level.slice(0, MAX - byId.size);
        const got = await Promise.all(batch.map(item));
        got.forEach((c) => c && byId.set(c.id, c));
        level = got.flatMap((c) => (c && !c.deleted && !c.dead ? c.kids || [] : []));
      }
      const render = (ids, depth) => ids.map((id) => byId.get(id)).filter((c) => c && !c.deleted && !c.dead).map((c) =>
        `<blockquote><p><strong>${c.by}</strong> · ${isoDay(c.time).slice(0, 10)}</p>${c.text || ""}${render(c.kids || [], depth + 1)}</blockquote>`).join("");
      const html = [
        story.url ? `<p>Link: <a href="${story.url}">${story.url}</a> (read the article itself with fetch_page)</p>` : "",
        story.text || "",
        `<h2>Comments (${story.descendants ?? 0}${(story.descendants ?? 0) > byId.size ? `, first ${byId.size} shown` : ""})</h2>`,
        render(story.kids || [], 0),
      ].join("\n");
      return { html, title: decodeHtml(story.title || `Comment by ${story.by}`), byline: story.by, siteName: "Hacker News", published: isoDay(story.time) };
    },
  },
  {
    // Abstract pages -> the paper itself.
    name: "arxiv-abs",
    match: (u) => u.hostname === "arxiv.org" && u.pathname.startsWith("/abs/"),
    rewrite: (u) => `https://arxiv.org/pdf/${u.pathname.slice("/abs/".length)}`,
  },
  {
    // Class names change every build and Readability keeps only one block of the article (3k of 44k chars).
    // Section headings keep stable ids s-1, s-2, ...: the article is the smallest element holding all of them.
    name: "namuwiki",
    match: (u) => u.hostname === "namu.wiki",
    pick(document) {
      const sections = document.querySelectorAll('[id^="s-"]');
      if (!sections.length) return null;
      const last = sections[sections.length - 1];
      let node = sections[0];
      while (node && !node.contains(last)) node = node.parentElement;
      node?.querySelectorAll('a[href^="/edit/"]').forEach((a) => a.remove()); // "[편집]" after every heading
      return node;
    },
  },
  {
    // Returns a short "trouble accessing Google Search" page to non-browser clients.
    name: "google-search",
    match: (u) => /(^|\.)google\.[a-z.]+$/.test(u.hostname) && u.pathname === "/search",
    refuse: "Google search result pages block automated access. Use Claude's own web search, or pass the URL of a result page instead.",
  },
  {
    // Desktop pages wrap the post in an iframe; the mobile PostView page has the body inline.
    name: "naver-blog",
    match: (u) => /^(m\.)?blog\.naver\.com$/.test(u.hostname),
    rewrite(u) {
      let blogId = u.searchParams.get("blogId");
      let logNo = u.searchParams.get("logNo");
      const parts = u.pathname.split("/").filter(Boolean); // blog.naver.com/{blogId}/{logNo}
      if (!blogId && parts.length >= 2 && /^\d+$/.test(parts[1])) [blogId, logNo] = parts;
      if (!blogId || !logNo) return u.href;
      return `https://m.blog.naver.com/PostView.naver?blogId=${encodeURIComponent(blogId)}&logNo=${encodeURIComponent(logNo)}`;
    },
  },
];

export function normalizeUrl(raw) {
  const u = new URL(raw);
  const refused = sites.find((s) => s.refuse && s.match(u));
  if (refused) throw new Error(refused.refuse);
  const site = sites.find((s) => s.rewrite && s.match(u));
  return site ? site.rewrite(u) : u.href;
}
