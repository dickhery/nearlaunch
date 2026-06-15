import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

async function waitForHealth(baseUrl, serverOutput) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return response.json();
    } catch {
      // The child process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Relayer test server did not start.\n${serverOutput()}`);
}

function startRelayer(port, extraEnv = {}) {
  const server = spawn(process.execPath, ["relayer/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      RELAYER_PORT: String(port),
      RELAYER_MOCK: "true",
      ICP_RELAYER_PEM_PATH: "",
      ICP_RELAYER_IDENTITY: "test-relayer",
      ICP_CLI: "/definitely/missing/icp",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  server.on("exit", (code, signal) => {
    output += `\nchild exited code=${code} signal=${signal}`;
  });
  return { server, output: () => output };
}

async function stopRelayer(server) {
  if (server.exitCode !== null) return;
  await new Promise((resolve) => {
    server.once("exit", resolve);
    server.kill("SIGTERM");
  });
}

function createFakeIcpCli() {
  const principal = "rrkah-fqaaa-aaaaa-aaaaq-cai";
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "nearlaunch-fake-icp-"),
  );
  const executable = path.join(directory, "icp");
  fs.writeFileSync(
    executable,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "icp 0.3.2"
  exit 0
fi
if [ "$1" = "identity" ] && [ "$2" = "principal" ]; then
  echo "${principal}"
  exit 0
fi
if [ "$1" = "canister" ] && [ "$2" = "call" ]; then
  if [ "$4" = "getAdminAccess" ]; then
    echo '(record { caller = principal "${principal}"; owner = principal "${principal}"; settlementRelayer = principal "${principal}"; isOwner = true; isAdmin = true })'
  else
    echo '(variant { ok })'
  fi
  exit 0
fi
exit 1
`,
    { mode: 0o755 },
  );
  return {
    executable,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

test("missing icp-cli disables quote creation with an actionable error", async () => {
  const port = 18_787;
  const baseUrl = `http://127.0.0.1:${port}`;
  const { server, output } = startRelayer(port);

  try {
    const health = await waitForHealth(baseUrl, output);
    assert.equal(health.ready, false);
    assert.equal(health.backendConnected, false);
    assert.equal(health.backendErrorCode, "ICP_CLI_NOT_FOUND");

    const response = await fetch(`${baseUrl}/api/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.equal(payload.code, "ICP_CLI_NOT_FOUND");
    assert.match(payload.error, /ICP CLI executable is unavailable/);
  } finally {
    await stopRelayer(server);
  }
});

test("mock quotes can be canceled after owner authorization", async () => {
  const port = 18_789;
  const baseUrl = `http://127.0.0.1:${port}`;
  const fakeIcp = createFakeIcpCli();
  const { server, output } = startRelayer(port, {
    ICP_CLI: fakeIcp.executable,
    NEAR_1CLICK_BASE_URL: "http://127.0.0.1:1",
  });

  try {
    const health = await waitForHealth(baseUrl, output);
    assert.equal(health.ready, true);
    assert.equal(health.backendIdentityAuthorized, true);

    const quoteResponse = await fetch(`${baseUrl}/api/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        authorization: "quote-authorization",
        orderId: "987654321",
        originAsset: "nep141:wrap.near",
        refundTo: "refund.near",
        expectedSettlementAmount: "7500000",
        expectedAmountUsdCents: "750",
        destinationAsset:
          "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      }),
    });
    assert.equal(quoteResponse.status, 200);
    const quote = await quoteResponse.json();
    assert.equal(quote.status, "PENDING_DEPOSIT");

    const cancelResponse = await fetch(`${baseUrl}/api/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        authorization: "cancel-authorization",
        orderId: "987654321",
        depositAddress: quote.depositAddress,
      }),
    });
    const canceled = await cancelResponse.json();
    assert.equal(cancelResponse.status, 200);
    assert.deepEqual(canceled, { ok: true, status: "CANCELED" });

    const storedQuoteResponse = await fetch(
      `${baseUrl}/api/quote?depositAddress=${encodeURIComponent(quote.depositAddress)}`,
    );
    const storedQuote = await storedQuoteResponse.json();
    assert.equal(storedQuote.status, "CANCELED");

    const settleResponse = await fetch(`${baseUrl}/api/mock/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId: "987654321",
        depositAddress: quote.depositAddress,
      }),
    });
    assert.equal(settleResponse.status, 400);
  } finally {
    await stopRelayer(server);
    fakeIcp.cleanup();
  }
});

test("CORS normalizes configured origins and handles preflight requests", async () => {
  const port = 18_788;
  const baseUrl = `http://127.0.0.1:${port}`;
  const frontendOrigin =
    "https://5cg73-fqaaa-aaaah-qusea-cai.icp0.io";
  const { server, output } = startRelayer(port, {
    RELAYER_ALLOWED_ORIGIN: `${frontendOrigin}/`,
  });

  try {
    await waitForHealth(baseUrl, output);

    const health = await fetch(`${baseUrl}/health`, {
      headers: { Origin: frontendOrigin },
    });
    assert.equal(
      health.headers.get("access-control-allow-origin"),
      frontendOrigin,
    );

    const preflight = await fetch(`${baseUrl}/api/tokens`, {
      method: "OPTIONS",
      headers: {
        Origin: frontendOrigin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers.get("access-control-allow-origin"),
      frontendOrigin,
    );
    assert.match(
      preflight.headers.get("access-control-allow-methods") || "",
      /GET/,
    );

    const rejected = await fetch(`${baseUrl}/api/tokens`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://example.com",
        "Access-Control-Request-Method": "GET",
      },
    });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get("access-control-allow-origin"), null);
  } finally {
    await stopRelayer(server);
  }
});
