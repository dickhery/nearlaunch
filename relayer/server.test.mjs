import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

const port = 18_787;
const baseUrl = `http://127.0.0.1:${port}`;

async function waitForHealth(serverOutput) {
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

test("missing icp-cli disables quote creation with an actionable error", async () => {
  const server = spawn(process.execPath, ["relayer/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      RELAYER_PORT: String(port),
      RELAYER_MOCK: "true",
      ICP_RELAYER_PEM_PATH: "",
      ICP_RELAYER_IDENTITY: "test-relayer",
      ICP_CLI: "/definitely/missing/icp",
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

  try {
    const health = await waitForHealth(() => output);
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
    server.kill("SIGTERM");
  }
});
