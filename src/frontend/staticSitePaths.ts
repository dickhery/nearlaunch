export function normalizeStaticSitePath(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..") || normalized.includes("\0")) {
    throw new Error(`Invalid file path: ${relativePath}`);
  }
  return `/${normalized}`;
}

/**
 * Browser folder picks (`webkitdirectory`) prefix every path with the selected
 * folder name (e.g. `my-site/index.html`). Strip that shared root so the site
 * is published at the canister root instead of `/my-site/...`.
 */
export function stripCommonRootFolder(relativePaths: string[]): string[] {
  if (relativePaths.length === 0) return [];

  const normalized = relativePaths.map((path) =>
    path.replaceAll("\\", "/").replace(/^\/+/, ""),
  );
  if (normalized.some((path) => !path || path.includes(".."))) {
    throw new Error("Invalid file path in upload package.");
  }

  const hasNested = normalized.some((path) => path.includes("/"));
  if (!hasNested) return normalized;

  const roots = normalized.map((path) => path.split("/")[0] ?? "");
  const root = roots[0];
  if (!root || !roots.every((candidate) => candidate === root)) {
    return normalized;
  }
  if (!normalized.every((path) => path.startsWith(`${root}/`))) {
    return normalized;
  }

  return normalized.map((path) => path.slice(root.length + 1));
}

export function contentTypeForPath(assetPath: string): string {
  const extension = assetPath.slice(assetPath.lastIndexOf(".")).toLowerCase();
  switch (extension) {
    case ".html":
    case ".htm":
      return "text/html";
    case ".css":
      return "text/css";
    case ".js":
    case ".mjs":
      return "text/javascript";
    case ".json":
    case ".json5":
    case ".map":
      return "application/json";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    case ".txt":
      return "text/plain";
    case ".xml":
      return "application/xml";
    case ".wasm":
      return "application/wasm";
    default:
      return "application/octet-stream";
  }
}
