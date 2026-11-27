// robots.txt: always honoured by fetch_site (it crawls); for single links the user asked for, only when
// LINKBRIEF_ROBOTS=always (a person opening a link is not a crawler).
export const AGENT = "linkbrief";

// Rules for our agent: the most specific matching "User-agent" group (linkbrief, else *).
export function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!lastWasAgent) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (current && (key === "allow" || key === "disallow")) current.rules.push({ allow: key === "allow", path: value });
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && AGENT.startsWith(a)));
  return (mine.length ? mine : groups.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules);
}

const toRegex = (path) => new RegExp(`^${path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")}`);

// Longest matching rule wins; Allow wins a tie; an empty Disallow allows everything.
export function isAllowed(rules, pathAndQuery) {
  let best = null;
  for (const r of rules) {
    if (!r.path) continue;
    if (!toRegex(r.path).test(pathAndQuery)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return !best || best.allow;
}

// Per-origin cache of parsed rules. A missing or unreadable robots.txt allows everything.
const cache = new Map();
export async function robotsAllows(url, fetchRobots) {
  const u = new URL(url);
  if (!cache.has(u.origin)) cache.set(u.origin, fetchRobots(`${u.origin}/robots.txt`).then(parseRobots, () => []));
  return isAllowed(await cache.get(u.origin), u.pathname + u.search);
}
