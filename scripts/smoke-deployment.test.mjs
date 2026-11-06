import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { smoke } from "./smoke-deployment.mjs";

const HEALTHY = {
  status: "ok",
  version: "0.0.0",
  commit: "abcdef0123",
  database: { ok: true, schemaVersion: 365, upToDate: true },
  runner: { ok: true, worker: "ros-runner", latencyMs: 3 },
};
const PAGE = '<script src="/assets/main.js"></script><link href="/assets/app.css" rel="stylesheet">';

async function withServer(routes, run) {
  const methods = [];
  const server = createServer((request, response) => {
    methods.push(request.method);
    const route = routes[request.url];
    if (!route) return response.writeHead(404).end("not found");
    response.writeHead(route.status ?? 200, route.headers).end(route.body);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`, methods);
  } finally {
    server.close();
  }
}

const json = (value, status = 200) => ({ status, body: JSON.stringify(value) });
const routes = {
  "/api/health": json(HEALTHY),
  "/sign-in": { headers: { "content-type": "text/html" }, body: PAGE },
  "/assets/main.js": { headers: { "content-type": "text/javascript" }, body: "1" },
  "/assets/app.css": { headers: { "content-type": "text/css" }, body: "a{}" },
};

test("a healthy deployment passes, with GET requests only", async () => {
  await withServer(routes, async (url, methods) => {
    assert.equal(await smoke(url, () => {}), 0);
    assert.deepEqual([...new Set(methods)], ["GET"]);
  });
});

test("an unmigrated database and an unreachable runner fail", async () => {
  const degraded = {
    ...HEALTHY,
    status: "degraded",
    database: { ok: false, schemaVersion: 1 },
    runner: { ok: false, error: "no such service" },
  };
  await withServer({ ...routes, "/api/health": json(degraded, 503) }, async (url) => {
    const lines = [];
    assert.equal(await smoke(url, (line) => lines.push(line)), 1);
    assert.match(lines.join("\n"), /no such service/);
  });
});

test("a missing asset fails", async () => {
  const { "/assets/app.css": _css, ...rest } = routes;
  await withServer(rest, async (url) => assert.equal(await smoke(url, () => {}), 1));
});

test("Cloudflare Access in front of the sign-in page is not a failure", async () => {
  const access = {
    status: 302,
    headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" },
  };
  await withServer({ ...routes, "/sign-in": access }, async (url) =>
    assert.equal(await smoke(url, () => {}), 0),
  );
});
