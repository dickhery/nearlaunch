import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

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

if (!fs.existsSync(artifactPath)) {
  throw new Error(
    `Missing ${artifactPath}. Run "icp build launcher_frontend" first.`,
  );
}

const wasm = zlib.gunzipSync(fs.readFileSync(artifactPath));
fs.mkdirSync(path.dirname(wasmPath), { recursive: true });
fs.writeFileSync(wasmPath, wasm);
console.log(`Wrote asset canister Wasm (${wasm.length} bytes) to ${wasmPath}`);