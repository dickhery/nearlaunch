import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const icpCli = process.env.ICP_CLI || "icp";
let deployIdentity = process.env.ICP_DEPLOY_IDENTITY || "nearlaunch-local";
const relayerIdentity = process.env.ICP_RELAYER_IDENTITY || deployIdentity;
process.env.VITE_RELAYER_URL ||= "http://127.0.0.1:8787";

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(" ")}`);
  return execFileSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
}

try {
  run(
    icpCli,
    ["identity", "principal", "--identity", deployIdentity],
    { capture: true },
  );
} catch {
  run(icpCli, [
    "identity",
    "new",
    deployIdentity,
    "--storage",
    "plaintext",
    "--quiet",
  ]);
}

process.env.ICP_DEPLOY_IDENTITY = deployIdentity;
process.env.ICP_RELAYER_IDENTITY = relayerIdentity;

try {
  run(icpCli, ["network", "status", "--json"], { capture: true });
} catch {
  run(icpCli, ["network", "start", "-d"]);
}

const cycleBalance = run(
  icpCli,
  ["cycles", "balance", "--identity", deployIdentity, "--quiet"],
  { capture: true },
).trim();
const cycleDigits = cycleBalance.match(/[0-9]+/)?.[0] || "0";
if (BigInt(cycleDigits) === 0n) {
  const localMappings = path.join(
    rootDir,
    ".icp",
    "data",
    "mappings",
    "local.ids.json",
  );
  if (fs.existsSync(localMappings)) {
    throw new Error(
      `Identity ${deployIdentity} has no local cycles. Fund it before rerunning bootstrap.`,
    );
  }
  console.log("Fresh project identity has no cycles; restarting the empty network to seed it.");
  run(icpCli, ["network", "stop"]);
  run(icpCli, ["network", "start", "-d"]);
}

const deployArgs = ["deploy"];
deployArgs.push("--identity", deployIdentity);
run(icpCli, deployArgs);

const factoryBalanceOutput = run(
  icpCli,
  [
    "canister",
    "call",
    "launcher_factory",
    "getCycleBalance",
    "()",
    "-e",
    "local",
    "--identity",
    deployIdentity,
    "--query",
  ],
  { capture: true },
);
const factoryBalance = BigInt(
  factoryBalanceOutput.match(/[0-9][0-9_]*/)?.[0].replaceAll("_", "") || "0",
);
const localFactoryTarget = 20_000_000_000_000n;
if (factoryBalance < localFactoryTarget) {
  run(icpCli, [
    "canister",
    "top-up",
    "launcher_factory",
    "--amount",
    (localFactoryTarget - factoryBalance).toString(),
    "-e",
    "local",
    "--identity",
    deployIdentity,
  ]);
}

run("mops", ["build", "app_template"]);
run("node", ["scripts/upload-template-wasm.mjs"]);
run(icpCli, ["build", "launcher_frontend"]);
run("node", ["scripts/upload-asset-wasm.mjs"]);

if (relayerIdentity !== deployIdentity) {
  const principal = run(
    icpCli,
    ["identity", "principal", "--identity", relayerIdentity],
    { capture: true },
  ).trim();
  const args = [
    "canister",
    "call",
    "launcher_backend",
    "setSettlementRelayer",
    `(principal "${principal}")`,
  ];
  args.push("--identity", deployIdentity);
  run(icpCli, args);
}

const frontendId = run(
  icpCli,
  ["canister", "status", "launcher_frontend", "-e", "local", "-i"],
  { capture: true },
).trim();
const networkStatus = JSON.parse(
  run(icpCli, ["network", "status", "--json"], { capture: true }),
);
const gatewayUrl = String(networkStatus.gateway_url).replace(/\/$/, "");

console.log("");
console.log("Local launcher is ready.");
console.log(`Frontend: ${gatewayUrl.replace("://", `://${frontendId}.`)}`);
console.log("Relayer:  pnpm relayer");
