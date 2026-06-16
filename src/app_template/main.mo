import Char "mo:core/Char";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Validation "../backend/lib/Validation";
import Types "../shared/Types";

shared (_install) actor class GeneratedApp(init : Types.ChildInit) {
  var owner = init.owner;
  let templateId = init.templateId;
  var config = init.config;

  type HeaderField = (Text, Text);

  type HttpRequest = {
    method : Text;
    url : Text;
    headers : [HeaderField];
    body : Blob;
    certificate_version : ?Nat16;
  };

  type HttpResponse = {
    status_code : Nat16;
    headers : [HeaderField];
    body : Blob;
    upgrade : ?Bool;
    streaming_strategy : ?{
      #Callback : {
        token : Blob;
        callback : shared query Blob -> async {
          body : Blob;
          token : ?Blob;
        };
      };
    };
  };

  func escape(value : Text) : Text {
    var escaped = "";
    for (char in value.chars()) {
      let codepoint = char.toNat32();
      escaped #= if (codepoint == 34) {
        "&quot;"
      } else if (codepoint == 39) {
        "&#39;"
      } else {
        switch (char) {
          case ('&') "&amp;";
          case ('<') "&lt;";
          case ('>') "&gt;";
          case (_) char.toText();
        };
      };
    };
    escaped;
  };

  func templateEyebrow() : Text {
    switch (templateId) {
      case ("portfolio") "Independent work, permanently online";
      case ("startup") "A new product, launched on ICP";
      case ("grant") "Open milestones, public progress";
      case (_) "Deployed on the Internet Computer";
    };
  };

  func optText(value : ?Text) : Text {
    switch (value) {
      case (?text) text;
      case (null) "";
    };
  };

  func optArray<T>(value : ?[T]) : [T] {
    switch (value) {
      case (?items) items;
      case (null) [];
    };
  };

  func renderSkills() : Text {
    let skills = optArray(config.skills);
    if (skills.size() == 0) return "";

    var markup = "<ul class=\"skill-list\">";
    for (skill in skills.vals()) {
      if (skill.size() > 0) {
        markup #= "<li>" # escape(skill) # "</li>";
      };
    };
    markup # "</ul>";
  };

  func renderSocialLinks() : Text {
    let links = optArray(config.socialLinks);
    if (links.size() == 0) return "";

    var markup = "<nav class=\"social-links\" aria-label=\"Portfolio links\">";
    for (link in links.vals()) {
      if (link.labelText.size() > 0 and link.url.size() > 0) {
        markup #= "<a href=\"" # escape(link.url) # "\" target=\"_blank\" rel=\"noreferrer\">" #
          escape(link.labelText) # "</a>";
      };
    };
    markup # "</nav>";
  };

  func renderTags(tags : [Text]) : Text {
    if (tags.size() == 0) return "";
    var markup = "<div class=\"project-tags\">";
    for (tag in tags.vals()) {
      if (tag.size() > 0) markup #= "<span>" # escape(tag) # "</span>";
    };
    markup # "</div>";
  };

  func renderProject(project : Types.PortfolioProject) : Text {
    let imageMarkup = if (project.imageUrl.size() > 0) {
      "<img src=\"" # escape(project.imageUrl) # "\" alt=\"\" loading=\"lazy\">"
    } else {
      "<div class=\"project-placeholder\" aria-hidden=\"true\"></div>"
    };
    let actionMarkup = if (project.url.size() > 0) {
      "<a class=\"project-link\" href=\"" # escape(project.url) # "\" target=\"_blank\" rel=\"noreferrer\">Open project</a>"
    } else {
      "";
    };

    "<article class=\"project-card\">" # imageMarkup #
    "<div><h3>" # escape(project.title) # "</h3><p>" # escape(project.description) # "</p>" #
    renderTags(project.tags) # actionMarkup # "</div></article>";
  };

  func renderProjects() : Text {
    let projects = optArray(config.projects);
    if (projects.size() == 0) return "";

    var markup = "<section class=\"section\"><div class=\"section-heading\"><span>Selected work</span><h2>Projects</h2></div><div class=\"project-grid\">";
    for (project in projects.vals()) {
      markup #= renderProject(project);
    };
    markup # "</div></section>";
  };

  func renderPage() : Text {
    let safeName = escape(config.name);
    let safeHeadline = escape(config.headline);
    let safeDescription = escape(config.description);
    let safeAccent = escape(config.accentColor);
    let safeContact = escape(config.contact);
    let safeLink = escape(config.primaryLink);
    let safeAbout = escape(switch (config.about) {
      case (?about) about;
      case (null) config.description;
    });
    let heroImageUrl = optText(config.heroImageUrl);
    let resumeUrl = optText(config.resumeUrl);
    let linkMarkup = if (config.primaryLink.size() > 0) {
      "<a class=\"primary\" href=\"" # safeLink # "\" target=\"_blank\" rel=\"noreferrer\">Explore the work</a>"
    } else {
      ""
    };
    let resumeMarkup = if (resumeUrl.size() > 0) {
      "<a class=\"secondary\" href=\"" # escape(resumeUrl) # "\" target=\"_blank\" rel=\"noreferrer\">Resume</a>"
    } else {
      ""
    };
    let contactMarkup = if (config.contact.size() > 0) {
      "<span>" # safeContact # "</span>"
    } else {
      "<span>Built on the Internet Computer</span>"
    };
    let heroMediaMarkup = if (heroImageUrl.size() > 0) {
      "<figure class=\"hero-media\"><img src=\"" # escape(heroImageUrl) # "\" alt=\"\" loading=\"eager\"></figure>"
    } else {
      "<figure class=\"hero-media empty\"><span>ICP</span><strong>Portfolio</strong></figure>"
    };

    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" #
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" #
    "<meta name=\"description\" content=\"" # safeDescription # "\">" #
    "<title>" # safeName # "</title><style>" #
    ":root{color-scheme:light;--accent:" # safeAccent # ";font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#f7f8fb;color:#171b22}" #
    "*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#f7f8fb;color:#171b22}" #
    "a{color:inherit}main{width:min(1120px,100%);margin:0 auto;padding:28px}" #
    ".hero{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(260px,.9fr);gap:28px;align-items:center;min-height:82vh;padding:42px 0;border-bottom:1px solid #dfe4ea}" #
    ".eyebrow,.section-heading span{color:var(--accent);font-size:.78rem;font-weight:800;text-transform:uppercase}" #
    "h1{max-width:780px;margin:18px 0;font-size:clamp(2.6rem,8vw,6.4rem);line-height:.96;letter-spacing:0}" #
    "p{color:#516070;line-height:1.7}.lede{max-width:680px;font-size:clamp(1.05rem,2vw,1.28rem)}" #
    ".actions,.social-links{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.actions{margin-top:32px}" #
    ".primary,.secondary,.social-links a,.project-link{display:inline-flex;align-items:center;min-height:42px;padding:11px 14px;border:1px solid #171b22;text-decoration:none;font-weight:800;border-radius:8px}" #
    ".primary{background:var(--accent);color:#071016;border-color:var(--accent)}.secondary,.social-links a{background:#fff}" #
    ".hero-media{margin:0;min-height:380px;border:1px solid #dfe4ea;border-radius:8px;overflow:hidden;background:#ffffff;display:grid;place-items:center}" #
    ".hero-media img{width:100%;height:100%;object-fit:cover}.hero-media.empty span{color:var(--accent);font-weight:900}.hero-media.empty strong{font-size:2rem}" #
    ".section{padding:52px 0;border-bottom:1px solid #dfe4ea}.section-heading{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:22px}.section-heading h2{margin:0;font-size:2rem}" #
    ".about-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(240px,.7fr);gap:28px}.about-copy{font-size:1.1rem}.skill-list{display:flex;flex-wrap:wrap;gap:10px;padding:0;margin:0;list-style:none}.skill-list li,.project-tags span{border:1px solid #d5dbe3;background:#fff;border-radius:8px;padding:8px 10px;font-weight:700}" #
    ".project-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px}.project-card{background:#fff;border:1px solid #dfe4ea;border-radius:8px;overflow:hidden}.project-card img,.project-placeholder{width:100%;aspect-ratio:16/10;object-fit:cover;background:linear-gradient(135deg,#171b22,#4a6474)}.project-card div{padding:18px}.project-card h3{margin:0 0 8px;font-size:1.2rem}.project-tags{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}.project-tags span{font-size:.78rem;padding:5px 8px}" #
    ".footer{display:flex;justify-content:space-between;gap:18px;flex-wrap:wrap;padding:28px 0;color:#6d7885}" #
    "@media(max-width:760px){main{padding:20px}.hero,.about-grid{grid-template-columns:1fr}.hero{min-height:auto}.hero-media{min-height:260px}}" #
    "</style></head><body><main><section class=\"hero\"><div><div class=\"eyebrow\">" # escape(templateEyebrow()) # "</div>" #
    "<h1>" # safeHeadline # "</h1><p class=\"lede\">" # safeDescription # "</p><div class=\"actions\">" #
    linkMarkup # resumeMarkup # "</div></div>" # heroMediaMarkup # "</section>" #
    "<section class=\"section\"><div class=\"section-heading\"><span>About</span><h2>" # safeName # "</h2></div><div class=\"about-grid\"><p class=\"about-copy\">" #
    safeAbout # "</p><div>" # renderSkills() # renderSocialLinks() # "</div></div></section>" #
    renderProjects() # "<div class=\"footer\"><strong>" # safeName # "</strong>" # contactMarkup #
    "<span>Owner-managed ICP portfolio</span></div></main></body></html>";
  };

  public query func getOwner() : async Principal {
    owner;
  };

  public query func getTemplateInfo() : async Types.ChildTemplateInfo {
    { templateId };
  };

  public query func getConfig() : async Types.ChildInit {
    { owner; templateId; config };
  };

  public shared ({ caller }) func updateConfig(next : Types.AppConfig) : async () {
    if (caller != owner) Runtime.trap("Caller is not this app's owner.");
    switch (Validation.appConfig(next)) {
      case (#err(message)) Runtime.trap(message);
      case (#ok(())) {};
    };
    config := next;
  };

  public shared ({ caller }) func transferOwnership(nextOwner : Principal) : async () {
    if (caller != owner) Runtime.trap("Caller is not this app's owner.");
    if (nextOwner.isAnonymous()) Runtime.trap("Owner cannot be anonymous.");
    owner := nextOwner;
  };

  public query func http_request(request : HttpRequest) : async HttpResponse {
    if (request.url == "/" or request.url.startsWith(#text("/?"))) {
      {
        status_code = 200;
        headers = [
          ("Content-Type", "text/html; charset=utf-8"),
          ("Cache-Control", "public, max-age=60"),
          ("X-Content-Type-Options", "nosniff"),
          ("Referrer-Policy", "strict-origin-when-cross-origin"),
        ];
        body = renderPage().encodeUtf8();
        upgrade = null;
        streaming_strategy = null;
      };
    } else {
      {
        status_code = 404;
        headers = [("Content-Type", "text/plain; charset=utf-8")];
        body = "Not found".encodeUtf8();
        upgrade = null;
        streaming_strategy = null;
      };
    };
  };
};
