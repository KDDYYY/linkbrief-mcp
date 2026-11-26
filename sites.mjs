// Site adapters: per-site fixes that generic extraction cannot handle.
// To add a site: push { name, match: (URL) => boolean, rewrite?: (URL) => string, refuse?: string }
// and add a test in test.mjs. `refuse` explains why a page cannot be fetched instead of returning a block page.
export const sites = [
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
