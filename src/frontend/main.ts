import { AuthClient } from "@icp-sdk/auth/client";
import { safeGetCanisterEnv } from "@icp-sdk/core/agent/canister-env";
import { Principal } from "@icp-sdk/core/principal";
import {
  createActor,
  type AdminAccess,
  type DeploymentOrder,
  DeploymentStatus,
  type PricingBreakdown,
  type PublicConfig,
  type ResultOrder,
  type ResultText,
  type ResultUnit,
  type Template,
} from "./bindings/launcher_backend";
import {
  createActor as createFactoryActor,
  type FactoryReadiness,
} from "./bindings/launcher_factory";
import {
  appPreviewDocument,
  type AppPreviewConfig,
  type AppPreviewLink,
  type AppPreviewProject,
} from "./appPreview";
import "./styles.css";

type LauncherActor = ReturnType<typeof createActor>;
type FactoryActor = ReturnType<typeof createFactoryActor>;

type QuoteView = {
  mock: boolean;
  orderId: string;
  quoteId: string;
  depositAddress: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  originAsset: string;
  originSymbol: string;
  amountOut: string;
  destinationAsset: string;
  deadline: string;
  status: string;
  settled?: boolean;
  txHash?: string;
};

type Token = {
  assetId: string;
  blockchain: string;
  symbol: string;
  decimals: number;
  price: number;
};

type RelayerHealth = {
  ok: boolean;
  mode: "mock" | "live";
  ready?: boolean;
  destinationAsset: string;
  icpEnvironment: string;
  recipientConfigured?: boolean;
  partnerAuthConfigured?: boolean;
  backendIdentityConfigured?: boolean;
  backendConnectionMode?: "agent" | "cli";
  backendConnected?: boolean;
  backendIdentityAuthorized?: boolean;
  backendPrincipal?: string;
  backendErrorCode?: string;
  backendError?: string;
};

const app = document.querySelector<HTMLDivElement>("#app") as HTMLDivElement;
const isLocalFrontend =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1" ||
  window.location.hostname.endsWith(".localhost");
const RELAYER_URL =
  import.meta.env.VITE_RELAYER_URL ||
  (isLocalFrontend
    ? "http://127.0.0.1:8787"
    : "https://relayer.richardhery.com");
const canisterEnv = safeGetCanisterEnv();
const backendCanisterId = canisterEnv?.["PUBLIC_CANISTER_ID:launcher_backend"];
const factoryCanisterId = canisterEnv?.["PUBLIC_CANISTER_ID:launcher_factory"];
const MIN_CHILD_CYCLES = 1_000_000_000_000n;
const MAX_INLINE_IMAGE_LENGTH = 450_000;
const MAX_IMAGE_SOURCE_BYTES = 8_000_000;
const MAX_IMAGE_WIDTH = 1600;
const MAX_IMAGE_HEIGHT = 1000;

const authClient = new AuthClient({
  identityProvider: "https://id.ai/authorize",
});

let actor: LauncherActor | null = null;
let factoryActor: FactoryActor | null = null;
let signedIn = false;
let principal = "";
let templates: Template[] = [];
let orders: DeploymentOrder[] = [];
let selectedTemplate = "portfolio";
let selectedFundingMonths = 3;
let currentOrder: DeploymentOrder | null = null;
let currentQuote: QuoteView | null = null;
let tokens: Token[] = [];
let stats = { totalOrders: 0n, liveApps: 0n, templates: 0n };
let publicConfig: PublicConfig | null = null;
let adminAccess: AdminAccess | null = null;
let admins: Principal[] = [];
let factoryReadiness: FactoryReadiness | null = null;
let relayerHealth: RelayerHealth | null = null;
let notice = "";
let paymentError = "";
let busy = false;
let busyMessage = "";
let draftConfig: AppPreviewConfig = {
  name: "Open Horizon Studio",
  headline: "Designing useful systems for ambitious teams.",
  description:
    "A portfolio for selected work, collaborations, and the practical craft behind each launch.",
  accentColor: "#2fbf8f",
  primaryLink: "https://example.com",
  contact: "hello@example.com",
  about:
    "I work across product strategy, interface design, and resilient web systems. This portfolio is editable by its owner after deployment.",
  heroImageUrl: "",
  resumeUrl: "https://example.com/resume.pdf",
  skills: ["Product strategy", "Frontend systems", "ICP canisters"],
  socialLinks: [
    { labelText: "GitHub", url: "https://github.com/example" },
    { labelText: "LinkedIn", url: "https://linkedin.com" },
  ],
  projects: [
    {
      title: "Launch Console",
      description:
        "A deployment workflow that turns a signed intent into a live Internet Computer app.",
      url: "https://example.com/project",
      imageUrl: "",
      tags: ["ICP", "NEAR", "TypeScript"],
    },
  ],
};

function createLauncherActor(
  identity?: Awaited<ReturnType<typeof authClient.getIdentity>>,
): LauncherActor {
  if (!backendCanisterId) {
    throw new Error(
      "launcher_backend canister ID is unavailable. Deploy the backend before starting the frontend.",
    );
  }

  return createActor(backendCanisterId, {
    agentOptions: {
      identity,
      host: window.location.origin,
      rootKey: canisterEnv?.IC_ROOT_KEY,
    },
  });
}

function createLauncherFactoryActor(
  identity?: Awaited<ReturnType<typeof authClient.getIdentity>>,
): FactoryActor {
  if (!factoryCanisterId) {
    throw new Error(
      "launcher_factory canister ID is unavailable. Deploy the factory before starting the frontend.",
    );
  }

  return createFactoryActor(factoryCanisterId, {
    agentOptions: {
      identity,
      host: window.location.origin,
      rootKey: canisterEnv?.IC_ROOT_KEY,
    },
  });
}

function money(cents: bigint): string {
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

function cycles(value: bigint): string {
  return `${units(value, 12, 3)}T`;
}

function units(value: bigint, decimals: number, fractionDigits = 6): string {
  if (decimals === 0) return value.toString();
  const padded = value.toString().padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded
    .slice(-decimals)
    .slice(0, fractionDigits)
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function decimalToUnits(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error("Enter a positive number.");
  }
  const [wholePart, fraction = ""] = trimmed.split(".");
  const whole = wholePart || "0";
  if (fraction.length > decimals) {
    throw new Error(`Use no more than ${decimals} decimal places.`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0");
}

function shortPrincipal(value: string): string {
  if (value.length < 18) return value;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function html(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function normalizeAccentColor(value: string): string {
  const trimmed = value.trim();
  if (HEX_COLOR_PATTERN.test(trimmed)) return trimmed;
  if (/^[0-9a-fA-F]{6}$/.test(trimmed)) return `#${trimmed}`;
  return trimmed;
}

function isValidAccentColor(value: string): boolean {
  return HEX_COLOR_PATTERN.test(normalizeAccentColor(value));
}

function resolvePreviewConfig(
  incoming: AppPreviewConfig,
  fallback?: AppPreviewConfig,
): AppPreviewConfig {
  const accentColor = isValidAccentColor(incoming.accentColor)
    ? normalizeAccentColor(incoming.accentColor)
    : fallback && isValidAccentColor(fallback.accentColor)
      ? normalizeAccentColor(fallback.accentColor)
      : incoming.accentColor;
  return { ...incoming, accentColor };
}

function isInlineImageUrl(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= MAX_INLINE_IMAGE_LENGTH &&
    /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(trimmed)
  );
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value.trim()).protocol === "https:";
  } catch {
    return false;
  }
}

const MAX_PROJECTS = 8;

function emptyProject(): AppPreviewProject {
  return { title: "", description: "", url: "", imageUrl: "", tags: [] };
}

function normalizeProject(project: AppPreviewProject): AppPreviewProject {
  return {
    title: project.title.trim(),
    description: project.description.trim(),
    url: project.url.trim(),
    imageUrl: project.imageUrl.trim(),
    tags: project.tags.map((tag) => tag.trim()).filter(Boolean).slice(0, 6),
  };
}

function formatProjectTitleIssue(projectNumber: number, title: string): string {
  if (title.length === 0) {
    return `Project ${projectNumber}: add a title or remove this project.`;
  }
  const preview = title.length > 48 ? `${title.slice(0, 45)}...` : title;
  return `Project ${projectNumber}: title must be between 1 and 80 characters (found ${title.length}: "${preview}").`;
}

function projectFieldValue(form: HTMLFormElement, index: string, suffix: string): string {
  const field = form.elements.namedItem(`project-${index}-${suffix}`);
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    return field.value;
  }
  return "";
}

function projectCardHasContent(form: HTMLFormElement, index: string): boolean {
  return Boolean(
    projectFieldValue(form, index, "title").trim() ||
      projectFieldValue(form, index, "description").trim() ||
      projectFieldValue(form, index, "url").trim() ||
      projectFieldValue(form, index, "tags").trim() ||
      projectFieldValue(form, index, "imageUrl").trim(),
  );
}

function projectsFromForm(form: HTMLFormElement): AppPreviewProject[] {
  const cards = [...form.querySelectorAll<HTMLElement>("[data-project-card]")];
  cards.sort(
    (left, right) =>
      Number(left.dataset.projectIndex || 0) - Number(right.dataset.projectIndex || 0),
  );

  const projects: AppPreviewProject[] = [];
  for (const card of cards) {
    const index = card.dataset.projectIndex;
    if (!index) continue;
    const project = normalizeProject({
      title: projectFieldValue(form, index, "title"),
      description: projectFieldValue(form, index, "description"),
      url: projectFieldValue(form, index, "url"),
      tags: splitList(projectFieldValue(form, index, "tags"), 6),
      imageUrl: projectFieldValue(form, index, "imageUrl"),
    });
    if (!project.title && !projectCardHasContent(form, index)) continue;
    projects.push(project);
  }
  return projects.slice(0, MAX_PROJECTS);
}

function validateProject(project: AppPreviewProject, projectNumber: number): string | null {
  if (project.title.length === 0) {
    return formatProjectTitleIssue(projectNumber, project.title);
  }
  if (project.title.length > 80) {
    return formatProjectTitleIssue(projectNumber, project.title);
  }
  if (project.description.length > 500) {
    return `Project ${projectNumber}: description must be 500 characters or fewer.`;
  }
  if (project.url && !isHttpsUrl(project.url)) {
    return `Project ${projectNumber}: link must use https://.`;
  }
  if (project.imageUrl && !isHttpsUrl(project.imageUrl) && !isInlineImageUrl(project.imageUrl)) {
    return `Project ${projectNumber}: image must use https:// or an uploaded PNG, JPEG, WebP, or GIF.`;
  }
  if (project.tags.length > 6) {
    return `Project ${projectNumber}: use 6 tags or fewer.`;
  }
  for (const tag of project.tags) {
    if (tag.length === 0 || tag.length > 32) {
      return `Project ${projectNumber}: each tag must be between 1 and 32 characters.`;
    }
  }
  return null;
}

function validateProjectsInForm(
  form: HTMLFormElement,
  projects: AppPreviewProject[],
): string | null {
  const cards = [...form.querySelectorAll<HTMLElement>("[data-project-card]")];
  for (const [index, card] of cards.entries()) {
    const projectIndex = card.dataset.projectIndex;
    if (!projectIndex) continue;
    const title = projectFieldValue(form, projectIndex, "title").trim();
    if (!title && projectCardHasContent(form, projectIndex)) {
      return formatProjectTitleIssue(index + 1, title);
    }
  }
  if (projects.length > MAX_PROJECTS) {
    return `Use ${MAX_PROJECTS} projects or fewer.`;
  }
  for (const [index, project] of projects.entries()) {
    const projectError = validateProject(project, index + 1);
    if (projectError) return projectError;
  }
  return null;
}

function validatePreviewConfig(config: AppPreviewConfig): string | null {
  if (config.name.trim().length < 2 || config.name.trim().length > 80) {
    return "App name must be between 2 and 80 characters.";
  }
  if (config.headline.trim().length < 4 || config.headline.trim().length > 140) {
    return "Headline must be between 4 and 140 characters.";
  }
  if (
    config.description.trim().length < 10 ||
    config.description.trim().length > 1200
  ) {
    return "Description must be between 10 and 1,200 characters.";
  }
  if (!isValidAccentColor(config.accentColor)) {
    return "Accent color must be a six-digit hex color.";
  }
  if (config.primaryLink.trim() && !isHttpsUrl(config.primaryLink)) {
    return "Primary link must use https://.";
  }
  if (config.heroImageUrl.trim() && !isHttpsUrl(config.heroImageUrl) && !isInlineImageUrl(config.heroImageUrl)) {
    return "Hero image must use https:// or an uploaded PNG, JPEG, WebP, or GIF.";
  }
  if (config.resumeUrl.trim() && !isHttpsUrl(config.resumeUrl)) {
    return "Resume link must use https://.";
  }
  if (config.skills.length > 12) {
    return "Use 12 skills or fewer.";
  }
  for (const skill of config.skills) {
    if (skill.length === 0 || skill.length > 40) {
      return "Each skill must be between 1 and 40 characters.";
    }
  }
  if (config.socialLinks.length > 6) {
    return "Use 6 social links or fewer.";
  }
  for (const link of config.socialLinks) {
    if (link.labelText.length === 0 || link.labelText.length > 32) {
      return "Each social link label must be between 1 and 32 characters.";
    }
    if (!isHttpsUrl(link.url)) {
      return "Social links must use https://.";
    }
  }
  if (config.projects.length > MAX_PROJECTS) {
    return `Use ${MAX_PROJECTS} projects or fewer.`;
  }
  for (const [index, project] of config.projects.entries()) {
    const projectError = validateProject(project, index + 1);
    if (projectError) return projectError;
  }
  return null;
}

function splitList(value: string, limit: number): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Could not read that image file."));
        return;
      }
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Could not read that image file."));
      image.src = reader.result;
    };
    reader.onerror = () => reject(new Error("Could not read that image file."));
    reader.readAsDataURL(file);
  });
}

async function imageFileToDataUrl(file: File): Promise<string> {
  if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) {
    throw new Error("Upload a PNG, JPEG, WebP, or GIF image.");
  }
  if (file.size > MAX_IMAGE_SOURCE_BYTES) {
    throw new Error("Choose an image under 8 MB.");
  }

  const image = await loadImage(file);
  const scale = Math.min(
    1,
    MAX_IMAGE_WIDTH / image.naturalWidth,
    MAX_IMAGE_HEIGHT / image.naturalHeight,
  );
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image processing is unavailable in this browser.");
  context.drawImage(image, 0, 0, width, height);

  let quality = 0.86;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  while (dataUrl.length > MAX_INLINE_IMAGE_LENGTH && quality > 0.5) {
    quality -= 0.08;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }
  if (dataUrl.length > MAX_INLINE_IMAGE_LENGTH) {
    throw new Error("That image is still too large after resizing. Try a smaller or less detailed image.");
  }
  return dataUrl;
}

function linksFromText(value: string): AppPreviewLink[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((line) => {
      const [labelText = "", url = ""] = line.split("|").map((part) => part.trim());
      return { labelText, url };
    })
    .filter((link) => link.labelText && link.url);
}

function linksToText(links: AppPreviewLink[]): string {
  return links.map((link) => `${link.labelText} | ${link.url}`).join("\n");
}

type CanisterAppConfig = Omit<
  AppPreviewConfig,
  | "about"
  | "heroImageUrl"
  | "resumeUrl"
  | "skills"
  | "socialLinks"
  | "projects"
> & {
  about?: string;
  heroImageUrl?: string;
  resumeUrl?: string;
  skills?: string[];
  socialLinks?: AppPreviewLink[];
  projects?: AppPreviewProject[];
};

function toCanisterConfig(config: AppPreviewConfig): CanisterAppConfig {
  const projects = config.projects
    .map(normalizeProject)
    .filter((project) => project.title.length > 0 && project.title.length <= 80);
  return {
    ...config,
    about: config.about.trim() || undefined,
    heroImageUrl: config.heroImageUrl.trim() || undefined,
    resumeUrl: config.resumeUrl.trim() || undefined,
    skills: config.skills.length > 0 ? config.skills : undefined,
    socialLinks: config.socialLinks.length > 0 ? config.socialLinks : undefined,
    projects: projects.length > 0 ? projects : undefined,
  };
}

function fromCanisterConfig(config: CanisterAppConfig): AppPreviewConfig {
  return {
    ...config,
    about: config.about || "",
    heroImageUrl: config.heroImageUrl || "",
    resumeUrl: config.resumeUrl || "",
    skills: config.skills || [],
    socialLinks: config.socialLinks || [],
    projects: config.projects || [],
  };
}

function unwrapResult(result: ResultOrder): DeploymentOrder {
  if (result.__kind__ === "err") throw new Error(result.err);
  return result.ok;
}

function unwrapText(result: ResultText): string {
  if (result.__kind__ === "err") throw new Error(result.err);
  return result.ok;
}

function unwrapUnit(result: ResultUnit): void {
  if (result.__kind__ === "err") throw new Error(result.err);
}

function activeTemplate(): Template | undefined {
  return templates.find((template) => template.id === selectedTemplate);
}

function pricingBreakdown(
  template: Template | undefined,
  fundingMonths: number,
): PricingBreakdown | null {
  if (!template || !publicConfig) return null;
  const fundingUsdCents =
    BigInt(fundingMonths) * publicConfig.pricing.monthlyFundingUsdCents;
  const configuredCycles =
    publicConfig.pricing.creationCycles +
    publicConfig.pricing.cycleBuffer +
    BigInt(fundingMonths) * publicConfig.pricing.monthlyCycles;
  return {
    templateUsdCents: template.basePriceUsdCents,
    serviceFeeUsdCents: publicConfig.pricing.serviceFeeUsdCents,
    fundingUsdCents,
    totalUsdCents:
      template.basePriceUsdCents +
      publicConfig.pricing.serviceFeeUsdCents +
      fundingUsdCents,
    initialCycles: childCycleTarget(configuredCycles),
  };
}

function configuredPlanCycles(fundingMonths: number): bigint {
  if (!publicConfig) return 0n;
  return childCycleTarget(
    publicConfig.pricing.creationCycles +
      publicConfig.pricing.cycleBuffer +
      BigInt(fundingMonths) * publicConfig.pricing.monthlyCycles,
  );
}

function childCycleTarget(configuredCycles: bigint): bigint {
  return configuredCycles < MIN_CHILD_CYCLES
    ? MIN_CHILD_CYCLES
    : configuredCycles;
}

function settlementLabel(order: DeploymentOrder): string {
  if (!publicConfig) return order.expectedSettlementAmount.toString();
  if (order.settlementAsset !== publicConfig.settlement.assetId) {
    return `${order.expectedSettlementAmount.toString()} smallest units of ${shortPrincipal(order.settlementAsset)}`;
  }
  return `${units(
    order.expectedSettlementAmount,
    Number(publicConfig.settlement.decimals),
  )} ${publicConfig.paymentDisplay.settlementSymbol} on ${publicConfig.paymentDisplay.settlementNetwork}`;
}

function appUrl(order: DeploymentOrder): string | undefined {
  if (
    order.createdCanisterId &&
    window.location.hostname.endsWith(".localhost")
  ) {
    const port = window.location.port ? `:${window.location.port}` : "";
    return `${window.location.protocol}//${order.createdCanisterId.toText()}.raw.localhost${port}/`;
  }
  return order.appUrl;
}

function statusLabel(status: DeploymentOrder["status"]): string {
  const labels: Record<DeploymentOrder["status"], string> = {
    AwaitingPayment: "Awaiting payment",
    PaymentDetected: "Payment confirmed",
    CreatingCanister: "Creating canister",
    Live: "Live",
    Failed: "Deployment failed",
    RefundRequired: "Refund required",
  };
  return labels[status];
}

function paymentStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    PENDING_DEPOSIT: "Waiting for your transfer",
    KNOWN_DEPOSIT_TX: "Deposit detected",
    PROCESSING: "Swap in progress",
    SUCCESS: "Payment delivered",
    INCOMPLETE_DEPOSIT: "Deposit amount is too low",
    REFUNDED: "Payment refunded",
    FAILED: "Payment failed",
  };
  return labels[status] || status;
}

function paymentConfigMatches(): boolean {
  return (
    !relayerHealth ||
    !publicConfig ||
    relayerHealth.destinationAsset === publicConfig.settlement.assetId
  );
}

function relayerReadyForOrders(): boolean {
  return relayerHealth?.ready === true;
}

function factoryBalanceRequired(fundingMonths: number): bigint | null {
  if (!publicConfig || !factoryReadiness) return null;
  return configuredPlanCycles(fundingMonths) + factoryReadiness.reserveCycles;
}

function factoryShortfall(fundingMonths: number): bigint | null {
  const required = factoryBalanceRequired(fundingMonths);
  if (required === null || !factoryReadiness) return null;
  return required > factoryReadiness.cycleBalance
    ? required - factoryReadiness.cycleBalance
    : 0n;
}

function supportedFundingMonths(): number[] {
  if (!factoryReadiness?.templateWasmConfigured) return [];
  return [1, 3, 6].filter((months) => factoryShortfall(months) === 0n);
}

function factoryPlanAvailable(fundingMonths: number): boolean {
  return supportedFundingMonths().includes(fundingMonths);
}

function factoryCapacityMessage(): string | null {
  if (!factoryReadiness || !publicConfig) return null;
  if (!factoryReadiness.templateWasmConfigured) {
    return "Deployments are paused until the approved app template Wasm is uploaded.";
  }

  const supported = supportedFundingMonths();
  const oneMonthShortfall = factoryShortfall(1);
  const threeMonthShortfall = factoryShortfall(3);
  const sixMonthShortfall = factoryShortfall(6);

  if (supported.length === 0 && oneMonthShortfall !== null) {
    return `Deployments are paused. Add at least ${cycles(oneMonthShortfall)} cycles to support the one-month plan. Current factory balance: ${cycles(factoryReadiness.cycleBalance)}.`;
  }
  if (supported.length < 3) {
    const planLabel = supported
      .map((months) => `${months}-month`)
      .join(" and ");
    const upgrades = [
      threeMonthShortfall && threeMonthShortfall > 0n
        ? `${cycles(threeMonthShortfall)} for three-month plans`
        : "",
      sixMonthShortfall && sixMonthShortfall > 0n
        ? `${cycles(sixMonthShortfall)} for six-month plans`
        : "",
    ].filter(Boolean);
    return `Factory capacity currently supports ${planLabel} plans. Add ${upgrades.join(" or ")}. Current balance: ${cycles(factoryReadiness.cycleBalance)}; the ${cycles(factoryReadiness.reserveCycles)} deployment reserve is included in these targets.`;
  }
  return null;
}

function renderAvailability(): string {
  const messages: string[] = [];
  if (!relayerHealth) {
    messages.push(
      "The payment service is unreachable. New payment quotes are unavailable until the relayer connection is restored.",
    );
  } else if (!relayerHealth.backendConnected) {
    messages.push(
      relayerHealth.backendError ||
        "The payment relayer is not connected to the ICP backend.",
    );
  } else if (!relayerHealth.backendIdentityAuthorized) {
    messages.push(
      "The payment relayer principal is not authorized by the ICP backend.",
    );
  } else if (relayerHealth.mode === "mock") {
    messages.push(
      "Payment test mode is active. The settlement button simulates payment and no tokens move.",
    );
  } else if (!relayerHealth.ready) {
    messages.push(
      "Live payments are paused because the relayer is missing its treasury recipient, partner credential, or protected ICP identity.",
    );
  }
  if (publicConfig && !publicConfig.ordersEnabled) {
    messages.push("New deployment orders are paused by an administrator.");
  }
  if (!paymentConfigMatches()) {
    messages.push(
      "The backend and relayer settlement asset IDs do not match. Payments are disabled until both are configured identically.",
    );
  }
  if (factoryReadiness && !factoryReadiness.templateWasmConfigured) {
    messages.push(factoryCapacityMessage() || "The factory is not ready.");
  } else {
    const capacityMessage = factoryCapacityMessage();
    if (capacityMessage) messages.push(capacityMessage);
  }
  if (messages.length === 0) return "";

  return `
    <div class="availability-banner ${relayerHealth?.mode === "mock" ? "test" : "warning"}">
      <strong>${relayerHealth?.mode === "mock" ? "Test mode" : "Service notice"}</strong>
      <span>${messages.map(html).join(" ")}</span>
    </div>
  `;
}

function renderTemplateCards(): string {
  const pricing = publicConfig?.pricing;
  return templates
    .filter((template) => template.active)
    .map((template, index) => {
      const minimum = pricing
        ? template.basePriceUsdCents +
          pricing.serviceFeeUsdCents +
          pricing.monthlyFundingUsdCents
        : template.basePriceUsdCents;
      return `
        <button class="template-card ${template.id === selectedTemplate ? "selected" : ""}"
          data-template="${html(template.id)}" type="button">
          <span class="template-index">0${index + 1}</span>
          <span class="template-category">${html(template.category)}</span>
          <strong>${html(template.name)}</strong>
          <p>${html(template.description)}</p>
          <span class="template-price">from ${money(minimum)} ${html(publicConfig?.paymentDisplay.priceCurrency || "USD")}</span>
        </button>
      `;
    })
    .join("");
}

function renderPriceBreakdown(
  template: Template | undefined,
  fundingMonths: number,
): string {
  const breakdown = pricingBreakdown(template, fundingMonths);
  if (!breakdown || !publicConfig) return "";
  return `
    <div class="pricing-breakdown">
      <div><span>Template</span><strong>${money(breakdown.templateUsdCents)}</strong></div>
      <div><span>Deployment service</span><strong>${money(breakdown.serviceFeeUsdCents)}</strong></div>
      <div><span>${fundingMonths} month${fundingMonths === 1 ? "" : "s"} of cycles</span><strong>${money(breakdown.fundingUsdCents)}</strong></div>
      <div class="pricing-total"><span>Fixed plan total</span><strong>${money(breakdown.totalUsdCents)} ${html(publicConfig.paymentDisplay.priceCurrency)}</strong></div>
      <p>This is the plan price. Your NEAR Intents quote tells you the exact amount of the source token to send.</p>
    </div>
  `;
}

function timeline(order: DeploymentOrder): string {
  const status = order.status;
  const steps: Array<[DeploymentOrder["status"], string]> = [
    [DeploymentStatus.AwaitingPayment, "Order created"],
    [DeploymentStatus.PaymentDetected, "Payment settled"],
    [DeploymentStatus.CreatingCanister, "Deploying on ICP"],
    [DeploymentStatus.Live, "App live"],
  ];
  const activeIndex =
    status === "Failed"
      ? 2
      : status === "RefundRequired"
        ? 0
        : Math.max(0, steps.findIndex(([key]) => key === status));

  return `
    <div class="timeline">
      ${steps
        .map(
          ([key, label], index) => `
            <div class="timeline-step ${index <= activeIndex ? "complete" : ""} ${key === status ? "current" : ""}">
              <span>${index + 1}</span>
              <small>${label}</small>
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderAppPreview(
  config: AppPreviewConfig,
  templateId: string,
  label: string,
  frameId: string,
): string {
  return `
    <div class="app-preview-card">
      <div class="app-preview-heading">
        <span class="section-label">App preview</span>
        <span>${html(label)}</span>
      </div>
      <iframe
        id="${html(frameId)}"
        class="app-preview-frame"
        title="${html(label)}"
        sandbox="allow-popups"
        referrerpolicy="no-referrer"
        srcdoc="${html(appPreviewDocument(config, templateId))}">
      </iframe>
    </div>
  `;
}

function renderAccentColorField(value: string): string {
  const accentColor = isValidAccentColor(value) ? normalizeAccentColor(value) : "#2fbf8f";
  return `
    <label>Accent color
      <div class="color-input-row">
        <input name="accentColorPicker" type="color" value="${html(accentColor)}" aria-label="Pick accent color" />
        <input name="accentColor" required pattern="#[0-9a-fA-F]{6}" value="${html(accentColor)}" />
      </div>
    </label>
  `;
}

function renderProjectImageField(index: number, value: string): string {
  const fieldName = `project-${index}-imageUrl`;
  return `
    <div class="image-field project-image-field">
      <label>Project image
        <input name="${fieldName}" type="text" placeholder="https://... or upload below" value="${html(value)}" />
      </label>
      <label class="file-picker">
        <span>Upload</span>
        <input data-image-upload="${fieldName}" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
      </label>
    </div>
    <p class="field-help image-upload-status" data-image-status="${fieldName}">Optional preview image. Use HTTPS or upload a PNG, JPEG, WebP, or GIF.</p>
  `;
}

function renderProjectCard(
  index: number,
  project: AppPreviewProject,
  displayNumber: number,
): string {
  return `
    <article class="project-editor-card" data-project-card data-project-index="${index}">
      <div class="project-editor-heading">
        <strong>Project ${displayNumber}</strong>
        <button class="button ghost project-remove" type="button" data-remove-project="${index}">Remove</button>
      </div>
      <label>Title
        <input name="project-${index}-title" maxlength="80" placeholder="Launch Console" value="${html(project.title)}" />
      </label>
      <label>Description
        <textarea name="project-${index}-description" maxlength="500" rows="3" placeholder="A short summary of this project">${html(project.description)}</textarea>
      </label>
      <label>Project link
        <input name="project-${index}-url" type="url" placeholder="https://example.com/project" value="${html(project.url)}" />
      </label>
      <label>Tags
        <input name="project-${index}-tags" placeholder="ICP, TypeScript, Design" value="${html(project.tags.join(", "))}" />
      </label>
      ${renderProjectImageField(index, project.imageUrl)}
    </article>
  `;
}

function renderProjectsEditor(projects: AppPreviewProject[]): string {
  const cards =
    projects.length > 0
      ? projects
          .map((project, index) => renderProjectCard(index, project, index + 1))
          .join("")
      : `<p class="projects-empty">No projects yet. Add up to ${MAX_PROJECTS} pieces of work to feature on your portfolio.</p>`;

  return `
    <section class="projects-editor" data-projects-editor>
      <div class="projects-editor-header">
        <div>
          <span class="section-label">Portfolio projects</span>
          <p class="field-help">Optional highlighted work shown on your live app. Each project has its own fields — no special formatting required.</p>
        </div>
        <button class="button secondary project-add" type="button" data-add-project ${projects.length >= MAX_PROJECTS ? "disabled" : ""}>Add project</button>
      </div>
      <div class="projects-editor-list" data-projects-list>${cards}</div>
    </section>
  `;
}

function updateAddProjectButton(form: HTMLFormElement): void {
  const button = form.querySelector<HTMLButtonElement>("[data-add-project]");
  if (!button) return;
  const count = form.querySelectorAll("[data-project-card]").length;
  button.disabled = count >= MAX_PROJECTS;
}

function renumberProjectCards(form: HTMLFormElement): void {
  form.querySelectorAll<HTMLElement>("[data-project-card]").forEach((card, index) => {
    const heading = card.querySelector(".project-editor-heading strong");
    if (heading) heading.textContent = `Project ${index + 1}`;
  });
}

function addProjectToForm(form: HTMLFormElement, refreshPreview: () => void): void {
  const list = form.querySelector("[data-projects-list]");
  if (!list) return;

  const cards = form.querySelectorAll("[data-project-card]");
  if (cards.length >= MAX_PROJECTS) return;

  form.querySelector(".projects-empty")?.remove();

  const indices = [...cards].map((card) =>
    Number((card as HTMLElement).dataset.projectIndex || 0),
  );
  const nextIndex = indices.length > 0 ? Math.max(...indices) + 1 : 0;

  list.insertAdjacentHTML(
    "beforeend",
    renderProjectCard(nextIndex, emptyProject(), cards.length + 1),
  );
  updateAddProjectButton(form);
  refreshPreview();
}

function removeProjectFromForm(
  form: HTMLFormElement,
  index: string | undefined,
  refreshPreview: () => void,
): void {
  if (!index) return;
  form
    .querySelector(`[data-project-card][data-project-index="${index}"]`)
    ?.remove();

  const list = form.querySelector("[data-projects-list]");
  const cards = form.querySelectorAll("[data-project-card]");
  if (cards.length === 0 && list) {
    list.innerHTML = `<p class="projects-empty">No projects yet. Add up to ${MAX_PROJECTS} pieces of work to feature on your portfolio.</p>`;
  } else {
    renumberProjectCards(form);
  }
  updateAddProjectButton(form);
  refreshPreview();
}

function bindProjectsEditor(
  form: HTMLFormElement,
  refreshPreview: () => void,
): void {
  form.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    if (target.closest("[data-add-project]")) {
      event.preventDefault();
      addProjectToForm(form, refreshPreview);
      return;
    }

    const removeButton = target.closest<HTMLElement>("[data-remove-project]");
    if (removeButton) {
      event.preventDefault();
      removeProjectFromForm(form, removeButton.dataset.removeProject, refreshPreview);
    }
  });
}

function renderHeroImageField(value: string): string {
  return `
    <div class="image-field">
      <label>Hero/banner image<input name="heroImageUrl" type="text" placeholder="https://... or upload below" value="${html(value)}" /></label>
      <label class="file-picker">
        <span>Upload image</span>
        <input data-image-upload="heroImageUrl" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
      </label>
    </div>
    <p class="field-help image-upload-status" data-image-status="heroImageUrl">Use an HTTPS image URL or upload a PNG, JPEG, WebP, or GIF. Uploads are resized before saving.</p>
  `;
}

function renderLivePortfolioEditor(
  config: AppPreviewConfig,
  templateId: string,
): string {
  return `
    <form class="live-config-form" id="live-config-form">
      <div class="form-heading">
        <div>
          <span class="section-label">Live app admin</span>
          <h4>Edit your deployed app</h4>
          <p class="field-help">Changes publish directly to your live ICP app canister.</p>
        </div>
        <button class="button secondary" type="submit">Save live app</button>
      </div>
      <div class="field-row">
        <label>Name<input name="name" required maxlength="80" value="${html(config.name)}" /></label>
        ${renderAccentColorField(config.accentColor)}
      </div>
      <label>Headline<input name="headline" required maxlength="140" value="${html(config.headline)}" /></label>
      <label>Description<textarea name="description" required maxlength="1200">${html(config.description)}</textarea></label>
      <label>About<textarea name="about" maxlength="2000">${html(config.about)}</textarea></label>
      <div class="field-row">
        <label>Primary link<input name="primaryLink" type="url" placeholder="https://github.com/..." value="${html(config.primaryLink)}" /></label>
        <label>Contact<input name="contact" placeholder="hello@example.com" value="${html(config.contact)}" /></label>
      </div>
      ${renderHeroImageField(config.heroImageUrl)}
      <label>Resume<input name="resumeUrl" type="url" placeholder="https://..." value="${html(config.resumeUrl)}" /></label>
      <label>Skills<textarea name="skills" maxlength="500">${html(config.skills.join(", "))}</textarea></label>
      <label>Social links<textarea name="socialLinks" maxlength="1000">${html(linksToText(config.socialLinks))}</textarea></label>
      ${renderProjectsEditor(config.projects)}
      ${renderAppPreview(config, templateId, "Updates as you edit", "live-preview-frame")}
    </form>
  `;
}

function renderCurrentOrder(): string {
  if (!currentOrder) {
    return `
      <div class="empty-state">
        <span>01</span>
        <h3>Your deployment order will appear here.</h3>
        <p>Choose a template, describe the app, and create a fixed-price order on ICP.</p>
      </div>
    `;
  }

  const status = currentOrder.status;
  const canQuote = status === "AwaitingPayment" && !currentQuote;
  const canDeploy = status === "PaymentDetected" || status === "Failed";
  const liveAppUrl = appUrl(currentOrder);
  const isLive = status === "Live";
  const savedConfig = fromCanisterConfig(currentOrder.config as CanisterAppConfig);
  const settlementAsset = currentOrder.settlementAsset;
  const canCancel =
    status === "AwaitingPayment" &&
    !currentOrder.paymentTxHash &&
    !currentOrder.settlementProof;
  const hasPaymentQuote = Boolean(
    currentOrder.paymentQuoteId ||
      currentOrder.depositAddress ||
      currentQuote,
  );

  return `
    <article class="order-card">
      <div class="order-heading">
        <div>
          <span class="kicker">Order #${currentOrder.id.toString()}</span>
          <h3>${html(currentOrder.config.name)}</h3>
        </div>
        <span class="status status-${status.toLowerCase()}">${html(statusLabel(status))}</span>
      </div>
      ${
        isLive
          ? ""
          : renderAppPreview(
              savedConfig,
              currentOrder.templateId,
              "Saved order configuration",
              "order-preview-frame",
            )
      }
      ${timeline(currentOrder)}
      <div class="order-facts">
        <div><small>Plan price</small><strong>${money(currentOrder.expectedAmountUsdCents)} ${html(publicConfig?.paymentDisplay.priceCurrency || "USD")}</strong></div>
        <div><small>Settlement target</small><strong>${html(settlementLabel(currentOrder))}</strong></div>
        <div><small>App funding</small><strong>${cycles(currentOrder.expectedCycles)} cycles</strong></div>
      </div>
      <div class="payment-explainer">
        <strong>How payment works</strong>
        <ol>
          <li>The plan is priced in ${html(publicConfig?.paymentDisplay.priceCurrency || "USD")} for clarity.</li>
          <li>NEAR Intents quotes the exact amount of your chosen source token.</li>
          <li>The relayer confirms delivery of ${html(settlementLabel(currentOrder))}; you never need an ICP or cycles wallet.</li>
        </ol>
      </div>

      ${
        canQuote
          ? `
            <div class="payment-panel">
              <div class="section-label">${currentOrder.depositAddress ? "Replace unavailable quote" : "Pay from a supported chain"}</div>
              ${
                currentOrder.depositAddress
                  ? `<p class="inline-warning">The previous quote details are not available from the relayer. Create a replacement quote before sending funds.</p>`
                  : ""
              }
              <label>
                Token you will send
                <select id="origin-asset">
                  ${tokens
                    .filter(
                      (token) =>
                        token.assetId !== settlementAsset,
                    )
                    .slice(0, 120)
                    .map(
                      (token) =>
                        `<option value="${html(token.assetId)}">${html(token.symbol)} on ${html(token.blockchain)}</option>`,
                    )
                    .join("")}
                </select>
              </label>
              <label>
                Refund address for that token's chain
                <input id="refund-address" placeholder="Address that can receive the selected token" />
              </label>
              <p class="field-help" id="refund-help">If the swap cannot complete, NEAR Intents returns funds to this address.</p>
              ${paymentError ? `<p class="inline-warning" role="alert">${html(paymentError)}</p>` : ""}
              <button class="button primary wide" id="quote-button" type="button">Get exact payment amount</button>
            </div>
          `
          : ""
      }

      ${
        currentQuote
          ? `
            <div class="payment-receipt">
              <div>
                <span class="section-label">${currentQuote.mock ? "Simulated payment" : "Live NEAR Intents payment"}</span>
                <h4>${currentQuote.mock ? "Test the settlement flow" : `Send exactly ${html(currentQuote.amountInFormatted)} ${html(currentQuote.originSymbol)}`}</h4>
                ${
                  currentQuote.mock
                    ? `<p class="inline-warning">No real tokens move in test mode.</p>`
                    : `<code>${html(currentQuote.depositAddress)}</code>`
                }
                ${currentQuote.depositMemo ? `<p>Memo: <strong>${html(currentQuote.depositMemo)}</strong></p>` : ""}
                <div class="payment-route">
                  <span>${currentQuote.mock ? "Simulated input" : "You send"} <strong>${html(currentQuote.amountInFormatted)} ${html(currentQuote.originSymbol)}${currentQuote.mock ? " (not a market quote)" : ""}</strong></span>
                  <span>Platform receives <strong>${html(settlementLabel(currentOrder))}</strong></span>
                </div>
                <p class="muted">Status: ${html(paymentStatusLabel(currentQuote.status))}. Quote expires ${new Date(currentQuote.deadline).toLocaleString()}.</p>
                ${
                  !currentQuote.mock
                    ? `
                      <label class="tx-submit">
                        Deposit transaction hash (optional)
                        <input id="deposit-tx-hash" placeholder="Submit after sending to speed up detection" />
                      </label>
                    `
                    : ""
                }
              </div>
              <div class="receipt-actions">
                ${
                  currentQuote.mock
                    ? `<button class="button primary" id="mock-settle-button" type="button">Simulate successful payment</button>`
                    : `
                      <button class="button secondary" id="submit-tx-button" type="button">Submit transaction hash</button>
                      <button class="button secondary" id="check-status-button" type="button">Check payment status</button>
                    `
                }
              </div>
            </div>
          `
          : ""
      }

      ${
        canDeploy
          ? `<button class="button deploy" id="deploy-button" type="button">${status === "Failed" ? "Retry deployment" : "Deploy app on ICP"}</button>`
          : ""
      }
      ${
        canCancel
          ? `
            <div class="cancel-order-panel">
              <p>${
                hasPaymentQuote
                  ? currentQuote?.mock
                    ? "The relayer will confirm that this simulated quote has no payment activity."
                    : "For a real quote, cancellation is allowed only after the quote expires and 1Click still reports that no deposit was detected."
                  : "This order has no payment quote and can be canceled immediately."
              }</p>
              <button class="button cancel wide" id="cancel-order-button" type="button">Cancel unpaid order</button>
            </div>
          `
          : ""
      }
      ${
        isLive && liveAppUrl
          ? `<a class="live-link" href="${html(liveAppUrl)}" target="_blank" rel="noreferrer">Open live ICP app <span>^</span></a>`
          : ""
      }
      ${
        isLive && currentOrder.createdCanisterId
          ? renderLivePortfolioEditor(savedConfig, currentOrder.templateId)
          : ""
      }
      ${currentOrder.error ? `<p class="error-message">${html(currentOrder.error)}</p>` : ""}
    </article>
  `;
}

function renderOrders(): string {
  if (!signedIn) {
    return `<div class="dashboard-empty">Sign in to see deployment history tied to your Internet Identity principal.</div>`;
  }
  if (orders.length === 0) {
    return `<div class="dashboard-empty">No deployments yet. Your first launch will show up here.</div>`;
  }

  return orders
    .map((order) => `
      <button class="app-row" data-order="${order.id.toString()}" type="button">
        <span class="app-mark" style="--mark:${html(order.config.accentColor)}"></span>
        <span><strong>${html(order.config.name)}</strong><small>${html(order.templateId)} / ${order.fundingMonths.toString()} months</small></span>
        <span class="status status-${order.status.toLowerCase()}">${html(statusLabel(order.status))}</span>
        <span class="row-arrow">-&gt;</span>
      </button>
    `)
    .join("");
}

function renderPrincipalPanel(): string {
  if (!signedIn) return "";
  return `
    <div class="principal-panel">
      <div>
        <span class="section-label">Your Internet Identity principal</span>
        <p>Use this value when the platform owner grants you admin access. Admin access is stored on-chain, not in a frontend environment variable.</p>
      </div>
      <input id="principal-value" value="${html(principal)}" readonly aria-label="Your Internet Identity principal" />
      <button class="button secondary" data-copy-principal type="button">Copy principal ID</button>
    </div>
  `;
}

function readinessStatus(): string {
  if (!factoryReadiness) return "Checking";
  if (!factoryReadiness.templateWasmConfigured) return "Template missing";
  const supported = supportedFundingMonths();
  if (supported.length === 0) return "Needs cycles";
  if (supported.length < 3) return "Limited capacity";
  return "All plans ready";
}

function renderAdmin(): string {
  if (!adminAccess?.isAdmin || !publicConfig) return "";
  const pricing = publicConfig.pricing;

  return `
    <section class="admin-section" id="admin">
      <div class="section-intro compact">
        <span class="section-number">03</span>
        <div><span class="kicker">Platform controls</span><h2>Admin dashboard.</h2></div>
        <p>Pricing and payment configuration are stored on-chain and applied to new orders only.</p>
      </div>

      <div class="admin-status-grid">
        <article><small>Relayer</small><strong>${html(relayerHealth?.mode || "unknown")}</strong><span>${relayerHealth?.mode === "live" ? (relayerHealth.ready ? "Real swaps enabled" : "Configuration incomplete") : relayerHealth?.mode === "mock" ? "No real funds move" : "Unavailable"}</span></article>
        <article><small>Factory</small><strong>${html(readinessStatus())}</strong><span>${factoryReadiness ? `${cycles(factoryReadiness.cycleBalance)} available` : "Unavailable"}</span></article>
        <article><small>Template Wasm</small><strong>${factoryReadiness?.templateWasmConfigured ? "Configured" : "Missing"}</strong><span>${factoryReadiness ? `${factoryReadiness.templateWasmSize.toString()} bytes` : "Unavailable"}</span></article>
        <article><small>New orders</small><strong>${publicConfig.ordersEnabled ? "Enabled" : "Paused"}</strong><button class="text-button" id="toggle-orders-button" type="button">${publicConfig.ordersEnabled ? "Pause" : "Enable"}</button></article>
      </div>

      ${
        factoryReadiness && !factoryReadiness.templateWasmConfigured
          ? `<div class="admin-alert"><strong>Factory setup required</strong><span>Run <code>pnpm template:build</code> and <code>pnpm template:upload</code> with the deployment identity before accepting payments.</span></div>`
          : ""
      }
      ${
        factoryReadiness && !factoryReadiness.canDeploy
          ? `<div class="admin-alert"><strong>Factory capacity</strong><span>${html(factoryCapacityMessage() || "Additional cycles are required.")} To enable the six-month plan now, top up <code>${html(factoryCanisterId || "launcher_factory")}</code> by at least <code>${factoryShortfall(6)?.toString() || "0"}</code> cycles.</span></div>`
          : ""
      }
      ${
        !paymentConfigMatches()
          ? `<div class="admin-alert"><strong>Relayer mismatch</strong><span>The relayer reports <code>${html(relayerHealth?.destinationAsset || "unknown")}</code>, while the backend expects <code>${html(publicConfig.settlement.assetId)}</code>. Update <code>SETTLEMENT_ASSET_ID</code> on the relayer before enabling payments.</span></div>`
          : ""
      }

      <div class="admin-grid">
        <form class="admin-card" id="pricing-form">
          <div class="admin-card-heading"><span class="section-label">Pricing</span><strong>${html(publicConfig.paymentDisplay.priceCurrency)}</strong></div>
          <label>Deployment service fee<input name="serviceFee" value="${units(pricing.serviceFeeUsdCents, 2, 2)}" inputmode="decimal" /></label>
          <label>Monthly funding price<input name="monthlyFunding" value="${units(pricing.monthlyFundingUsdCents, 2, 2)}" inputmode="decimal" /></label>
          <div class="field-row">
            <label>Base canister allocation (T)<input name="creationCycles" value="${units(pricing.creationCycles, 12, 3)}" inputmode="decimal" /></label>
            <label>Monthly operating allowance (T)<input name="monthlyCycles" value="${units(pricing.monthlyCycles, 12, 3)}" inputmode="decimal" /></label>
          </div>
          <label>Contingency buffer (T)<input name="cycleBuffer" value="${units(pricing.cycleBuffer, 12, 3)}" inputmode="decimal" /></label>
          <div class="cycle-plan-summary">
            ${[1, 3, 6]
              .map(
                (months) =>
                  `<span><small>${months}-month allocation</small><strong>${cycles(configuredPlanCycles(months))}</strong></span>`,
              )
              .join("")}
          </div>
          <p class="muted">The USD funding price is what the customer pays. The allocation totals above are the cycles the factory transfers to each new app.</p>
          <button class="button secondary wide" id="cycle-preset-button" type="button">Apply conservative cycle preset</button>
          <button class="button primary wide" type="submit">Save pricing</button>
        </form>

        <form class="admin-card" id="payment-config-form">
          <div class="admin-card-heading"><span class="section-label">Payment display</span><strong>1Click</strong></div>
          <div class="field-row">
            <label>Price currency<input name="priceCurrency" value="${html(publicConfig.paymentDisplay.priceCurrency)}" /></label>
            <label>Settlement symbol<input name="settlementSymbol" value="${html(publicConfig.paymentDisplay.settlementSymbol)}" /></label>
          </div>
          <label>Settlement network<input name="settlementNetwork" value="${html(publicConfig.paymentDisplay.settlementNetwork)}" /></label>
          <label>Settlement asset ID<input name="assetId" value="${html(publicConfig.settlement.assetId)}" /></label>
          <label>Asset decimals<input name="decimals" value="${publicConfig.settlement.decimals.toString()}" inputmode="numeric" /></label>
          <button class="button primary wide" type="submit">Save payment configuration</button>
        </form>
      </div>

      <div class="admin-card template-admin">
        <div class="admin-card-heading"><span class="section-label">Templates</span><strong>${templates.length}</strong></div>
        <div class="template-admin-list">
          ${templates
            .map(
              (template) => `
                <form data-template-admin="${html(template.id)}">
                  <div><strong>${html(template.name)}</strong><small>${html(template.id)}</small></div>
                  <label>Base price<input name="basePrice" value="${units(template.basePriceUsdCents, 2, 2)}" inputmode="decimal" /></label>
                  <label class="checkbox-label"><input name="active" type="checkbox" ${template.active ? "checked" : ""} /> Active</label>
                  <button class="button secondary" type="submit">Save</button>
                </form>
              `,
            )
            .join("")}
        </div>
      </div>

      <div class="admin-grid">
        <div class="admin-card">
          <div class="admin-card-heading"><span class="section-label">Your principal</span><strong>${adminAccess.isOwner ? "Owner" : "Admin"}</strong></div>
          <code class="principal-code">${html(principal)}</code>
          <button class="button secondary wide" data-copy-principal type="button">Copy principal ID</button>
          <p class="muted">The platform owner grants this principal admin access on-chain. It does not belong in frontend environment variables.</p>
        </div>
        ${
          adminAccess.isOwner
            ? `
              <div class="admin-card">
                <div class="admin-card-heading"><span class="section-label">Access control</span><strong>${admins.length} admins</strong></div>
                <form id="admin-add-form">
                  <label>Admin principal<input name="principal" placeholder="aaaaa-bbbbb-..." /></label>
                  <button class="button secondary wide" type="submit">Add admin</button>
                </form>
                <div class="admin-principal-list">
                  ${admins
                    .map(
                      (admin) => `
                        <div><code>${html(admin.toText())}</code><button class="text-button" data-remove-admin="${html(admin.toText())}" type="button">Remove</button></div>
                      `,
                    )
                    .join("") || "<span class=\"muted\">No additional admins.</span>"}
                </div>
                <form id="relayer-form">
                  <label>Settlement relayer principal<input name="principal" value="${html(adminAccess.settlementRelayer.toText())}" /></label>
                  <button class="button secondary wide" type="submit">Update relayer</button>
                </form>
              </div>
            `
            : ""
        }
      </div>
    </section>
  `;
}

function render(): void {
  const template = activeTemplate();
  const initialBreakdown = pricingBreakdown(template, selectedFundingMonths);
  const managingOrder = currentOrder !== null;
  const managingLiveApp =
    currentOrder?.status === "Live" && Boolean(currentOrder.createdCanisterId);
  const canCreateOrder =
    signedIn &&
    publicConfig?.ordersEnabled &&
    paymentConfigMatches() &&
    relayerReadyForOrders() &&
    factoryPlanAvailable(selectedFundingMonths) &&
    !busy;

  app.innerHTML = `
    <div class="site-shell">
      <header class="topbar">
        <a class="brand" href="#"><span class="brand-glyph">N</span><span>NearLaunch <small>for ICP</small></span></a>
        <nav>
          <a href="#launch">Launch</a>
          <a href="#apps">My apps</a>
          ${adminAccess?.isAdmin ? `<a href="#admin">Admin</a>` : ""}
          <a href="#how">How it works</a>
        </nav>
        ${
          signedIn
            ? `
              <div class="identity-actions">
                <button class="identity-button" data-copy-principal type="button" title="Copy principal ID">
                  <span class="online-dot"></span>${html(shortPrincipal(principal))}<b>Copy</b>
                </button>
                <button class="text-button" id="sign-out-button" type="button">Sign out</button>
              </div>
            `
            : `
              <button class="identity-button" id="identity-button" type="button">
                <span class="offline-dot"></span>Sign in
              </button>
            `
        }
      </header>

      <main>
        <section class="hero">
          <div class="hero-copy">
            <div class="eyebrow"><span>NEAR Intents</span><i></i><span>Internet Computer</span></div>
            <h1>Ask for an app.<br /><em>Get a live canister.</em></h1>
            <p>Deploy and fund a real ICP application without handling cycles, Wasm installation, or chain-specific payment rails.</p>
            <a class="button primary" href="#launch">Start a deployment</a>
          </div>
          <div class="hero-console" aria-label="Deployment flow preview">
            <div class="console-top"><span></span><span></span><span></span><small>intent.deploy</small></div>
            <div class="console-body">
              <div><small>OUTCOME</small><strong>Launch "Northstar" on ICP</strong></div>
              <div class="console-route"><span>Source token</span><b>-&gt;</b><span>NEAR Intents</span><b>-&gt;</b><span>${html(publicConfig?.paymentDisplay.settlementSymbol || "USDC")}</span></div>
              <pre><code><span>template</span> grant-page
<span>funding</span> 3 months
<span>controller</span> user principal
<span>status</span> <b>ready to deploy</b></code></pre>
            </div>
          </div>
          <div class="hero-stats">
            <div><strong>${stats.liveApps.toString()}</strong><small>apps launched</small></div>
            <div><strong>${stats.templates.toString()}</strong><small>approved templates</small></div>
            <div><strong>${stats.totalOrders.toString()}</strong><small>on-chain orders</small></div>
          </div>
        </section>

        <section class="launch-section" id="launch">
          <div class="section-intro">
            <span class="section-number">01</span>
            <div><span class="kicker">Choose the outcome</span><h2>What are we launching?</h2></div>
            <p>Every template is an approved Wasm path. Users configure content; the factory controls what code can be installed.</p>
          </div>
          ${renderAvailability()}
          <div class="template-grid">${renderTemplateCards()}</div>

          <div class="builder-grid ${managingOrder ? "builder-grid--managing-order" : ""} ${managingLiveApp ? "builder-grid--live-app" : ""}">
            <form class="builder-form" id="launch-form">
              <div class="form-heading">
                <span class="section-label">Configure ${html(template?.name || "app")}</span>
                <span class="price-preview" id="price-preview">fixed ${initialBreakdown ? money(initialBreakdown.totalUsdCents) : "$0.00"} ${html(publicConfig?.paymentDisplay.priceCurrency || "USD")}</span>
              </div>
              <div class="field-row">
                <label>App name<input name="name" required maxlength="80" value="${html(draftConfig.name)}" /></label>
                ${renderAccentColorField(draftConfig.accentColor)}
              </div>
              <label>Headline<input name="headline" required maxlength="140" value="${html(draftConfig.headline)}" /></label>
              <label>Description<textarea name="description" required maxlength="1200">${html(draftConfig.description)}</textarea></label>
              <label>About<textarea name="about" maxlength="2000">${html(draftConfig.about)}</textarea></label>
              <div class="field-row">
                <label>Primary link<input name="primaryLink" type="url" placeholder="https://github.com/..." value="${html(draftConfig.primaryLink)}" /></label>
                <label>Contact<input name="contact" placeholder="hello@example.com" value="${html(draftConfig.contact)}" /></label>
              </div>
              ${renderHeroImageField(draftConfig.heroImageUrl)}
              <label>Resume<input name="resumeUrl" type="url" placeholder="https://..." value="${html(draftConfig.resumeUrl)}" /></label>
              <label>Skills<textarea name="skills" maxlength="500">${html(draftConfig.skills.join(", "))}</textarea></label>
              <label>Social links<textarea name="socialLinks" maxlength="1000">${html(linksToText(draftConfig.socialLinks))}</textarea></label>
              ${renderProjectsEditor(draftConfig.projects)}
              ${renderAppPreview(
                draftConfig,
                selectedTemplate,
                "Updates as you type",
                "draft-preview-frame",
              )}
              <label>Funding duration
                <div class="funding-options">
                  ${[1, 3, 6]
                    .map((months) => {
                      const available = factoryPlanAvailable(months);
                      return `<input id="fund-${months}" type="radio" name="fundingMonths" value="${months}" ${months === selectedFundingMonths ? "checked" : ""} ${available ? "" : "disabled"}><label for="fund-${months}" class="${available ? "" : "unavailable"}">${months}<small>${available ? `month${months > 1 ? "s" : ""}` : "needs cycles"}</small></label>`;
                    })
                    .join("")}
                </div>
              </label>
              <div id="pricing-breakdown">${renderPriceBreakdown(template, selectedFundingMonths)}</div>
              <button class="button primary wide" type="submit" ${canCreateOrder ? "" : "disabled"}>
                ${
                  signedIn
                    ? !paymentConfigMatches()
                      ? "Payment configuration mismatch"
                      : !relayerReadyForOrders()
                        ? "Payment service unavailable"
                        : !factoryPlanAvailable(selectedFundingMonths)
                          ? "Selected plan needs more cycles"
                      : publicConfig?.ordersEnabled
                        ? "Create deployment order"
                        : "New orders are paused"
                    : "Sign in to create an order"
                }
              </button>
            </form>
            <aside class="order-pane">
              <div class="pane-top">
                <span class="section-label">${managingLiveApp ? "Manage live app" : "Live order state"}</span>
                <span class="pulse"></span>
              </div>
              ${
                managingOrder
                  ? `<button class="button ghost new-deployment-button" id="new-deployment-button" type="button">Configure new deployment</button>`
                  : ""
              }
              ${renderCurrentOrder()}
            </aside>
          </div>
        </section>

        <section class="apps-section" id="apps">
          <div class="section-intro compact">
            <span class="section-number">02</span>
            <div><span class="kicker">Deployment registry</span><h2>Your apps, on-chain.</h2></div>
          </div>
          ${renderPrincipalPanel()}
          <div class="apps-table">${renderOrders()}</div>
        </section>

        ${renderAdmin()}

        <section class="how-section" id="how">
          <div class="section-intro compact">
            <span class="section-number">${adminAccess?.isAdmin ? "04" : "03"}</span>
            <div><span class="kicker">Chain abstraction, applied</span><h2>One outcome, four systems.</h2></div>
          </div>
          <div class="architecture">
            <article><span>01</span><strong>Express intent</strong><p>Pick a template, content, and a funding window.</p></article>
            <article><span>02</span><strong>Route payment</strong><p>NEAR 1Click quotes the exact source-token amount for the fixed settlement target.</p></article>
            <article><span>03</span><strong>Verify settlement</strong><p>The authorized relayer submits a replay-safe proof to ICP.</p></article>
            <article><span>04</span><strong>Create canister</strong><p>The factory allocates cycles, installs approved Wasm, and assigns ownership.</p></article>
          </div>
        </section>
      </main>
      <footer><span>NearLaunch for ICP</span><span>Outcome-driven deployment infrastructure</span><a href="https://docs.near-intents.org/" target="_blank" rel="noreferrer">NEAR Intents docs ^</a></footer>
      ${notice ? `<div class="toast">${html(notice)}</div>` : ""}
    </div>
  `;

  bindEvents();
  syncBusyDom();
}

function bindEvents(): void {
  document.querySelector("#identity-button")?.addEventListener("click", () => {
    void signIn();
  });
  document.querySelector("#sign-out-button")?.addEventListener("click", () => {
    void signOut();
  });
  document.querySelectorAll<HTMLElement>("[data-copy-principal]").forEach((button) => {
    button.addEventListener("click", () => {
      void copyPrincipal();
    });
  });
  document.querySelector<HTMLInputElement>("#principal-value")?.addEventListener("click", (event) => {
    if (event.currentTarget instanceof HTMLInputElement) {
      event.currentTarget.select();
    }
  });

  document.querySelectorAll<HTMLElement>("[data-template]").forEach((element) => {
    element.addEventListener("click", () => {
      selectedTemplate = element.dataset.template || selectedTemplate;
      render();
    });
  });

  document.querySelector("#new-deployment-button")?.addEventListener("click", () => {
    currentOrder = null;
    currentQuote = null;
    notice = "Configure a new deployment below.";
    render();
  });

  document.querySelector<HTMLFormElement>("#launch-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.currentTarget instanceof HTMLFormElement) {
      void createOrder(event.currentTarget);
    }
  });
  document
    .querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      "#launch-form input:not([name='fundingMonths']):not([type='file']):not([name='accentColorPicker']), #launch-form textarea",
    )
    .forEach((field) => {
      field.addEventListener("input", () => {
        const form = field.closest("form");
        if (form instanceof HTMLFormElement) syncAccentColorFields(form);
        refreshDraftPreview();
      });
    });
  document
    .querySelectorAll<HTMLInputElement>("#launch-form input[name='accentColorPicker']")
    .forEach((field) => {
      field.addEventListener("input", () => {
        const form = field.closest("form");
        if (form instanceof HTMLFormElement) syncAccentColorFields(form);
        refreshDraftPreview();
      });
    });
  document.querySelectorAll<HTMLInputElement>("#launch-form [data-image-upload]").forEach((field) => {
    field.addEventListener("change", () => {
      void handleImageUpload(field, refreshDraftPreview);
    });
  });
  const launchForm = document.querySelector<HTMLFormElement>("#launch-form");
  if (launchForm) {
    bindProjectsEditor(launchForm, refreshDraftPreview);
  }

  document.querySelectorAll<HTMLInputElement>('input[name="fundingMonths"]').forEach((input) => {
    input.addEventListener("change", () => updatePricingPreview(Number(input.value)));
  });

  document.querySelector("#origin-asset")?.addEventListener("change", updateRefundHelp);
  document.querySelector("#quote-button")?.addEventListener("click", () => {
    void requestQuote();
  });
  document.querySelector("#mock-settle-button")?.addEventListener("click", () => {
    void settleMockPayment();
  });
  document.querySelector("#submit-tx-button")?.addEventListener("click", () => {
    void submitDepositTransaction();
  });
  document.querySelector("#check-status-button")?.addEventListener("click", () => {
    void refreshPaymentStatus();
  });
  document.querySelector("#deploy-button")?.addEventListener("click", () => {
    void deployCurrentOrder();
  });
  document.querySelector("#cancel-order-button")?.addEventListener("click", () => {
    void cancelCurrentOrder();
  });
  document.querySelector<HTMLFormElement>("#live-config-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.currentTarget instanceof HTMLFormElement) {
      void saveLivePortfolioConfig(event.currentTarget);
    }
  });
  document
    .querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      "#live-config-form input:not([type='file']):not([name='accentColorPicker']), #live-config-form textarea",
    )
    .forEach((field) => {
      field.addEventListener("input", () => {
        const form = field.closest("form");
        if (form instanceof HTMLFormElement) syncAccentColorFields(form);
        refreshLivePreview();
      });
    });
  document
    .querySelectorAll<HTMLInputElement>("#live-config-form input[name='accentColorPicker']")
    .forEach((field) => {
      field.addEventListener("input", () => {
        const form = field.closest("form");
        if (form instanceof HTMLFormElement) syncAccentColorFields(form);
        refreshLivePreview();
      });
    });
  document.querySelectorAll<HTMLInputElement>("#live-config-form [data-image-upload]").forEach((field) => {
    field.addEventListener("change", () => {
      void handleImageUpload(field, refreshLivePreview);
    });
  });
  const liveConfigForm = document.querySelector<HTMLFormElement>("#live-config-form");
  if (liveConfigForm) {
    bindProjectsEditor(liveConfigForm, refreshLivePreview);
  }

  document.querySelectorAll<HTMLElement>("[data-order]").forEach((row) => {
    row.addEventListener("click", () => {
      const id = row.dataset.order;
      const order = orders.find((candidate) => candidate.id.toString() === id);
      if (order) void selectOrder(order);
    });
  });

  document.querySelector<HTMLFormElement>("#pricing-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.currentTarget instanceof HTMLFormElement) {
      void savePricing(event.currentTarget);
    }
  });
  document.querySelector("#cycle-preset-button")?.addEventListener("click", () => {
    void applyConservativeCyclePreset();
  });
  document.querySelector<HTMLFormElement>("#payment-config-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.currentTarget instanceof HTMLFormElement) {
      void savePaymentConfig(event.currentTarget);
    }
  });
  document.querySelector("#toggle-orders-button")?.addEventListener("click", () => {
    void toggleOrders();
  });
  document.querySelector<HTMLFormElement>("#admin-add-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.currentTarget instanceof HTMLFormElement) {
      void addAdmin(event.currentTarget);
    }
  });
  document.querySelector<HTMLFormElement>("#relayer-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.currentTarget instanceof HTMLFormElement) {
      void updateRelayer(event.currentTarget);
    }
  });
  document.querySelectorAll<HTMLFormElement>("[data-template-admin]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveTemplate(form);
    });
  });
  document.querySelectorAll<HTMLElement>("[data-remove-admin]").forEach((button) => {
    button.addEventListener("click", () => {
      const value = button.dataset.removeAdmin;
      if (value) void removeAdmin(value);
    });
  });
}

function updatePricingPreview(months: number): void {
  selectedFundingMonths = months;
  const breakdown = pricingBreakdown(activeTemplate(), months);
  const preview = document.querySelector("#price-preview");
  const details = document.querySelector("#pricing-breakdown");
  if (preview && breakdown) {
    preview.textContent = `fixed ${money(breakdown.totalUsdCents)} ${publicConfig?.paymentDisplay.priceCurrency || "USD"}`;
  }
  if (details) details.innerHTML = renderPriceBreakdown(activeTemplate(), months);
}

function previewConfigFromForm(
  form: HTMLFormElement,
  fallback?: AppPreviewConfig,
): AppPreviewConfig {
  const data = new FormData(form);
  return resolvePreviewConfig(
    {
      name: String(data.get("name") || ""),
      headline: String(data.get("headline") || ""),
      description: String(data.get("description") || ""),
      accentColor: String(data.get("accentColor") || ""),
      primaryLink: String(data.get("primaryLink") || ""),
      contact: String(data.get("contact") || ""),
      about: String(data.get("about") || ""),
      heroImageUrl: String(data.get("heroImageUrl") || ""),
      resumeUrl: String(data.get("resumeUrl") || ""),
      skills: splitList(String(data.get("skills") || ""), 12),
      socialLinks: linksFromText(String(data.get("socialLinks") || "")),
      projects: projectsFromForm(form),
    },
    fallback,
  );
}

function refreshDraftPreview(): void {
  const form = document.querySelector<HTMLFormElement>("#launch-form");
  const frame = document.querySelector<HTMLIFrameElement>(
    "#draft-preview-frame",
  );
  if (!form || !frame) return;
  draftConfig = previewConfigFromForm(form);
  frame.srcdoc = appPreviewDocument(draftConfig, selectedTemplate);
}

function refreshLivePreview(): void {
  const form = document.querySelector<HTMLFormElement>("#live-config-form");
  const frame = document.querySelector<HTMLIFrameElement>(
    "#live-preview-frame",
  );
  if (!form || !frame || !currentOrder) return;
  const fallback = fromCanisterConfig(currentOrder.config as CanisterAppConfig);
  frame.srcdoc = appPreviewDocument(
    previewConfigFromForm(form, fallback),
    currentOrder.templateId,
  );
}

function syncAccentColorFields(form: HTMLFormElement): void {
  const picker = form.elements.namedItem("accentColorPicker");
  const accent = form.elements.namedItem("accentColor");
  if (!(picker instanceof HTMLInputElement) || !(accent instanceof HTMLInputElement)) {
    return;
  }

  if (document.activeElement === picker) {
    accent.value = picker.value;
    return;
  }
  if (HEX_COLOR_PATTERN.test(accent.value)) {
    picker.value = accent.value;
  }
}

async function handleImageUpload(
  input: HTMLInputElement,
  refreshPreview: () => void,
): Promise<void> {
  const fieldName = input.dataset.imageUpload;
  const file = input.files?.[0];
  const form = input.closest("form");
  const status = form?.querySelector<HTMLElement>(
    `[data-image-status="${fieldName}"]`,
  );
  if (!fieldName || !file || !form) return;

  try {
    if (status) status.textContent = "Processing image...";
    const dataUrl = await imageFileToDataUrl(file);
    const target = form.elements.namedItem(fieldName);
    if (!(target instanceof HTMLInputElement)) {
      throw new Error("Image field is unavailable.");
    }
    target.value = dataUrl;
    refreshPreview();
    if (status) {
      status.textContent =
        "Image uploaded into this app config. Save the app to publish it.";
    }
  } catch (error) {
    if (status) {
      status.textContent = error instanceof Error ? error.message : String(error);
    }
  } finally {
    input.value = "";
  }
}

function updateRefundHelp(): void {
  const assetId = document.querySelector<HTMLSelectElement>("#origin-asset")?.value;
  const token = tokens.find((candidate) => candidate.assetId === assetId);
  const help = document.querySelector("#refund-help");
  if (help && token) {
    help.textContent = `Use an address on ${token.blockchain} that can receive ${token.symbol}. It is used only if the swap is refunded.`;
  }
}

async function readApiResponse<T>(
  response: Response,
  fallbackMessage: string,
): Promise<T> {
  const responseText = await response.text();
  let payload: unknown = {};
  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    payload = { error: responseText };
  }

  if (!response.ok) {
    const errorPayload = payload as {
      error?: unknown;
      message?: unknown;
      code?: unknown;
    };
    const message =
      typeof errorPayload.error === "string"
        ? errorPayload.error
        : typeof errorPayload.message === "string"
          ? errorPayload.message
          : `${fallbackMessage} HTTP ${response.status}.`;
    const code =
      typeof errorPayload.code === "string" ? ` (${errorPayload.code})` : "";
    throw new Error(`${message}${code}`);
  }

  return payload as T;
}

function syncBusyDom(): void {
  app.setAttribute("aria-busy", busy ? "true" : "false");
  document.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    if (busy) {
      if (!button.disabled) {
        button.disabled = true;
        button.dataset.busyDisabled = "true";
      }
    } else if (button.dataset.busyDisabled === "true") {
      button.disabled = false;
      delete button.dataset.busyDisabled;
    }
  });

  let indicator = document.querySelector<HTMLElement>(".busy-toast");
  if (busy) {
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.className = "busy-toast";
      indicator.setAttribute("role", "status");
      indicator.setAttribute("aria-live", "polite");
      document.body.append(indicator);
    }
    indicator.textContent = busyMessage || "Working...";
  } else {
    indicator?.remove();
  }
}

async function withBusy(
  task: () => Promise<void>,
  message = "Working on ICP...",
): Promise<void> {
  if (busy) return;
  busy = true;
  busyMessage = message;
  notice = "";
  syncBusyDom();
  try {
    await task();
  } catch (error) {
    notice = error instanceof Error ? error.message : String(error);
  } finally {
    busy = false;
    busyMessage = "";
    render();
  }
}

async function copyPrincipal(): Promise<void> {
  if (!principal) return;
  let copied = false;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(principal);
      copied = true;
    }
  } catch {
    copied = false;
  }

  if (!copied) {
    const existingField =
      document.querySelector<HTMLInputElement>("#principal-value");
    const field = existingField || document.createElement("textarea");
    if (!existingField) {
      field.value = principal;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.append(field);
    }
    field.focus();
    field.select();
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    if (!existingField) field.remove();
  }

  notice = copied
    ? "Principal ID copied."
    : "Clipboard access is blocked. Your full principal is shown below; select it and press Ctrl+C or Command+C.";
  render();
  if (!copied) {
    requestAnimationFrame(() => {
      const field = document.querySelector<HTMLInputElement>("#principal-value");
      field?.focus();
      field?.select();
    });
  }
}

async function signIn(): Promise<void> {
  await withBusy(async () => {
    const identity = await authClient.signIn({
      maxTimeToLive: 8n * 3_600_000_000_000n,
    });
    signedIn = true;
    principal = identity.getPrincipal().toText();
    actor = createLauncherActor(identity);
    factoryActor = createLauncherFactoryActor(identity);
    await Promise.all([loadOrders(), loadAdminAccess()]);
    currentOrder = orders[0] || null;
    if (currentOrder) await restoreQuote(currentOrder);
    notice = "Internet Identity connected.";
  }, "Opening Internet Identity...");
}

async function signOut(): Promise<void> {
  await withBusy(async () => {
    await authClient.signOut();
    signedIn = false;
    principal = "";
    actor = createLauncherActor();
    factoryActor = createLauncherFactoryActor();
    orders = [];
    currentOrder = null;
    currentQuote = null;
    admins = [];
    await loadAdminAccess();
    notice = "Signed out.";
  }, "Signing out...");
}

async function createOrder(form: HTMLFormElement): Promise<void> {
  await withBusy(async () => {
    if (!signedIn || !actor) throw new Error("Sign in before creating an order.");
    const data = new FormData(form);
    syncAccentColorFields(form);
    draftConfig = previewConfigFromForm(form);
    const projectsError = validateProjectsInForm(form, draftConfig.projects);
    if (projectsError) {
      throw new Error(projectsError);
    }
    const validationError = validatePreviewConfig(draftConfig);
    if (validationError) {
      throw new Error(validationError);
    }
    const result = await actor.createDeploymentOrder({
      templateId: selectedTemplate,
      fundingMonths: BigInt(String(data.get("fundingMonths"))),
      config: toCanisterConfig(draftConfig),
    });
    currentOrder = unwrapResult(result);
    currentQuote = null;
    paymentError = "";
    await loadOrders();
    notice = `Order #${currentOrder.id.toString()} created on ICP.`;
  }, "Creating deployment order...");
}

async function requestQuote(): Promise<void> {
  await withBusy(async () => {
    try {
      paymentError = "";
      if (!actor || !currentOrder) {
        throw new Error("Create a deployment order first.");
      }
      const originAsset =
        document.querySelector<HTMLSelectElement>("#origin-asset")?.value;
      const refundTo =
        document.querySelector<HTMLInputElement>("#refund-address")?.value.trim();
      if (!originAsset || !refundTo) {
        throw new Error("Choose a token and enter its refund address.");
      }

      const authorization = unwrapText(
        await actor.authorizePaymentQuote(currentOrder.id),
      );
      const response = await fetch(`${RELAYER_URL}/api/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          authorization,
          orderId: currentOrder.id.toString(),
          originAsset,
          refundTo,
          expectedSettlementAmount:
            currentOrder.expectedSettlementAmount.toString(),
          expectedAmountUsdCents:
            currentOrder.expectedAmountUsdCents.toString(),
          destinationAsset: currentOrder.settlementAsset,
        }),
      });
      currentQuote = await readApiResponse<QuoteView>(
        response,
        "Could not create the payment quote.",
      );
      await refreshCurrentOrder();
      notice = currentQuote.mock
        ? "Test quote created. No real funds will move."
        : "Live NEAR Intents quote created.";
    } catch (error) {
      paymentError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }, "Requesting payment quote...");
}

async function restoreQuote(order: DeploymentOrder): Promise<void> {
  currentQuote = null;
  if (!order.depositAddress) return;
  try {
    const query = new URLSearchParams({ depositAddress: order.depositAddress });
    const response = await fetch(`${RELAYER_URL}/api/quote?${query.toString()}`);
    if (response.ok) currentQuote = (await response.json()) as QuoteView;
  } catch {
    currentQuote = null;
  }
}

async function selectOrder(order: DeploymentOrder): Promise<void> {
  await withBusy(async () => {
    currentOrder = order;
    await restoreQuote(order);
    location.hash = "#launch";
  }, "Loading deployment...");
}

async function settleMockPayment(): Promise<void> {
  await withBusy(async () => {
    if (!currentQuote) throw new Error("No active quote.");
    const response = await fetch(`${RELAYER_URL}/api/mock/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId: currentQuote.orderId,
        depositAddress: currentQuote.depositAddress,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Mock settlement failed.");
    currentQuote = { ...currentQuote, status: payload.status, settled: true };
    await refreshCurrentOrder();
    await loadOrders();
    notice = "Simulated payment proof accepted by the ICP backend.";
  }, "Submitting simulated settlement...");
}

async function submitDepositTransaction(): Promise<void> {
  await withBusy(async () => {
    if (!currentQuote) throw new Error("No active quote.");
    const txHash = document.querySelector<HTMLInputElement>("#deposit-tx-hash")?.value.trim();
    if (!txHash) throw new Error("Enter the deposit transaction hash.");
    const response = await fetch(`${RELAYER_URL}/api/deposit/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        depositAddress: currentQuote.depositAddress,
        txHash,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Transaction submission failed.");
    notice = "Deposit transaction submitted to NEAR Intents.";
  }, "Submitting transaction hash...");
}

async function refreshPaymentStatus(): Promise<void> {
  await withBusy(async () => {
    if (!currentQuote) throw new Error("No active quote.");
    const query = new URLSearchParams({
      depositAddress: currentQuote.depositAddress,
      ...(currentQuote.depositMemo ? { depositMemo: currentQuote.depositMemo } : {}),
    });
    const response = await fetch(`${RELAYER_URL}/api/status?${query.toString()}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Status lookup failed.");
    currentQuote = { ...currentQuote, status: payload.status };
    await refreshCurrentOrder();
    await loadOrders();
    notice = `Payment status: ${paymentStatusLabel(payload.status)}.`;
  }, "Checking payment status...");
}

async function deployCurrentOrder(): Promise<void> {
  await withBusy(async () => {
    if (!actor || !currentOrder) throw new Error("No deployment order selected.");
    currentOrder = unwrapResult(await actor.deployPaidOrder(currentOrder.id));
    await Promise.all([loadOrders(), loadFactoryReadiness()]);
    notice = "The factory installed your app canister.";
  }, "Deploying app canister...");
}

async function saveLivePortfolioConfig(form: HTMLFormElement): Promise<void> {
  await withBusy(async () => {
    if (!signedIn || !actor) {
      throw new Error("Sign in with Internet Identity before editing a live app.");
    }
    if (!currentOrder?.createdCanisterId) {
      throw new Error("This deployment does not have a live app canister yet.");
    }

    syncAccentColorFields(form);
    const fallback = fromCanisterConfig(currentOrder.config as CanisterAppConfig);
    const nextConfig = previewConfigFromForm(form, fallback);
    const projectsError = validateProjectsInForm(form, nextConfig.projects);
    if (projectsError) {
      throw new Error(projectsError);
    }
    const validationError = validatePreviewConfig(nextConfig);
    if (validationError) {
      throw new Error(validationError);
    }

    currentOrder = unwrapResult(
      await actor.updateDeploymentOrderConfig(
        currentOrder.id,
        toCanisterConfig(nextConfig),
      ),
    );
    await loadOrders();
    notice = "Live app updated.";
  }, "Updating the live app canister...");
}

async function cancelCurrentOrder(): Promise<void> {
  await withBusy(async () => {
    if (!actor || !currentOrder) {
      throw new Error("No deployment order selected.");
    }

    const order = currentOrder;
    const confirmed = window.confirm(
      `Cancel order #${order.id.toString()}? It will be removed from your dashboard and cannot be paid or deployed.`,
    );
    if (!confirmed) return;

    if (order.paymentQuoteId || order.depositAddress) {
      if (!order.depositAddress) {
        throw new Error("This order's payment quote is incomplete.");
      }
      const authorization = unwrapText(
        await actor.authorizeDeploymentCancellation(order.id),
      );
      const response = await fetch(`${RELAYER_URL}/api/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: order.id.toString(),
          depositAddress: order.depositAddress,
          authorization,
        }),
      });
      await readApiResponse<{ ok: boolean; status: string }>(
        response,
        "Could not cancel the quoted order.",
      );
    } else {
      unwrapResult(await actor.cancelDeploymentOrder(order.id));
    }

    currentQuote = null;
    paymentError = "";
    await loadOrders();
    currentOrder = orders[0] || null;
    if (currentOrder) await restoreQuote(currentOrder);
    notice = `Order #${order.id.toString()} canceled.`;
  }, "Canceling order...");
}

async function refreshCurrentOrder(): Promise<void> {
  if (!actor || !currentOrder) return;
  const order = await actor.getDeploymentOrder(currentOrder.id);
  if (order) currentOrder = order;
}

async function loadOrders(): Promise<void> {
  if (!actor || !signedIn) return;
  orders = await actor.getMyDeployments(0n, 50n);
  orders.sort((a, b) => (a.id === b.id ? 0 : a.id > b.id ? -1 : 1));
}

async function loadPublicData(): Promise<void> {
  if (!actor) return;
  const [templateList, platformStats, config] = await Promise.all([
    actor.listTemplates(),
    actor.getStats(),
    actor.getPublicConfig(),
  ]);
  templates = templateList;
  stats = platformStats;
  publicConfig = config;
  if (!templates.some((template) => template.id === selectedTemplate)) {
    selectedTemplate = templates[0]?.id || "";
  }
}

async function loadAdminAccess(): Promise<void> {
  if (!actor) return;
  adminAccess = await actor.getAdminAccess();
  if (adminAccess.isOwner) {
    admins = await actor.listAdmins();
  } else {
    admins = [];
  }
}

async function loadFactoryReadiness(): Promise<void> {
  if (!factoryActor || !publicConfig) return;
  const required =
    publicConfig.pricing.creationCycles +
    publicConfig.pricing.cycleBuffer +
    6n * publicConfig.pricing.monthlyCycles;
  factoryReadiness = await factoryActor.getReadiness(required);
  const supported = supportedFundingMonths();
  const firstSupported = supported[0];
  if (
    firstSupported !== undefined &&
    !supported.includes(selectedFundingMonths)
  ) {
    selectedFundingMonths = firstSupported;
  }
}

async function loadRelayerHealth(): Promise<void> {
  try {
    const response = await fetch(`${RELAYER_URL}/health`);
    if (response.ok) relayerHealth = (await response.json()) as RelayerHealth;
  } catch {
    relayerHealth = null;
  }
}

async function loadTokens(): Promise<void> {
  try {
    const response = await fetch(`${RELAYER_URL}/api/tokens`);
    if (!response.ok) return;
    const payload = (await response.json()) as { tokens: Token[] };
    const preferred = ["near", "eth", "base", "arb", "sol", "btc"];
    tokens = payload.tokens
      .filter((token) => token.price > 0)
      .sort((a, b) => {
        const aRank = preferred.indexOf(a.blockchain);
        const bRank = preferred.indexOf(b.blockchain);
        return (aRank < 0 ? 99 : aRank) - (bRank < 0 ? 99 : bRank);
      });
  } catch {
    tokens = [];
  }
}

async function savePricing(form: HTMLFormElement): Promise<void> {
  await withBusy(async () => {
    if (!actor) throw new Error("Admin actor is unavailable.");
    const data = new FormData(form);
    unwrapUnit(
      await actor.setPricingConfig({
        serviceFeeUsdCents: decimalToUnits(String(data.get("serviceFee")), 2),
        monthlyFundingUsdCents: decimalToUnits(String(data.get("monthlyFunding")), 2),
        creationCycles: decimalToUnits(String(data.get("creationCycles")), 12),
        monthlyCycles: decimalToUnits(String(data.get("monthlyCycles")), 12),
        cycleBuffer: decimalToUnits(String(data.get("cycleBuffer")), 12),
      }),
    );
    await loadPublicData();
    await loadFactoryReadiness();
    notice = "Pricing updated for future orders.";
  }, "Saving pricing...");
}

async function applyConservativeCyclePreset(): Promise<void> {
  await withBusy(async () => {
    if (!actor) throw new Error("Admin actor is unavailable.");
    unwrapUnit(await actor.applyConservativeCyclePreset());
    await loadPublicData();
    await loadFactoryReadiness();
    notice =
      "Conservative cycle preset applied. USD prices were left unchanged.";
  }, "Applying cycle preset...");
}

async function savePaymentConfig(form: HTMLFormElement): Promise<void> {
  await withBusy(async () => {
    if (!actor) throw new Error("Admin actor is unavailable.");
    const data = new FormData(form);
    unwrapUnit(
      await actor.setSettlementConfig({
        assetId: String(data.get("assetId") || "").trim(),
        decimals: BigInt(String(data.get("decimals") || "0")),
      }),
    );
    unwrapUnit(
      await actor.setPaymentDisplayConfig({
        priceCurrency: String(data.get("priceCurrency") || "").trim(),
        settlementSymbol: String(data.get("settlementSymbol") || "").trim(),
        settlementNetwork: String(data.get("settlementNetwork") || "").trim(),
      }),
    );
    await loadPublicData();
    notice = "Payment configuration updated. Keep the relayer settlement asset in sync.";
  }, "Saving payment configuration...");
}

async function toggleOrders(): Promise<void> {
  await withBusy(async () => {
    if (!actor || !publicConfig) throw new Error("Admin actor is unavailable.");
    unwrapUnit(await actor.setOrdersEnabled(!publicConfig.ordersEnabled));
    await loadPublicData();
    notice = publicConfig.ordersEnabled
      ? "New orders enabled."
      : "New orders paused.";
  }, "Updating order availability...");
}

async function saveTemplate(form: HTMLFormElement): Promise<void> {
  await withBusy(async () => {
    if (!actor) throw new Error("Admin actor is unavailable.");
    const templateId = form.dataset.templateAdmin;
    const template = templates.find((candidate) => candidate.id === templateId);
    if (!template) throw new Error("Template not found.");
    const data = new FormData(form);
    unwrapUnit(
      await actor.upsertTemplate({
        ...template,
        basePriceUsdCents: decimalToUnits(String(data.get("basePrice")), 2),
        active: data.get("active") === "on",
      }),
    );
    await loadPublicData();
    notice = `${template.name} updated.`;
  }, "Saving template...");
}

async function addAdmin(form: HTMLFormElement): Promise<void> {
  await withBusy(async () => {
    if (!actor) throw new Error("Admin actor is unavailable.");
    const data = new FormData(form);
    const newAdmin = Principal.fromText(String(data.get("principal") || "").trim());
    unwrapUnit(await actor.addAdmin(newAdmin));
    await loadAdminAccess();
    notice = "Admin principal added.";
  }, "Adding admin...");
}

async function removeAdmin(value: string): Promise<void> {
  await withBusy(async () => {
    if (!actor) throw new Error("Admin actor is unavailable.");
    unwrapUnit(await actor.removeAdmin(Principal.fromText(value)));
    await loadAdminAccess();
    notice = "Admin principal removed.";
  }, "Removing admin...");
}

async function updateRelayer(form: HTMLFormElement): Promise<void> {
  await withBusy(async () => {
    if (!actor) throw new Error("Admin actor is unavailable.");
    const data = new FormData(form);
    const nextRelayer = Principal.fromText(String(data.get("principal") || "").trim());
    unwrapUnit(await actor.setSettlementRelayer(nextRelayer));
    await loadAdminAccess();
    notice = "Settlement relayer updated.";
  }, "Updating settlement relayer...");
}

async function init(): Promise<void> {
  try {
    signedIn = authClient.isAuthenticated();
    if (signedIn) {
      const identity = await authClient.getIdentity();
      principal = identity.getPrincipal().toText();
      actor = createLauncherActor(identity);
      factoryActor = createLauncherFactoryActor(identity);
    } else {
      actor = createLauncherActor();
      factoryActor = createLauncherFactoryActor();
    }

    await loadPublicData();
    await Promise.all([
      loadTokens(),
      loadRelayerHealth(),
      loadFactoryReadiness(),
      loadAdminAccess(),
    ]);
    if (signedIn) {
      await loadOrders();
      currentOrder = orders[0] || null;
      if (currentOrder) await restoreQuote(currentOrder);
    }
  } catch (error) {
    notice = error instanceof Error ? error.message : String(error);
  }
  render();
}

void init();
