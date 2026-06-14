import Char "mo:core/Char";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
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

  func renderPage() : Text {
    let safeName = escape(config.name);
    let safeHeadline = escape(config.headline);
    let safeDescription = escape(config.description);
    let safeAccent = escape(config.accentColor);
    let safeContact = escape(config.contact);
    let safeLink = escape(config.primaryLink);
    let linkMarkup = if (config.primaryLink.size() > 0) {
      "<a class=\"primary\" href=\"" # safeLink # "\" target=\"_blank\" rel=\"noreferrer\">Explore the project</a>"
    } else {
      ""
    };
    let contactMarkup = if (config.contact.size() > 0) {
      "<span>" # safeContact # "</span>"
    } else {
      "<span>Built with chain abstraction</span>"
    };

    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" #
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" #
    "<meta name=\"description\" content=\"" # safeDescription # "\">" #
    "<title>" # safeName # "</title><style>" #
    ":root{color-scheme:dark;--accent:" # safeAccent # ";font-family:Inter,ui-sans-serif,system-ui,sans-serif}" #
    "*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#090b0f;color:#f4f6f8;display:grid;place-items:center;padding:28px}" #
    "body:before{content:'';position:fixed;inset:0;background:radial-gradient(circle at 15% 15%,color-mix(in srgb,var(--accent) 24%,transparent),transparent 34%),radial-gradient(circle at 90% 80%,#173647,transparent 36%);pointer-events:none}" #
    "main{position:relative;width:min(980px,100%);padding:clamp(32px,7vw,84px);border:1px solid #ffffff1a;border-radius:32px;background:#11141acc;box-shadow:0 35px 100px #0009;backdrop-filter:blur(18px)}" #
    ".eyebrow{color:var(--accent);font-size:.78rem;font-weight:800;letter-spacing:.16em;text-transform:uppercase}" #
    "h1{max-width:820px;margin:24px 0;font-size:clamp(3rem,9vw,7.2rem);line-height:.92;letter-spacing:-.065em}" #
    "p{max-width:680px;margin:0;color:#aeb7c2;font-size:clamp(1.05rem,2vw,1.35rem);line-height:1.7}" #
    ".actions{display:flex;align-items:center;gap:18px;flex-wrap:wrap;margin-top:42px}.primary{display:inline-flex;padding:15px 20px;border-radius:999px;background:var(--accent);color:#081014;text-decoration:none;font-weight:800}" #
    ".meta{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-top:70px;padding-top:22px;border-top:1px solid #ffffff14;color:#7f8a96;font-size:.9rem}" #
    "</style></head><body><main><div class=\"eyebrow\">" # escape(templateEyebrow()) # "</div>" #
    "<h1>" # safeHeadline # "</h1><p>" # safeDescription # "</p><div class=\"actions\">" #
    linkMarkup # "</div><div class=\"meta\"><strong>" # safeName # "</strong>" # contactMarkup #
    "</div></main></body></html>";
  };

  public query func getConfig() : async Types.ChildInit {
    { owner; templateId; config };
  };

  public shared ({ caller }) func updateConfig(next : Types.AppConfig) : async () {
    if (caller != owner) Runtime.trap("Caller is not this app's owner.");
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
