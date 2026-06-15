export type AppPreviewConfig = {
  name: string;
  headline: string;
  description: string;
  accentColor: string;
  primaryLink: string;
  contact: string;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function templateEyebrow(templateId: string): string {
  switch (templateId) {
    case "portfolio":
      return "Independent work, permanently online";
    case "startup":
      return "A new product, launched on ICP";
    case "grant":
      return "Open milestones, public progress";
    default:
      return "Deployed on the Internet Computer";
  }
}

function safeHttpsUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export function appPreviewDocument(
  config: AppPreviewConfig,
  templateId: string,
): string {
  const safeName = escapeHtml(config.name || "Untitled app");
  const safeHeadline = escapeHtml(
    config.headline || "Your headline will appear here.",
  );
  const safeDescription = escapeHtml(
    config.description || "Your description will appear here.",
  );
  const safeAccent = /^#[0-9a-fA-F]{6}$/.test(config.accentColor)
    ? config.accentColor
    : "#79f2c0";
  const safeContact = escapeHtml(config.contact);
  const safeLink = escapeHtml(safeHttpsUrl(config.primaryLink));
  const linkMarkup = safeLink
    ? `<a class="primary" href="${safeLink}" target="_blank" rel="noreferrer">Explore the project</a>`
    : "";
  const contactMarkup = safeContact
    ? `<span>${safeContact}</span>`
    : "<span>Built with chain abstraction</span>";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="${safeDescription}">
<title>${safeName}</title><style>
:root{color-scheme:dark;--accent:${safeAccent};font-family:Inter,ui-sans-serif,system-ui,sans-serif}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#090b0f;color:#f4f6f8;display:grid;place-items:center;padding:28px}
body:before{content:'';position:fixed;inset:0;background:radial-gradient(circle at 15% 15%,color-mix(in srgb,var(--accent) 24%,transparent),transparent 34%),radial-gradient(circle at 90% 80%,#173647,transparent 36%);pointer-events:none}
main{position:relative;width:min(980px,100%);padding:clamp(32px,7vw,84px);border:1px solid #ffffff1a;border-radius:32px;background:#11141acc;box-shadow:0 35px 100px #0009;backdrop-filter:blur(18px)}
.eyebrow{color:var(--accent);font-size:.78rem;font-weight:800;letter-spacing:.16em;text-transform:uppercase}
h1{max-width:820px;margin:24px 0;font-size:clamp(3rem,9vw,7.2rem);line-height:.92;letter-spacing:-.065em}
p{max-width:680px;margin:0;color:#aeb7c2;font-size:clamp(1.05rem,2vw,1.35rem);line-height:1.7}
.actions{display:flex;align-items:center;gap:18px;flex-wrap:wrap;margin-top:42px}.primary{display:inline-flex;padding:15px 20px;border-radius:999px;background:var(--accent);color:#081014;text-decoration:none;font-weight:800}
.meta{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-top:70px;padding-top:22px;border-top:1px solid #ffffff14;color:#7f8a96;font-size:.9rem}
</style></head><body><main><div class="eyebrow">${escapeHtml(templateEyebrow(templateId))}</div>
<h1>${safeHeadline}</h1><p>${safeDescription}</p><div class="actions">${linkMarkup}</div>
<div class="meta"><strong>${safeName}</strong>${contactMarkup}</div></main></body></html>`;
}
