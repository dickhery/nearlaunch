import Map "mo:core/Map";
import Types "../shared/Types";

module {
  // One-shot bridge for upgrading b513665 over 951ae69.
  // Remove this module and the actor migration hook after mainnet upgrade succeeds.
  type OldAppConfig = {
    name : Text;
    headline : Text;
    description : Text;
    accentColor : Text;
    primaryLink : Text;
    contact : Text;
  };

  type OldDeploymentOrder = {
    id : Nat;
    owner : Principal;
    templateId : Text;
    config : OldAppConfig;
    fundingMonths : Nat;
    status : Types.DeploymentStatus;
    requestedAt : Int;
    expectedAmountUsdCents : Nat;
    expectedSettlementAmount : Nat;
    expectedCycles : Nat;
    settlementAsset : Text;
    paymentQuoteId : ?Text;
    depositAddress : ?Text;
    paymentTxHash : ?Text;
    settlementProof : ?Text;
    createdCanisterId : ?Principal;
    appUrl : ?Text;
    error : ?Text;
  };

  type OldActor = {
    orders : Map.Map<Nat, OldDeploymentOrder>;
  };

  type NewActor = {
    orders : Map.Map<Nat, Types.DeploymentOrder>;
  };

  func migrateConfig(old : OldAppConfig) : Types.AppConfig {
    {
      name = old.name;
      headline = old.headline;
      description = old.description;
      accentColor = old.accentColor;
      primaryLink = old.primaryLink;
      contact = old.contact;
      about = null;
      heroImageUrl = null;
      resumeUrl = null;
      skills = null;
      socialLinks = null;
      projects = null;
    };
  };

  func migrateOrder(old : OldDeploymentOrder) : Types.DeploymentOrder {
    {
      id = old.id;
      owner = old.owner;
      templateId = old.templateId;
      config = migrateConfig(old.config);
      fundingMonths = old.fundingMonths;
      status = old.status;
      requestedAt = old.requestedAt;
      expectedAmountUsdCents = old.expectedAmountUsdCents;
      expectedSettlementAmount = old.expectedSettlementAmount;
      expectedCycles = old.expectedCycles;
      settlementAsset = old.settlementAsset;
      paymentQuoteId = old.paymentQuoteId;
      depositAddress = old.depositAddress;
      paymentTxHash = old.paymentTxHash;
      settlementProof = old.settlementProof;
      createdCanisterId = old.createdCanisterId;
      appUrl = old.appUrl;
      error = old.error;
    };
  };

  public func run(old : OldActor) : NewActor {
    {
      orders = old.orders.map<Nat, OldDeploymentOrder, Types.DeploymentOrder>(
        func(_, order) = migrateOrder(order),
      );
    };
  };
};
