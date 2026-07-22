import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { Secp256k1KeyIdentity } from "@icp-sdk/core/identity/secp256k1";
import { Principal } from "@icp-sdk/core/principal";
import express from "express";
import { idlFactory as backendIdlFactory } from "../src/frontend/bindings/declarations/launcher_backend.did.js";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, "..");
const dataDir = path.join(import.meta.dirname, ".data");
const quoteStorePath = path.join(dataDir, "quotes.json");

function loadDotEnv() {
  const envPath = path.join(rootDir, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function normalizeAllowedOrigin(value) {
  const candidate = value.trim();
  if (candidate === "*") return candidate;

  const parsed = new URL(candidate);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(
      `RELAYER_ALLOWED_ORIGIN must use http or https: ${candidate}`,
    );
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname && parsed.pathname !== "/")
  ) {
    throw new Error(
      `RELAYER_ALLOWED_ORIGIN must contain origins only, without paths or credentials: ${candidate}`,
    );
  }
  return parsed.origin;
}

function parseAllowedOrigins(value) {
  const origins = value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map(normalizeAllowedOrigin);

  if (origins.length === 0) {
    throw new Error("RELAYER_ALLOWED_ORIGIN must contain at least one origin.");
  }
  if (origins.includes("*") && origins.length > 1) {
    throw new Error(
      'RELAYER_ALLOWED_ORIGIN cannot combine "*" with explicit origins.',
    );
  }
  return new Set(origins);
}

const METRICS_API_BASE =
  process.env.METRICS_API_BASE || "https://metrics-api.internetcomputer.org";
const ICP_PRICE_API =
  process.env.ICP_PRICE_API ||
  "https://api.coingecko.com/api/v3/simple/price?ids=internet-computer&vs_currencies=usd";
const CYCLES_RATE_SCALE = 10_000n;
const TRILLION_CYCLES = 1_000_000_000_000n;
const DEFAULT_USD_PER_TRILLION_CENTS = 100;
const cyclesRateCache = {
  usdPerTrillionCents: DEFAULT_USD_PER_TRILLION_CENTS,
  icpUsd: null,
  icpXdrRate: null,
  fetchedAt: 0,
  source: "default",
};

const config = {
  port: Number(process.env.RELAYER_PORT || 8787),
  mock: process.env.RELAYER_MOCK !== "false",
  allowedOrigins: parseAllowedOrigins(
    process.env.RELAYER_ALLOWED_ORIGIN || "*",
  ),
  oneClickBaseUrl:
    process.env.NEAR_1CLICK_BASE_URL || "https://1click.chaindefuser.com",
  apiKey: process.env.NEAR_1CLICK_API_KEY || "",
  jwt: process.env.NEAR_1CLICK_JWT || "",
  destinationAsset:
    process.env.SETTLEMENT_ASSET_ID ||
    "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  recipient: process.env.SETTLEMENT_RECIPIENT || "",
  recipientType: process.env.SETTLEMENT_RECIPIENT_TYPE || "DESTINATION_CHAIN",
  slippageBps: Number(process.env.SETTLEMENT_SLIPPAGE_BPS || 100),
  icpEnvironment: process.env.ICP_ENVIRONMENT || "local",
  icpIdentity: process.env.ICP_RELAYER_IDENTITY || "",
  icpCli: process.env.ICP_CLI || "icp",
  backendCanister: process.env.ICP_BACKEND_CANISTER || "launcher_backend",
  backendHost:
    process.env.ICP_API_HOST ||
    (process.env.ICP_ENVIRONMENT === "ic"
      ? "https://icp-api.io"
      : "http://127.0.0.1:8000"),
  backendIdentityPemPath: process.env.ICP_RELAYER_PEM_PATH || "",
};

fs.mkdirSync(dataDir, { recursive: true });

class RelayerError extends Error {
  constructor(message, status = 400, code = "RELAYER_ERROR", details) {
    super(message);
    this.name = "RelayerError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const backendRuntime = {
  mode: null,
  ready: false,
  principal: "",
  authorized: false,
  errorCode: "",
  error: "",
};
let backendActor = null;

function loadQuotes() {
  try {
    return JSON.parse(fs.readFileSync(quoteStorePath, "utf8"));
  } catch {
    return {};
  }
}

let quotes = loadQuotes();

function saveQuotes() {
  const temporaryPath = `${quoteStorePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(quotes, null, 2));
  fs.renameSync(temporaryPath, quoteStorePath);
}

function text(value, max = 300) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error("Invalid text field.");
  }
  return value;
}

function natural(value, max = 100_000_000_000n) {
  const input = text(String(value), 40);
  if (!/^[0-9]+$/.test(input)) throw new Error("Expected an unsigned integer.");
  const result = BigInt(input);
  if (result <= 0n || result > max) throw new Error("Amount is outside the allowed range.");
  return result;
}

function candidText(value) {
  return `"${String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")}"`;
}

async function execIcp(method, candidArgs, query = false) {
  const argsDir = path.join(rootDir, ".icp", "cache", "args");
  fs.mkdirSync(argsDir, { recursive: true });
  const argsPath = path.join(
    argsDir,
    `nearlaunch-${method}-${crypto.randomUUID()}.candid`,
  );
  const argsFile = path.relative(rootDir, argsPath);
  fs.writeFileSync(argsPath, candidArgs);

  const commandArgs = [
    "canister",
    "call",
    config.backendCanister,
    method,
    "--args-file",
    argsFile,
    "-e",
    config.icpEnvironment,
  ];
  if (query) commandArgs.push("--query");
  if (config.icpIdentity) {
    commandArgs.push("--identity", config.icpIdentity);
  }

  try {
    const { stdout, stderr } = await execFileAsync(config.icpCli, commandArgs, {
      cwd: rootDir,
      maxBuffer: 2 * 1024 * 1024,
    });
    const output = `${stdout}\n${stderr}`;
    if (/variant\s*\{\s*err/i.test(output) || /__kind__.*err/i.test(output)) {
      throw new Error(output.trim());
    }
    return stdout.trim();
  } finally {
    fs.rmSync(argsPath, { force: true });
  }
}

function unwrapBackendResult(result) {
  if (result && typeof result === "object" && "err" in result) {
    throw new Error(String(result.err));
  }
  return result?.ok;
}

async function callBackend(method, actorArgs, candidArgs) {
  if (!backendRuntime.ready) {
    throw new RelayerError(
      backendRuntime.error ||
        "The payment relayer is not connected to the ICP backend.",
      503,
      backendRuntime.errorCode || "ICP_BACKEND_UNAVAILABLE",
    );
  }

  if (backendActor) {
    const backendMethod = backendActor[method];
    if (typeof backendMethod !== "function") {
      throw new RelayerError(
        `ICP backend method ${method} is unavailable.`,
        503,
        "ICP_BACKEND_INTERFACE_ERROR",
      );
    }
    return unwrapBackendResult(await backendMethod(...actorArgs));
  }

  return execIcp(method, candidArgs);
}

function principalFromCliOutput(output, field) {
  return output.match(
    new RegExp(`${field}\\s*=\\s*principal\\s+"([^"]+)"`),
  )?.[1];
}

async function initializeBackendConnection() {
  try {
    if (config.backendIdentityPemPath) {
      if (!fs.existsSync(config.backendIdentityPemPath)) {
        throw new RelayerError(
          "ICP_RELAYER_PEM_PATH does not point to a readable identity file.",
          503,
          "ICP_IDENTITY_FILE_MISSING",
        );
      }

      const canisterId = Principal.fromText(config.backendCanister);
      const pem = fs.readFileSync(config.backendIdentityPemPath, "utf8");
      const identity = Secp256k1KeyIdentity.fromPem(pem);
      const agent = await HttpAgent.create({
        host: config.backendHost,
        identity,
        shouldFetchRootKey: config.icpEnvironment !== "ic",
        shouldSyncTime: true,
      });
      backendActor = Actor.createActor(backendIdlFactory, {
        agent,
        canisterId,
      });
      backendRuntime.mode = "agent";
      backendRuntime.principal = identity.getPrincipal().toText();

      const access = await backendActor.getAdminAccess();
      backendRuntime.authorized =
        access.settlementRelayer.toText() === backendRuntime.principal;
      if (!backendRuntime.authorized) {
        throw new RelayerError(
          `Relayer principal ${backendRuntime.principal} is not the settlement relayer configured on launcher_backend.`,
          503,
          "ICP_RELAYER_NOT_AUTHORIZED",
        );
      }
    } else {
      backendRuntime.mode = "cli";
      if (!config.icpIdentity) {
        throw new RelayerError(
          "Configure ICP_RELAYER_PEM_PATH for the production agent, or ICP_RELAYER_IDENTITY for CLI mode.",
          503,
          "ICP_IDENTITY_NOT_CONFIGURED",
        );
      }

      try {
        await execFileAsync(config.icpCli, ["--version"], {
          cwd: rootDir,
          maxBuffer: 256 * 1024,
        });
      } catch (error) {
        if (error?.code === "ENOENT") {
          throw new RelayerError(
            "The ICP CLI executable is unavailable. Set ICP_CLI to its absolute path or configure ICP_RELAYER_PEM_PATH.",
            503,
            "ICP_CLI_NOT_FOUND",
          );
        }
        throw error;
      }

      const { stdout } = await execFileAsync(
        config.icpCli,
        ["identity", "principal", "--identity", config.icpIdentity],
        { cwd: rootDir, maxBuffer: 256 * 1024 },
      );
      backendRuntime.principal = stdout.trim();
      const accessOutput = await execIcp("getAdminAccess", "()", true);
      const configuredRelayer = principalFromCliOutput(
        accessOutput,
        "settlementRelayer",
      );
      const caller = principalFromCliOutput(accessOutput, "caller");
      backendRuntime.authorized =
        caller === backendRuntime.principal &&
        configuredRelayer === backendRuntime.principal;
      if (!backendRuntime.authorized) {
        throw new RelayerError(
          `Relayer principal ${backendRuntime.principal} is not the settlement relayer configured on launcher_backend.`,
          503,
          "ICP_RELAYER_NOT_AUTHORIZED",
        );
      }
    }

    backendRuntime.ready = true;
  } catch (error) {
    backendRuntime.ready = false;
    backendRuntime.errorCode =
      error instanceof RelayerError
        ? error.code
        : "ICP_BACKEND_CONNECTION_FAILED";
    backendRuntime.error =
      error instanceof Error
        ? error.message
        : "Could not connect to launcher_backend.";
  }
}

function oneClickHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (config.apiKey) {
    headers["X-API-Key"] = config.apiKey;
  } else if (config.jwt) {
    headers.Authorization = `Bearer ${config.jwt}`;
  }
  return headers;
}

async function oneClickFetch(urlPath, options = {}) {
  const response = await fetch(`${config.oneClickBaseUrl}${urlPath}`, {
    ...options,
    headers: {
      ...oneClickHeaders(),
      ...(options.headers || {}),
    },
  });
  const responseText = await response.text();
  let payload = {};
  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    payload = { message: responseText };
  }
  if (!response.ok) {
    const upstreamMessage =
      payload.message ||
      payload.error ||
      `1Click request failed with ${response.status}.`;
    throw new RelayerError(
      `NEAR 1Click rejected the request: ${upstreamMessage}`,
      response.status === 400 ? 400 : 503,
      response.status === 400
        ? "NEAR_QUOTE_REJECTED"
        : "NEAR_1CLICK_UNAVAILABLE",
      payload,
    );
  }
  return payload;
}

async function fetchTokens() {
  return oneClickFetch("/v0/tokens", { method: "GET" });
}

function latestMetricSample(series) {
  if (!Array.isArray(series) || series.length === 0) return null;
  const sample = series[series.length - 1];
  if (!Array.isArray(sample) || sample.length < 2) return null;
  const value = BigInt(sample[1]);
  if (value <= 0n) return null;
  return value;
}

function computeUsdPerTrillionCents(icpXdrRate, icpUsd) {
  if (icpXdrRate <= 0n || icpUsd <= 0) return DEFAULT_USD_PER_TRILLION_CENTS;
  const icpPerTrillionScaled =
    (TRILLION_CYCLES * CYCLES_RATE_SCALE) / icpXdrRate;
  const usdPerTrillionScaled = Math.round(
    (Number(icpPerTrillionScaled) / Number(CYCLES_RATE_SCALE)) * icpUsd * 100,
  );
  if (
    !Number.isFinite(usdPerTrillionScaled) ||
    usdPerTrillionScaled <= 0 ||
    usdPerTrillionScaled > 1_000_000
  ) {
    return DEFAULT_USD_PER_TRILLION_CENTS;
  }
  return usdPerTrillionScaled;
}

async function fetchMarketCyclesRate(forceRefresh = false) {
  const maxAgeMs = 15 * 60_000;
  if (
    !forceRefresh &&
    cyclesRateCache.fetchedAt > 0 &&
    Date.now() - cyclesRateCache.fetchedAt < maxAgeMs
  ) {
    return cyclesRateCache;
  }

  let icpXdrRate = cyclesRateCache.icpXdrRate;
  let icpUsd = cyclesRateCache.icpUsd;
  let source = "cache";

  try {
    const response = await fetch(
      `${METRICS_API_BASE}/api/v1/icp-xdr-conversion-rates`,
    );
    if (response.ok) {
      const payload = await response.json();
      icpXdrRate = latestMetricSample(payload.icp_xdr_conversion_rates);
      source = "metrics-api";
    }
  } catch {
    // Keep the previous conversion rate when the metrics API is unavailable.
  }

  try {
    const response = await fetch(ICP_PRICE_API);
    if (response.ok) {
      const payload = await response.json();
      const nextPrice = payload?.["internet-computer"]?.usd;
      if (typeof nextPrice === "number" && nextPrice > 0) {
        icpUsd = nextPrice;
        source = source === "metrics-api" ? "metrics-api+coingecko" : "coingecko";
      }
    }
  } catch {
    // Keep the previous ICP price when the price API is unavailable.
  }

  const usdPerTrillionCents =
    icpXdrRate && icpUsd
      ? computeUsdPerTrillionCents(icpXdrRate, icpUsd)
      : cyclesRateCache.usdPerTrillionCents;

  cyclesRateCache.usdPerTrillionCents = usdPerTrillionCents;
  cyclesRateCache.icpUsd = icpUsd;
  cyclesRateCache.icpXdrRate =
    icpXdrRate === null || icpXdrRate === undefined
      ? null
      : icpXdrRate.toString();
  cyclesRateCache.fetchedAt = Date.now();
  cyclesRateCache.source = source;
  return cyclesRateCache;
}

async function syncMarketCyclesRate(forceRefresh = false) {
  const rate = await fetchMarketCyclesRate(forceRefresh);
  if (!backendRuntime.ready) return rate;

  try {
    await callBackend(
      "setUsdPerTrillionCents",
      [BigInt(rate.usdPerTrillionCents)],
      `(${rate.usdPerTrillionCents})`,
    );
    rate.syncedToBackend = true;
  } catch (error) {
    rate.syncedToBackend = false;
    rate.syncError =
      error instanceof Error ? error.message : "Could not update backend rate.";
  }
  return rate;
}

function fallbackTokens() {
  return [
    {
      assetId: "nep141:wrap.near",
      decimals: 24,
      blockchain: "near",
      symbol: "wNEAR",
      price: 0,
    },
    {
      assetId:
        "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      decimals: 6,
      blockchain: "near",
      symbol: "USDC",
      price: 1,
    },
    {
      assetId:
        "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
      decimals: 6,
      blockchain: "eth",
      symbol: "USDC",
      price: 1,
    },
    {
      assetId:
        "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
      decimals: 6,
      blockchain: "sol",
      symbol: "USDC",
      price: 1,
    },
  ];
}

function publicQuote(record) {
  return {
    mock: record.mock,
    orderId: record.orderId,
    quoteId: record.quoteId,
    depositAddress: record.depositAddress,
    ...(record.depositMemo ? { depositMemo: record.depositMemo } : {}),
    amountIn: record.amountIn,
    amountInFormatted: record.amountInFormatted,
    originAsset: record.originAsset,
    originSymbol: record.originSymbol,
    amountOut: record.amountOut,
    destinationAsset: record.destinationAsset,
    deadline: record.deadline,
    status: record.status,
    settled: record.settled,
    ...(record.txHash ? { txHash: record.txHash } : {}),
  };
}

async function registerQuote(record, authorization) {
  await callBackend(
    "registerAuthorizedPaymentQuote",
    [
      BigInt(record.orderId),
      authorization,
      record.quoteId,
      record.depositAddress,
    ],
    `(${record.orderId}, ${candidText(authorization)}, ${candidText(record.quoteId)}, ${candidText(record.depositAddress)})`,
  );
}

async function settleQuote(record, statusPayload) {
  if (record.canceled) {
    throw new Error("Canceled quotes cannot be settled.");
  }
  if (record.settled) return;

  const amountOut = natural(
    statusPayload?.swapDetails?.amountOut ||
      statusPayload?.quoteResponse?.quote?.amountOut ||
      record.amountOut,
  );
  const destinationTx =
    statusPayload?.swapDetails?.destinationChainTxHashes?.[0]?.hash ||
    statusPayload?.swapDetails?.nearTxHashes?.[0] ||
    statusPayload?.swapDetails?.originChainTxHashes?.[0]?.hash ||
    `1click:${record.quoteId}`;
  const proofId = `1click:${record.quoteId}:${record.depositAddress}`;

  await callBackend(
    "markPaymentSettled",
    [
      BigInt(record.orderId),
      {
        quoteId: record.quoteId,
        depositAddress: record.depositAddress,
        txHash: destinationTx,
        proofId,
        assetId: record.destinationAsset,
        amountOut,
      },
    ],
    `(${record.orderId}, record {
      quoteId = ${candidText(record.quoteId)};
      depositAddress = ${candidText(record.depositAddress)};
      txHash = ${candidText(destinationTx)};
      proofId = ${candidText(proofId)};
      assetId = ${candidText(record.destinationAsset)};
      amountOut = ${amountOut.toString()};
    })`,
  );

  record.settled = true;
  record.settledAt = new Date().toISOString();
  record.status = "SUCCESS";
  record.txHash = destinationTx;
  saveQuotes();
}

async function markRefund(record, reason) {
  if (record.canceled) {
    throw new Error("Canceled quotes cannot be marked for refund.");
  }
  if (record.refundRecorded) return;
  await callBackend(
    "markRefundRequired",
    [BigInt(record.orderId), reason],
    `(${record.orderId}, ${candidText(reason)})`,
  );
  record.refundRecorded = true;
  record.status = "REFUNDED";
  saveQuotes();
}

async function refreshQuoteStatus(record) {
  if (record.canceled) {
    return {
      status: "CANCELED",
      depositAddress: record.depositAddress,
      canceled: true,
    };
  }
  if (record.mock) {
    return {
      status: record.status,
      depositAddress: record.depositAddress,
      settled: record.settled,
    };
  }

  const query = new URLSearchParams({
    depositAddress: record.depositAddress,
  });
  if (record.depositMemo) query.set("depositMemo", record.depositMemo);

  const payload = await oneClickFetch(`/v0/status?${query.toString()}`, {
    method: "GET",
  });
  record.status = payload.status;
  record.lastStatus = payload;
  saveQuotes();

  if (payload.status === "SUCCESS") {
    await settleQuote(record, payload);
  } else if (payload.status === "REFUNDED") {
    await markRefund(
      record,
      payload.swapDetails?.refundReason || "1Click refunded the deposit.",
    );
  }

  return payload;
}

function cancellationBlockReason(record, status) {
  if (status !== "PENDING_DEPOSIT") {
    return `This order cannot be canceled because its payment status is ${status}.`;
  }
  if (record.mock) return "";

  const deadline = Date.parse(record.deadline);
  if (!Number.isFinite(deadline)) {
    return "This quote is missing a valid deadline and cannot be canceled automatically.";
  }
  if (Date.now() < deadline) {
    return `This payment quote remains active until ${new Date(deadline).toISOString()}. For safety, cancel it after the quote expires.`;
  }
  return "";
}

async function cancelQuote(record, authorization) {
  await callBackend(
    "cancelAuthorizedDeploymentOrder",
    [BigInt(record.orderId), authorization, record.depositAddress],
    `(${record.orderId}, ${candidText(authorization)}, ${candidText(record.depositAddress)})`,
  );
  record.canceled = true;
  record.canceledAt = new Date().toISOString();
  record.status = "CANCELED";
  saveQuotes();
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

app.use((request, response, next) => {
  const requestOrigin = request.headers.origin;
  let normalizedRequestOrigin = null;
  if (requestOrigin) {
    try {
      normalizedRequestOrigin = normalizeAllowedOrigin(requestOrigin);
    } catch {
      normalizedRequestOrigin = null;
    }
  }

  const wildcardAllowed = config.allowedOrigins.has("*");
  const originAllowed =
    wildcardAllowed ||
    (normalizedRequestOrigin !== null &&
      config.allowedOrigins.has(normalizedRequestOrigin));

  response.vary("Origin");
  if (originAllowed) {
    response.setHeader(
      "Access-Control-Allow-Origin",
      wildcardAllowed ? "*" : normalizedRequestOrigin,
    );
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    response.setHeader("Access-Control-Max-Age", "600");
  }
  if (request.method === "OPTIONS") {
    if (requestOrigin && !originAllowed) {
      return response.status(403).json({ error: "Origin is not allowed." });
    }
    return response.sendStatus(204);
  }
  next();
});

const requestBuckets = new Map();
app.use((request, response, next) => {
  const key = request.ip || "unknown";
  const now = Date.now();
  const current = requestBuckets.get(key);
  if (!current || now - current.startedAt > 60_000) {
    requestBuckets.set(key, { startedAt: now, count: 1 });
    return next();
  }
  current.count += 1;
  if (current.count > 60) {
    return response.status(429).json({ error: "Rate limit exceeded." });
  }
  next();
});

app.get("/health", (_request, response) => {
  const recipientConfigured = Boolean(config.recipient);
  const partnerAuthConfigured = Boolean(config.apiKey || config.jwt);
  const backendIdentityConfigured = Boolean(
    config.backendIdentityPemPath || config.icpIdentity,
  );
  response.json({
    ok: true,
    mode: config.mock ? "mock" : "live",
    ready:
      backendRuntime.ready &&
      (config.mock || (recipientConfigured && partnerAuthConfigured)),
    destinationAsset: config.destinationAsset,
    // Treasury destination for 1Click EXACT_OUTPUT settlements. Exposed so the
    // admin UI can show where platform revenue lands without re-opening .env.
    settlementRecipient: config.recipient || undefined,
    settlementRecipientType: config.recipient
      ? config.recipientType
      : undefined,
    icpEnvironment: config.icpEnvironment,
    recipientConfigured,
    partnerAuthConfigured,
    backendIdentityConfigured,
    backendConnectionMode: backendRuntime.mode,
    backendConnected: backendRuntime.ready,
    backendIdentityAuthorized: backendRuntime.authorized,
    backendPrincipal: backendRuntime.principal || undefined,
    backendErrorCode: backendRuntime.errorCode || undefined,
    backendError: backendRuntime.error || undefined,
  });
});

app.get("/api/cycles-rate", async (request, response) => {
  try {
    const forceRefresh = request.query.refresh === "true";
    const rate = await syncMarketCyclesRate(forceRefresh);
    response.json({
      usdPerTrillionCents: rate.usdPerTrillionCents,
      icpUsd: rate.icpUsd,
      icpXdrRate: rate.icpXdrRate,
      source: rate.source,
      fetchedAt: rate.fetchedAt,
      syncedToBackend: rate.syncedToBackend ?? false,
      ...(rate.syncError ? { syncError: rate.syncError } : {}),
    });
  } catch (error) {
    response.status(503).json({
      error: error instanceof Error ? error.message : String(error),
      usdPerTrillionCents: cyclesRateCache.usdPerTrillionCents,
    });
  }
});

app.get("/api/tokens", async (_request, response) => {
  try {
    const tokenList = await fetchTokens();
    response.json({ tokens: tokenList });
  } catch (error) {
    response.json({
      tokens: fallbackTokens(),
      warning: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/api/quote", (request, response) => {
  try {
    const depositAddress = text(request.query.depositAddress, 240);
    const record = quotes[depositAddress];
    if (!record) throw new Error("Quote not found.");
    response.json(publicQuote(record));
  } catch (error) {
    response.status(404).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/api/quote", async (request, response) => {
  try {
    if (!backendRuntime.ready) {
      throw new RelayerError(
        backendRuntime.error ||
          "The payment relayer is not connected to launcher_backend.",
        503,
        backendRuntime.errorCode || "ICP_BACKEND_UNAVAILABLE",
      );
    }

    const orderId = natural(request.body.orderId, 9_999_999_999n).toString();
    const authorization = text(request.body.authorization, 240);
    const expectedSettlementAmount = natural(
      request.body.expectedSettlementAmount,
    );
    const expectedAmountUsdCents = natural(
      request.body.expectedAmountUsdCents,
      10_000_000n,
    );
    const originAsset = text(request.body.originAsset);
    const refundTo = text(request.body.refundTo, 240);
    const requestedDestination = text(request.body.destinationAsset);

    if (requestedDestination !== config.destinationAsset) {
      throw new Error("Order settlement asset does not match the relayer configuration.");
    }

    let tokenList = fallbackTokens();
    try {
      tokenList = await fetchTokens();
    } catch {
      // Mock mode and offline development use the fallback metadata.
    }
    const originToken = tokenList.find((token) => token.assetId === originAsset);
    if (!originToken) {
      throw new RelayerError(
        "The selected source token is no longer supported by NEAR 1Click.",
        400,
        "ORIGIN_ASSET_UNSUPPORTED",
      );
    }
    if (!tokenList.some((token) => token.assetId === config.destinationAsset)) {
      throw new RelayerError(
        "The configured settlement token is not currently supported by NEAR 1Click.",
        503,
        "DESTINATION_ASSET_UNSUPPORTED",
      );
    }
    const originSymbol = originToken.symbol || "TOKEN";
    const quoteId = `nearlaunch-${orderId}-${crypto.randomUUID()}`;
    const deadline = new Date(Date.now() + 90 * 60_000).toISOString();

    if (config.mock) {
      const depositAddress = `mock:${orderId}:${crypto.randomBytes(8).toString("hex")}`;
      const record = {
        mock: true,
        orderId,
        quoteId,
        depositAddress,
        amountIn: expectedSettlementAmount.toString(),
        amountInFormatted: (Number(expectedAmountUsdCents) / 100).toFixed(2),
        originAsset,
        originSymbol,
        amountOut: expectedSettlementAmount.toString(),
        destinationAsset: config.destinationAsset,
        deadline,
        status: "PENDING_DEPOSIT",
        settled: false,
        createdAt: new Date().toISOString(),
      };
      await registerQuote(record, authorization);
      quotes[depositAddress] = record;
      saveQuotes();
      return response.json(publicQuote(record));
    }

    if (!config.recipient) {
      throw new Error("SETTLEMENT_RECIPIENT is required in live mode.");
    }

    const quoteResponse = await oneClickFetch("/v0/quote", {
      method: "POST",
      body: JSON.stringify({
        dry: false,
        depositMode: "SIMPLE",
        swapType: "EXACT_OUTPUT",
        slippageTolerance: config.slippageBps,
        originAsset,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: config.destinationAsset,
        amount: expectedSettlementAmount.toString(),
        refundTo,
        refundType: "ORIGIN_CHAIN",
        recipient: config.recipient,
        recipientType: config.recipientType,
        deadline,
        sessionId: `nearlaunch-order-${orderId}`,
        referral: "nearlaunch-icp",
      }),
    });

    const quote = quoteResponse.quote;
    const record = {
      mock: false,
      orderId,
      quoteId: quoteResponse.correlationId,
      depositAddress: quote.depositAddress,
      depositMemo: quote.depositMemo,
      amountIn: quote.amountIn,
      amountInFormatted: quote.amountInFormatted,
      originAsset,
      originSymbol,
      amountOut: quote.amountOut,
      destinationAsset: config.destinationAsset,
      deadline: quote.deadline || deadline,
      status: "PENDING_DEPOSIT",
      settled: false,
      quoteResponse,
      createdAt: new Date().toISOString(),
    };

    await registerQuote(record, authorization);
    quotes[record.depositAddress] = record;
    saveQuotes();
    response.json(publicQuote(record));
  } catch (error) {
    response
      .status(error instanceof RelayerError ? error.status : 400)
      .json({
        error: error instanceof Error ? error.message : String(error),
        code:
          error instanceof RelayerError
            ? error.code
            : "QUOTE_REQUEST_FAILED",
        ...(error instanceof RelayerError && error.details
          ? { details: error.details }
          : {}),
      });
  }
});

app.post("/api/deposit/submit", async (request, response) => {
  try {
    const depositAddress = text(request.body.depositAddress, 240);
    const txHash = text(request.body.txHash, 240);
    const record = quotes[depositAddress];
    if (!record) throw new Error("Unknown deposit address.");
    if (record.canceled) throw new Error("This payment quote was canceled.");
    if (record.mock) throw new Error("Deposit submission is disabled in mock mode.");

    const payload = await oneClickFetch("/v0/deposit/submit", {
      method: "POST",
      body: JSON.stringify({ depositAddress, txHash }),
    });
    record.submittedTxHash = txHash;
    saveQuotes();
    response.json(payload);
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/api/status", async (request, response) => {
  try {
    const depositAddress = text(request.query.depositAddress, 240);
    const record = quotes[depositAddress];
    if (!record) throw new Error("Unknown deposit address.");
    response.json(await refreshQuoteStatus(record));
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/api/cancel", async (request, response) => {
  try {
    const orderId = natural(request.body.orderId, 9_999_999_999n).toString();
    const depositAddress = text(request.body.depositAddress, 240);
    const authorization = text(request.body.authorization, 240);
    const record = quotes[depositAddress];
    if (!record || record.orderId !== orderId) {
      throw new RelayerError(
        "The payment quote does not match this order.",
        404,
        "QUOTE_NOT_FOUND",
      );
    }
    if (record.canceled) {
      return response.json({ ok: true, status: "CANCELED" });
    }
    if (record.settled) {
      throw new RelayerError(
        "This order already has a successful payment.",
        409,
        "ORDER_CANCELLATION_BLOCKED",
      );
    }

    const statusPayload = await refreshQuoteStatus(record);
    const blockReason = cancellationBlockReason(record, statusPayload.status);
    if (blockReason) {
      throw new RelayerError(
        blockReason,
        409,
        "ORDER_CANCELLATION_BLOCKED",
        {
          status: statusPayload.status,
          deadline: record.deadline,
        },
      );
    }

    await cancelQuote(record, authorization);
    response.json({ ok: true, status: "CANCELED" });
  } catch (error) {
    response
      .status(error instanceof RelayerError ? error.status : 400)
      .json({
        error: error instanceof Error ? error.message : String(error),
        code:
          error instanceof RelayerError
            ? error.code
            : "ORDER_CANCELLATION_FAILED",
        ...(error instanceof RelayerError && error.details
          ? { details: error.details }
          : {}),
      });
  }
});

app.post("/api/mock/settle", async (request, response) => {
  try {
    if (!config.mock) throw new Error("Mock settlement is disabled.");
    const orderId = natural(request.body.orderId, 9_999_999_999n).toString();
    const depositAddress = text(request.body.depositAddress, 240);
    const record = quotes[depositAddress];
    if (!record || !record.mock || record.orderId !== orderId) {
      throw new Error("Mock quote not found.");
    }
    if (record.canceled) throw new Error("This payment quote was canceled.");

    await settleQuote(record, {
      swapDetails: {
        amountOut: record.amountOut,
        nearTxHashes: [`mock-tx-${crypto.randomUUID()}`],
      },
    });
    response.json({ ok: true, status: record.status });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

await initializeBackendConnection();
void syncMarketCyclesRate(true);

const server = app.listen(config.port, "127.0.0.1", () => {
  console.log(
    `NearLaunch relayer listening on http://127.0.0.1:${config.port} (${config.mock ? "mock" : "live"} mode)`,
  );
  if (!backendRuntime.ready) {
    console.error(
      `ICP backend unavailable [${backendRuntime.errorCode}]: ${backendRuntime.error}`,
    );
  }
});

server.on("error", (error) => {
  console.error(`Relayer server failed: ${error.message}`);
  process.exitCode = 1;
});
