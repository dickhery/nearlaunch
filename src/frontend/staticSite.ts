import { AssetManager } from "@icp-sdk/canisters/assets";
import type { HttpAgent } from "@icp-sdk/core/agent";

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

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".json5": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

export function isStaticSiteTemplate(templateId: string): boolean {
  return templateId === STATIC_SITE_TEMPLATE_ID;
}

export function contentTypeForPath(assetPath: string): string {
  const extension = assetPath.slice(assetPath.lastIndexOf(".")).toLowerCase();
  return MIME_TYPES[extension] || "application/octet-stream";
}

export function normalizeStaticSitePath(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) {
    throw new Error(`Invalid file path: ${relativePath}`);
  }
  return `/${normalized}`;
}

export function staticSitePaths(files: File[]): string[] {
  return files.map((file) => {
    const relativePath = file.webkitRelativePath || file.name;
    return normalizeStaticSitePath(relativePath);
  });
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
  let hasIndex = false;

  for (const file of files) {
    totalBytes += file.size;
    if (totalBytes > MAX_STATIC_SITE_BYTES) {
      return "Total upload size cannot exceed 50 MB.";
    }

    const assetPath = normalizeStaticSitePath(file.webkitRelativePath || file.name);
    if (paths.has(assetPath)) {
      return `Duplicate file path: ${assetPath}`;
    }
    paths.add(assetPath);
    if (assetPath === "/index.html" || assetPath.endsWith("/index.html")) {
      hasIndex = true;
    }
  }

  if (!hasIndex) {
    return "Your project must include an index.html file.";
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

  const assetManager = new AssetManager({ canisterId, agent });
  const uploadFiles = [...files];
  const hasAssetsConfig = uploadFiles.some((file) => {
    const assetPath = normalizeStaticSitePath(file.webkitRelativePath || file.name);
    return assetPath === "/.ic-assets.json5";
  });

  if (!hasAssetsConfig) {
    uploadFiles.push(
      new File([SPA_ASSETS_CONFIG], ".ic-assets.json5", {
        type: "application/json",
      }),
    );
  }

  const total = uploadFiles.length;
  let uploaded = 0;

  for (const file of uploadFiles) {
    const assetPath = normalizeStaticSitePath(file.webkitRelativePath || file.name);
    const content = new Uint8Array(await file.arrayBuffer());
    await assetManager.store(content, {
      fileName: assetPath.slice(1),
      path: "/",
      contentType: contentTypeForPath(assetPath),
    });
    uploaded += 1;
    onProgress?.(uploaded, total);
  }
}