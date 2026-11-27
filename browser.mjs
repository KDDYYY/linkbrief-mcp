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
// Renders run one at a time, so fetch_pages with many JS pages never opens ten browsers at once.
// shortcut: launches a fresh browser per call (~1-2 s); keep one alive if rendering becomes frequent.
let queue = Promise.resolve();
export function renderPage(url, checkUrl) {
  const run = queue.then(() => renderNow(url, checkUrl));
  queue = run.catch(() => {});
  return run;
}

// Cuts a tall image into JPEG tiles (each at most 1,500 px high, overlapping so no line of text is lost),
// scaled to at most 1,568 px wide. The page loads nothing from the network.
export function sliceImage(bytes, mimeType, { tileHeight = 1500, overlap = 60, maxTiles = 8 } = {}) {
  const run = queue.then(() => withBrowser(async (page) => {
    await page.setRequestInterception(true);
    page.on("request", (req) => (req.url().startsWith("data:") ? req.continue() : req.abort()).catch(() => {}));
    await page.setViewport({ width: 1568, height: tileHeight });
    await page.setContent(`<style>*{margin:0}img{display:block;max-width:1568px}</style><img src="data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}">`);
    const { width, height } = await page.$eval("img", (img) => img.decode().then(() => img.getBoundingClientRect().toJSON()));
    const tiles = [];
    for (let y = 0; y < height && tiles.length < maxTiles; y += tileHeight - overlap) {
      tiles.push(await page.screenshot({ type: "jpeg", quality: 85, clip: { x: 0, y, width, height: Math.min(tileHeight, height - y) }, captureBeyondViewport: true }));
      if (y + tileHeight >= height) break;
    }
    return tiles;
  }));
  queue = run.catch(() => {});
  return run;
}

async function renderNow(url, checkUrl) {
  return withBrowser(async (page) => {
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
  });
}

async function withBrowser(fn) {
  const executablePath = findBrowser();
  if (!executablePath) throw new Error("No Chrome or Edge found for JavaScript rendering (set LINKBRIEF_BROWSER to its path).");
  let puppeteer;
  try { puppeteer = (await import("puppeteer-core")).default; } catch {
    throw new Error("JavaScript rendering needs the optional puppeteer-core package (npm install puppeteer-core).");
  }
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "linkbrief-")); // fresh profile: no cookies or logins
  const args = ["--no-first-run", "--no-default-browser-check", "--lang=ko-KR"];
  // Same proxy as plain requests (see page.mjs); Chrome takes NO_PROXY as a semicolon list.
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (proxy) args.push(`--proxy-server=${proxy}`);
  if (proxy && noProxy) args.push(`--proxy-bypass-list=${noProxy.split(",").map((s) => s.trim()).filter(Boolean).join(";")}`);
  const browser = await puppeteer.launch({ executablePath, headless: true, userDataDir, args });
  try {
    return await fn(await browser.newPage());
  } finally {
    await browser.close().catch(() => {});
    // Windows can keep profile files locked for a moment after close; leftovers in tmp are harmless.
    try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignore */ }
  }
}
