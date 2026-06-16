module {
  public type Link = {
    labelText : Text;
    url : Text;
  };

  public type PortfolioProject = {
    title : Text;
    description : Text;
    url : Text;
    imageUrl : Text;
    tags : [Text];
  };

  public type AppConfig = {
    name : Text;
    headline : Text;
    description : Text;
    accentColor : Text;
    primaryLink : Text;
    contact : Text;
    about : ?Text;
    heroImageUrl : ?Text;
    resumeUrl : ?Text;
    skills : ?[Text];
    socialLinks : ?[Link];
    projects : ?[PortfolioProject];
  };

  public type Template = {
    id : Text;
    name : Text;
    description : Text;
    category : Text;
    basePriceUsdCents : Nat;
    active : Bool;
  };

  public type SettlementConfig = {
    assetId : Text;
    decimals : Nat;
  };

  public type PaymentDisplayConfig = {
    priceCurrency : Text;
    settlementSymbol : Text;
    settlementNetwork : Text;
  };

  public type PricingConfig = {
    serviceFeeUsdCents : Nat;
    monthlyFundingUsdCents : Nat;
    creationCycles : Nat;
    monthlyCycles : Nat;
    cycleBuffer : Nat;
  };

  public type PricingBreakdown = {
    templateUsdCents : Nat;
    serviceFeeUsdCents : Nat;
    fundingUsdCents : Nat;
    totalUsdCents : Nat;
    initialCycles : Nat;
  };

  public type PublicConfig = {
    pricing : PricingConfig;
    paymentDisplay : PaymentDisplayConfig;
    settlement : SettlementConfig;
    ordersEnabled : Bool;
  };

  public type AdminAccess = {
    caller : Principal;
    owner : Principal;
    settlementRelayer : Principal;
    isOwner : Bool;
    isAdmin : Bool;
  };

  public type DeploymentStatus = {
    #AwaitingPayment;
    #PaymentDetected;
    #CreatingCanister;
    #Live;
    #Failed;
    #RefundRequired;
  };

  public type DeploymentOrder = {
    id : Nat;
    owner : Principal;
    templateId : Text;
    config : AppConfig;
    fundingMonths : Nat;
    status : DeploymentStatus;
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

  public type CreateOrderRequest = {
    templateId : Text;
    config : AppConfig;
    fundingMonths : Nat;
  };

  public type SettlementProof = {
    quoteId : Text;
    depositAddress : Text;
    txHash : Text;
    proofId : Text;
    assetId : Text;
    amountOut : Nat;
  };

  public type FactoryDeployRequest = {
    orderId : Nat;
    owner : Principal;
    templateId : Text;
    config : AppConfig;
    initialCycles : Nat;
  };

  public type FactoryDeployError = {
    message : Text;
    canisterId : ?Principal;
  };

  public type FactoryDeployResult = {
    #ok : Principal;
    #err : FactoryDeployError;
  };

  public type FactoryDeploymentStatus = {
    #Creating;
    #Created;
    #Installing;
    #Live;
    #Failed;
  };

  public type FactoryDeployment = {
    orderId : Nat;
    owner : Principal;
    templateId : Text;
    status : FactoryDeploymentStatus;
    canisterId : ?Principal;
    error : ?Text;
  };

  public type FactoryReadiness = {
    cycleBalance : Nat;
    reserveCycles : Nat;
    maxChildCycles : Nat;
    requiredCycles : Nat;
    templateWasmConfigured : Bool;
    templateWasmSize : Nat;
    canDeploy : Bool;
  };

  public type ChildInit = {
    owner : Principal;
    templateId : Text;
    config : AppConfig;
  };

  public type ChildTemplateInfo = {
    templateId : Text;
  };

  public type PlatformStats = {
    totalOrders : Nat;
    liveApps : Nat;
    templates : Nat;
  };
};
