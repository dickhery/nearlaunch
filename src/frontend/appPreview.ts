export type AppPreviewLink = {
  labelText: string;
  url: string;
};

export type AppPreviewProject = {
  title: string;
  description: string;
  url: string;
  imageUrl: string;
  tags: string[];
};

export type AppPreviewConfig = {
  name: string;
  headline: string;
  description: string;
  accentColor: string;
  primaryLink: string;
  contact: string;
  about: string;
  heroImageUrl: string;
  resumeUrl: string;
  skills: string[];
  socialLinks: AppPreviewLink[];
  projects: AppPreviewProject[];
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
    case "static-site":
      return "Your files, hosted on ICP";
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

function safeImageUrl(value: string): string {
  const trimmed = value.trim();
  const httpsUrl = safeHttpsUrl(trimmed);
  if (httpsUrl) return httpsUrl;
  if (
    trimmed.length <= 450_000 &&
    /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(
      trimmed,
    )
  ) {
    return trimmed;
  }
  return "";
}

function renderSkills(skills: string[]): string {
  const items = skills
    .filter(Boolean)
    .map((skill) => `<li>${escapeHtml(skill)}</li>`)
    .join("");
  return items ? `<ul class="skill-list">${items}</ul>` : "";
}

function renderSocialLinks(links: AppPreviewLink[]): string {
  const items = links
    .filter((link) => link.labelText && safeHttpsUrl(link.url))
    .map(
      (link) =>
        `<a href="${escapeHtml(safeHttpsUrl(link.url))}" target="_blank" rel="noreferrer">${escapeHtml(link.labelText)}</a>`,
    )
    .join("");
  return items
    ? `<nav class="social-links" aria-label="Portfolio links">${items}</nav>`
    : "";
}

function renderTags(tags: string[]): string {
  const items = tags
    .filter(Boolean)
    .map((tag) => `<span>${escapeHtml(tag)}</span>`)
    .join("");
  return items ? `<div class="project-tags">${items}</div>` : "";
}

function renderProject(project: AppPreviewProject): string {
  const imageUrl = safeImageUrl(project.imageUrl);
  const projectUrl = safeHttpsUrl(project.url);
  const imageMarkup = imageUrl
    ? `<figure class="project-media"><img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(project.title)} preview" loading="lazy"></figure>`
    : `<figure class="project-media"><div class="project-placeholder" aria-hidden="true"></div></figure>`;
  const actionMarkup = projectUrl
    ? `<a class="project-link" href="${escapeHtml(projectUrl)}" target="_blank" rel="noreferrer">Open project</a>`
    : "";

  return `<article class="project-card">${imageMarkup}<div><h3>${escapeHtml(
    project.title,
  )}</h3><p>${escapeHtml(project.description)}</p>${renderTags(
    project.tags,
  )}${actionMarkup}</div></article>`;
}

function renderProjects(projects: AppPreviewProject[]): string {
  const items = projects.filter((project) => project.title).map(renderProject).join("");
  return items
    ? `<section class="section"><div class="section-heading"><span>Selected work</span><h2>Projects</h2></div><div class="project-grid">${items}</div></section>`
    : "";
}

export function appPreviewDocument(
  config: AppPreviewConfig,
  templateId: string,
): string {
  const safeName = escapeHtml(config.name || "Untitled portfolio");
  const safeHeadline = escapeHtml(
    config.headline || "Your headline will appear here.",
  );
  const safeDescription = escapeHtml(
    config.description || "Your description will appear here.",
  );
  const safeAccent = /^#[0-9a-fA-F]{6}$/.test(config.accentColor)
    ? config.accentColor
    : "#2fbf8f";
  const safeContact = escapeHtml(config.contact);
  const about = escapeHtml(config.about || config.description);
  const primaryLink = safeHttpsUrl(config.primaryLink);
  const resumeUrl = safeHttpsUrl(config.resumeUrl);
  const heroImageUrl = safeImageUrl(config.heroImageUrl);
  const primaryCta =
    templateId === "startup" ? "Get started" : "Explore the work";
  const secondaryCta =
    templateId === "startup" ? "Learn more" : "Resume";
  const aboutLabel = templateId === "startup" ? "Product" : "About";
  const projectsLabel = templateId === "startup" ? "Highlights" : "Projects";
  const projectsKicker =
    templateId === "startup" ? "Why it matters" : "Selected work";
  const heroPlaceholder =
    templateId === "startup" ? "Launch" : "Portfolio";

  const linkMarkup = primaryLink
    ? `<a class="primary" href="${escapeHtml(primaryLink)}" target="_blank" rel="noreferrer">${escapeHtml(primaryCta)}</a>`
    : "";
  const resumeMarkup = resumeUrl
    ? `<a class="secondary" href="${escapeHtml(resumeUrl)}" target="_blank" rel="noreferrer">${escapeHtml(secondaryCta)}</a>`
    : "";
  const contactMarkup = safeContact
    ? `<span>${safeContact}</span>`
    : "<span>Built on the Internet Computer</span>";
  const heroMediaMarkup = heroImageUrl
    ? `<figure class="hero-media"><img src="${escapeHtml(heroImageUrl)}" alt="" loading="eager"></figure>`
    : `<figure class="hero-media empty"><span>ICP</span><strong>${escapeHtml(heroPlaceholder)}</strong></figure>`;

  const footerLabel =
    templateId === "portfolio"
      ? "Owner-managed ICP portfolio"
      : templateId === "startup"
        ? "Owner-managed ICP landing page"
        : templateId === "static-site"
          ? "Owner-managed static site on ICP"
          : "Deployed on the Internet Computer";

  const aboutSection =
    about || config.skills.length > 0 || config.socialLinks.length > 0
      ? `<section class="section"><div class="section-heading"><span>${escapeHtml(aboutLabel)}</span><h2>${safeName}</h2></div><div class="about-grid"><p class="about-copy">${about || safeDescription}</p><div>${renderSkills(
          config.skills,
        )}${renderSocialLinks(config.socialLinks)}</div></div></section>`
      : "";

  const projectsSection = renderProjects(config.projects)
    .replace("Selected work", escapeHtml(projectsKicker))
    .replace("Projects", escapeHtml(projectsLabel));

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="${safeDescription}">
<title>${safeName}</title><style>
:root{color-scheme:light;--accent:${safeAccent};font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#f7f8fb;color:#171b22}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#f7f8fb;color:#171b22}
a{color:inherit}main{width:min(1120px,100%);margin:0 auto;padding:28px}
.hero{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(280px,.95fr);gap:32px;align-items:center;min-height:min(82vh,860px);padding:42px 0;border-bottom:1px solid #dfe4ea}
.eyebrow,.section-heading span{color:var(--accent);font-size:.78rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
h1{max-width:780px;margin:18px 0;font-size:clamp(2.4rem,7vw,5.8rem);line-height:.98;letter-spacing:-.03em}
p{color:#516070;line-height:1.7}.lede{max-width:680px;font-size:clamp(1.05rem,2vw,1.28rem)}
.actions,.social-links{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.actions{margin-top:32px}
.primary,.secondary,.social-links a,.project-link{display:inline-flex;align-items:center;min-height:42px;padding:11px 14px;border:1px solid #171b22;text-decoration:none;font-weight:800;border-radius:8px}
.primary{background:var(--accent);color:#071016;border-color:var(--accent)}.secondary,.social-links a{background:#fff}
.hero-media{margin:0;aspect-ratio:4/5;max-height:560px;min-height:280px;border:1px solid #dfe4ea;border-radius:12px;overflow:hidden;background:linear-gradient(180deg,#ffffff,#eef2f6);display:grid;place-items:center}
.hero-media img{display:block;width:100%;height:100%;object-fit:cover;object-position:center}.hero-media.empty span{color:var(--accent);font-weight:900}.hero-media.empty strong{font-size:2rem}
.section{padding:52px 0;border-bottom:1px solid #dfe4ea}.section-heading{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:22px}.section-heading h2{margin:0;font-size:2rem}
.about-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(240px,.7fr);gap:28px}.about-copy{font-size:1.1rem}.skill-list{display:flex;flex-wrap:wrap;gap:10px;padding:0;margin:0;list-style:none}.skill-list li,.project-tags span{border:1px solid #d5dbe3;background:#fff;border-radius:8px;padding:8px 10px;font-weight:700}
.project-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px}.project-card{display:flex;flex-direction:column;background:#fff;border:1px solid #dfe4ea;border-radius:12px;overflow:hidden}
.project-media{margin:0;aspect-ratio:16/10;overflow:hidden;background:#e8ecf1}.project-media img,.project-placeholder{display:block;width:100%;height:100%;object-fit:cover;object-position:center}.project-placeholder{background:linear-gradient(135deg,#171b22,#4a6474)}
.project-card div{padding:18px}.project-card h3{margin:0 0 8px;font-size:1.2rem}.project-tags{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}.project-tags span{font-size:.78rem;padding:5px 8px}
.footer{display:flex;justify-content:space-between;gap:18px;flex-wrap:wrap;padding:28px 0;color:#6d7885}
body.template-startup .hero{min-height:auto;padding-top:56px}body.template-startup .hero-media{aspect-ratio:16/10;max-height:420px}
@media(max-width:760px){main{padding:20px}.hero,.about-grid{grid-template-columns:1fr}.hero{min-height:auto;padding-top:28px}.hero-media{max-height:none;aspect-ratio:16/10;min-height:220px}}
</style></head><body class="template-${escapeHtml(templateId)}"><main><section class="hero"><div><div class="eyebrow">${escapeHtml(
    templateEyebrow(templateId),
  )}</div>
<h1>${safeHeadline}</h1><p class="lede">${safeDescription}</p><div class="actions">${linkMarkup}${resumeMarkup}</div></div>${heroMediaMarkup}</section>
${aboutSection}
${projectsSection}
<div class="footer"><strong>${safeName}</strong>${contactMarkup}<span>${escapeHtml(footerLabel)}</span></div></main></body></html>`;
}
