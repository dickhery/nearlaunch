import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";

const rootDir = path.resolve(import.meta.dirname, "..");
const artifactPath = path.join(
  rootDir,
  ".icp",
  "cache",
  "artifacts",
  "launcher_frontend",
);
const wasmPath = path.join(
  rootDir,
  ".icp",
  "cache",
  "artifacts",
  "asset_canister.wasm",
);
const environment = process.env.ICP_ENVIRONMENT || "local";
const identity = process.env.ICP_DEPLOY_IDENTITY || "";
const icpCli = process.env.ICP_CLI || "icp";

function ensureAssetWasm() {
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      `Missing ${artifactPath}. Run "pnpm asset:extract" after "icp build launcher_frontend".`,
    );
  }

  const artifact = fs.readFileSync(artifactPath);
  const wasm = zlib.gunzipSync(artifact);
  fs.mkdirSync(path.dirname(wasmPath), { recursive: true });
  fs.writeFileSync(wasmPath, wasm);
  return wasm;
}

const wasm = fs.existsSync(wasmPath) ? fs.readFileSync(wasmPath) : ensureAssetWasm();
if (wasm.length > 1_900_000) {
  throw new Error("Asset canister Wasm exceeds the factory's 1.9 MB upload limit.");
}

const hash = crypto.createHash("sha256").update(wasm).digest();
const blob = (buffer) =>
  `blob "${Array.from(buffer, (byte) => `\\${byte.toString(16).padStart(2, "0")}`).join("")}"`;
const candid = `(${blob(wasm)}, ${blob(hash)})`;
const argsDir = path.join(rootDir, ".icp", "cache", "args");
fs.mkdirSync(argsDir, { recursive: true });
const argsPath = path.join(
  argsDir,
  `nearlaunch-asset-${crypto.randomUUID()}.candid`,
);
const argsFile = path.relative(rootDir, argsPath);

fs.writeFileSync(argsPath, candid);

const args = [
  "canister",
  "call",
  "launcher_factory",
  "uploadAssetCanisterWasm",
  "--args-file",
  argsFile,
  "-e",
  environment,
];
if (identity) args.push("--identity", identity);

try {
  const output = execFileSync(icpCli, args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 4 * 1024 * 1024,
  });
  process.stdout.write(output);
  console.log(`Uploaded asset canister Wasm (${wasm.length} bytes).`);
  console.log(`SHA-256: ${hash.toString("hex")}`);
} finally {
  fs.rmSync(argsPath, { force: true });
}