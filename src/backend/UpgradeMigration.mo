import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Pricing "lib/Pricing";
import Types "../shared/Types";

module {
  // One-shot bridge for upgrading the subscription backend to pay-as-you-go.
  // Remove this module and the actor migration hook after mainnet upgrade succeeds.
  type OldPricingConfig = {
    serviceFeeUsdCents : Nat;
    monthlyFundingUsdCents : Nat;
    creationCycles : Nat;
    monthlyCycles : Nat;
    cycleBuffer : Nat;
  };

  type OldDeploymentOrder = {
    id : Nat;
    owner : Principal;
    templateId : Text;
    config : Types.AppConfig;
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
    pricingConfig : OldPricingConfig;
    orders : Map.Map<Nat, OldDeploymentOrder>;
  };

  type NewActor = {
    pricingConfig : Types.PricingConfig;
    orders : Map.Map<Nat, Types.DeploymentOrder>;
  };

  func migratePricingConfig(old : OldPricingConfig) : Types.PricingConfig {
    let defaults = Pricing.defaultConfig();
    {
      serviceFeeUsdCents = old.serviceFeeUsdCents;
      monthlyFundingUsdCents = 0;
      creationCycles = 0;
      monthlyCycles = 0;
      cycleBuffer = 0;
      initialDeployCycles = defaults.initialDeployCycles;
      cyclesMarkupBps = defaults.cyclesMarkupBps;
      usdPerTrillionCents = defaults.usdPerTrillionCents;
    };
  };

  func migrateOrder(old : OldDeploymentOrder) : Types.DeploymentOrder {
    {
      id = old.id;
      owner = old.owner;
      templateId = old.templateId;
      config = old.config;
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
      orderKind = null;
      topUpTargetOrderId = null;
    };
  };

  public func run(old : OldActor) : NewActor {
    {
      pricingConfig = migratePricingConfig(old.pricingConfig);
      orders = old.orders.map<Nat, OldDeploymentOrder, Types.DeploymentOrder>(
        func(_, order) = migrateOrder(order),
      );
    };
  };
};