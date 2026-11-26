// Optional headless rendering with the Chrome or Edge already installed on this PC (via puppeteer-core,
// which downloads no browser). Used for pages that build their content with JavaScript or block plain requests.
// Off with LINKBRIEF_BROWSER=off; point at a specific browser with LINKBRIEF_BROWSER=<path to executable>.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CANDIDATES = {
  win32: [
    path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe"),
    path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Microsoft\\Edge\\Application\\msedge.exe"),
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"],
};

export function findBrowser() {
  const setting = process.env.LINKBRIEF_BROWSER;
  if (setting === "off") return null;
  if (setting) return fs.existsSync(setting) ? setting : null;
  return (CANDIDATES[process.platform] || CANDIDATES.linux).find((p) => p && fs.existsSync(p)) || null;
}

// Renders url and returns the final HTML. Every request the page makes goes through checkUrl
// (the same private-address guard as plain fetches); images, media and fonts are skipped.
// shortcut: launches a fresh browser per call (~1-2 s); keep one alive if rendering becomes frequent.
export async function renderPage(url, checkUrl) {
  const executablePath = findBrowser();
  if (!executablePath) throw new Error("No Chrome or Edge found for JavaScript rendering (set LINKBRIEF_BROWSER to its path).");
  let puppeteer;
  try { puppeteer = (await import("puppeteer-core")).default; } catch {
    throw new Error("JavaScript rendering needs the optional puppeteer-core package (npm install puppeteer-core).");
  }
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "linkbrief-")); // fresh profile: no cookies or logins
  const browser = await puppeteer.launch({ executablePath, headless: true, userDataDir, args: ["--no-first-run", "--no-default-browser-check", "--lang=ko-KR"] });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    const allowed = new Map(); // host -> Promise<boolean>
    page.on("request", async (req) => {
      try {
        if (["image", "media", "font"].includes(req.resourceType())) return await req.abort();
        const u = new URL(req.url());
        if (u.protocol === "data:" || u.protocol === "blob:") return await req.continue();
        if (!allowed.has(u.host)) allowed.set(u.host, checkUrl(u.href).then(() => true, () => false));
        return (await allowed.get(u.host)) ? await req.continue() : await req.abort("blockedbyclient");
      } catch { /* request already handled or page closed */ }
    });
    const response = await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 }).catch((err) => {
      if (!/timeout/i.test(err.message)) throw err; // slow pages: use what has rendered so far
      return null;
    });
    return { url: page.url(), status: response?.status() ?? 200, html: await page.content() };
  } finally {
    await browser.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}
