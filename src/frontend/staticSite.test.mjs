import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contentTypeForPath,
  normalizeStaticSitePath,
  stripCommonRootFolder,
} from "./staticSitePaths.ts";

test("normalizeStaticSitePath rejects traversal and normalizes separators", () => {
  assert.equal(normalizeStaticSitePath("index.html"), "/index.html");
  assert.equal(normalizeStaticSitePath("assets\\app.js"), "/assets/app.js");
  assert.throws(() => normalizeStaticSitePath("../secret"), /Invalid file path/);
  assert.throws(() => normalizeStaticSitePath(""), /Invalid file path/);
});

test("stripCommonRootFolder removes the webkitdirectory folder prefix", () => {
  assert.deepEqual(
    stripCommonRootFolder([
      "portfolio/index.html",
      "portfolio/styles.css",
      "portfolio/assets/logo.png",
    ]),
    ["index.html", "styles.css", "assets/logo.png"],
  );
});

test("stripCommonRootFolder leaves already-root packages alone", () => {
  assert.deepEqual(
    stripCommonRootFolder(["index.html", "styles.css", "js/app.js"]),
    ["index.html", "styles.css", "js/app.js"],
  );
});

test("stripCommonRootFolder does not strip when roots differ", () => {
  assert.deepEqual(
    stripCommonRootFolder(["a/index.html", "b/page.html"]),
    ["a/index.html", "b/page.html"],
  );
});

test("contentTypeForPath maps common static extensions", () => {
  assert.equal(contentTypeForPath("/index.html"), "text/html");
  assert.equal(contentTypeForPath("/assets/app.js"), "text/javascript");
  assert.equal(contentTypeForPath("/assets/app.css"), "text/css");
  assert.equal(contentTypeForPath("/file.unknown"), "application/octet-stream");
});
