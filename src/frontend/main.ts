import { AuthClient } from "@icp-sdk/auth/client";
import { safeGetCanisterEnv } from "@icp-sdk/core/agent/canister-env";
import { Principal } from "@icp-sdk/core/principal";
import {
  createActor,
  type AdminAccess,
  type ChildCycleStatus,
  type DeploymentOrder,
  DeploymentStatus,
  OrderKind,
  type PricingBreakdown,
  type PublicConfig,
  type ResultOrder,
  type ResultText,
  type ResultUnit,
  type RevenueSummary,
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
import {
  formatStaticSiteSize,
  isStaticSiteTemplate,
  planStaticSiteFiles,
  uploadStaticSiteFiles,
  validateStaticSiteFiles,
} from "./staticSite";
import { HttpAgent } from "@icp-sdk/core/agent";
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
  settlementRecipient?: string;
  settlementRecipientType?: string;
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

type CyclesRate = {
  usdPerTrillionCents: number;
  icpUsd?: number | null;
  source?: string;
  fetchedAt?: number;
  syncedToBackend?: boolean;
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

// Prefer the icp0.io gateway. Production RELAYER_ALLOWED_ORIGIN historically
// listed only that host; visiting *.icp.net then fails browser CORS and the UI
// reports the payment service as unreachable. After the relayer expands
// sibling gateways, either host works — but keep traffic on icp0.io so older
// relayer processes and bookmarked icp.net links still function.
(() => {
  if (isLocalFrontend) return;
  const host = window.location.hostname.toLowerCase();
  const match = host.match(/^([a-z0-9-]+)(?:\.raw)?\.icp\.net$/i);
  if (!match) return;
  const target = new URL(window.location.href);
  target.hostname = `${match[1]}.icp0.io`;
  window.location.replace(target.toString());
})();
const TRILLION_CYCLES = 1_000_000_000_000n;
const INITIAL_DEPLOY_CYCLES = 2n * TRILLION_CYCLES;
const MIN_TOP_UP_CYCLES = 100_000_000_000n;
const MAX_TOP_UP_CYCLES = 3n * TRILLION_CYCLES;
const TOP_UP_PRESETS = [
  500_000_000_000n,
  TRILLION_CYCLES,
  2n * TRILLION_CYCLES,
] as const;
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
/** Static site is the default Launch selection — most flexible BYO hosting path. */
let selectedTemplate = "static-site";
let staticSiteFiles: File[] = [];
let staticSiteFilesByOrderId = new Map<bigint, File[]>();
let staticSiteLiveFiles: File[] = [];
let selectedTopUpCycles = TRILLION_CYCLES;
let deployBreakdown: PricingBreakdown | null = null;
let topUpBreakdown: PricingBreakdown | null = null;
let cycleBalances = new Map<string, ChildCycleStatus>();
let cyclesRate: CyclesRate | null = null;
let currentOrder: DeploymentOrder | null = null;
let currentQuote: QuoteView | null = null;
let tokens: Token[] = [];
let stats = { totalOrders: 0n, liveApps: 0n, templates: 0n };
let publicConfig: PublicConfig | null = null;
let adminAccess: AdminAccess | null = null;
let admins: Principal[] = [];
let factoryReadiness: FactoryReadiness | null = null;
let relayerHealth: RelayerHealth | null = null;
let lastRelayerError = "";
let revenueSummary: RevenueSummary | null = null;
let notice = "";
let paymentError = "";
let busy = false;
let busyMessage = "";
/** Client-side page: only one primary workspace is shown at a time. */
type AppView = "home" | "launch" | "apps" | "how" | "admin";
let currentView: AppView = parseViewFromHash();
/** Section open-state for portfolio/landing customization panels. */
let openConfigSections: Record<string, boolean> = {
  branding: true,
  content: true,
  links: true,
  skills: true,
  socials: true,
  projects: true,
  preview: true,
};
/** Live app management workspace tab. */
type LiveManageTab = "content" | "cycles" | "files";
let liveManageTab: LiveManageTab = "content";

const DEFAULT_PORTFOLIO_CONFIG: AppPreviewConfig = {
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

const DEFAULT_STARTUP_CONFIG: AppPreviewConfig = {
  name: "Northstar",
  headline: "Ship the product your users already want.",
  description:
    "A focused landing page for your product story, primary call to action, and social proof — hosted on the Internet Computer.",
  accentColor: "#4f8cff",
  primaryLink: "https://example.com",
  contact: "hello@example.com",
  about:
    "Northstar helps teams go from intent to a live product page with clear messaging, links, and owner-managed updates after launch.",
  heroImageUrl: "",
  resumeUrl: "",
  skills: ["Product", "Growth", "ICP"],
  socialLinks: [
    { labelText: "Twitter", url: "https://twitter.com" },
    { labelText: "Docs", url: "https://example.com/docs" },
  ],
  projects: [
    {
      title: "Feature highlight",
      description: "Describe a capability, integration, or case study your visitors should notice first.",
      url: "https://example.com/feature",
      imageUrl: "",
      tags: ["Launch", "Product"],
    },
  ],
};

let draftConfig: AppPreviewConfig = staticSiteConfigFromDraft("My static site", []);

function parseViewFromHash(): AppView {
  const raw = (location.hash || "#home").replace(/^#/, "").split(/[/?]/)[0] || "home";
  if (raw === "launch" || raw === "apps" || raw === "how" || raw === "admin" || raw === "home") {
    return raw;
  }
  // Legacy in-page anchors from older builds still land on the right screen.
  if (raw === "" || raw === "top") return "home";
  return "home";
}

function setView(view: AppView, options: { replace?: boolean } = {}): void {
  const nextHash = view === "home" ? "#home" : `#${view}`;
  if (options.replace) {
    history.replaceState(null, "", nextHash);
  } else if (location.hash !== nextHash) {
    location.hash = nextHash;
  }
  currentView = view;
}

function syncViewFromHash(): void {
  const next = parseViewFromHash();
  if (next === "admin" && !adminAccess?.isAdmin) {
    currentView = "home";
    history.replaceState(null, "", "#home");
    return;
  }
  currentView = next;
}

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
const MAX_SOCIAL_LINKS = 6;

function emptyProject(): AppPreviewProject {
  return { title: "", description: "", url: "", imageUrl: "", tags: [] };
}

function emptySocialLink(): AppPreviewLink {
  return { labelText: "", url: "" };
}

function defaultConfigForTemplate(templateId: string): AppPreviewConfig {
  if (isStaticSiteTemplate(templateId)) {
    return staticSiteConfigFromDraft("My static site", staticSiteFiles);
  }
  if (templateId === "startup") {
    return { ...DEFAULT_STARTUP_CONFIG, socialLinks: [...DEFAULT_STARTUP_CONFIG.socialLinks], skills: [...DEFAULT_STARTUP_CONFIG.skills], projects: DEFAULT_STARTUP_CONFIG.projects.map((project) => ({ ...project, tags: [...project.tags] })) };
  }
  return {
    ...DEFAULT_PORTFOLIO_CONFIG,
    socialLinks: [...DEFAULT_PORTFOLIO_CONFIG.socialLinks],
    skills: [...DEFAULT_PORTFOLIO_CONFIG.skills],
    projects: DEFAULT_PORTFOLIO_CONFIG.projects.map((project) => ({
      ...project,
      tags: [...project.tags],
    })),
  };
}

function configSectionOpen(id: string, defaultOpen = true): boolean {
  if (id in openConfigSections) return openConfigSections[id] !== false;
  return defaultOpen;
}

function renderConfigSection(
  id: string,
  title: string,
  help: string,
  body: string,
  defaultOpen = true,
): string {
  const open = configSectionOpen(id, defaultOpen);
  return `
    <details class="config-section" data-config-section="${html(id)}" ${open ? "open" : ""}>
      <summary>
        <span>${html(title)}</span>
        <span class="muted config-section-help">${html(help)}</span>
      </summary>
      <div class="config-section-body">${body}</div>
    </details>
  `;
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

function configuredInitialDeployCycles(): bigint {
  return publicConfig?.pricing.initialDeployCycles ?? INITIAL_DEPLOY_CYCLES;
}

function configuredMarkupBps(): bigint {
  return publicConfig?.pricing.cyclesMarkupBps ?? 5_000n;
}

function isTopUpOrder(order: DeploymentOrder): boolean {
  return order.orderKind === OrderKind.TopUp;
}

function unwrapPricing(
  result: { __kind__: "ok"; ok: PricingBreakdown } | { __kind__: "err"; err: string },
): PricingBreakdown | null {
  if (result.__kind__ === "err") return null;
  return result.ok;
}

function markupPercentLabel(): string {
  return `${(Number(configuredMarkupBps()) / 100).toFixed(0)}%`;
}

function daysOfRuntime(balance: bigint, burnPerDay: bigint): string {
  if (burnPerDay === 0n) return "stable";
  const days = balance / burnPerDay;
  if (days >= 365n) return `${(Number(days) / 365).toFixed(1)} years`;
  if (days >= 1n) return `${days.toString()} days`;
  return "less than a day";
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
  if (order.createdCanisterId && window.location.hostname.endsWith(".localhost")) {
    const port = window.location.port ? `:${window.location.port}` : "";
    const hostPrefix = isStaticSiteTemplate(order.templateId) ? "" : "raw.";
    return `${window.location.protocol}//${order.createdCanisterId.toText()}.${hostPrefix}localhost${port}/`;
  }
  return order.appUrl ?? undefined;
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

function factoryDeployShortfall(): bigint | null {
  if (!factoryReadiness) return null;
  const required = configuredInitialDeployCycles() + factoryReadiness.reserveCycles;
  return required > factoryReadiness.cycleBalance
    ? required - factoryReadiness.cycleBalance
    : 0n;
}

function factoryTopUpShortfall(amount = selectedTopUpCycles): bigint | null {
  if (!factoryReadiness) return null;
  const required = amount + factoryReadiness.reserveCycles;
  return required > factoryReadiness.cycleBalance
    ? required - factoryReadiness.cycleBalance
    : 0n;
}

function factoryWasmConfigured(templateId = selectedTemplate): boolean {
  if (!factoryReadiness) return false;
  if (isStaticSiteTemplate(templateId)) {
    return factoryReadiness.assetWasmConfigured === true;
  }
  return factoryReadiness.templateWasmConfigured === true;
}

function factoryCanDeploy(): boolean {
  return factoryWasmConfigured() && factoryReadiness?.canDeploy === true;
}

function factoryCapacityMessage(): string | null {
  if (!factoryReadiness) return null;
  if (!factoryWasmConfigured()) {
    return isStaticSiteTemplate(selectedTemplate)
      ? "Static site deployments are paused until the asset canister Wasm is uploaded."
      : "Deployments are paused until the approved app template Wasm is uploaded.";
  }

  const deployShortfall = factoryDeployShortfall();
  if (deployShortfall !== null && deployShortfall > 0n) {
    return `Deployments are paused. Add at least ${cycles(deployShortfall)} cycles to the factory. Current balance: ${cycles(factoryReadiness.cycleBalance)}.`;
  }
  return null;
}

function preferredFrontendOrigin(): string {
  const host = window.location.hostname.toLowerCase();
  const match = host.match(
    /^([a-z0-9-]+)(?:\.raw)?\.(icp0\.io|icp\.net)$/i,
  );
  if (!match) return window.location.origin;
  return `https://${match[1]}.icp0.io`;
}

function renderAvailability(): string {
  const messages: string[] = [];
  if (!relayerHealth) {
    const preferred = preferredFrontendOrigin();
    const onAlternateGateway =
      preferred !== window.location.origin &&
      /\.icp\.net$/i.test(window.location.hostname);
    messages.push(
      onAlternateGateway
        ? `The payment service is blocked for this site origin (${window.location.origin}). Open ${preferred} or allow both icp0.io and icp.net origins on the relayer (RELAYER_ALLOWED_ORIGIN).`
        : lastRelayerError
          ? `The payment service is unreachable (${lastRelayerError}). New payment quotes are unavailable until the relayer connection is restored.`
          : "The payment service is unreachable. New payment quotes are unavailable until the relayer connection is restored.",
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
  if (factoryReadiness && !factoryWasmConfigured()) {
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

function orderedActiveTemplates(): Template[] {
  const active = templates.filter((template) => template.active);
  const rank = (id: string): number => {
    if (id === "static-site") return 0;
    if (id === "portfolio") return 1;
    if (id === "startup") return 2;
    return 10;
  };
  return [...active].sort((left, right) => rank(left.id) - rank(right.id));
}

function renderTemplateCards(): string {
  return orderedActiveTemplates()
    .map((template, index) => {
      const minimum =
        template.id === selectedTemplate && deployBreakdown
          ? deployBreakdown.totalUsdCents
          : template.basePriceUsdCents +
            (publicConfig?.pricing.serviceFeeUsdCents || 0n);
      const uploadBadge = isStaticSiteTemplate(template.id)
        ? `<span class="template-badge">Default · Upload files</span>`
        : template.id === "portfolio"
          ? `<span class="template-badge template-badge--soft">Customizable</span>`
          : template.id === "startup"
            ? `<span class="template-badge template-badge--soft">Landing page</span>`
            : "";
      return `
        <button class="template-card ${template.id === selectedTemplate ? "selected" : ""} ${isStaticSiteTemplate(template.id) ? "template-card--static-site" : ""}"
          data-template="${html(template.id)}" type="button">
          <span class="template-index">0${index + 1}</span>
          <span class="template-category">${html(template.category)}</span>
          ${uploadBadge}
          <strong>${html(template.name)}</strong>
          <p>${html(template.description)}</p>
          <span class="template-price">from ${money(minimum)} ${html(publicConfig?.paymentDisplay.priceCurrency || "USD")}</span>
        </button>
      `;
    })
    .join("");
}

function renderDeployPriceBreakdown(breakdown: PricingBreakdown | null): string {
  if (!breakdown || !publicConfig) return "";
  return `
    <div class="pricing-breakdown">
      <div><span>Template</span><strong>${money(breakdown.templateUsdCents)}</strong></div>
      <div><span>Deployment service</span><strong>${money(breakdown.serviceFeeUsdCents)}</strong></div>
      <div><span>Starter cycles (${cycles(breakdown.initialCycles)})</span><strong>${money(breakdown.cyclesBaseUsdCents + breakdown.cyclesMarkupUsdCents)}</strong></div>
      <div><span>Platform markup (${html(markupPercentLabel())})</span><strong>${money(breakdown.cyclesMarkupUsdCents)}</strong></div>
      <div class="pricing-total"><span>Deploy total</span><strong>${money(breakdown.totalUsdCents)} ${html(publicConfig.paymentDisplay.priceCurrency)}</strong></div>
      <p>Every new app starts with ${cycles(breakdown.initialCycles)} cycles. Top up later when your balance runs low.</p>
    </div>
  `;
}

function renderTopUpPriceBreakdown(breakdown: PricingBreakdown | null): string {
  if (!breakdown || !publicConfig) return "";
  return `
    <div class="pricing-breakdown">
      <div><span>Cycle purchase (${cycles(breakdown.initialCycles)})</span><strong>${money(breakdown.cyclesBaseUsdCents)}</strong></div>
      <div><span>Platform markup (${html(markupPercentLabel())})</span><strong>${money(breakdown.cyclesMarkupUsdCents)}</strong></div>
      <div class="pricing-total"><span>Top-up total</span><strong>${money(breakdown.totalUsdCents)} ${html(publicConfig.paymentDisplay.priceCurrency)}</strong></div>
      <p>${cycles(breakdown.initialCycles)} cycles are deposited into your app canister after payment settles.</p>
    </div>
  `;
}

function renderCycleBalancePanel(order: DeploymentOrder): string {
  const balance = cycleBalances.get(order.id.toString());
  if (!balance) {
    return `
      <div class="cycle-balance-panel">
        <span class="section-label">Canister cycles</span>
        <p class="muted">Loading live cycle balance...</p>
      </div>
    `;
  }

  return `
    <div class="cycle-balance-panel">
      <div class="cycle-balance-heading">
        <span class="section-label">Canister cycles</span>
        <button class="text-button" id="refresh-cycle-balance" type="button">Refresh</button>
      </div>
      <div class="cycle-balance-grid">
        <div><small>Current balance</small><strong>${cycles(balance.cycles)}</strong></div>
        <div><small>Daily burn (idle)</small><strong>${cycles(balance.idleCyclesBurnedPerDay)}</strong></div>
        <div><small>Estimated runway</small><strong>${html(daysOfRuntime(balance.cycles, balance.idleCyclesBurnedPerDay))}</strong></div>
      </div>
      <p class="field-help">Top up before the balance gets too low. Pricing uses the current ICP market rate plus a ${html(markupPercentLabel())} platform fee.</p>
    </div>
  `;
}

function renderTopUpPanel(order: DeploymentOrder): string {
  if (order.status !== "Live" || isTopUpOrder(order)) return "";
  const shortfall = factoryTopUpShortfall();
  const canTopUp =
    signedIn &&
    publicConfig?.ordersEnabled &&
    paymentConfigMatches() &&
    relayerReadyForOrders() &&
    shortfall === 0n &&
    !busy;

  return `
    <div class="top-up-panel">
      <div class="top-up-heading">
        <span class="section-label">Top up cycles</span>
        <span class="muted">${cyclesRate ? `Rate: ${money(BigInt(cyclesRate.usdPerTrillionCents))} / T` : "Fetching market rate..."}</span>
      </div>
      <div class="top-up-options">
        ${TOP_UP_PRESETS.map(
          (amount) => `
            <input id="topup-${amount.toString()}" type="radio" name="topUpCycles" value="${amount.toString()}" ${amount === selectedTopUpCycles ? "checked" : ""}>
            <label for="topup-${amount.toString()}">${cycles(amount)}<small>cycles</small></label>
          `,
        ).join("")}
      </div>
      <div id="topup-pricing-breakdown">${renderTopUpPriceBreakdown(topUpBreakdown)}</div>
      <button class="button secondary wide" id="create-topup-button" type="button" ${canTopUp ? "" : "disabled"}>
        ${
          !signedIn
            ? "Sign in to top up"
            : !publicConfig?.ordersEnabled
              ? "Top-ups are paused"
              : shortfall && shortfall > 0n
                ? "Factory needs more cycles"
                : "Create top-up order"
        }
      </button>
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
      : `<p class="projects-empty">No projects yet. Add up to ${MAX_PROJECTS} pieces of work to feature on your page.</p>`;

  return `
    <section class="projects-editor" data-projects-editor>
      <div class="projects-editor-header">
        <div>
          <span class="section-label">Featured projects / case studies</span>
          <p class="field-help">Each card supports title, description, link, tags, and an optional image (HTTPS or upload). Up to ${MAX_PROJECTS}.</p>
        </div>
        <button class="button secondary project-add" type="button" data-add-project ${projects.length >= MAX_PROJECTS ? "disabled" : ""}>Add project</button>
      </div>
      <div class="projects-editor-list" data-projects-list>${cards}</div>
    </section>
  `;
}

function renderSocialLinkCard(
  index: number,
  link: AppPreviewLink,
  displayNumber: number,
): string {
  return `
    <article class="social-editor-card" data-social-card data-social-index="${index}">
      <div class="project-editor-heading">
        <strong>Link ${displayNumber}</strong>
        <button class="button ghost" type="button" data-remove-social="${index}">Remove</button>
      </div>
      <div class="field-row">
        <label>Label
          <input name="social-${index}-label" maxlength="32" placeholder="GitHub" value="${html(link.labelText)}" />
        </label>
        <label>URL
          <input name="social-${index}-url" type="url" placeholder="https://..." value="${html(link.url)}" />
        </label>
      </div>
    </article>
  `;
}

function renderSocialLinksEditor(links: AppPreviewLink[]): string {
  const cards =
    links.length > 0
      ? links.map((link, index) => renderSocialLinkCard(index, link, index + 1)).join("")
      : `<p class="projects-empty">No social or external links yet. Add up to ${MAX_SOCIAL_LINKS}.</p>`;

  return `
    <section class="social-editor" data-social-editor>
      <div class="projects-editor-header">
        <div>
          <span class="section-label">Social &amp; external links</span>
          <p class="field-help">Shown as buttons on your live page (GitHub, X, Docs, etc.). Label + https URL per row.</p>
        </div>
        <button class="button secondary" type="button" data-add-social ${links.length >= MAX_SOCIAL_LINKS ? "disabled" : ""}>Add link</button>
      </div>
      <div class="social-editor-list" data-social-list>${cards}</div>
    </section>
  `;
}

function socialFieldValue(form: HTMLFormElement, index: string, suffix: string): string {
  const field = form.elements.namedItem(`social-${index}-${suffix}`);
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    return field.value;
  }
  return "";
}

function socialLinksFromForm(form: HTMLFormElement): AppPreviewLink[] {
  const cards = [...form.querySelectorAll<HTMLElement>("[data-social-card]")];
  cards.sort(
    (left, right) =>
      Number(left.dataset.socialIndex || 0) - Number(right.dataset.socialIndex || 0),
  );
  const links: AppPreviewLink[] = [];
  for (const card of cards) {
    const index = card.dataset.socialIndex;
    if (!index) continue;
    const labelText = socialFieldValue(form, index, "label").trim();
    const url = socialFieldValue(form, index, "url").trim();
    if (!labelText && !url) continue;
    links.push({ labelText, url });
  }
  if (links.length > 0) return links.slice(0, MAX_SOCIAL_LINKS);

  // Fallback for any residual textarea-based form markup.
  const legacy = form.elements.namedItem("socialLinks");
  if (legacy instanceof HTMLTextAreaElement) {
    return linksFromText(legacy.value);
  }
  return [];
}

function updateAddSocialButton(form: HTMLFormElement): void {
  const button = form.querySelector<HTMLButtonElement>("[data-add-social]");
  if (!button) return;
  button.disabled = form.querySelectorAll("[data-social-card]").length >= MAX_SOCIAL_LINKS;
}

function renumberSocialCards(form: HTMLFormElement): void {
  form.querySelectorAll<HTMLElement>("[data-social-card]").forEach((card, index) => {
    const heading = card.querySelector(".project-editor-heading strong");
    if (heading) heading.textContent = `Link ${index + 1}`;
  });
}

function addSocialToForm(form: HTMLFormElement, refreshPreview: () => void): void {
  const list = form.querySelector("[data-social-list]");
  if (!list) return;
  const cards = form.querySelectorAll("[data-social-card]");
  if (cards.length >= MAX_SOCIAL_LINKS) return;
  form.querySelector("[data-social-list] .projects-empty")?.remove();
  const indices = [...cards].map((card) =>
    Number((card as HTMLElement).dataset.socialIndex || 0),
  );
  const nextIndex = indices.length > 0 ? Math.max(...indices) + 1 : 0;
  list.insertAdjacentHTML(
    "beforeend",
    renderSocialLinkCard(nextIndex, emptySocialLink(), cards.length + 1),
  );
  updateAddSocialButton(form);
  refreshPreview();
}

function removeSocialFromForm(
  form: HTMLFormElement,
  index: string | undefined,
  refreshPreview: () => void,
): void {
  if (!index) return;
  form
    .querySelector(`[data-social-card][data-social-index="${index}"]`)
    ?.remove();
  const list = form.querySelector("[data-social-list]");
  const cards = form.querySelectorAll("[data-social-card]");
  if (cards.length === 0 && list) {
    list.innerHTML = `<p class="projects-empty">No social or external links yet. Add up to ${MAX_SOCIAL_LINKS}.</p>`;
  } else {
    renumberSocialCards(form);
  }
  updateAddSocialButton(form);
  refreshPreview();
}

function bindSocialLinksEditor(
  form: HTMLFormElement,
  refreshPreview: () => void,
): void {
  form.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest("[data-add-social]")) {
      event.preventDefault();
      addSocialToForm(form, refreshPreview);
      return;
    }
    const removeButton = target.closest<HTMLElement>("[data-remove-social]");
    if (removeButton) {
      event.preventDefault();
      removeSocialFromForm(form, removeButton.dataset.removeSocial, refreshPreview);
    }
  });
}

function renderAppConfigBuilder(
  config: AppPreviewConfig,
  templateId: string,
  options: { formId: string; frameId: string; live?: boolean },
): string {
  const isStartup = templateId === "startup";
  const nameLabel = isStartup ? "Product name" : "Display name";
  const headlineLabel = isStartup ? "Hero headline" : "Headline";
  const descriptionLabel = isStartup ? "Product pitch" : "Short bio / description";
  const aboutLabel = isStartup ? "Longer story" : "About section";
  const primaryLabel = isStartup ? "Primary CTA URL" : "Primary link";
  const secondaryLabel = isStartup ? "Secondary link (docs, waitlist…)" : "Resume / CV link";
  const skillsLabel = isStartup ? "Keywords / tags" : "Skills";
  const projectsHelp = isStartup
    ? "Feature highlights, case studies, or product modules"
    : "Selected work and case studies";

  return `
    <form class="${options.live ? "live-config-form" : "builder-config-form"}" id="${html(options.formId)}">
      ${
        options.live
          ? `
            <div class="form-heading">
              <div>
                <span class="section-label">Edit live content</span>
                <h4>Customize your deployed ${isStartup ? "landing page" : "portfolio"}</h4>
                <p class="field-help">Saves to your app canister (one update call). Preview updates as you type.</p>
              </div>
              <button class="button primary" type="submit">Save live app</button>
            </div>
          `
          : `
            <p class="builder-tip">Customize every section below. Optional blocks can be left empty and hidden on the live page. You can edit all of this again after deployment from <strong>My apps</strong>.</p>
          `
      }
      ${renderConfigSection(
        "branding",
        "Branding",
        "Name, color, hero image",
        `
          <div class="field-row">
            <label>${nameLabel}<input name="name" required maxlength="80" value="${html(config.name)}" /></label>
            ${renderAccentColorField(config.accentColor)}
          </div>
          ${renderHeroImageField(config.heroImageUrl)}
        `,
      )}
      ${renderConfigSection(
        "content",
        "Page content",
        "Headline, description, about",
        `
          <label>${headlineLabel}<input name="headline" required maxlength="140" value="${html(config.headline)}" /></label>
          <label>${descriptionLabel}<textarea name="description" required maxlength="1200" rows="3">${html(config.description)}</textarea></label>
          <label>${aboutLabel}<textarea name="about" maxlength="2000" rows="4">${html(config.about)}</textarea></label>
        `,
      )}
      ${renderConfigSection(
        "links",
        "Calls to action",
        "Primary action, contact, secondary link",
        `
          <div class="field-row">
            <label>${primaryLabel}<input name="primaryLink" type="url" placeholder="https://..." value="${html(config.primaryLink)}" /></label>
            <label>Contact (email or handle)<input name="contact" placeholder="hello@example.com" value="${html(config.contact)}" /></label>
          </div>
          <label>${secondaryLabel}<input name="resumeUrl" type="url" placeholder="https://..." value="${html(config.resumeUrl)}" /></label>
          <p class="field-help">Primary link becomes the main button (${isStartup ? "Get started" : "Explore the work"}). Secondary link becomes the outline button when set.</p>
        `,
      )}
      ${renderConfigSection(
        "skills",
        skillsLabel,
        "Up to 12 chips",
        `
          <label>${skillsLabel}
            <textarea name="skills" maxlength="500" rows="2" placeholder="Product strategy, Frontend, ICP">${html(config.skills.join(", "))}</textarea>
          </label>
          <p class="field-help">Comma-separated. Shown as chips beside your about section.</p>
        `,
      )}
      ${renderConfigSection(
        "socials",
        "Social & external links",
        "Up to 6 labeled buttons",
        renderSocialLinksEditor(config.socialLinks),
      )}
      ${renderConfigSection(
        "projects",
        projectsHelp,
        `Up to ${MAX_PROJECTS} cards`,
        renderProjectsEditor(config.projects),
      )}
      ${renderConfigSection(
        "preview",
        "Live preview",
        "Updates as you type",
        renderAppPreview(
          config,
          templateId,
          options.live ? "Updates as you edit" : "Updates as you type",
          options.frameId,
        ),
        true,
      )}
      ${
        options.live
          ? `<button class="button primary wide" type="submit">Save changes to live app</button>`
          : ""
      }
    </form>
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
  return renderAppConfigBuilder(config, templateId, {
    formId: "live-config-form",
    frameId: "live-preview-frame",
    live: true,
  });
}

function renderLiveManageTabs(order: DeploymentOrder): string {
  const isStatic = isStaticSiteTemplate(order.templateId);
  const tabs: { id: LiveManageTab; label: string }[] = isStatic
    ? [
        { id: "files", label: "Publish files" },
        { id: "cycles", label: "Cycles" },
      ]
    : [
        { id: "content", label: "Edit content" },
        { id: "cycles", label: "Cycles" },
      ];
  const fallbackTab: LiveManageTab = tabs[0]?.id ?? "content";
  const active = tabs.some((tab) => tab.id === liveManageTab)
    ? liveManageTab
    : fallbackTab;
  if (active !== liveManageTab) liveManageTab = active;

  return `
    <div class="live-manage-tabs" role="tablist" aria-label="Manage live app">
      ${tabs
        .map(
          (tab) => `
            <button class="live-manage-tab ${liveManageTab === tab.id ? "is-active" : ""}"
              type="button" data-live-tab="${tab.id}" role="tab" aria-selected="${liveManageTab === tab.id}">
              ${tab.label}
            </button>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderLiveManageWorkspace(order: DeploymentOrder, savedConfig: AppPreviewConfig): string {
  if (!order.createdCanisterId) return "";
  const isStatic = isStaticSiteTemplate(order.templateId);
  const tabs = renderLiveManageTabs(order);

  if (liveManageTab === "cycles") {
    return `
      <div class="live-manage-panel">
        ${tabs}
        ${renderCycleBalancePanel(order)}
        ${renderTopUpPanel(order)}
      </div>
    `;
  }

  if (isStatic) {
    return `
      <div class="live-manage-panel">
        ${tabs}
        ${renderLiveStaticSiteEditor()}
      </div>
    `;
  }

  return `
    <div class="live-manage-panel">
      ${tabs}
      ${renderLivePortfolioEditor(savedConfig, order.templateId)}
    </div>
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
  const topUpOrder = isTopUpOrder(currentOrder);
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
  const targetOrder =
    topUpOrder && currentOrder.topUpTargetOrderId !== undefined
      ? orders.find((candidate) => candidate.id === currentOrder?.topUpTargetOrderId)
      : undefined;

  return `
    <article class="order-card">
      <div class="order-heading">
        <div>
          <span class="kicker">${topUpOrder ? "Top-up" : "Order"} #${currentOrder.id.toString()}</span>
          <h3>${html(topUpOrder && targetOrder ? `Top up ${targetOrder.config.name}` : currentOrder.config.name)}</h3>
        </div>
        <span class="status status-${status.toLowerCase()}">${html(statusLabel(status))}</span>
      </div>
      ${
        isLive || topUpOrder
          ? ""
          : isStaticSiteTemplate(currentOrder.templateId)
            ? renderStaticSiteOrderFiles(currentOrder)
            : renderAppPreview(
                savedConfig,
                currentOrder.templateId,
                "Saved order configuration",
                "order-preview-frame",
              )
      }
      ${timeline(currentOrder)}
      <div class="order-facts">
        <div><small>${topUpOrder ? "Top-up price" : "Order price"}</small><strong>${money(currentOrder.expectedAmountUsdCents)} ${html(publicConfig?.paymentDisplay.priceCurrency || "USD")}</strong></div>
        <div><small>Settlement target</small><strong>${html(settlementLabel(currentOrder))}</strong></div>
        <div><small>${topUpOrder ? "Cycles purchased" : "Starter cycles"}</small><strong>${cycles(currentOrder.expectedCycles)} cycles</strong></div>
      </div>
      <div class="payment-explainer">
        <strong>How payment works</strong>
        <ol>
          <li>The ${topUpOrder ? "top-up" : "deployment"} is priced in ${html(publicConfig?.paymentDisplay.priceCurrency || "USD")} using the current cycle market rate.</li>
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
                    .slice(0, 120)
                    .map((token) => {
                      const isSettlement = token.assetId === settlementAsset;
                      const label = isSettlement
                        ? `${token.symbol} on ${token.blockchain} (settlement asset)`
                        : `${token.symbol} on ${token.blockchain}`;
                      return `<option value="${html(token.assetId)}">${html(label)}</option>`;
                    })
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
          ? `<button class="button deploy" id="deploy-button" type="button">${
              status === "Failed"
                ? topUpOrder
                  ? "Retry top-up"
                  : "Retry deployment"
                : topUpOrder
                  ? "Apply cycle top-up"
                  : isStaticSiteTemplate(currentOrder.templateId)
                    ? "Deploy static site on ICP"
                    : "Deploy app on ICP"
            }</button>`
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
          ? `
            <div class="live-app-actions">
              <a class="live-link" href="${html(liveAppUrl)}" target="_blank" rel="noreferrer">Open live ICP app <span>^</span></a>
              <button class="button secondary compact" type="button" data-live-tab="${isStaticSiteTemplate(currentOrder.templateId) ? "files" : "content"}">
                ${isStaticSiteTemplate(currentOrder.templateId) ? "Publish files" : "Edit content"}
              </button>
              <button class="button secondary compact" type="button" data-live-tab="cycles">Manage cycles</button>
            </div>
          `
          : ""
      }
      ${
        isLive && currentOrder.createdCanisterId && !topUpOrder
          ? renderLiveManageWorkspace(currentOrder, savedConfig)
          : ""
      }
      ${currentOrder.error ? `<p class="error-message">${html(currentOrder.error)}</p>` : ""}
    </article>
  `;
}

function renderOrderRow(order: DeploymentOrder, emphasis: "live" | "progress"): string {
  const liveAppUrl = order.status === "Live" && !isTopUpOrder(order) ? appUrl(order) : undefined;
  const kind = isTopUpOrder(order) ? "top-up" : order.templateId;
  return `
    <article class="app-row-card app-row-card--${emphasis}">
      <button class="app-row" data-order="${order.id.toString()}" type="button">
        <span class="app-mark" style="--mark:${html(order.config.accentColor)}"></span>
        <span>
          <strong>${html(order.config.name)}</strong>
          <small>${html(kind)} · order #${order.id.toString()}</small>
        </span>
        <span class="status status-${order.status.toLowerCase()}">${html(statusLabel(order.status))}</span>
        <span class="row-arrow">Manage</span>
      </button>
      <div class="app-row-actions">
        ${
          liveAppUrl
            ? `<a class="button ghost compact" href="${html(liveAppUrl)}" target="_blank" rel="noreferrer">Open</a>`
            : ""
        }
        <button class="button secondary compact" type="button" data-order="${order.id.toString()}" data-manage-tab="${
          order.status === "Live" && isStaticSiteTemplate(order.templateId)
            ? "files"
            : order.status === "Live"
              ? "content"
              : "content"
        }">${order.status === "Live" ? "Edit / manage" : "Continue"}</button>
      </div>
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

  const live = orders.filter(
    (order) => order.status === "Live" && !isTopUpOrder(order),
  );
  const inProgress = orders.filter(
    (order) => !(order.status === "Live" && !isTopUpOrder(order)),
  );

  return `
    ${
      live.length > 0
        ? `
          <div class="apps-group">
            <div class="apps-group-heading">
              <span class="section-label">Live apps</span>
              <p class="field-help">Open the site, edit portfolio/landing content, republish static files, or top up cycles.</p>
            </div>
            <div class="apps-table">${live.map((order) => renderOrderRow(order, "live")).join("")}</div>
          </div>
        `
        : ""
    }
    ${
      inProgress.length > 0
        ? `
          <div class="apps-group">
            <div class="apps-group-heading">
              <span class="section-label">Orders in progress</span>
              <p class="field-help">Unpaid, deploying, top-ups, or failed orders you can continue from Launch.</p>
            </div>
            <div class="apps-table">${inProgress.map((order) => renderOrderRow(order, "progress")).join("")}</div>
          </div>
        `
        : ""
    }
  `;
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
  if (!factoryReadiness.templateWasmConfigured && !factoryReadiness.assetWasmConfigured) {
    return "Wasm missing";
  }
  if (!factoryCanDeploy()) return "Needs cycles";
  return "Ready";
}

function staticSiteTotalBytes(files: File[]): number {
  return files.reduce((total, file) => total + file.size, 0);
}

function staticSiteConfigFromDraft(name: string, files: File[]): AppPreviewConfig {
  const totalBytes = staticSiteTotalBytes(files);
  return {
    name: name.trim() || "My static site",
    headline: `${files.length} file${files.length === 1 ? "" : "s"} ready to deploy`,
    description: `Static site package with ${formatStaticSiteSize(totalBytes)} of assets.`,
    accentColor: "#2fbf8f",
    primaryLink: "",
    contact: "",
    about: "",
    heroImageUrl: "",
    resumeUrl: "",
    skills: [],
    socialLinks: [],
    projects: [],
  };
}

function renderStaticSiteFileList(files: File[], listId: string): string {
  if (files.length === 0) {
    return `<p class="field-help" id="${listId}">No files selected yet. Include an <code>index.html</code> at the project root.</p>`;
  }

  let plan;
  try {
    plan = planStaticSiteFiles(files);
  } catch {
    plan = files.map((file) => ({
      source: file,
      relativePath: file.webkitRelativePath || file.name,
      assetPath: `/${file.name}`,
    }));
  }

  const preview = plan
    .slice(0, 12)
    .map(
      (entry) =>
        `<li><code>${html(entry.assetPath)}</code><span>${formatStaticSiteSize(entry.source.size)}</span></li>`,
    )
    .join("");

  const overflow =
    plan.length > 12
      ? `<li class="muted">+ ${plan.length - 12} more files</li>`
      : "";

  return `
    <div class="static-site-files" id="${listId}">
      <div class="static-site-files-heading">
        <strong>${plan.length} files</strong>
        <span>${formatStaticSiteSize(staticSiteTotalBytes(files))}</span>
      </div>
      <ul>${preview}${overflow}</ul>
    </div>
  `;
}

function renderStaticSiteOrderFiles(order: DeploymentOrder): string {
  const files = staticSiteFilesByOrderId.get(order.id) || [];
  const needsFiles =
    files.length === 0 &&
    (order.status === "AwaitingPayment" ||
      order.status === "PaymentDetected" ||
      order.status === "Failed");

  return `
    <div class="static-site-order-files">
      ${renderStaticSiteFileList(files, "order-static-site-file-list")}
      ${
        needsFiles
          ? `
            <div class="static-site-reattach">
              <p class="inline-warning">Project files are not in this browser tab. Re-select the same package before deployment so they can be published to your canister.</p>
              <label class="file-picker wide">
                <span>Re-select project files</span>
                <input id="static-site-order-files" type="file" multiple webkitdirectory directory />
              </label>
              <label class="file-picker wide secondary-picker">
                <span>Or choose individual files</span>
                <input id="static-site-order-files-flat" type="file" multiple />
              </label>
            </div>
          `
          : files.length > 0
            ? `<p class="field-help">These files stay in this tab until deployment finishes. Folder uploads are normalized so <code>index.html</code> lands at the canister root.</p>`
            : ""
      }
    </div>
  `;
}

function renderStaticSiteBuilder(): string {
  return `
    <div class="static-site-intro">
      <span class="section-label">Bring your own site · default</span>
      <p>Full control: upload any built static project (HTML, CSS, JS, images, fonts). After payment, NearLaunch creates a certified asset canister you control and publishes your files to <code>https://&lt;canister-id&gt;.icp0.io</code>.</p>
    </div>
    <label>Site name (shown in your dashboard)
      <input name="name" required maxlength="80" value="${html(draftConfig.name)}" />
    </label>
    <label>Short summary (optional, for your records)
      <input name="headline" maxlength="140" placeholder="Marketing site v2" value="${html(draftConfig.headline)}" />
    </label>
    <div class="static-site-upload">
      <label class="file-picker wide">
        <span>Choose project folder</span>
        <input id="static-site-folder" type="file" multiple webkitdirectory directory />
      </label>
      <label class="file-picker wide secondary-picker">
        <span>Or choose individual files</span>
        <input id="static-site-files" type="file" multiple />
      </label>
      <p class="field-help">Package must include <code>index.html</code> at the site root. Folder uploads strip the root folder name so files publish at <code>/</code>. Keep this tab open through payment, deploy, and upload. After launch, republish any time from <strong>My apps → Publish files</strong>.</p>
      ${renderStaticSiteFileList(staticSiteFiles, "static-site-file-list")}
    </div>
  `;
}

function renderLiveStaticSiteEditor(): string {
  return `
    <form class="live-config-form" id="live-static-site-form">
      <div class="form-heading">
        <div>
          <span class="section-label">Republish static site</span>
          <h4>Upload a new build</h4>
          <p class="field-help">Files with the same path overwrite on your live asset canister. You remain the controller — no redeploy order needed.</p>
        </div>
        <button class="button primary" type="submit">Publish files</button>
      </div>
      <label class="file-picker wide">
        <span>Choose project folder</span>
        <input id="static-site-live-files" type="file" multiple webkitdirectory directory />
      </label>
      <label class="file-picker wide secondary-picker">
        <span>Or choose individual files</span>
        <input id="static-site-live-files-flat" type="file" multiple />
      </label>
      ${renderStaticSiteFileList(staticSiteLiveFiles, "static-site-live-file-list")}
    </form>
  `;
}

function treasuryRecipientDisplay(): string {
  const onChain = revenueSummary?.treasuryRecipient?.trim() || "";
  if (onChain) return onChain;
  return relayerHealth?.settlementRecipient?.trim() || "";
}

function treasuryMismatch(): boolean {
  const onChain = revenueSummary?.treasuryRecipient?.trim() || "";
  const relayer = relayerHealth?.settlementRecipient?.trim() || "";
  return Boolean(onChain && relayer && onChain !== relayer);
}

function settledAssetLabel(): string {
  if (!revenueSummary || !publicConfig) return "—";
  return `${units(
    revenueSummary.settledSettlementAmount,
    Number(revenueSummary.settlementDecimals),
  )} ${revenueSummary.settlementSymbol}`;
}

function renderRevenueGuide(): string {
  const treasury = treasuryRecipientDisplay();
  const symbol = publicConfig?.paymentDisplay.settlementSymbol || "USDC";
  const network = publicConfig?.paymentDisplay.settlementNetwork || "NEAR";
  const factoryId = factoryCanisterId || revenueSummary?.factoryCanisterId || "launcher_factory";
  const shortfall = factoryDeployShortfall();
  const topUpAmount =
    shortfall && shortfall > 0n
      ? shortfall.toString()
      : "1000000000000";

  return `
    <div class="admin-card revenue-guide-card">
      <div class="admin-card-heading">
        <span class="section-label">Revenue collection</span>
        <strong>${html(symbol)} on ${html(network)}</strong>
      </div>
      <p class="muted">Customer payments never land in an ICP wallet. NEAR Intents 1Click delivers the fixed settlement amount to your treasury destination. Use this guide to collect revenue and keep the factory funded without burning extra cycles.</p>

      <div class="revenue-summary-grid">
        <article>
          <small>Settled revenue</small>
          <strong>${revenueSummary ? money(revenueSummary.settledUsdCents) : "—"}</strong>
          <span>${revenueSummary ? settledAssetLabel() : "Sign in as admin to load"}</span>
        </article>
        <article>
          <small>Settled payments</small>
          <strong>${revenueSummary ? revenueSummary.settledPayments.toString() : "—"}</strong>
          <span>${
            revenueSummary
              ? `${revenueSummary.settledDeployPayments.toString()} deploys · ${revenueSummary.settledTopUpPayments.toString()} top-ups`
              : "Query is free and admin-only"
          }</span>
        </article>
        <article>
          <small>Factory cycles</small>
          <strong>${factoryReadiness ? cycles(factoryReadiness.cycleBalance) : "—"}</strong>
          <span>${
            factoryReadiness?.canDeploy
              ? "Ready for new deployments"
              : shortfall && shortfall > 0n
                ? `Needs at least ${cycles(shortfall)} more`
                : "Check readiness"
          }</span>
        </article>
        <article>
          <small>Refund watchlist</small>
          <strong>${revenueSummary ? revenueSummary.refundRequiredCount.toString() : "—"}</strong>
          <span>Manual NEAR refunds if marked by the relayer</span>
        </article>
      </div>

      <div class="treasury-row">
        <div>
          <small>Treasury destination</small>
          <code class="principal-code">${html(treasury || "Not configured")}</code>
          ${
            treasury
              ? `<button class="text-button" data-copy-text="${html(treasury)}" type="button">Copy treasury address</button>`
              : `<span class="muted">Set it below (and in the relayer <code>SETTLEMENT_RECIPIENT</code> env).</span>`
          }
        </div>
        <button class="button secondary" id="refresh-revenue-button" type="button">Refresh revenue</button>
      </div>

      ${
        !treasury
          ? `<div class="admin-alert"><strong>Treasury missing</strong><span>Save the NEAR account or address where 1Click delivers settlement funds. The live relayer must use the same value in <code>SETTLEMENT_RECIPIENT</code>.</span></div>`
          : ""
      }
      ${
        treasuryMismatch()
          ? `<div class="admin-alert"><strong>Treasury mismatch</strong><span>On-chain treasury is <code>${html(revenueSummary?.treasuryRecipient || "")}</code> but the relayer is delivering to <code>${html(relayerHealth?.settlementRecipient || "")}</code>. Align them before accepting payments.</span></div>`
          : ""
      }

      <ol class="revenue-steps">
        <li>
          <strong>Confirm settlement destination</strong>
          <span>Every paid order swaps into <code>${html(publicConfig?.settlement.assetId || "settlement asset")}</code> and credits your treasury on ${html(network)}. The deposit address users fund is temporary; final revenue is yours after the swap succeeds.</span>
        </li>
        <li>
          <strong>Collect or transfer revenue</strong>
          <span>Open the wallet that controls <code>${html(treasury || "your treasury account")}</code>, check the ${html(symbol)} balance, and transfer funds to your cold wallet, exchange, or operating account. NearLaunch does not custody or auto-withdraw this balance.</span>
        </li>
        <li>
          <strong>Fund factory cycles from operating revenue</strong>
          <span>Deployments spend factory cycles, not settlement ${html(symbol)}. Convert a portion of revenue to ICP, mint cycles for the deployer identity, then top up the factory. Prefer infrequent larger top-ups over many small ones to keep management calls low.</span>
        </li>
        <li>
          <strong>Keep a readiness reserve</strong>
          <span>Leave enough factory balance for the largest child allocation plus the on-chain safety reserve. Pause new orders from this dashboard if the factory shortfall grows, then top up before re-enabling.</span>
        </li>
      </ol>

      <div class="ops-commands">
        <div class="admin-card-heading">
          <span class="section-label">Operator commands</span>
          <strong>icp-cli</strong>
        </div>
        <p class="muted">Run these with the deployment identity after converting ICP to cycles. Replace amounts as needed.</p>
        <pre class="ops-command-block"><code># Check factory readiness
icp canister call launcher_factory getCycleBalance '()' -e ic --query

# Top up factory (example: ${html(cycles(BigInt(topUpAmount)))} cycles)
icp canister top-up ${html(factoryId)} --amount ${html(topUpAmount)} -e ic --identity nearlaunch-deployer

# Optional: convert ICP to cycles first
icp cycles mint --cycles ${html(topUpAmount)} -e ic --identity nearlaunch-deployer</code></pre>
        <div class="ops-command-actions">
          <button class="button secondary" data-copy-text="icp canister call launcher_factory getCycleBalance '()' -e ic --query" type="button">Copy balance check</button>
          <button class="button secondary" data-copy-text="icp canister top-up ${html(factoryId)} --amount ${html(topUpAmount)} -e ic --identity nearlaunch-deployer" type="button">Copy top-up command</button>
        </div>
      </div>

      <form class="treasury-form" id="treasury-form">
        <div class="admin-card-heading"><span class="section-label">Treasury label</span><strong>On-chain</strong></div>
        <label>Treasury recipient (NEAR account or destination address)
          <input name="recipient" value="${html(revenueSummary?.treasuryRecipient || relayerHealth?.settlementRecipient || "")}" placeholder="your-treasury.near" autocomplete="off" />
        </label>
        <p class="field-help">Stored for admin display only. The relayer still needs the same value in <code>SETTLEMENT_RECIPIENT</code> to deliver real funds.</p>
        <button class="button primary wide" type="submit">Save treasury recipient</button>
      </form>
    </div>
  `;
}

function navLink(view: AppView, label: string): string {
  const active = currentView === view ? " is-active" : "";
  return `<a class="nav-link${active}" href="#${view}" data-nav="${view}">${label}</a>`;
}

function renderNav(): string {
  return `
    <nav class="primary-nav" aria-label="Primary">
      ${navLink("home", "Home")}
      ${navLink("launch", "Launch")}
      ${navLink("apps", "My apps")}
      ${adminAccess?.isAdmin ? navLink("admin", "Admin") : ""}
      ${navLink("how", "Guide")}
    </nav>
  `;
}

function renderLaunchSteps(): string {
  const managingOrder = currentOrder !== null;
  const status = currentOrder?.status;
  const paymentDone =
    status === "PaymentDetected" ||
    status === "CreatingCanister" ||
    status === "Live";
  const live = status === "Live";
  const steps = [
    { id: "sign-in", label: "Sign in", done: signedIn, current: !signedIn },
    {
      id: "template",
      label: "Choose template",
      done: signedIn && (managingOrder || Boolean(selectedTemplate)),
      current: signedIn && !managingOrder,
    },
    {
      id: "pay",
      label: "Pay",
      done: Boolean(paymentDone || live),
      current: managingOrder && !paymentDone && !live && status !== "Failed",
    },
    {
      id: "deploy",
      label: "Deploy",
      done: Boolean(live),
      current:
        managingOrder &&
        (status === "PaymentDetected" ||
          status === "CreatingCanister" ||
          status === "Failed"),
    },
  ];
  return `
    <ol class="launch-steps" aria-label="Deployment steps">
      ${steps
        .map(
          (step, index) => `
            <li class="launch-step ${step.done ? "is-done" : ""} ${step.current ? "is-current" : ""}">
              <span class="launch-step-index">${step.done ? "✓" : String(index + 1)}</span>
              <span class="launch-step-label">${step.label}</span>
            </li>
          `,
        )
        .join("")}
    </ol>
  `;
}

function renderGettingStarted(): string {
  const items = [
    {
      done: signedIn,
      title: "Sign in with Internet Identity",
      body: "Your principal becomes the controller of every app you deploy.",
      action: signedIn
        ? `<span class="guide-done">Signed in</span>`
        : `<button class="button secondary compact" id="guide-sign-in" type="button">Sign in</button>`,
    },
    {
      done: orders.some((order) => !isTopUpOrder(order)),
      title: "Create a deployment order",
      body: "Pick a template or upload a static site, configure it, then create an order.",
      action: `<a class="button secondary compact" href="#launch" data-nav="launch">Open Launch</a>`,
    },
    {
      done: orders.some((order) => order.status === "Live" && !isTopUpOrder(order)),
      title: "Pay and deploy",
      body: "Get a NEAR Intents quote, send the exact amount, then deploy your ICP canister.",
      action: `<a class="button secondary compact" href="#how" data-nav="how">Read the guide</a>`,
    },
  ];
  return `
    <div class="getting-started">
      <div class="getting-started-heading">
        <span class="section-label">Getting started</span>
        <p>Three steps to a live canister. Only the Launch page makes paid calls after you act.</p>
      </div>
      <ol class="getting-started-list">
        ${items
          .map(
            (item, index) => `
              <li class="getting-started-item ${item.done ? "is-done" : ""}">
                <span class="getting-started-index">${item.done ? "✓" : String(index + 1)}</span>
                <div>
                  <strong>${item.title}</strong>
                  <p>${item.body}</p>
                  ${item.action}
                </div>
              </li>
            `,
          )
          .join("")}
      </ol>
    </div>
  `;
}

function renderHomeView(): string {
  return `
    <section class="home-view view-panel" id="home">
      <div class="hero hero-compact">
        <div class="hero-copy">
          <div class="eyebrow"><span>NEAR Intents</span><i></i><span>Internet Computer</span></div>
          <h1>Deploy a live ICP app.<br /><em>Pay from any chain.</em></h1>
          <p>NearLaunch turns a template (or your own static site) into a funded ICP canister you control. Payments route through NEAR Intents; cycles stay on ICP.</p>
          <div class="hero-actions">
            <a class="button primary" href="#launch" data-nav="launch">Start a deployment</a>
            <a class="button secondary" href="#how" data-nav="how">How it works</a>
          </div>
        </div>
        <div class="hero-side">
          <div class="hero-console" aria-label="Deployment flow preview">
            <div class="console-top"><span></span><span></span><span></span><small>intent.deploy</small></div>
            <div class="console-body compact">
              <div><small>OUTCOME</small><strong>Live ICP canister</strong></div>
              <div class="console-route"><span>Any token</span><b>-&gt;</b><span>NEAR Intents</span><b>-&gt;</b><span>${html(publicConfig?.paymentDisplay.settlementSymbol || "USDC")}</span></div>
              <pre><code><span>starter</span> ${html(cycles(configuredInitialDeployCycles()))}
<span>controller</span> your principal
<span>status</span> <b>ready to deploy</b></code></pre>
            </div>
          </div>
          <div class="hero-stats hero-stats-inline">
            <div><strong>${stats.liveApps.toString()}</strong><small>apps launched</small></div>
            <div><strong>${stats.templates.toString()}</strong><small>templates</small></div>
            <div><strong>${stats.totalOrders.toString()}</strong><small>orders</small></div>
          </div>
        </div>
      </div>
      ${renderGettingStarted()}
      <div class="home-feature-grid">
        <article>
          <span class="section-label">01 · Templates</span>
          <strong>Portfolio or your files</strong>
          <p>Use the curated portfolio template, or upload HTML/CSS/JS to a certified asset canister.</p>
        </article>
        <article>
          <span class="section-label">02 · Pay once</span>
          <strong>Fixed price, any token</strong>
          <p>NEAR 1Click quotes the exact amount for the settlement asset. No ICP wallet required to pay.</p>
        </article>
        <article>
          <span class="section-label">03 · Own it</span>
          <strong>You control the canister</strong>
          <p>Your Internet Identity principal is controller. Top up cycles later from My apps.</p>
        </article>
      </div>
    </section>
  `;
}

function renderHowView(): string {
  return `
    <section class="how-section view-panel" id="how">
      <div class="section-intro compact">
        <span class="section-number">Guide</span>
        <div>
          <span class="kicker">How NearLaunch works</span>
          <h2>From intent to live canister.</h2>
          <p class="section-lede">Follow this flow once. After your first app is live, reuse My apps for top-ups and edits.</p>
        </div>
      </div>
      <div class="architecture">
        <article><span>01</span><strong>Sign in</strong><p>Internet Identity creates an app-specific principal. That principal becomes controller of canisters you deploy.</p></article>
        <article><span>02</span><strong>Configure</strong><p>Choose a template or upload a static site. Starter cycles (${html(cycles(configuredInitialDeployCycles()))}) are included in the deploy price.</p></article>
        <article><span>03</span><strong>Pay</strong><p>NEAR 1Click quotes the exact source-token amount for the fixed settlement target. Send only that amount.</p></article>
        <article><span>04</span><strong>Deploy</strong><p>After settlement proof lands on ICP, deploy creates your canister. Static sites then upload files from this browser tab.</p></article>
      </div>
      <div class="guide-details">
        <details class="guide-card" open>
          <summary>What you need before starting</summary>
          <ul>
            <li>A modern browser (for Internet Identity passkeys).</li>
            <li>A wallet/address on a chain supported by NEAR Intents for payment and refunds.</li>
            <li>For static sites: a folder with <code>index.html</code> at the site root. Keep the tab open until upload finishes.</li>
          </ul>
        </details>
        <details class="guide-card">
          <summary>Where to click in this app</summary>
          <ul>
            <li><strong>Home</strong> — overview and checklist.</li>
            <li><strong>Launch</strong> — pick template, configure, pay, and deploy (one order at a time).</li>
            <li><strong>My apps</strong> — history; open an order to manage cycles or live content.</li>
            <li><strong>Guide</strong> — this page.</li>
          </ul>
        </details>
        <details class="guide-card">
          <summary>Cycles and cost (kept conservative)</summary>
          <ul>
            <li>Deploy price includes template fee + service fee + marked-up starter cycles.</li>
            <li>Top-ups charge only the cycles you choose, plus markup — buy only what you need.</li>
            <li>Querying balances and browsing templates uses cheap query calls; paid updates happen only when you create orders or save live config.</li>
          </ul>
        </details>
      </div>
    </section>
  `;
}

function renderLaunchView(): string {
  const template = activeTemplate();
  const managingOrder = currentOrder !== null;
  const managingLiveApp =
    currentOrder?.status === "Live" &&
    Boolean(currentOrder.createdCanisterId) &&
    !isTopUpOrder(currentOrder);
  const canCreateOrder =
    signedIn &&
    publicConfig?.ordersEnabled &&
    paymentConfigMatches() &&
    relayerReadyForOrders() &&
    factoryCanDeploy() &&
    !busy;

  return `
    <section class="launch-section view-panel" id="launch">
      <div class="section-intro compact">
        <span class="section-number">Launch</span>
        <div>
          <span class="kicker">Deploy workspace</span>
          <h2>What are we launching?</h2>
          <p class="section-lede">Pick a template, configure it, then create an order. Payment and deploy stay on this page so you never lose the flow.</p>
        </div>
      </div>
      ${renderLaunchSteps()}
      ${renderAvailability()}
      ${
        managingOrder
          ? ""
          : `
            <div class="template-grid">${renderTemplateCards()}</div>
          `
      }

      <div class="builder-grid ${managingOrder ? "builder-grid--managing-order" : ""} ${managingLiveApp ? "builder-grid--live-app" : ""}">
        <div class="builder-form">
          <div class="form-heading">
            <span class="section-label">Configure ${html(template?.name || "app")}</span>
            <span class="price-preview" id="price-preview">from ${deployBreakdown ? money(deployBreakdown.totalUsdCents) : "$0.00"} ${html(publicConfig?.paymentDisplay.priceCurrency || "USD")}</span>
          </div>
          ${
            isStaticSiteTemplate(selectedTemplate)
              ? `
                <form id="launch-form">
                  ${renderStaticSiteBuilder()}
                  <div class="starter-cycles-note">
                    <span class="section-label">Pay as you go</span>
                    <p>Each deployment starts with <strong>${cycles(configuredInitialDeployCycles())}</strong> cycles. Top up later from My apps when a canister is live.</p>
                  </div>
                  <div id="pricing-breakdown">${renderDeployPriceBreakdown(deployBreakdown)}</div>
                  <button class="button primary wide" type="submit" ${canCreateOrder ? "" : "disabled"}>
                    ${
                      signedIn
                        ? !paymentConfigMatches()
                          ? "Payment configuration mismatch"
                          : !relayerReadyForOrders()
                            ? "Payment service unavailable"
                            : !factoryCanDeploy()
                              ? "Factory needs more cycles"
                          : publicConfig?.ordersEnabled
                            ? "Create static site order"
                            : "New orders are paused"
                        : "Sign in to create an order"
                    }
                  </button>
                </form>
              `
              : `
                ${renderAppConfigBuilder(draftConfig, selectedTemplate, {
                  formId: "launch-form",
                  frameId: "draft-preview-frame",
                })}
                <div class="starter-cycles-note">
                  <span class="section-label">Pay as you go</span>
                  <p>Each deployment starts with <strong>${cycles(configuredInitialDeployCycles())}</strong> cycles. Top up later from My apps when a canister is live.</p>
                </div>
                <div id="pricing-breakdown">${renderDeployPriceBreakdown(deployBreakdown)}</div>
                <button class="button primary wide" form="launch-form" type="submit" ${canCreateOrder ? "" : "disabled"}>
                  ${
                    signedIn
                      ? !paymentConfigMatches()
                        ? "Payment configuration mismatch"
                        : !relayerReadyForOrders()
                          ? "Payment service unavailable"
                          : !factoryCanDeploy()
                            ? "Factory needs more cycles"
                        : publicConfig?.ordersEnabled
                          ? "Create deployment order"
                          : "New orders are paused"
                      : "Sign in to create an order"
                  }
                </button>
              `
          }
        </div>
        <aside class="order-pane">
          <div class="pane-top">
            <span class="section-label">${managingLiveApp ? "Manage live app" : "Live order state"}</span>
            <span class="pulse"></span>
          </div>
          ${
            managingOrder
              ? `<button class="button ghost new-deployment-button" id="new-deployment-button" type="button">Configure new deployment</button>`
              : `<p class="order-pane-hint muted">After you create an order, payment quotes and deploy controls appear here.</p>`
          }
          ${renderCurrentOrder()}
        </aside>
      </div>
    </section>
  `;
}

function renderAppsView(): string {
  return `
    <section class="apps-section view-panel" id="apps">
      <div class="section-intro compact">
        <span class="section-number">Apps</span>
        <div>
          <span class="kicker">Deployment registry</span>
          <h2>Your apps, on-chain.</h2>
          <p class="section-lede">Manage live sites and continue unpaid orders. Edit portfolio/landing content, republish static files, or top up cycles — all tied to your Internet Identity principal.</p>
        </div>
      </div>
      ${renderPrincipalPanel()}
      ${renderOrders()}
      ${
        signedIn && orders.length === 0
          ? `<div class="empty-cta"><a class="button primary" href="#launch" data-nav="launch">Create your first order</a></div>`
          : !signedIn
            ? `<div class="empty-cta"><button class="button primary" id="apps-sign-in" type="button">Sign in to view apps</button></div>`
            : ""
      }
    </section>
  `;
}

function renderAdmin(): string {
  if (!adminAccess?.isAdmin || !publicConfig) return "";
  const pricing = publicConfig.pricing;

  return `
    <section class="admin-section view-panel" id="admin">
      <div class="section-intro compact">
        <span class="section-number">Admin</span>
        <div>
          <span class="kicker">Platform controls</span>
          <h2>Admin dashboard.</h2>
          <p class="section-lede">Pricing and payment configuration are stored on-chain and applied to new orders only. Revenue settles off-ICP to your NEAR treasury.</p>
        </div>
      </div>

      <div class="admin-status-grid">
        <article><small>Relayer</small><strong>${html(relayerHealth?.mode || "unknown")}</strong><span>${relayerHealth?.mode === "live" ? (relayerHealth.ready ? "Real swaps enabled" : "Configuration incomplete") : relayerHealth?.mode === "mock" ? "No real funds move" : "Unavailable"}</span></article>
        <article><small>Factory</small><strong>${html(readinessStatus())}</strong><span>${factoryReadiness ? `${cycles(factoryReadiness.cycleBalance)} available` : "Unavailable"}</span></article>
        <article><small>App Wasm</small><strong>${factoryReadiness?.templateWasmConfigured ? "Configured" : "Missing"}</strong><span>${factoryReadiness ? `${factoryReadiness.templateWasmSize.toString()} bytes` : "Unavailable"}</span></article>
        <article><small>Asset Wasm</small><strong>${factoryReadiness?.assetWasmConfigured ? "Configured" : "Missing"}</strong><span>${factoryReadiness ? `${factoryReadiness.assetWasmSize.toString()} bytes` : "Unavailable"}</span></article>
        <article><small>Settled revenue</small><strong>${revenueSummary ? money(revenueSummary.settledUsdCents) : "—"}</strong><span>${revenueSummary ? `${revenueSummary.settledPayments.toString()} payments` : "Load after admin sign-in"}</span></article>
        <article><small>New orders</small><strong>${publicConfig.ordersEnabled ? "Enabled" : "Paused"}</strong><button class="text-button" id="toggle-orders-button" type="button">${publicConfig.ordersEnabled ? "Pause" : "Enable"}</button></article>
      </div>

      ${
        factoryReadiness && (!factoryReadiness.templateWasmConfigured || !factoryReadiness.assetWasmConfigured)
          ? `<div class="admin-alert"><strong>Factory setup required</strong><span>Run <code>pnpm template:build && pnpm template:upload</code> and <code>icp build launcher_frontend && pnpm asset:upload</code> with the deployment identity before accepting payments.</span></div>`
          : ""
      }
      ${
        factoryReadiness && !factoryReadiness.canDeploy
          ? `<div class="admin-alert"><strong>Factory capacity</strong><span>${html(factoryCapacityMessage() || "Additional cycles are required.")} Top up <code>${html(factoryCanisterId || "launcher_factory")}</code> by at least <code>${factoryDeployShortfall()?.toString() || "0"}</code> cycles to resume deployments.</span></div>`
          : ""
      }
      ${
        !paymentConfigMatches()
          ? `<div class="admin-alert"><strong>Relayer mismatch</strong><span>The relayer reports <code>${html(relayerHealth?.destinationAsset || "unknown")}</code>, while the backend expects <code>${html(publicConfig.settlement.assetId)}</code>. Update <code>SETTLEMENT_ASSET_ID</code> on the relayer before enabling payments.</span></div>`
          : ""
      }

      ${renderRevenueGuide()}

      <div class="admin-grid">
        <form class="admin-card" id="pricing-form">
          <div class="admin-card-heading"><span class="section-label">Pricing</span><strong>${html(publicConfig.paymentDisplay.priceCurrency)}</strong></div>
          <label>Deployment service fee<input name="serviceFee" value="${units(pricing.serviceFeeUsdCents, 2, 2)}" inputmode="decimal" /></label>
          <label>Starter deploy allocation (T)<input name="initialDeployCycles" value="${units(pricing.initialDeployCycles ?? INITIAL_DEPLOY_CYCLES, 12, 3)}" inputmode="decimal" /></label>
          <label>Cycle markup (%)<input name="cyclesMarkupPercent" value="${(Number(pricing.cyclesMarkupBps ?? 5_000n) / 100).toFixed(0)}" inputmode="numeric" /></label>
          <label>USD per trillion cycles<input name="usdPerTrillion" value="${units(pricing.usdPerTrillionCents ?? 100n, 2, 2)}" inputmode="decimal" /></label>
          <p class="muted">Market rate is refreshed by the relayer. Deploy orders include template + service + marked-up starter cycles. Top-ups charge only marked-up cycles. Keep allocations conservative so factory top-ups stay infrequent.</p>
          <button class="button secondary wide" id="refresh-rate-button" type="button">Refresh market cycle rate</button>
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

function renderActiveView(): string {
  switch (currentView) {
    case "launch":
      return renderLaunchView();
    case "apps":
      return renderAppsView();
    case "how":
      return renderHowView();
    case "admin":
      return renderAdmin() || renderHomeView();
    case "home":
    default:
      return renderHomeView();
  }
}

function render(): void {
  syncViewFromHash();

  app.innerHTML = `
    <div class="site-shell">
      <header class="topbar">
        <a class="brand" href="#home" data-nav="home"><span class="brand-glyph">N</span><span>NearLaunch <small>for ICP</small></span></a>
        ${renderNav()}
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
      <nav class="mobile-nav" aria-label="Mobile">
        ${renderNav()}
      </nav>

      <main>
        ${renderActiveView()}
      </main>
      <footer>
        <span>NearLaunch for ICP</span>
        <span>Outcome-driven deployment · conservative cycles</span>
        <a href="https://docs.near-intents.org/" target="_blank" rel="noreferrer">NEAR Intents docs ^</a>
      </footer>
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
  document.querySelector("#guide-sign-in")?.addEventListener("click", () => {
    void signIn();
  });
  document.querySelector("#apps-sign-in")?.addEventListener("click", () => {
    void signIn();
  });
  document.querySelector("#sign-out-button")?.addEventListener("click", () => {
    void signOut();
  });
  document.querySelectorAll<HTMLDetailsElement>("[data-config-section]").forEach((details) => {
    details.addEventListener("toggle", () => {
      const id = details.dataset.configSection;
      if (id) openConfigSections[id] = details.open;
    });
  });
  document.querySelectorAll<HTMLElement>("[data-copy-principal]").forEach((button) => {
    button.addEventListener("click", () => {
      void copyPrincipal();
    });
  });
  document.querySelectorAll<HTMLElement>("[data-copy-text]").forEach((button) => {
    button.addEventListener("click", () => {
      const value = button.dataset.copyText;
      if (value) void copyTextValue(value, "Copied to clipboard.");
    });
  });
  document.querySelector<HTMLInputElement>("#principal-value")?.addEventListener("click", (event) => {
    if (event.currentTarget instanceof HTMLInputElement) {
      event.currentTarget.select();
    }
  });

  document.querySelectorAll<HTMLElement>("[data-template]").forEach((element) => {
    element.addEventListener("click", () => {
      const next = element.dataset.template || selectedTemplate;
      if (next === selectedTemplate) return;
      selectedTemplate = next;
      draftConfig = defaultConfigForTemplate(selectedTemplate);
      void refreshDeployBreakdown().then(() => render());
    });
  });

  document.querySelector("#new-deployment-button")?.addEventListener("click", () => {
    currentOrder = null;
    currentQuote = null;
    liveManageTab = isStaticSiteTemplate(selectedTemplate) ? "files" : "content";
    notice = "Configure a new deployment below.";
    render();
  });

  document.querySelectorAll<HTMLElement>("[data-live-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.liveTab;
      if (tab === "content" || tab === "cycles" || tab === "files") {
        liveManageTab = tab;
        render();
      }
    });
  });

  document.querySelectorAll<HTMLElement>("[data-manage-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.order;
      const tab = button.dataset.manageTab;
      const order = orders.find((candidate) => candidate.id.toString() === id);
      if (!order) return;
      if (tab === "content" || tab === "cycles" || tab === "files") {
        liveManageTab = tab;
      } else if (isStaticSiteTemplate(order.templateId)) {
        liveManageTab = "files";
      } else {
        liveManageTab = "content";
      }
      void selectOrder(order);
    });
  });

  document.querySelector<HTMLFormElement>("#launch-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.currentTarget instanceof HTMLFormElement) {
      void createOrder(event.currentTarget);
    }
  });
  document
    .querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      "#launch-form input:not([type='file']):not([name='accentColorPicker']), #launch-form textarea",
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
    bindSocialLinksEditor(launchForm, refreshDraftPreview);
  }
  const syncStaticSiteSelection = (files: FileList | null | undefined) => {
    staticSiteFiles = [...files || []];
    const nameField = document.querySelector<HTMLInputElement>("#launch-form input[name='name']");
    const headlineField = document.querySelector<HTMLInputElement>("#launch-form input[name='headline']");
    const siteName = nameField?.value.trim() || "My static site";
    draftConfig = staticSiteConfigFromDraft(siteName, staticSiteFiles);
    if (headlineField?.value.trim()) {
      draftConfig = { ...draftConfig, headline: headlineField.value.trim() };
    }
    const list = document.querySelector("#static-site-file-list");
    if (list) {
      list.outerHTML = renderStaticSiteFileList(staticSiteFiles, "static-site-file-list");
    }
  };
  document.querySelector<HTMLInputElement>("#static-site-folder")?.addEventListener("change", (event) => {
    const input = event.currentTarget;
    if (input instanceof HTMLInputElement) syncStaticSiteSelection(input.files);
  });
  document.querySelector<HTMLInputElement>("#static-site-files")?.addEventListener("change", (event) => {
    const input = event.currentTarget;
    if (input instanceof HTMLInputElement) syncStaticSiteSelection(input.files);
  });
  document.querySelector<HTMLFormElement>("#live-static-site-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void publishLiveStaticSite();
  });
  const syncLiveStaticSiteFiles = (files: FileList | null | undefined) => {
    staticSiteLiveFiles = [...files || []];
    const list = document.querySelector("#static-site-live-file-list");
    if (list) {
      list.outerHTML = renderStaticSiteFileList(staticSiteLiveFiles, "static-site-live-file-list");
    }
  };
  document.querySelector<HTMLInputElement>("#static-site-live-files")?.addEventListener("change", (event) => {
    const input = event.currentTarget;
    if (input instanceof HTMLInputElement) syncLiveStaticSiteFiles(input.files);
  });
  document.querySelector<HTMLInputElement>("#static-site-live-files-flat")?.addEventListener("change", (event) => {
    const input = event.currentTarget;
    if (input instanceof HTMLInputElement) syncLiveStaticSiteFiles(input.files);
  });
  const attachOrderStaticSiteFiles = (files: FileList | null | undefined) => {
    if (!currentOrder || !isStaticSiteTemplate(currentOrder.templateId)) return;
    const nextFiles = [...files || []];
    const validationError = validateStaticSiteFiles(nextFiles);
    if (validationError) {
      notice = validationError;
      render();
      return;
    }
    staticSiteFilesByOrderId.set(currentOrder.id, nextFiles);
    notice = `Attached ${nextFiles.length} files to order #${currentOrder.id.toString()}.`;
    render();
  };
  document.querySelector<HTMLInputElement>("#static-site-order-files")?.addEventListener("change", (event) => {
    const input = event.currentTarget;
    if (input instanceof HTMLInputElement) attachOrderStaticSiteFiles(input.files);
  });
  document.querySelector<HTMLInputElement>("#static-site-order-files-flat")?.addEventListener("change", (event) => {
    const input = event.currentTarget;
    if (input instanceof HTMLInputElement) attachOrderStaticSiteFiles(input.files);
  });

  document.querySelectorAll<HTMLInputElement>('input[name="topUpCycles"]').forEach((input) => {
    input.addEventListener("change", () => {
      void updateTopUpPreview(BigInt(input.value));
    });
  });
  document.querySelector("#create-topup-button")?.addEventListener("click", () => {
    void createTopUpOrder();
  });
  document.querySelector("#refresh-cycle-balance")?.addEventListener("click", () => {
    void refreshCurrentCycleBalance(true);
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
    bindSocialLinksEditor(liveConfigForm, refreshLivePreview);
  }

  document.querySelectorAll<HTMLElement>("[data-order]").forEach((row) => {
    row.addEventListener("click", (event) => {
      // Nested action buttons use their own handlers.
      if ((event.target as HTMLElement | null)?.closest("[data-manage-tab]")) return;
      const id = row.dataset.order;
      const order = orders.find((candidate) => candidate.id.toString() === id);
      if (!order) return;
      if (order.status === "Live" && isStaticSiteTemplate(order.templateId)) {
        liveManageTab = "files";
      } else if (order.status === "Live") {
        liveManageTab = "content";
      }
      void selectOrder(order);
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
  document.querySelector("#refresh-rate-button")?.addEventListener("click", () => {
    void refreshCyclesRate(true);
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
  document.querySelector("#refresh-revenue-button")?.addEventListener("click", () => {
    void refreshRevenueSummary();
  });
  document.querySelector<HTMLFormElement>("#treasury-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.currentTarget instanceof HTMLFormElement) {
      void saveTreasuryRecipient(event.currentTarget);
    }
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

async function refreshDeployBreakdown(): Promise<void> {
  if (!actor || !selectedTemplate) {
    deployBreakdown = null;
    return;
  }
  deployBreakdown = unwrapPricing(await actor.quoteDeployment(selectedTemplate));
}

async function refreshTopUpBreakdown(amount = selectedTopUpCycles): Promise<void> {
  if (!actor) {
    topUpBreakdown = null;
    return;
  }
  topUpBreakdown = unwrapPricing(await actor.quoteTopUp(amount));
}

async function updateTopUpPreview(amount: bigint): Promise<void> {
  selectedTopUpCycles = amount;
  await refreshTopUpBreakdown(amount);
  const details = document.querySelector("#topup-pricing-breakdown");
  if (details) details.innerHTML = renderTopUpPriceBreakdown(topUpBreakdown);
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
      socialLinks: socialLinksFromForm(form),
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

async function copyTextValue(value: string, successNotice: string): Promise<void> {
  if (!value) return;
  let copied = false;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      copied = true;
    }
  } catch {
    copied = false;
  }

  if (!copied) {
    const field = document.createElement("textarea");
    field.value = value;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.focus();
    field.select();
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    field.remove();
  }

  notice = copied ? successNotice : "Copy failed. Select the text manually.";
  render();
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
    if (isStaticSiteTemplate(selectedTemplate)) {
      const data = new FormData(form);
      const siteName = String(data.get("name") || "").trim();
      const summary = String(data.get("headline") || "").trim();
      const filesError = validateStaticSiteFiles(staticSiteFiles);
      if (filesError) throw new Error(filesError);
      draftConfig = staticSiteConfigFromDraft(siteName, staticSiteFiles);
      if (summary) {
        draftConfig = { ...draftConfig, headline: summary };
      }
    } else {
      syncAccentColorFields(form);
      draftConfig = previewConfigFromForm(form);
      const projectsError = validateProjectsInForm(form, draftConfig.projects);
      if (projectsError) {
        throw new Error(projectsError);
      }
      const socialError = draftConfig.socialLinks.find(
        (link) =>
          (link.labelText && !link.url) ||
          (link.url && !link.labelText) ||
          (link.url && !isHttpsUrl(link.url)) ||
          link.labelText.length > 32,
      );
      if (socialError) {
        throw new Error(
          "Each social link needs a label (≤32 chars) and an https:// URL.",
        );
      }
      const validationError = validatePreviewConfig(draftConfig);
      if (validationError) {
        throw new Error(validationError);
      }
    }
    const result = await actor.createDeploymentOrder({
      templateId: selectedTemplate,
      config: toCanisterConfig(draftConfig),
    });
    currentOrder = unwrapResult(result);
    if (isStaticSiteTemplate(selectedTemplate)) {
      staticSiteFilesByOrderId.set(currentOrder.id, [...staticSiteFiles]);
    }
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
    await Promise.all([
      restoreQuote(order),
      order.status === "Live" && !isTopUpOrder(order)
        ? refreshCurrentCycleBalance(true)
        : refreshTopUpBreakdown(selectedTopUpCycles),
    ]);
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

async function createUploadAgent(): Promise<HttpAgent> {
  const identity = await authClient.getIdentity();
  return HttpAgent.create({
    host: window.location.origin,
    identity,
    rootKey: canisterEnv?.IC_ROOT_KEY,
  });
}

async function deployCurrentOrder(): Promise<void> {
  const staticSiteDeploy =
    currentOrder &&
    !isTopUpOrder(currentOrder) &&
    isStaticSiteTemplate(currentOrder.templateId);
  const busyLabel =
    currentOrder && isTopUpOrder(currentOrder)
      ? "Applying cycle top-up..."
      : staticSiteDeploy
        ? "Deploying static site..."
        : "Deploying app canister...";
  await withBusy(async () => {
    if (!actor || !currentOrder) throw new Error("No deployment order selected.");
    const wasTopUp = isTopUpOrder(currentOrder);
    const targetOrderId = currentOrder.topUpTargetOrderId;
    const orderId = currentOrder.id;
    const uploadFiles = staticSiteFilesByOrderId.get(orderId) || [];
    if (staticSiteDeploy && uploadFiles.length === 0) {
      throw new Error(
        "Project files are not available in this browser tab. Re-select your site package on this order, then deploy again.",
      );
    }
    if (staticSiteDeploy) {
      const filesError = validateStaticSiteFiles(uploadFiles);
      if (filesError) throw new Error(filesError);
    }

    currentOrder = unwrapResult(await actor.deployPaidOrder(orderId));
    await Promise.all([loadOrders(), loadFactoryReadiness()]);

    if (staticSiteDeploy && currentOrder.createdCanisterId) {
      const agent = await createUploadAgent();
      await uploadStaticSiteFiles(
        currentOrder.createdCanisterId.toText(),
        agent,
        uploadFiles,
        (uploaded, total) => {
          busyMessage = `Uploading site files (${uploaded}/${total})...`;
          syncBusyDom();
        },
      );
      staticSiteFilesByOrderId.delete(orderId);
    }

    if (wasTopUp && targetOrderId !== undefined) {
      const target = orders.find((order) => order.id === targetOrderId);
      if (target) {
        currentOrder = target;
        await refreshCurrentCycleBalance(true);
      }
      notice = "Cycle top-up applied to your live app canister.";
    } else {
      await refreshCurrentCycleBalance(true);
      notice = staticSiteDeploy
        ? "Your static site is live on the Internet Computer."
        : "The factory installed your app canister.";
    }
  }, busyLabel);
}

async function publishLiveStaticSite(): Promise<void> {
  await withBusy(async () => {
    if (!signedIn || !currentOrder?.createdCanisterId) {
      throw new Error("Select a live static site deployment first.");
    }
    if (!isStaticSiteTemplate(currentOrder.templateId)) {
      throw new Error("This deployment is not a static site.");
    }
    const filesError = validateStaticSiteFiles(staticSiteLiveFiles);
    if (filesError) throw new Error(filesError);

    const agent = await createUploadAgent();
    await uploadStaticSiteFiles(
      currentOrder.createdCanisterId.toText(),
      agent,
      staticSiteLiveFiles,
      (uploaded, total) => {
        busyMessage = `Publishing site files (${uploaded}/${total})...`;
        syncBusyDom();
      },
    );
    staticSiteLiveFiles = [];
    notice = "Updated files are live on your asset canister.";
    render();
  }, "Publishing static site files...");
}

async function createTopUpOrder(): Promise<void> {
  await withBusy(async () => {
    if (!signedIn || !actor || !currentOrder) {
      throw new Error("Select a live app before creating a top-up order.");
    }
    if (currentOrder.status !== "Live" || isTopUpOrder(currentOrder)) {
      throw new Error("Only live deployment orders can be topped up.");
    }
    if (selectedTopUpCycles < MIN_TOP_UP_CYCLES || selectedTopUpCycles > MAX_TOP_UP_CYCLES) {
      throw new Error("Choose a top-up between 0.1T and 3T cycles.");
    }

    currentOrder = unwrapResult(
      await actor.createTopUpOrder({
        targetOrderId: currentOrder.id,
        topUpCycles: selectedTopUpCycles,
      }),
    );
    currentQuote = null;
    paymentError = "";
    await loadOrders();
    notice = `Top-up order #${currentOrder.id.toString()} created on ICP.`;
  }, "Creating top-up order...");
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

    const socialError = nextConfig.socialLinks.find(
      (link) =>
        (link.labelText && !link.url) ||
        (link.url && !link.labelText) ||
        (link.url && !isHttpsUrl(link.url)) ||
        link.labelText.length > 32,
    );
    if (socialError) {
      throw new Error(
        "Each social link needs a label (≤32 chars) and an https:// URL.",
      );
    }

    currentOrder = unwrapResult(
      await actor.updateDeploymentOrderConfig(
        currentOrder.id,
        toCanisterConfig(nextConfig),
      ),
    );
    await loadOrders();
    notice = "Live app content updated. Refresh the open site tab to see changes.";
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
  if (adminAccess.isAdmin) {
    await loadRevenueSummary();
  } else {
    revenueSummary = null;
  }
}

async function loadRevenueSummary(): Promise<void> {
  if (!actor || !adminAccess?.isAdmin) {
    revenueSummary = null;
    return;
  }
  try {
    revenueSummary = await actor.getRevenueSummary();
  } catch {
    // Older backends or non-admin callers should not break the dashboard.
    revenueSummary = null;
  }
}

async function refreshRevenueSummary(): Promise<void> {
  await withBusy(async () => {
    await Promise.all([loadRevenueSummary(), loadFactoryReadiness(), loadRelayerHealth()]);
    notice = revenueSummary
      ? `Revenue ledger: ${money(revenueSummary.settledUsdCents)} across ${revenueSummary.settledPayments.toString()} payments.`
      : "Revenue summary is unavailable.";
  }, "Refreshing revenue summary...");
}

async function saveTreasuryRecipient(form: HTMLFormElement): Promise<void> {
  await withBusy(async () => {
    if (!actor) throw new Error("Admin actor is unavailable.");
    const data = new FormData(form);
    const recipient = String(data.get("recipient") || "").trim();
    unwrapUnit(await actor.setTreasuryRecipient(recipient));
    await loadRevenueSummary();
    notice = recipient
      ? "Treasury recipient saved for the admin guide. Keep the relayer SETTLEMENT_RECIPIENT in sync."
      : "Treasury recipient cleared.";
  }, "Saving treasury recipient...");
}

async function loadFactoryReadiness(): Promise<void> {
  if (!factoryActor || !publicConfig) return;
  factoryReadiness = await factoryActor.getReadiness(configuredInitialDeployCycles());
}

async function loadCyclesRate(forceRefresh = false): Promise<void> {
  try {
    const query = forceRefresh ? "?refresh=true" : "";
    const response = await fetch(`${RELAYER_URL}/api/cycles-rate${query}`);
    if (!response.ok) return;
    cyclesRate = (await response.json()) as CyclesRate;
    await Promise.all([refreshDeployBreakdown(), refreshTopUpBreakdown()]);
    if (publicConfig) {
      await loadPublicData();
    }
  } catch {
    cyclesRate = null;
  }
}

async function refreshCyclesRate(forceRefresh = false): Promise<void> {
  await withBusy(async () => {
    await loadCyclesRate(forceRefresh);
    notice = cyclesRate?.syncedToBackend
      ? `Market cycle rate updated to ${money(BigInt(cyclesRate.usdPerTrillionCents))} per trillion cycles.`
      : "Fetched the latest market cycle rate.";
  }, "Refreshing cycle market rate...");
}

async function refreshCurrentCycleBalance(force = false): Promise<void> {
  if (!actor || !currentOrder) return;
  if (currentOrder.status !== "Live" || isTopUpOrder(currentOrder)) return;
  const cacheKey = currentOrder.id.toString();
  if (!force && cycleBalances.has(cacheKey)) return;

  const result = await actor.getCanisterCycleBalance(currentOrder.id);
  if (result.__kind__ === "ok") {
    cycleBalances.set(cacheKey, result.ok);
  }
}

async function loadRelayerHealth(): Promise<void> {
  try {
    const response = await fetch(`${RELAYER_URL}/health`, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (response.ok) {
      relayerHealth = (await response.json()) as RelayerHealth;
      lastRelayerError = "";
      return;
    }
    relayerHealth = null;
    lastRelayerError = `HTTP ${response.status} from ${RELAYER_URL}/health`;
  } catch (error) {
    relayerHealth = null;
    const detail = error instanceof Error ? error.message : String(error);
    lastRelayerError = `failed to reach ${RELAYER_URL} from ${window.location.origin}${detail ? `: ${detail}` : ""}`;
  }
}

async function loadTokens(): Promise<void> {
  try {
    const response = await fetch(`${RELAYER_URL}/api/tokens`);
    if (!response.ok) return;
    const payload = (await response.json()) as { tokens: Token[] };
    const preferredChains = ["near", "eth", "base", "arb", "sol", "btc"];
    const preferredSymbols = ["USDC", "USDT", "wNEAR", "NEAR", "ETH", "WETH", "SOL", "BTC"];
    const settlementAsset = publicConfig?.settlement.assetId;
    tokens = payload.tokens
      .filter((token) => typeof token.assetId === "string" && token.assetId.length > 0)
      .sort((a, b) => {
        // Prefer the configured settlement asset so users can pay in the same token.
        if (settlementAsset) {
          if (a.assetId === settlementAsset && b.assetId !== settlementAsset) return -1;
          if (b.assetId === settlementAsset && a.assetId !== settlementAsset) return 1;
        }
        const aSymbol = preferredSymbols.indexOf(a.symbol);
        const bSymbol = preferredSymbols.indexOf(b.symbol);
        if (aSymbol !== bSymbol) {
          return (aSymbol < 0 ? 99 : aSymbol) - (bSymbol < 0 ? 99 : bSymbol);
        }
        const aChain = preferredChains.indexOf(a.blockchain);
        const bChain = preferredChains.indexOf(b.blockchain);
        if (aChain !== bChain) {
          return (aChain < 0 ? 99 : aChain) - (bChain < 0 ? 99 : bChain);
        }
        // Stable secondary sort: priced tokens first, then by symbol.
        if ((a.price > 0) !== (b.price > 0)) return a.price > 0 ? -1 : 1;
        return a.symbol.localeCompare(b.symbol);
      });
  } catch {
    tokens = [];
  }
}

async function savePricing(form: HTMLFormElement): Promise<void> {
  await withBusy(async () => {
    if (!actor || !publicConfig) throw new Error("Admin actor is unavailable.");
    const data = new FormData(form);
    const markupPercent = Number(String(data.get("cyclesMarkupPercent") || "0"));
    if (!Number.isFinite(markupPercent) || markupPercent < 0 || markupPercent > 200) {
      throw new Error("Cycle markup must be between 0% and 200%.");
    }
    unwrapUnit(
      await actor.setPricingConfig({
        ...publicConfig.pricing,
        serviceFeeUsdCents: decimalToUnits(String(data.get("serviceFee")), 2),
        monthlyFundingUsdCents: 0n,
        creationCycles: 0n,
        monthlyCycles: 0n,
        cycleBuffer: 0n,
        initialDeployCycles: decimalToUnits(String(data.get("initialDeployCycles")), 12),
        cyclesMarkupBps: BigInt(Math.round(markupPercent * 100)),
        usdPerTrillionCents: decimalToUnits(String(data.get("usdPerTrillion")), 2),
      }),
    );
    await loadPublicData();
    await Promise.all([loadFactoryReadiness(), refreshDeployBreakdown(), refreshTopUpBreakdown()]);
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
  window.addEventListener("hashchange", () => {
    const previous = currentView;
    syncViewFromHash();
    if (previous !== currentView) {
      // Keep in-memory draft/order state; only swap the visible workspace.
      window.scrollTo({ top: 0, behavior: "smooth" });
      render();
    }
  });

  // Normalize empty hash to #home so nav active states stay consistent.
  if (!location.hash || location.hash === "#") {
    history.replaceState(null, "", "#home");
  }
  syncViewFromHash();

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
      loadCyclesRate(),
      loadFactoryReadiness(),
      refreshDeployBreakdown(),
      refreshTopUpBreakdown(),
      loadAdminAccess(),
    ]);
    if (signedIn) {
      await loadOrders();
      currentOrder = orders[0] || null;
      if (currentOrder) {
        await restoreQuote(currentOrder);
        if (currentOrder.status === "Live" && !isTopUpOrder(currentOrder)) {
          await refreshCurrentCycleBalance(true);
        }
      }
    }
  } catch (error) {
    notice = error instanceof Error ? error.message : String(error);
  }
  render();
}

void init();
