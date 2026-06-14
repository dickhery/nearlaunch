import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
