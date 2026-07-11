import { AssetManager } from "@icp-sdk/canisters/assets";
import type { HttpAgent } from "@icp-sdk/core/agent";
import {
  contentTypeForPath,
  normalizeStaticSitePath,
  stripCommonRootFolder,
} from "./staticSitePaths";

export {
  contentTypeForPath,
  normalizeStaticSitePath,
  stripCommonRootFolder,
} from "./staticSitePaths";

export const STATIC_SITE_TEMPLATE_ID = "static-site";
export const MAX_STATIC_SITE_FILES = 200;
export const MAX_STATIC_SITE_BYTES = 50 * 1024 * 1024;

const SPA_ASSETS_CONFIG = `[
  {
    "match": "**/*",
    "security_policy": "standard",
    "headers": {
      "Cache-Control": "public, max-age=0, must-revalidate"
    },
    "allow_raw_access": false
  },
  {
    "match": "assets/**/*",
    "headers": {
      "Cache-Control": "public, max-age=31536000, immutable"
    }
  },
  {
    "match": "**/*",
    "enable_aliasing": true
  }
]
`;

export type StaticSiteFilePlan = {
  source: File;
  relativePath: string;
  assetPath: string;
};

export function isStaticSiteTemplate(templateId: string): boolean {
  return templateId === STATIC_SITE_TEMPLATE_ID;
}

export function relativePathFromFile(file: File): string {
  return (file.webkitRelativePath || file.name)
    .replaceAll("\\", "/")
    .replace(/^\/+/, "");
}

export function planStaticSiteFiles(files: File[]): StaticSiteFilePlan[] {
  const stripped = stripCommonRootFolder(files.map(relativePathFromFile));
  return files.map((source, index) => {
    const relativePath = stripped[index] ?? relativePathFromFile(source);
    return {
      source,
      relativePath,
      assetPath: normalizeStaticSitePath(relativePath),
    };
  });
}

export function staticSitePaths(files: File[]): string[] {
  return planStaticSiteFiles(files).map((plan) => plan.assetPath);
}

export function validateStaticSiteFiles(files: File[]): string | null {
  if (files.length === 0) {
    return "Choose at least one file to deploy.";
  }
  if (files.length > MAX_STATIC_SITE_FILES) {
    return `Upload ${MAX_STATIC_SITE_FILES} files or fewer.`;
  }

  let totalBytes = 0;
  const paths = new Set<string>();
  let plan: StaticSiteFilePlan[];

  try {
    plan = planStaticSiteFiles(files);
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid static site package.";
  }

  for (const entry of plan) {
    totalBytes += entry.source.size;
    if (totalBytes > MAX_STATIC_SITE_BYTES) {
      return "Total upload size cannot exceed 50 MB.";
    }
    if (paths.has(entry.assetPath)) {
      return `Duplicate file path: ${entry.assetPath}`;
    }
    paths.add(entry.assetPath);
  }

  if (!paths.has("/index.html")) {
    return "Your project must include an index.html file at the site root (after the selected folder is normalized).";
  }
  return null;
}

export function formatStaticSiteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function uploadStaticSiteFiles(
  canisterId: string,
  agent: HttpAgent,
  files: File[],
  onProgress?: (uploaded: number, total: number) => void,
): Promise<void> {
  const validationError = validateStaticSiteFiles(files);
  if (validationError) {
    throw new Error(validationError);
  }

  const plan = planStaticSiteFiles(files);
  const assetManager = new AssetManager({ canisterId, agent });
  const hasAssetsConfig = plan.some((entry) => entry.assetPath === "/.ic-assets.json5");

  const uploads: Array<{ assetPath: string; content: Uint8Array; contentType: string }> =
    [];

  for (const entry of plan) {
    uploads.push({
      assetPath: entry.assetPath,
      content: new Uint8Array(await entry.source.arrayBuffer()),
      contentType: contentTypeForPath(entry.assetPath),
    });
  }

  if (!hasAssetsConfig) {
    const encoder = new TextEncoder();
    uploads.push({
      assetPath: "/.ic-assets.json5",
      content: encoder.encode(SPA_ASSETS_CONFIG),
      contentType: "application/json",
    });
  }

  const total = uploads.length;
  let uploaded = 0;

  for (const item of uploads) {
    // AssetManager joins path + fileName (e.g. path "/assets" + "app.js" -> "/assets/app.js").
    const lastSlash = item.assetPath.lastIndexOf("/");
    const directory = lastSlash <= 0 ? "/" : item.assetPath.slice(0, lastSlash);
    const fileName = item.assetPath.slice(lastSlash + 1);
    await assetManager.store(item.content, {
      fileName,
      path: directory,
      contentType: item.contentType,
    });
    uploaded += 1;
    onProgress?.(uploaded, total);
  }
}
