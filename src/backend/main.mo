import Blob "mo:core/Blob";
import Error "mo:core/Error";
import Iter "mo:core/Iter";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Result "mo:core/Result";
import Runtime "mo:core/Runtime";
import Set "mo:core/Set";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Pricing "lib/Pricing";
import Validation "lib/Validation";
import Types "../shared/Types";

shared (install) actor class LauncherBackend() {
  let owner = do {
    if (install.caller.isAnonymous()) {
      Runtime.trap("Install launcher_backend with a named identity.");
    };
    install.caller;
  };
  var settlementRelayer = install.caller;
  var settlementConfig : Types.SettlementConfig = {
    assetId = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
    decimals = 6;
  };
  var paymentDisplayConfig : Types.PaymentDisplayConfig = {
    priceCurrency = "USD";
    settlementSymbol = "USDC";
    settlementNetwork = "NEAR";
  };
  var pricingConfig = Pricing.defaultConfig();
  var ordersEnabled = true;
  let admins = Set.empty<Principal>();

  let templates = do {
    let registry = Map.empty<Text, Types.Template>();
    registry.add(
      "portfolio",
      {
        id = "portfolio";
        name = "Portfolio Plus";
        description = "A multi-section portfolio with skills, socials, project cards, resume, and owner-managed content.";
        category = "Personal";
        basePriceUsdCents = 700;
        active = true;
      },
    );
    registry.add(
      "startup",
      {
        id = "startup";
        name = "Startup landing page";
        description = "A conversion-oriented product page with a clear call to action.";
        category = "Business";
        basePriceUsdCents = 500;
        active = true;
      },
    );
    registry.add(
      "static-site",
      {
        id = "static-site";
        name = "Static site";
        description = "Upload your own HTML, CSS, JavaScript, and assets to host a certified static website on ICP.";
        category = "Custom";
        basePriceUsdCents = 500;
        active = true;
      },
    );
    registry;
  };

  let orders = Map.empty<Nat, Types.DeploymentOrder>();
  let canceledOrders = Set.empty<Nat>();
  var nextOrderId : Nat = 1;
  var liveAppCount : Nat = 0;
  let usedSettlementProofs = Set.empty<Text>();
  type OrderAuthorization = {
    orderId : Nat;
    owner : Principal;
    expiresAt : Int;
  };
  let quoteAuthorizations = Map.empty<Text, OrderAuthorization>();
  let activeQuoteAuthorizationByOrder = Map.empty<Nat, Text>();
  let cancellationAuthorizations = Map.empty<Text, OrderAuthorization>();
  let activeCancellationAuthorizationByOrder = Map.empty<Nat, Text>();

  transient let factoryCanisterId = switch (
    Runtime.envVar<system>("PUBLIC_CANISTER_ID:launcher_factory")
  ) {
    case (?value) value;
    case (null) Runtime.trap("launcher_factory canister ID is not configured.");
  };

  transient let factory : actor {
    deployOrder : shared Types.FactoryDeployRequest -> async Types.FactoryDeployResult;
    topUpChild : shared Types.FactoryTopUpRequest -> async Result.Result<(), Text>;
    updateDeployment : shared Types.FactoryUpdateRequest -> async Types.FactoryUpdateResult;
    getReadiness : shared query Nat -> async Types.FactoryReadiness;
    getChildCycleStatus : shared Principal -> async Types.ChildCycleStatus;
  } = actor (factoryCanisterId);

  transient let ic : actor {
    raw_rand : shared () -> async Blob;
  } = actor "aaaaa-aa";

  func requireOwner(caller : Principal) {
    if (caller.isAnonymous()) Runtime.trap("Anonymous caller is not allowed.");
    if (caller != owner) Runtime.trap("Caller is not the platform owner.");
  };

  func requireRelayer(caller : Principal) {
    if (caller.isAnonymous()) Runtime.trap("Anonymous caller is not allowed.");
    if (caller != settlementRelayer) Runtime.trap("Caller is not the settlement relayer.");
  };

  func isAdmin(caller : Principal) : Bool {
    caller == owner or admins.contains(caller);
  };

  func requireAdmin(caller : Principal) {
    if (caller.isAnonymous()) Runtime.trap("Anonymous caller is not allowed.");
    if (not isAdmin(caller)) Runtime.trap("Caller is not a platform admin.");
  };

  func getOrderOrTrap(orderId : Nat) : Types.DeploymentOrder {
    switch (orders.get(orderId)) {
      case (?order) order;
      case (null) Runtime.trap("Deployment order not found.");
    };
  };

  func clearQuoteAuthorization(orderId : Nat) {
    switch (activeQuoteAuthorizationByOrder.get(orderId)) {
      case (?token) {
        activeQuoteAuthorizationByOrder.remove(orderId);
        quoteAuthorizations.remove(token);
      };
      case (null) {};
    };
  };

  func clearCancellationAuthorization(orderId : Nat) {
    switch (activeCancellationAuthorizationByOrder.get(orderId)) {
      case (?token) {
        activeCancellationAuthorizationByOrder.remove(orderId);
        cancellationAuthorizations.remove(token);
      };
      case (null) {};
    };
  };

  func hasPaymentActivity(order : Types.DeploymentOrder) : Bool {
    order.paymentQuoteId != null or
    order.depositAddress != null or
    order.paymentTxHash != null or
    order.settlementProof != null;
  };

  func pageLimit(limit : Nat) : Nat {
    Nat.min(limit, 50);
  };

  func isTopUpOrder(order : Types.DeploymentOrder) : Bool {
    switch (order.orderKind) {
      case (?#TopUp) true;
      case (?#Deploy) false;
      case (null) {
        switch (order.topUpTargetOrderId) {
          case (?_) true;
          case (null) false;
        };
      };
    };
  };

  func isDeployOrder(order : Types.DeploymentOrder) : Bool {
    not isTopUpOrder(order);
  };

  func randomToken(random : Blob) : Text {
    var token = "";
    for (byte in random.vals()) {
      if (token.size() > 0) token #= "-";
      token #= byte.toText();
    };
    token;
  };

  public query func getOwner() : async Principal {
    owner;
  };

  public query func getSettlementConfig() : async Types.SettlementConfig {
    settlementConfig;
  };

  public query func getPublicConfig() : async Types.PublicConfig {
    {
      pricing = pricingConfig;
      paymentDisplay = paymentDisplayConfig;
      settlement = settlementConfig;
      ordersEnabled;
    };
  };

  public shared query ({ caller }) func getAdminAccess() : async Types.AdminAccess {
    {
      caller;
      owner;
      settlementRelayer;
      isOwner = caller == owner;
      isAdmin = not caller.isAnonymous() and isAdmin(caller);
    };
  };

  public shared query ({ caller }) func listAdmins() : async [Principal] {
    requireOwner(caller);
    admins.values().toArray();
  };

  public query func listTemplates() : async [Types.Template] {
    templates.values().toArray();
  };

  public query func getTemplate(templateId : Text) : async ?Types.Template {
    templates.get(templateId);
  };

  public query func quoteDeployment(
    templateId : Text,
  ) : async Result.Result<Types.PricingBreakdown, Text> {
    switch (Pricing.validate(pricingConfig)) {
      case (?message) return #err("Pricing configuration requires admin attention: " # message);
      case (null) {};
    };
    let template = switch (templates.get(templateId)) {
      case (null) return #err("Template not found.");
      case (?value) value;
    };
    #ok(Pricing.quoteDeploy(pricingConfig, template));
  };

  public query func quoteTopUp(
    topUpCycles : Nat,
  ) : async Result.Result<Types.PricingBreakdown, Text> {
    switch (Pricing.validate(pricingConfig)) {
      case (?message) return #err("Pricing configuration requires admin attention: " # message);
      case (null) {};
    };
    switch (Validation.topUpCycles(topUpCycles)) {
      case (#err(message)) return #err(message);
      case (#ok(())) {};
    };
    #ok(Pricing.quoteTopUp(pricingConfig, topUpCycles));
  };

  public shared ({ caller }) func createDeploymentOrder(
    request : Types.CreateOrderRequest
  ) : async Result.Result<Types.DeploymentOrder, Text> {
    switch (Validation.requireAuthenticated(caller)) {
      case (#err(message)) return #err(message);
      case (#ok(())) {};
    };
    switch (
      if (request.templateId == "static-site") {
        Validation.staticSiteConfig(request.config);
      } else {
        Validation.appConfig(request.config);
      }
    ) {
      case (#err(message)) return #err(message);
      case (#ok(())) {};
    };
    if (not ordersEnabled) return #err("New deployment orders are temporarily paused.");
    switch (Pricing.validate(pricingConfig)) {
      case (?message) return #err("Pricing configuration requires admin attention: " # message);
      case (null) {};
    };

    let template = switch (templates.get(request.templateId)) {
      case (null) return #err("Template not found.");
      case (?value) value;
    };
    if (not template.active) return #err("Template is currently unavailable.");

    let price = Pricing.quoteDeploy(pricingConfig, template);
    let readiness = try {
      await factory.getReadiness(price.initialCycles);
    } catch (error) {
      return #err("Deployment factory is unavailable: " # error.message());
    };
    if (request.templateId == "static-site") {
      if (not readiness.assetWasmConfigured) {
        return #err("Deployment is temporarily unavailable while the asset canister Wasm is configured.");
      };
    } else if (not readiness.templateWasmConfigured) {
      return #err("Deployment is temporarily unavailable while the app template is configured.");
    };
    if (not readiness.canDeploy) {
      return #err("Deployment is temporarily unavailable because the factory needs more cycles.");
    };

    let order : Types.DeploymentOrder = {
      id = nextOrderId;
      owner = caller;
      templateId = request.templateId;
      config = request.config;
      fundingMonths = 0;
      status = #AwaitingPayment;
      requestedAt = Time.now();
      expectedAmountUsdCents = price.totalUsdCents;
      expectedSettlementAmount = Pricing.toSmallestUnits(price.totalUsdCents, settlementConfig.decimals);
      expectedCycles = price.initialCycles;
      settlementAsset = settlementConfig.assetId;
      paymentQuoteId = null;
      depositAddress = null;
      paymentTxHash = null;
      settlementProof = null;
      createdCanisterId = null;
      appUrl = null;
      error = null;
      orderKind = ?#Deploy;
      topUpTargetOrderId = null;
    };

    orders.add(nextOrderId, order);
    nextOrderId += 1;
    #ok(order);
  };

  public shared ({ caller }) func createTopUpOrder(
    request : Types.CreateTopUpOrderRequest,
  ) : async Result.Result<Types.DeploymentOrder, Text> {
    switch (Validation.requireAuthenticated(caller)) {
      case (#err(message)) return #err(message);
      case (#ok(())) {};
    };
    switch (Validation.topUpCycles(request.topUpCycles)) {
      case (#err(message)) return #err(message);
      case (#ok(())) {};
    };
    if (not ordersEnabled) return #err("New top-up orders are temporarily paused.");
    switch (Pricing.validate(pricingConfig)) {
      case (?message) return #err("Pricing configuration requires admin attention: " # message);
      case (null) {};
    };

    let target = getOrderOrTrap(request.targetOrderId);
    if (caller != target.owner) return #err("Caller does not own the target deployment.");
    if (target.status != #Live) return #err("Only live apps can receive cycle top-ups.");
    if (isTopUpOrder(target)) return #err("Top-up orders cannot be topped up.");
    let canisterId = switch (target.createdCanisterId) {
      case (?value) value;
      case (null) return #err("Target deployment is missing its app canister ID.");
    };

    let price = Pricing.quoteTopUp(pricingConfig, request.topUpCycles);
    let readiness = try {
      await factory.getReadiness(request.topUpCycles);
    } catch (error) {
      return #err("Deployment factory is unavailable: " # error.message());
    };
    if (not readiness.canDeploy) {
      return #err("Top-up is temporarily unavailable because the factory needs more cycles.");
    };

    let topUpConfig : Types.AppConfig = {
      name = "Cycle top-up for " # target.config.name;
      headline = "Cycle top-up";
      description = "Adds cycles to a live NearLaunch deployment.";
      accentColor = target.config.accentColor;
      primaryLink = "";
      contact = "";
      about = null;
      heroImageUrl = null;
      resumeUrl = null;
      skills = null;
      socialLinks = null;
      projects = null;
    };

    let order : Types.DeploymentOrder = {
      id = nextOrderId;
      owner = caller;
      templateId = target.templateId;
      config = topUpConfig;
      fundingMonths = 0;
      status = #AwaitingPayment;
      requestedAt = Time.now();
      expectedAmountUsdCents = price.totalUsdCents;
      expectedSettlementAmount = Pricing.toSmallestUnits(price.totalUsdCents, settlementConfig.decimals);
      expectedCycles = request.topUpCycles;
      settlementAsset = settlementConfig.assetId;
      paymentQuoteId = null;
      depositAddress = null;
      paymentTxHash = null;
      settlementProof = null;
      createdCanisterId = ?canisterId;
      appUrl = target.appUrl;
      error = null;
      orderKind = ?#TopUp;
      topUpTargetOrderId = ?request.targetOrderId;
    };

    orders.add(nextOrderId, order);
    nextOrderId += 1;
    #ok(order);
  };

  public shared ({ caller }) func getCanisterCycleBalance(
    orderId : Nat,
  ) : async Result.Result<Types.ChildCycleStatus, Text> {
    switch (Validation.requireAuthenticated(caller)) {
      case (#err(message)) return #err(message);
      case (#ok(())) {};
    };

    let order = switch (orders.get(orderId)) {
      case (?value) value;
      case (null) return #err("Deployment order not found.");
    };
    if (caller != order.owner) return #err("Caller does not own this deployment.");
    if (order.status != #Live) return #err("Cycle balance is only available for live apps.");
    if (isTopUpOrder(order)) return #err("Top-up orders do not have their own canister balance.");
    let canisterId = switch (order.createdCanisterId) {
      case (?value) value;
      case (null) return #err("This deployment is missing its app canister ID.");
    };

    try {
      #ok(await factory.getChildCycleStatus(canisterId));
    } catch (error) {
      #err("Could not read canister cycle balance: " # error.message());
    };
  };

  public shared ({ caller }) func cancelDeploymentOrder(
    orderId : Nat
  ) : async Result.Result<Types.DeploymentOrder, Text> {
    switch (Validation.requireAuthenticated(caller)) {
      case (#err(message)) return #err(message);
      case (#ok(())) {};
    };

    let order = getOrderOrTrap(orderId);
    if (caller != order.owner and caller != owner) {
      return #err("Caller does not own this order.");
    };
    if (canceledOrders.contains(orderId)) return #ok(order);
    if (order.status != #AwaitingPayment) {
      return #err("Only orders awaiting payment can be canceled.");
    };
    if (hasPaymentActivity(order)) {
      return #err(
        "This order already has a payment quote. Its quote status must be checked before cancellation."
      );
    };

    clearQuoteAuthorization(orderId);
    clearCancellationAuthorization(orderId);
    canceledOrders.add(orderId);
    #ok(order);
  };

  public shared ({ caller }) func registerAuthorizedPaymentQuote(
    orderId : Nat,
    authorization : Text,
    quoteId : Text,
    depositAddress : Text,
  ) : async Result.Result<Types.DeploymentOrder, Text> {
    requireRelayer(caller);
    if (quoteId.size() == 0 or quoteId.size() > 200) return #err("Invalid quote ID.");
    if (depositAddress.size() == 0 or depositAddress.size() > 240) {
      return #err("Invalid deposit address.");
    };

    let order = getOrderOrTrap(orderId);
    if (canceledOrders.contains(orderId)) {
      return #err("Order was canceled before payment.");
    };
    if (order.paymentQuoteId == ?quoteId and order.depositAddress == ?depositAddress) {
      return #ok(order);
    };
    if (order.status != #AwaitingPayment) {
      return #err("Order is no longer awaiting payment.");
    };

    let authorizationRecord = switch (quoteAuthorizations.get(authorization)) {
      case (null) return #err("Payment quote authorization is invalid or already used.");
      case (?value) value;
    };
    if (authorizationRecord.expiresAt < Time.now()) {
      quoteAuthorizations.remove(authorization);
      activeQuoteAuthorizationByOrder.remove(orderId);
      return #err("Payment quote authorization has expired.");
    };
    if (
      authorizationRecord.orderId != orderId or
      authorizationRecord.owner != order.owner
    ) {
      return #err("Payment quote authorization does not match this order.");
    };

    let updated = {
      order with
      paymentQuoteId = ?quoteId;
      depositAddress = ?depositAddress;
    };
    orders.add(orderId, updated);
    quoteAuthorizations.remove(authorization);
    activeQuoteAuthorizationByOrder.remove(orderId);
    #ok(updated);
  };

  public shared ({ caller }) func registerPaymentQuote(
    orderId : Nat,
    quoteId : Text,
    depositAddress : Text,
  ) : async Result.Result<Types.DeploymentOrder, Text> {
    requireRelayer(caller);
    if (quoteId.size() == 0 or quoteId.size() > 200) return #err("Invalid quote ID.");
    if (depositAddress.size() == 0 or depositAddress.size() > 240) {
      return #err("Invalid deposit address.");
    };

    let order = getOrderOrTrap(orderId);
    if (canceledOrders.contains(orderId)) {
      return #err("Order was canceled before payment.");
    };
    if (order.paymentQuoteId == ?quoteId and order.depositAddress == ?depositAddress) {
      return #ok(order);
    };
    if (order.status != #AwaitingPayment) {
      return #err("Order is no longer awaiting payment.");
    };

    let updated = {
      order with
      paymentQuoteId = ?quoteId;
      depositAddress = ?depositAddress;
    };
    orders.add(orderId, updated);
    clearQuoteAuthorization(orderId);
    #ok(updated);
  };

  public shared ({ caller }) func authorizePaymentQuote(
    orderId : Nat
  ) : async Result.Result<Text, Text> {
    switch (Validation.requireAuthenticated(caller)) {
      case (#err(message)) return #err(message);
      case (#ok(())) {};
    };
    let order = getOrderOrTrap(orderId);
    if (caller != order.owner) return #err("Caller does not own this order.");
    if (canceledOrders.contains(orderId)) {
      return #err("Order was canceled before payment.");
    };
    if (order.status != #AwaitingPayment) {
      return #err("Order is no longer awaiting payment.");
    };

    let random = try {
      await ic.raw_rand();
    } catch (error) {
      return #err("Could not authorize a payment quote: " # error.message());
    };

    let currentOrder = getOrderOrTrap(orderId);
    if (
      caller != currentOrder.owner or
      currentOrder.status != #AwaitingPayment or
      canceledOrders.contains(orderId)
    ) {
      return #err("Order changed while authorizing the payment quote.");
    };

    let token = randomToken(random);
    switch (activeQuoteAuthorizationByOrder.get(orderId)) {
      case (?previousToken) quoteAuthorizations.remove(previousToken);
      case (null) {};
    };
    quoteAuthorizations.add(
      token,
      {
        orderId;
        owner = caller;
        expiresAt = Time.now() + 600_000_000_000;
      },
    );
    activeQuoteAuthorizationByOrder.add(orderId, token);
    #ok(token);
  };

  public shared ({ caller }) func authorizeDeploymentCancellation(
    orderId : Nat
  ) : async Result.Result<Text, Text> {
    switch (Validation.requireAuthenticated(caller)) {
      case (#err(message)) return #err(message);
      case (#ok(())) {};
    };

    let order = getOrderOrTrap(orderId);
    if (caller != order.owner) return #err("Caller does not own this order.");
    if (canceledOrders.contains(orderId)) {
      return #err("Order is already canceled.");
    };
    if (order.status != #AwaitingPayment) {
      return #err("Only orders awaiting payment can be canceled.");
    };
    if (order.paymentQuoteId == null or order.depositAddress == null) {
      return #err("This order does not require a relayer cancellation check.");
    };
    if (order.paymentTxHash != null or order.settlementProof != null) {
      return #err("This order already has payment activity.");
    };

    let random = try {
      await ic.raw_rand();
    } catch (error) {
      return #err("Could not authorize order cancellation: " # error.message());
    };

    let currentOrder = getOrderOrTrap(orderId);
    if (
      caller != currentOrder.owner or
      currentOrder.status != #AwaitingPayment or
      canceledOrders.contains(orderId) or
      currentOrder.paymentQuoteId != order.paymentQuoteId or
      currentOrder.depositAddress != order.depositAddress or
      currentOrder.paymentTxHash != null or
      currentOrder.settlementProof != null
    ) {
      return #err("Order changed while authorizing cancellation.");
    };

    let token = randomToken(random);
    clearCancellationAuthorization(orderId);
    cancellationAuthorizations.add(
      token,
      {
        orderId;
        owner = caller;
        expiresAt = Time.now() + 600_000_000_000;
      },
    );
    activeCancellationAuthorizationByOrder.add(orderId, token);
    #ok(token);
  };

  public shared ({ caller }) func cancelAuthorizedDeploymentOrder(
    orderId : Nat,
    authorization : Text,
    depositAddress : Text,
  ) : async Result.Result<Types.DeploymentOrder, Text> {
    requireRelayer(caller);
    let order = getOrderOrTrap(orderId);

    if (canceledOrders.contains(orderId)) return #ok(order);
    if (order.status != #AwaitingPayment) {
      return #err("Only orders awaiting payment can be canceled.");
    };
    if (order.paymentQuoteId == null or order.depositAddress != ?depositAddress) {
      return #err("Payment quote details do not match this order.");
    };
    if (order.paymentTxHash != null or order.settlementProof != null) {
      return #err("This order already has payment activity.");
    };

    let authorizationRecord = switch (
      cancellationAuthorizations.get(authorization)
    ) {
      case (null) return #err("Cancellation authorization is invalid or already used.");
      case (?value) value;
    };
    if (authorizationRecord.expiresAt < Time.now()) {
      cancellationAuthorizations.remove(authorization);
      activeCancellationAuthorizationByOrder.remove(orderId);
      return #err("Cancellation authorization has expired.");
    };
    if (
      authorizationRecord.orderId != orderId or
      authorizationRecord.owner != order.owner
    ) {
      return #err("Cancellation authorization does not match this order.");
    };

    clearQuoteAuthorization(orderId);
    clearCancellationAuthorization(orderId);
    canceledOrders.add(orderId);
    #ok(order);
  };

  public shared ({ caller }) func markPaymentSettled(
    orderId : Nat,
    proof : Types.SettlementProof,
  ) : async Result.Result<Types.DeploymentOrder, Text> {
    requireRelayer(caller);
    let order = getOrderOrTrap(orderId);

    if (canceledOrders.contains(orderId)) {
      return #err("Order was canceled before payment.");
    };
    if (order.settlementProof == ?proof.proofId) return #ok(order);
    if (usedSettlementProofs.contains(proof.proofId)) {
      return #err("Settlement proof has already been used.");
    };
    if (order.status != #AwaitingPayment) {
      return #err("Order is not awaiting payment.");
    };
    if (order.paymentQuoteId != ?proof.quoteId) return #err("Quote ID does not match.");
    if (order.depositAddress != ?proof.depositAddress) {
      return #err("Deposit address does not match.");
    };
    if (order.settlementAsset != proof.assetId) return #err("Settlement asset does not match.");
    if (proof.amountOut < order.expectedSettlementAmount) {
      return #err("Settled amount is below the deployment quote.");
    };
    if (
      proof.proofId.size() == 0 or proof.proofId.size() > 240 or
      proof.txHash.size() == 0 or proof.txHash.size() > 240
    ) {
      return #err("Settlement proof is malformed.");
    };

    usedSettlementProofs.add(proof.proofId);
    let updated = {
      order with
      status = #PaymentDetected;
      paymentTxHash = ?proof.txHash;
      settlementProof = ?proof.proofId;
      error = null;
    };
    orders.add(orderId, updated);
    #ok(updated);
  };

  public shared ({ caller }) func markRefundRequired(
    orderId : Nat,
    reason : Text,
  ) : async Result.Result<Types.DeploymentOrder, Text> {
    requireRelayer(caller);
    let order = getOrderOrTrap(orderId);
    if (canceledOrders.contains(orderId)) {
      return #err("Order was canceled before payment.");
    };
    if (order.status != #AwaitingPayment) return #err("Order cannot be marked for refund.");

    let updated = {
      order with
      status = #RefundRequired;
      error = ?reason;
    };
    orders.add(orderId, updated);
    #ok(updated);
  };

  public shared ({ caller }) func deployPaidOrder(
    orderId : Nat
  ) : async Result.Result<Types.DeploymentOrder, Text> {
    switch (Validation.requireAuthenticated(caller)) {
      case (#err(message)) return #err(message);
      case (#ok(())) {};
    };

    let order = getOrderOrTrap(orderId);
    if (caller != order.owner and caller != owner) return #err("Caller does not own this order.");
    if (canceledOrders.contains(orderId)) {
      return #err("Order was canceled before payment.");
    };
    if (order.status == #Live) return #ok(order);
    if (order.status != #PaymentDetected and order.status != #Failed) {
      return #err("Order is not ready for fulfillment.");
    };

    if (isTopUpOrder(order)) {
      let targetCanisterId = switch (order.createdCanisterId) {
        case (?value) value;
        case (null) return #err("Top-up order is missing its target canister ID.");
      };
      let fulfilling = {
        order with
        status = #CreatingCanister;
        error = null;
      };
      orders.add(orderId, fulfilling);

      let topUpResult = try {
        await factory.topUpChild({
          orderId;
          owner = order.owner;
          canisterId = targetCanisterId;
          cycles = order.expectedCycles;
        });
      } catch (error) {
        #err("Factory top-up call failed: " # error.message());
      };

      switch (topUpResult) {
        case (#err(message)) {
          let failed = {
            fulfilling with
            status = #Failed;
            error = ?message;
          };
          orders.add(orderId, failed);
          #err(message);
        };
        case (#ok(())) {
          let live = {
            fulfilling with
            status = #Live;
            error = null;
          };
          orders.add(orderId, live);
          #ok(live);
        };
      };
    } else {
      let deploying = {
        order with
        status = #CreatingCanister;
        error = null;
      };
      orders.add(orderId, deploying);

      let deploymentCycles = Pricing.resolveInitialDeployCycles(pricingConfig);
      let factoryResult = try {
        await factory.deployOrder({
          orderId;
          owner = order.owner;
          templateId = order.templateId;
          config = order.config;
          initialCycles = deploymentCycles;
        });
      } catch (error) {
        #err({
          message = "Factory call failed: " # error.message();
          canisterId = order.createdCanisterId;
        });
      };

      switch (factoryResult) {
        case (#ok(canisterId)) {
          let live = {
            deploying with
            status = #Live;
            expectedCycles = deploymentCycles;
            createdCanisterId = ?canisterId;
            appUrl = if (order.templateId == "static-site") {
              ?("https://" # canisterId.toText() # ".icp0.io");
            } else {
              ?("https://" # canisterId.toText() # ".raw.icp0.io");
            };
            error = null;
          };
          orders.add(orderId, live);
          liveAppCount += 1;
          #ok(live);
        };
        case (#err(failure)) {
          let failed = {
            deploying with
            status = #Failed;
            expectedCycles = deploymentCycles;
            createdCanisterId = failure.canisterId;
            error = ?failure.message;
          };
          orders.add(orderId, failed);
          #err(failure.message);
        };
      };
    };
  };

  public shared ({ caller }) func updateDeploymentOrderConfig(
    orderId : Nat,
    config : Types.AppConfig,
  ) : async Result.Result<Types.DeploymentOrder, Text> {
    switch (Validation.requireAuthenticated(caller)) {
      case (#err(message)) return #err(message);
      case (#ok(())) {};
    };

    let order = getOrderOrTrap(orderId);
    if (caller != order.owner) return #err("Caller does not own this order.");
    if (canceledOrders.contains(orderId)) return #err("Order was canceled.");
    if (order.status != #Live) {
      return #err("Only live apps can be edited after deployment.");
    };
    let canisterId = switch (order.createdCanisterId) {
      case (?value) value;
      case (null) return #err("This live deployment is missing its app canister ID.");
    };

    if (order.templateId == "static-site") {
      return #err("Static sites are updated by uploading files directly to the asset canister.");
    };

    let resolvedConfig = Validation.resolveAppConfigForUpdate(order.config, config);
    switch (Validation.appConfig(resolvedConfig)) {
      case (#err(message)) return #err(message);
      case (#ok(())) {};
    };

    let factoryResult = try {
      await factory.updateDeployment({
        orderId;
        owner = order.owner;
        templateId = order.templateId;
        canisterId;
        config = resolvedConfig;
        allowReinstall = false;
      });
    } catch (error) {
      #err({
        message = "Factory update failed: " # error.message();
        canisterId = ?canisterId;
      });
    };

    switch (factoryResult) {
      case (#err(failure)) {
        let failed = {
          order with
          error = ?failure.message;
        };
        orders.add(orderId, failed);
        return #err(failure.message);
      };
      case (#ok(_mode)) {};
    };

    let updated = {
      order with
      config = resolvedConfig;
      error = null;
    };
    orders.add(orderId, updated);
    #ok(updated);
  };

  public query func getDeploymentOrder(orderId : Nat) : async ?Types.DeploymentOrder {
    orders.get(orderId);
  };

  public shared query ({ caller }) func getMyDeployments(
    offset : Nat,
    limit : Nat,
  ) : async [Types.DeploymentOrder] {
    if (caller.isAnonymous()) return [];

    let results = List.empty<Types.DeploymentOrder>();
    let cappedLimit = pageLimit(limit);
    var matched : Nat = 0;
    label scan for (order in orders.values()) {
      if (
        order.owner == caller and
        not canceledOrders.contains(order.id) and
        isDeployOrder(order)
      ) {
        if (matched >= offset and results.size() < cappedLimit) results.add(order);
        matched += 1;
        if (results.size() >= cappedLimit) break scan;
      };
    };
    results.toArray();
  };

  public query func listPublicDeployments(
    offset : Nat,
    limit : Nat,
  ) : async [Types.DeploymentOrder] {
    let results = List.empty<Types.DeploymentOrder>();
    let cappedLimit = pageLimit(limit);
    var matched : Nat = 0;
    label scan for (order in orders.values()) {
      if (order.status == #Live) {
        if (matched >= offset and results.size() < cappedLimit) results.add(order);
        matched += 1;
        if (results.size() >= cappedLimit) break scan;
      };
    };
    results.toArray();
  };

  public query func getStats() : async Types.PlatformStats {
    {
      totalOrders = orders.size();
      liveApps = liveAppCount;
      templates = templates.size();
    };
  };

  public shared ({ caller }) func setSettlementRelayer(
    principal : Principal
  ) : async Result.Result<(), Text> {
    requireOwner(caller);
    if (principal.isAnonymous()) return #err("Relayer cannot be anonymous.");
    settlementRelayer := principal;
    #ok(());
  };

  public shared ({ caller }) func setSettlementConfig(
    config : Types.SettlementConfig
  ) : async Result.Result<(), Text> {
    requireAdmin(caller);
    if (config.assetId.size() == 0 or config.assetId.size() > 240) {
      return #err("Settlement asset ID is invalid.");
    };
    if (config.decimals < 2 or config.decimals > 18) {
      return #err("Settlement asset decimals must be between 2 and 18.");
    };
    settlementConfig := config;
    #ok(());
  };

  public shared ({ caller }) func setPaymentDisplayConfig(
    config : Types.PaymentDisplayConfig
  ) : async Result.Result<(), Text> {
    requireAdmin(caller);
    if (
      config.priceCurrency.size() == 0 or config.priceCurrency.size() > 12 or
      config.settlementSymbol.size() == 0 or config.settlementSymbol.size() > 20 or
      config.settlementNetwork.size() == 0 or config.settlementNetwork.size() > 40
    ) {
      return #err("Payment labels are invalid.");
    };
    paymentDisplayConfig := config;
    #ok(());
  };

  public shared ({ caller }) func setPricingConfig(
    config : Types.PricingConfig
  ) : async Result.Result<(), Text> {
    requireAdmin(caller);
    switch (Pricing.validate(config)) {
      case (?message) return #err(message);
      case (null) {};
    };
    pricingConfig := config;
    #ok(());
  };

  public shared ({ caller }) func applyConservativeCyclePreset() : async Result.Result<(), Text> {
    requireAdmin(caller);
    let config = Pricing.conservativeCycleConfig(pricingConfig);
    switch (Pricing.validate(config)) {
      case (?message) return #err(message);
      case (null) {};
    };
    pricingConfig := config;
    #ok(());
  };

  public shared ({ caller }) func setUsdPerTrillionCents(
    usdPerTrillionCents : Nat,
  ) : async Result.Result<(), Text> {
    if (caller != settlementRelayer) {
      requireAdmin(caller);
    };
    if (usdPerTrillionCents == 0 or usdPerTrillionCents > 1_000_000) {
      return #err("USD per trillion cycles rate is invalid.");
    };
    pricingConfig := {
      pricingConfig with
      usdPerTrillionCents = ?usdPerTrillionCents;
    };
    switch (Pricing.validate(pricingConfig)) {
      case (?message) return #err(message);
      case (null) {};
    };
    #ok(());
  };

  public shared ({ caller }) func setOrdersEnabled(
    enabled : Bool
  ) : async Result.Result<(), Text> {
    requireAdmin(caller);
    ordersEnabled := enabled;
    #ok(());
  };

  public shared ({ caller }) func addAdmin(
    principal : Principal
  ) : async Result.Result<(), Text> {
    requireOwner(caller);
    if (principal.isAnonymous()) return #err("Admin cannot be anonymous.");
    admins.add(principal);
    #ok(());
  };

  public shared ({ caller }) func removeAdmin(
    principal : Principal
  ) : async Result.Result<(), Text> {
    requireOwner(caller);
    admins.remove(principal);
    #ok(());
  };

  public shared ({ caller }) func upsertTemplate(
    template : Types.Template
  ) : async Result.Result<(), Text> {
    requireAdmin(caller);
    if (template.id.size() == 0 or template.id.size() > 40) {
      return #err("Template ID is invalid.");
    };
    if (template.name.size() == 0 or template.name.size() > 80) {
      return #err("Template name is invalid.");
    };
    if (template.description.size() > 500 or template.category.size() > 80) {
      return #err("Template metadata is too long.");
    };
    if (template.basePriceUsdCents > 10_000_000) {
      return #err("Template price is too large.");
    };
    templates.add(template.id, template);
    #ok(());
  };
};
