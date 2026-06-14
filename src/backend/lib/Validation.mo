import Char "mo:core/Char";
import Principal "mo:core/Principal";
import Result "mo:core/Result";
import Text "mo:core/Text";
import Types "../../shared/Types";

module {
  func isHexDigit(char : Char) : Bool {
    switch (char) {
      case ('0' or '1' or '2' or '3' or '4' or '5' or '6' or '7' or '8' or '9') true;
      case ('a' or 'b' or 'c' or 'd' or 'e' or 'f') true;
      case ('A' or 'B' or 'C' or 'D' or 'E' or 'F') true;
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
    #ok(());
  };
};
