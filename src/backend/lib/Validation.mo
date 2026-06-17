import Char "mo:core/Char";
import Principal "mo:core/Principal";
import Result "mo:core/Result";
import Text "mo:core/Text";
import Types "../../shared/Types";

module {
  let MAX_HTTPS_URL_LENGTH : Nat = 240;
  let MAX_INLINE_IMAGE_LENGTH : Nat = 450_000;
  let MAX_CONFIG_TEXT_LENGTH : Nat = 650_000;

  func isHexDigit(char : Char) : Bool {
    switch (char) {
      case ('0' or '1' or '2' or '3' or '4' or '5' or '6' or '7' or '8' or '9') true;
      case ('a' or 'b' or 'c' or 'd' or 'e' or 'f') true;
      case ('A' or 'B' or 'C' or 'D' or 'E' or 'F') true;
      case (_) false;
    };
  };

  func isBase64Char(char : Char) : Bool {
    switch (char) {
      case ('A' or 'B' or 'C' or 'D' or 'E' or 'F' or 'G' or 'H' or 'I' or 'J' or 'K' or 'L' or 'M' or 'N' or 'O' or 'P' or 'Q' or 'R' or 'S' or 'T' or 'U' or 'V' or 'W' or 'X' or 'Y' or 'Z') true;
      case ('a' or 'b' or 'c' or 'd' or 'e' or 'f' or 'g' or 'h' or 'i' or 'j' or 'k' or 'l' or 'm' or 'n' or 'o' or 'p' or 'q' or 'r' or 's' or 't' or 'u' or 'v' or 'w' or 'x' or 'y' or 'z') true;
      case ('0' or '1' or '2' or '3' or '4' or '5' or '6' or '7' or '8' or '9' or '+' or '/' or '=') true;
      case (_) false;
    };
  };

  func isHexColor(color : Text) : Bool {
    if (color.size() != 7) return false;

    var index : Nat = 0;
    for (char in color.chars()) {
      if (index == 0) {
        if (char != '#') return false;
      } else if (not isHexDigit(char)) {
        return false;
      };
      index += 1;
    };
    true;
  };

  func inlineImagePrefixLength(value : Text) : ?Nat {
    if (value.startsWith(#text("data:image/jpeg;base64,"))) {
      ?("data:image/jpeg;base64,".size());
    } else if (value.startsWith(#text("data:image/jpg;base64,"))) {
      ?("data:image/jpg;base64,".size());
    } else if (value.startsWith(#text("data:image/png;base64,"))) {
      ?("data:image/png;base64,".size());
    } else if (value.startsWith(#text("data:image/webp;base64,"))) {
      ?("data:image/webp;base64,".size());
    } else if (value.startsWith(#text("data:image/gif;base64,"))) {
      ?("data:image/gif;base64,".size());
    } else {
      null;
    };
  };

  func isInlineImage(value : Text) : Bool {
    let prefixLength = switch (inlineImagePrefixLength(value)) {
      case (?length) length;
      case (null) return false;
    };

    var index : Nat = 0;
    var payloadLength : Nat = 0;
    for (char in value.chars()) {
      if (index >= prefixLength) {
        payloadLength += 1;
        if (not isBase64Char(char)) return false;
      };
      index += 1;
    };
    payloadLength > 0;
  };

  func requireHttpsUrl(value : Text, fieldName : Text) : Result.Result<(), Text> {
    if (value.size() == 0) return #ok(());
    if (value.size() > MAX_HTTPS_URL_LENGTH) return #err(fieldName # " URL is too long.");
    if (not value.startsWith(#text("https://"))) {
      return #err(fieldName # " must use https://.");
    };
    #ok(());
  };

  func requireImageUrl(value : Text, fieldName : Text) : Result.Result<(), Text> {
    if (value.size() == 0) return #ok(());
    if (value.startsWith(#text("https://"))) return requireHttpsUrl(value, fieldName);
    if (value.size() > MAX_INLINE_IMAGE_LENGTH) {
      return #err(fieldName # " upload is too large. Use a smaller image.");
    };
    if (not isInlineImage(value)) {
      return #err(fieldName # " must use https:// or an uploaded PNG, JPEG, WebP, or GIF image.");
    };
    #ok(());
  };

  func validateOptionalText(
    value : ?Text,
    maxLength : Nat,
    fieldName : Text,
  ) : Result.Result<(), Text> {
    switch (value) {
      case (null) #ok(());
      case (?text) {
        if (text.size() > maxLength) {
          #err(fieldName # " is too long.")
        } else {
          #ok(())
        };
      };
    };
  };

  func optionalTextSize(value : ?Text) : Nat {
    switch (value) {
      case (?text) text.size();
      case (null) 0;
    };
  };

  func appConfigTextSize(config : Types.AppConfig) : Nat {
    var total =
      config.name.size() +
      config.headline.size() +
      config.description.size() +
      config.accentColor.size() +
      config.primaryLink.size() +
      config.contact.size() +
      optionalTextSize(config.about) +
      optionalTextSize(config.heroImageUrl) +
      optionalTextSize(config.resumeUrl);

    switch (config.skills) {
      case (?items) {
        for (item in items.vals()) total += item.size();
      };
      case (null) {};
    };
    switch (config.socialLinks) {
      case (?items) {
        for (link in items.vals()) {
          total += link.labelText.size() + link.url.size();
        };
      };
      case (null) {};
    };
    switch (config.projects) {
      case (?items) {
        for (project in items.vals()) {
          total +=
            project.title.size() +
            project.description.size() +
            project.url.size() +
            project.imageUrl.size();
          for (tag in project.tags.vals()) total += tag.size();
        };
      };
      case (null) {};
    };
    total;
  };

  func validateSkills(skills : ?[Text]) : Result.Result<(), Text> {
    switch (skills) {
      case (null) #ok(());
      case (?items) {
        if (items.size() > 12) return #err("Use 12 skills or fewer.");
        for (skill in items.vals()) {
          if (skill.size() == 0 or skill.size() > 40) {
            return #err("Each skill must be between 1 and 40 characters.");
          };
        };
        #ok(());
      };
    };
  };

  func validateLinks(links : ?[Types.Link]) : Result.Result<(), Text> {
    switch (links) {
      case (null) #ok(());
      case (?items) {
        if (items.size() > 6) return #err("Use 6 social links or fewer.");
        for (link in items.vals()) {
          if (link.labelText.size() == 0 or link.labelText.size() > 32) {
            return #err("Each social link label must be between 1 and 32 characters.");
          };
          switch (requireHttpsUrl(link.url, "Social link")) {
            case (#err(message)) return #err(message);
            case (#ok(())) {};
          };
        };
        #ok(());
      };
    };
  };

  func validateProject(project : Types.PortfolioProject) : Result.Result<(), Text> {
    if (project.title.size() == 0 or project.title.size() > 80) {
      return #err("Each project title must be between 1 and 80 characters.");
    };
    if (project.description.size() > 500) {
      return #err("Each project description must be 500 characters or fewer.");
    };
    switch (requireHttpsUrl(project.url, "Project link")) {
      case (#err(message)) return #err(message);
      case (#ok(())) {};
    };
    switch (requireImageUrl(project.imageUrl, "Project image")) {
      case (#err(message)) return #err(message);
      case (#ok(())) {};
    };
    if (project.tags.size() > 6) return #err("Use 6 tags or fewer per project.");
    for (tag in project.tags.vals()) {
      if (tag.size() == 0 or tag.size() > 32) {
        return #err("Each project tag must be between 1 and 32 characters.");
      };
    };
    #ok(());
  };

  func validateProjects(
    projects : ?[Types.PortfolioProject]
  ) : Result.Result<(), Text> {
    switch (projects) {
      case (null) #ok(());
      case (?items) {
        if (items.size() > 8) return #err("Use 8 projects or fewer.");
        for (project in items.vals()) {
          switch (validateProject(project)) {
            case (#err(message)) return #err(message);
            case (#ok(())) {};
          };
        };
        #ok(());
      };
    };
  };

  public func requireAuthenticated(caller : Principal) : Result.Result<(), Text> {
    if (caller.isAnonymous()) {
      #err("Sign in with Internet Identity first.")
    } else {
      #ok(())
    };
  };

  public func fundingMonths(value : Nat) : Result.Result<(), Text> {
    if (value == 1 or value == 3 or value == 6) {
      #ok(())
    } else {
      #err("Funding duration must be 1, 3, or 6 months.")
    };
  };

  public func appConfig(config : Types.AppConfig) : Result.Result<(), Text> {
    if (appConfigTextSize(config) > MAX_CONFIG_TEXT_LENGTH) {
      return #err("App content is too large. Use smaller uploaded images or fewer project images.");
    };
    if (config.name.size() < 2 or config.name.size() > 80) {
      return #err("App name must be between 2 and 80 characters.");
    };
    if (config.headline.size() < 4 or config.headline.size() > 140) {
      return #err("Headline must be between 4 and 140 characters.");
    };
    if (config.description.size() < 10 or config.description.size() > 1_200) {
      return #err("Description must be between 10 and 1,200 characters.");
    };
    if (config.primaryLink.size() > 240 or config.contact.size() > 160) {
      return #err("Link or contact value is too long.");
    };
    if (not isHexColor(config.accentColor)) {
      return #err("Accent color must be a six-digit hex color.");
    };
    if (
      config.primaryLink.size() > 0 and
      not config.primaryLink.startsWith(#text("https://"))
    ) {
      return #err("Primary link must use https://.");
    };
    switch (validateOptionalText(config.about, 2_000, "About section")) {
      case (#err(message)) return #err(message);
      case (#ok(())) {};
    };
    switch (requireImageUrl(switch (config.heroImageUrl) { case (?url) url; case (null) "" }, "Hero image")) {
      case (#err(message)) return #err(message);
      case (#ok(())) {};
    };
    switch (requireHttpsUrl(switch (config.resumeUrl) { case (?url) url; case (null) "" }, "Resume")) {
      case (#err(message)) return #err(message);
      case (#ok(())) {};
    };
    switch (validateSkills(config.skills)) {
      case (#err(message)) return #err(message);
      case (#ok(())) {};
    };
    switch (validateLinks(config.socialLinks)) {
      case (#err(message)) return #err(message);
      case (#ok(())) {};
    };
    switch (validateProjects(config.projects)) {
      case (#err(message)) return #err(message);
      case (#ok(())) {};
    };
    #ok(());
  };
};
