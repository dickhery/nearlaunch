import { execFileSync } from "node:child_process";
import { defineConfig } from "vite";
import { icpBindgen } from "@icp-sdk/bindgen/plugins/vite";

const environment = process.env.ICP_ENVIRONMENT || "local";
const backendCanisters = ["launcher_backend", "launcher_factory"];

function runIcp(args: string[]): string {
  return execFileSync("icp", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function getCanisterId(name: string): string {
  return runIcp(["canister", "status", name, "-e", environment, "-i"]);
}

function getDevServerConfig() {
  const networkStatus = JSON.parse(
    runIcp(["network", "status", "-e", environment, "--json"]),
  ) as {
    api_url: string;
    root_key: string;
  };

  const canisterParams = backendCanisters
    .map((name) => `PUBLIC_CANISTER_ID:${name}=${getCanisterId(name)}`)
    .join("&");

  return {
    headers: {
      "Set-Cookie": `ic_env=${encodeURIComponent(
        `${canisterParams}&ic_root_key=${networkStatus.root_key}`,
      )}; SameSite=Lax;`,
    },
    proxy: {
      "/api": {
        target: networkStatus.api_url,
        changeOrigin: true,
      },
      "/relayer": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/relayer/, ""),
      },
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [
    icpBindgen({
      didFile: "./src/backend/launcher_backend.did",
      outDir: "./src/frontend/bindings",
    }),
    icpBindgen({
      didFile: "./src/factory/launcher_factory.did",
      outDir: "./src/frontend/bindings",
    }),
  ],
  build: {
    target: "es2022",
    sourcemap: true,
  },
  ...(command === "serve" ? { server: getDevServerConfig() } : {}),
}));
