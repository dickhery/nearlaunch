import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const rootDir = path.resolve(import.meta.dirname, "..");
const wasmPath = path.join(rootDir, ".mops", ".build", "app_template.wasm");
const environment = process.env.ICP_ENVIRONMENT || "local";
const identity = process.env.ICP_DEPLOY_IDENTITY || "";
const icpCli = process.env.ICP_CLI || "icp";

if (!fs.existsSync(wasmPath)) {
  throw new Error(
    `Missing ${wasmPath}. Run "pnpm template:build" before uploading.`,
  );
}

const wasm = fs.readFileSync(wasmPath);
if (wasm.length > 1_900_000) {
  throw new Error("Template Wasm exceeds the factory's 1.9 MB upload limit.");
}

const hash = crypto.createHash("sha256").update(wasm).digest();
const blob = (buffer) =>
  `blob "${Array.from(buffer, (byte) => `\\${byte.toString(16).padStart(2, "0")}`).join("")}"`;
const candid = `(${blob(wasm)}, ${blob(hash)})`;
const argsDir = path.join(rootDir, ".icp", "cache", "args");
fs.mkdirSync(argsDir, { recursive: true });
const argsPath = path.join(
  argsDir,
  `nearlaunch-template-${crypto.randomUUID()}.candid`,
);
const argsFile = path.relative(rootDir, argsPath);

fs.writeFileSync(argsPath, candid);

const args = [
  "canister",
  "call",
  "launcher_factory",
  "uploadTemplateWasm",
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
  console.log(`Uploaded app template Wasm (${wasm.length} bytes).`);
  console.log(`SHA-256: ${hash.toString("hex")}`);
} finally {
  fs.rmSync(argsPath, { force: true });
}
