// Site adapters: per-site fixes that generic extraction cannot handle.
// To add a site: push { name, match: (URL) => boolean, rewrite?: (URL) => string, refuse?: string }
// and add a test in test.mjs. `refuse` explains why a page cannot be fetched instead of returning a block page.
// A site whose page is an empty JavaScript shell can instead give `api(URL) -> JSON URL`, optional `headers`,
// and `fromApi(json) -> { html, title, byline, siteName, published }` (throw with a reason when unreadable).

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
