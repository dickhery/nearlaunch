import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Char "mo:core/Char";
import List "mo:core/List";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Nat32 "mo:core/Nat32";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import VarArray "mo:core/VarArray";
import Validation "../backend/lib/Validation";
import Types "../shared/Types";

shared (install) actor class GeneratedApp(init : Types.ChildInit) {
  transient let platformController = install.caller;
  transient let TEMPLATE_VERSION : Nat = 4;
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

  type StoredImage = {
    contentType : Text;
    data : Blob;
  };

  var heroImage : ?StoredImage = null;
  var projectImages : [?StoredImage] = [];

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

  func pathOnly(url : Text) : Text {
    switch (Text.split(url, #char '?').next()) {
      case (?part) part;
      case (null) url;
    };
  };

  func templateEyebrow() : Text {
    switch (templateId) {
      case ("portfolio") "Independent work, permanently online";
      case ("startup") "A new product, launched on ICP";
      case ("grant") "Open milestones, public progress";
      case (_) "Deployed on the Internet Computer";
    };
  };

  func footerLabel() : Text {
    switch (templateId) {
      case ("portfolio") "Owner-managed ICP portfolio";
      case ("startup") "Owner-managed ICP landing page";
      case ("grant") "Owner-managed ICP grant page";
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

  func inlineImagePrefixLength(value : Text) : ?Nat {
    if (value.startsWith(#text "data:image/jpeg;base64,")) {
      ?("data:image/jpeg;base64,".size());
    } else if (value.startsWith(#text "data:image/jpg;base64,")) {
      ?("data:image/jpg;base64,".size());
    } else if (value.startsWith(#text "data:image/png;base64,")) {
      ?("data:image/png;base64,".size());
    } else if (value.startsWith(#text "data:image/webp;base64,")) {
      ?("data:image/webp;base64,".size());
    } else if (value.startsWith(#text "data:image/gif;base64,")) {
      ?("data:image/gif;base64,".size());
    } else {
      null;
    };
  };

  func inlineImageContentType(value : Text) : ?Text {
    if (
      value.startsWith(#text "data:image/jpeg;base64,") or value.startsWith(
        #text "data:image/jpg;base64,",
      )
    ) {
      ?"image/jpeg";
    } else if (value.startsWith(#text "data:image/png;base64,")) {
      ?"image/png";
    } else if (value.startsWith(#text "data:image/webp;base64,")) {
      ?"image/webp";
    } else if (value.startsWith(#text "data:image/gif;base64,")) {
      ?"image/gif";
    } else {
      null;
    };
  };

  func base64CharValue(char : Char) : ?Nat8 {
    let code = Char.toNat32(char);
    if (code >= 65 and code <= 90) {
      ?Nat8.fromNat(Nat32.toNat(code - 65));
    } else if (code >= 97 and code <= 122) {
      ?Nat8.fromNat(Nat32.toNat(code - 71));
    } else if (code >= 48 and code <= 57) {
      ?Nat8.fromNat(Nat32.toNat(code + 4));
    } else if (char == '+') {
      ?62;
    } else if (char == '/') {
      ?63;
    } else {
      null;
    };
  };

  let IMAGE_CHUNK_SIZE : Nat = 4096;

  func isInlineImageUrl(value : Text) : Bool {
    switch (inlineImagePrefixLength(value)) {
      case (?_) true;
      case (null) false;
    };
  };

  func decodeInlineImage(value : Text) : ?StoredImage {
    switch (inlineImagePrefixLength(value)) {
      case (?prefixLength) {
        switch (inlineImageContentType(value)) {
          case (?contentType) {
            var chunk = VarArray.repeat<Nat8>(0, IMAGE_CHUNK_SIZE);
            var chunkLen : Nat = 0;
            var parts = List.empty<Blob>();
            var buffer : Nat32 = 0;
            var bits : Nat = 0;
            var index : Nat = 0;
            var sawPayload = false;

            func flushChunk() {
              if (chunkLen > 0) {
                List.add(
                  parts,
                  Blob.fromArray(Array.tabulate<Nat8>(chunkLen, func i = chunk[i])),
                );
                chunk := VarArray.repeat<Nat8>(0, IMAGE_CHUNK_SIZE);
                chunkLen := 0;
              };
            };

            func pushByte(byte : Nat8) {
              chunk[chunkLen] := byte;
              chunkLen += 1;
              if (chunkLen >= IMAGE_CHUNK_SIZE) flushChunk();
            };

            for (char in value.chars()) {
              if (index >= prefixLength) {
                if (char == '=') break;
                sawPayload := true;
                switch (base64CharValue(char)) {
                  case (?encoded) {
                    buffer := (buffer << 6) | Nat32.fromNat(Nat8.toNat(encoded));
                    bits += 6;
                    if (bits >= 8) {
                      bits -= 8;
                      let shift = Nat32.fromNat(bits);
                      let byte = Nat8.fromNat(Nat32.toNat((buffer >> shift) & 0xFF));
                      pushByte(byte);
                    };
                  };
                  case (null) {};
                };
              };
              index += 1;
            };
            flushChunk();
            if (sawPayload) {
              let partBlobs = List.toArray(parts);
              var totalBytes : Nat = 0;
              for (part in partBlobs.vals()) {
                totalBytes += part.size();
              };
              if (totalBytes == 0) {
                null;
              } else {
                var bytes = VarArray.repeat<Nat8>(0, totalBytes);
                var offset : Nat = 0;
                for (part in partBlobs.vals()) {
                  for (byte in part.vals()) {
                    bytes[offset] := byte;
                    offset += 1;
                  };
                };
                ?{
                  contentType;
                  data = Blob.fromArray(Array.tabulate<Nat8>(totalBytes, func i = bytes[i]));
                };
              };
            } else {
              null;
            };
          };
          case (null) null;
        };
      };
      case (null) null;
    };
  };

  func resetImageCache() {
    heroImage := null;
    let projects = optArray(config.projects);
    projectImages := Array.tabulate<?StoredImage>(projects.size(), func _ = null);
  };

  func ensureHeroImage() : ?StoredImage {
    switch (heroImage) {
      case (?image) ?image;
      case (null) {
        let extracted = decodeInlineImage(optText(config.heroImageUrl));
        heroImage := extracted;
        extracted;
      };
    };
  };

  func ensureProjectImage(index : Nat) : ?StoredImage {
    if (index >= projectImages.size()) return null;
    switch (projectImages[index]) {
      case (?image) ?image;
      case (null) {
        let projects = optArray(config.projects);
        if (index >= projects.size()) return null;
        let extracted = decodeInlineImage(projects[index].imageUrl);
        let next = Array.tabulate<?StoredImage>(projectImages.size(), func i {
          if (i == index) extracted else projectImages[i];
        });
        projectImages := next;
        extracted;
      };
    };
  };

  func heroImageSrc() : Text {
    let url = optText(config.heroImageUrl);
    if (isInlineImageUrl(url)) "/assets/hero"
    else if (url.startsWith(#text "https://")) url
    else {
      switch (heroImage) {
        case (?_) "/assets/hero";
        case (null) "";
      };
    };
  };

  func projectImageSrc(index : Nat, imageUrl : Text) : Text {
    if (isInlineImageUrl(imageUrl)) "/assets/project/" # Nat.toText(index)
    else if (imageUrl.startsWith(#text "https://")) imageUrl
    else {
      if (index < projectImages.size()) {
        switch (projectImages[index]) {
          case (?_) "/assets/project/" # Nat.toText(index);
          case (null) "";
        };
      } else {
        "";
      };
    };
  };

  func pageStyles(accent : Text) : Text {
    ":root{color-scheme:light;--accent:" # accent #
    ";font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#f7f8fb;color:#171b22}" #
    "*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#f7f8fb;color:#171b22}" #
    "a{color:inherit}main{width:min(1120px,100%);margin:0 auto;padding:28px}" #
    ".hero{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(280px,.95fr);gap:32px;align-items:center;min-height:min(82vh,860px);padding:42px 0;border-bottom:1px solid #dfe4ea}" #
    ".eyebrow,.section-heading span{color:var(--accent);font-size:.78rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase}" #
    "h1{max-width:780px;margin:18px 0;font-size:clamp(2.4rem,7vw,5.8rem);line-height:.98;letter-spacing:-.03em}" #
    "p{color:#516070;line-height:1.7}.lede{max-width:680px;font-size:clamp(1.05rem,2vw,1.28rem)}" #
    ".actions,.social-links{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.actions{margin-top:32px}" #
    ".primary,.secondary,.social-links a,.project-link{display:inline-flex;align-items:center;min-height:42px;padding:11px 14px;border:1px solid #171b22;text-decoration:none;font-weight:800;border-radius:8px}" #
    ".primary{background:var(--accent);color:#071016;border-color:var(--accent)}.secondary,.social-links a{background:#fff}" #
    ".hero-media{margin:0;aspect-ratio:4/5;max-height:560px;min-height:280px;border:1px solid #dfe4ea;border-radius:12px;overflow:hidden;background:linear-gradient(180deg,#ffffff,#eef2f6);display:grid;place-items:center}" #
    ".hero-media img{display:block;width:100%;height:100%;object-fit:cover;object-position:center}" #
    ".hero-media.empty span{color:var(--accent);font-weight:900}.hero-media.empty strong{font-size:2rem}" #
    ".section{padding:52px 0;border-bottom:1px solid #dfe4ea}.section-heading{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:22px}.section-heading h2{margin:0;font-size:2rem}" #
    ".about-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(240px,.7fr);gap:28px}.about-copy{font-size:1.1rem}.skill-list{display:flex;flex-wrap:wrap;gap:10px;padding:0;margin:0;list-style:none}.skill-list li,.project-tags span{border:1px solid #d5dbe3;background:#fff;border-radius:8px;padding:8px 10px;font-weight:700}" #
    ".project-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px}.project-card{display:flex;flex-direction:column;background:#fff;border:1px solid #dfe4ea;border-radius:12px;overflow:hidden}" #
    ".project-media{margin:0;aspect-ratio:16/10;overflow:hidden;background:#e8ecf1}.project-media img,.project-placeholder{display:block;width:100%;height:100%;object-fit:cover;object-position:center}.project-placeholder{background:linear-gradient(135deg,#171b22,#4a6474)}" #
    ".project-card div{padding:18px}.project-card h3{margin:0 0 8px;font-size:1.2rem}.project-tags{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}.project-tags span{font-size:.78rem;padding:5px 8px}" #
    ".footer{display:flex;justify-content:space-between;gap:18px;flex-wrap:wrap;padding:28px 0;color:#6d7885}" #
    "body.template-startup .hero{min-height:auto;padding-top:56px}body.template-startup .hero-media{aspect-ratio:16/10;max-height:420px}" #
    "@media(max-width:760px){main{padding:20px}.hero,.about-grid{grid-template-columns:1fr}.hero{min-height:auto;padding-top:28px}.hero-media{max-height:none;aspect-ratio:16/10;min-height:220px}}"
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

  func renderProject(index : Nat, project : Types.PortfolioProject) : Text {
    let imageSrc = projectImageSrc(index, project.imageUrl);
    let imageMarkup = if (imageSrc.size() > 0) {
      "<figure class=\"project-media\"><img src=\"" # escape(imageSrc) #
      "\" alt=\"" # escape(project.title) # " preview\" loading=\"lazy\"></figure>"
    } else {
      "<figure class=\"project-media\"><div class=\"project-placeholder\" aria-hidden=\"true\"></div></figure>"
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
    var index = 0;
    for (project in projects.vals()) {
      markup #= renderProject(index, project);
      index += 1;
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
    let resumeUrl = optText(config.resumeUrl);
    let heroSrc = heroImageSrc();
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
    let heroMediaMarkup = if (heroSrc.size() > 0) {
      "<figure class=\"hero-media\"><img src=\"" # escape(heroSrc) # "\" alt=\"\" loading=\"eager\"></figure>"
    } else {
      "<figure class=\"hero-media empty\"><span>ICP</span><strong>Portfolio</strong></figure>"
    };

    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" #
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" #
    "<meta name=\"description\" content=\"" # safeDescription # "\">" #
    "<title>" # safeName # "</title><style>" # pageStyles(safeAccent) #
    "</style></head><body class=\"template-" # escape(templateId) # "\"><main><section class=\"hero\"><div><div class=\"eyebrow\">" #
    escape(templateEyebrow()) # "</div>" #
    "<h1>" # safeHeadline # "</h1><p class=\"lede\">" # safeDescription # "</p><div class=\"actions\">" #
    linkMarkup # resumeMarkup # "</div></div>" # heroMediaMarkup # "</section>" #
    "<section class=\"section\"><div class=\"section-heading\"><span>About</span><h2>" # safeName # "</h2></div><div class=\"about-grid\"><p class=\"about-copy\">" #
    safeAbout # "</p><div>" # renderSkills() # renderSocialLinks() # "</div></div></section>" #
    renderProjects() # "<div class=\"footer\"><strong>" # safeName # "</strong>" # contactMarkup #
    "<span>" # escape(footerLabel()) # "</span></div></main></body></html>";
  };

  func textAfterPrefix(value : Text, prefix : Text) : Text {
    if (not value.startsWith(#text prefix)) return "";
    var result = "";
    var skip = prefix.size();
    for (char in value.chars()) {
      if (skip > 0) {
        skip -= 1;
      } else {
        result #= char.toText();
      };
    };
    result;
  };

  func parseProjectAssetIndex(url : Text) : ?Nat {
    let suffix = textAfterPrefix(url, "/assets/project/");
    if (suffix.size() == 0) return null;
    var digits = "";
    for (char in suffix.chars()) {
      if (char >= '0' and char <= '9') {
        digits #= char.toText();
      } else {
        return null;
      };
    };
    if (digits.size() == 0) null else Nat.fromText(digits);
  };

  func imageResponse(image : StoredImage) : HttpResponse {
    {
      status_code = 200;
      headers = [
        ("Content-Type", image.contentType),
        ("Cache-Control", "public, max-age=300"),
        ("X-Content-Type-Options", "nosniff"),
      ];
      body = image.data;
      upgrade = null;
      streaming_strategy = null;
    };
  };

  public query func getOwner() : async Principal {
    owner;
  };

  public query func getTemplateVersion() : async Nat {
    TEMPLATE_VERSION;
  };

  public query func getTemplateInfo() : async Types.ChildTemplateInfo {
    { templateId };
  };

  public query func getConfig() : async Types.ChildInit {
    { owner; templateId; config };
  };

  func requireOwner(caller : Principal) {
    if (caller.isAnonymous()) Runtime.trap("Anonymous caller is not allowed.");
    if (caller != owner) Runtime.trap("Caller is not this app's owner.");
  };

  func requireEditor(caller : Principal) {
    if (caller.isAnonymous()) Runtime.trap("Anonymous caller is not allowed.");
    if (caller != owner and caller != platformController) {
      Runtime.trap("Caller cannot edit this app.");
    };
  };

  func applyConfig(next : Types.AppConfig) {
    switch (Validation.appConfig(next)) {
      case (#err(message)) Runtime.trap(message);
      case (#ok(())) {};
    };
    config := next;
    resetImageCache();
  };

  public shared ({ caller }) func updateConfig(next : Types.AppConfig) : async () {
    requireEditor(caller);
    applyConfig(next);
  };

  public shared ({ caller }) func updateConfigForOwner(
    expectedOwner : Principal,
    next : Types.AppConfig,
  ) : async () {
    if (caller.isAnonymous()) Runtime.trap("Anonymous caller is not allowed.");
    if (caller != platformController) Runtime.trap("Caller is not the platform controller.");
    if (expectedOwner != owner) Runtime.trap("App owner no longer matches this deployment order.");
    applyConfig(next);
  };

  public shared ({ caller }) func transferOwnership(nextOwner : Principal) : async () {
    requireOwner(caller);
    if (nextOwner.isAnonymous()) Runtime.trap("Owner cannot be anonymous.");
    owner := nextOwner;
  };

  public query func http_request(request : HttpRequest) : async HttpResponse {
    let route = pathOnly(request.url);
    if (route == "/" or route.startsWith(#text "/?")) {
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
    } else if (route == "/assets/hero") {
      switch (ensureHeroImage()) {
        case (?image) imageResponse(image);
        case (null) {
          {
            status_code = 404;
            headers = [("Content-Type", "text/plain; charset=utf-8")];
            body = "Hero image not found".encodeUtf8();
            upgrade = null;
            streaming_strategy = null;
          };
        };
      };
    } else {
      switch (parseProjectAssetIndex(route)) {
        case (?index) {
          switch (ensureProjectImage(index)) {
            case (?image) imageResponse(image);
            case (null) {
              {
                status_code = 404;
                headers = [("Content-Type", "text/plain; charset=utf-8")];
                body = "Project image not found".encodeUtf8();
                upgrade = null;
                streaming_strategy = null;
              };
            };
          };
        };
        case (null) {
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
  };

  resetImageCache();
};