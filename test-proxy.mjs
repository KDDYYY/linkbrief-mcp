// Proxy support, in its own process because the proxy agent is installed once per process:
// requests go through HTTP_PROXY, NO_PROXY hosts go direct, and names this PC cannot resolve are left to the proxy.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const article = `<html><head><title>Via proxy</title></head><body><article><h1>Via proxy</h1><p>${"Proxied content for the test. ".repeat(20)}</p></article></body></html>`;

let directHits = 0;
const target = http.createServer((req, res) => { directHits++; res.writeHead(200, { "content-type": "text/html" }); res.end(article); });
const targetPort = await listen(target);

// A minimal forward proxy like a corporate one: CONNECT tunnels (what undici uses) and absolute-form
// requests, both sent on to the local target whatever host was asked for.
const seen = [];
const proxy = http.createServer((req, res) => {
  seen.push(req.url);
  const up = http.request({ host: "127.0.0.1", port: targetPort, path: new URL(req.url).pathname, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on("error", () => { res.writeHead(502); res.end(); });
  up.end();
});
proxy.on("connect", (req, client, head) => {
  seen.push(req.url); // "host:port"
  const up = net.connect(targetPort, "127.0.0.1", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    up.write(head);
    up.pipe(client);
    client.pipe(up);
  });
  up.on("error", () => client.destroy());
  client.on("error", () => up.destroy());
});
const proxyPort = await listen(proxy);

process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
process.env.NO_PROXY = "localhost";
process.env.LINKBRIEF_BROWSER = "off";
const { fetchText, testAllowHosts, assertPublicUrl } = await import("./page.mjs");

// 1) Through the proxy
testAllowHosts.add(`127.0.0.1:${targetPort}`);
const r = await fetchText(`http://127.0.0.1:${targetPort}/a`);
assert.match(r.text, /# Via proxy/);
assert.equal(seen.length, 1, "the request went through the proxy");
assert.match(seen[0], new RegExp(`127\.0\.0\.1:${targetPort}`));

// 2) NO_PROXY hosts go direct
testAllowHosts.add(`localhost:${targetPort}`);
const before = directHits;
await fetchText(`http://localhost:${targetPort}/b`);
assert.equal(seen.length, 1, "localhost bypassed the proxy");
assert.equal(directHits, before + 1);

// 3) A name this PC cannot resolve is left to the proxy; intranet-looking names still are not
await fetchText(`http://linkbrief-test.invalid/c`).catch(() => {}); // our proxy maps it to the target
assert.ok(seen.some((s) => s.includes("linkbrief-test.invalid")), "unresolvable public-looking name handed to the proxy");
for (const u of ["http://intranet/", "http://wiki.corp/", "http://printer.local/", "http://db.internal/"]) {
  await assert.rejects(assertPublicUrl(u), /Could not resolve|private or local/, u);
}

target.close();
proxy.close();
console.log("ok (proxy)");
