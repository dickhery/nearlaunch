import Types "../../shared/Types";
import CyclePolicy "../../shared/CyclePolicy";

module {
  public let MIN_CHILD_CYCLES : Nat = CyclePolicy.MIN_CHILD_CYCLES;
  public let MAX_CHILD_CYCLES : Nat = CyclePolicy.MAX_CHILD_CYCLES;
  public let TRILLION_CYCLES : Nat = CyclePolicy.TRILLION_CYCLES;
  public let INITIAL_DEPLOY_CYCLES : Nat = CyclePolicy.INITIAL_DEPLOY_CYCLES;
  public let MIN_TOP_UP_CYCLES : Nat = CyclePolicy.MIN_TOP_UP_CYCLES;
  public let MAX_TOP_UP_CYCLES : Nat = CyclePolicy.MAX_TOP_UP_CYCLES;
  public let DEFAULT_MARKUP_BPS : Nat = 5_000;
  public let DEFAULT_USD_PER_TRILLION_CENTS : Nat = 100;
  let MAX_USD_CENTS : Nat = 10_000_000;

  public func defaultConfig() : Types.PricingConfig {
    {
      serviceFeeUsdCents = 50;
      monthlyFundingUsdCents = 0;
      creationCycles = 0;
      monthlyCycles = 0;
      cycleBuffer = 0;
      initialDeployCycles = ?INITIAL_DEPLOY_CYCLES;
      cyclesMarkupBps = ?DEFAULT_MARKUP_BPS;
      usdPerTrillionCents = ?DEFAULT_USD_PER_TRILLION_CENTS;
    };
  };

  public func resolveInitialDeployCycles(config : Types.PricingConfig) : Nat {
    switch (config.initialDeployCycles) {
      case (?value) value;
      case (null) INITIAL_DEPLOY_CYCLES;
    };
  };

  public func resolveMarkupBps(config : Types.PricingConfig) : Nat {
    switch (config.cyclesMarkupBps) {
      case (?value) value;
      case (null) DEFAULT_MARKUP_BPS;
    };
  };

  public func resolveUsdPerTrillionCents(config : Types.PricingConfig) : Nat {
    switch (config.usdPerTrillionCents) {
      case (?value) value;
      case (null) DEFAULT_USD_PER_TRILLION_CENTS;
    };
  };

  public func cyclesToBaseUsdCents(cycles : Nat, usdPerTrillionCents : Nat) : Nat {
    (cycles * usdPerTrillionCents) / TRILLION_CYCLES;
  };

  public func markupUsdCents(baseUsdCents : Nat, markupBps : Nat) : Nat {
    (baseUsdCents * markupBps) / 10_000;
  };

  public func quoteCycles(
    config : Types.PricingConfig,
    cycles : Nat,
  ) : {
    baseUsdCents : Nat;
    markupUsdCents : Nat;
    totalUsdCents : Nat;
  } {
    let usdPerTrillion = resolveUsdPerTrillionCents(config);
    let markupBps = resolveMarkupBps(config);
    let baseUsdCents = cyclesToBaseUsdCents(cycles, usdPerTrillion);
    let markup = markupUsdCents(baseUsdCents, markupBps);
    {
      baseUsdCents;
      markupUsdCents = markup;
      totalUsdCents = baseUsdCents + markup;
    };
  };

  public func quoteDeploy(
    config : Types.PricingConfig,
    template : Types.Template,
  ) : Types.PricingBreakdown {
    let initialCycles = resolveInitialDeployCycles(config);
    let cyclesQuote = quoteCycles(config, initialCycles);
    {
      templateUsdCents = template.basePriceUsdCents;
      serviceFeeUsdCents = config.serviceFeeUsdCents;
      fundingUsdCents = cyclesQuote.totalUsdCents;
      totalUsdCents =
        template.basePriceUsdCents + config.serviceFeeUsdCents + cyclesQuote.totalUsdCents;
      initialCycles;
      cyclesBaseUsdCents = cyclesQuote.baseUsdCents;
      cyclesMarkupUsdCents = cyclesQuote.markupUsdCents;
    };
  };

  public func quoteTopUp(
    config : Types.PricingConfig,
    topUpCycles : Nat,
  ) : Types.PricingBreakdown {
    let cyclesQuote = quoteCycles(config, topUpCycles);
    {
      templateUsdCents = 0;
      serviceFeeUsdCents = 0;
      fundingUsdCents = cyclesQuote.totalUsdCents;
      totalUsdCents = cyclesQuote.totalUsdCents;
      initialCycles = topUpCycles;
      cyclesBaseUsdCents = cyclesQuote.baseUsdCents;
      cyclesMarkupUsdCents = cyclesQuote.markupUsdCents;
    };
  };

  public func conservativeCycleConfig(
    current : Types.PricingConfig
  ) : Types.PricingConfig {
    let defaults = defaultConfig();
    {
      current with
      initialDeployCycles = defaults.initialDeployCycles;
      cyclesMarkupBps = defaults.cyclesMarkupBps;
      usdPerTrillionCents = defaults.usdPerTrillionCents;
    };
  };

  public func validate(config : Types.PricingConfig) : ?Text {
    if (config.serviceFeeUsdCents > MAX_USD_CENTS) {
      return ?"USD pricing values are too large.";
    };

    let initialCycles = resolveInitialDeployCycles(config);
    if (initialCycles < MIN_CHILD_CYCLES) {
      return ?"Initial deploy allocation must be at least 1T cycles.";
    };
    if (initialCycles > MAX_CHILD_CYCLES) {
      return ?"Initial deploy allocation exceeds the factory's 5T cycle limit.";
    };

    let markupBps = resolveMarkupBps(config);
    if (markupBps > 20_000) {
      return ?"Cycles markup cannot exceed 200%.";
    };

    let usdPerTrillion = resolveUsdPerTrillionCents(config);
    if (usdPerTrillion == 0 or usdPerTrillion > 1_000_000) {
      return ?"USD per trillion cycles rate is invalid.";
    };
    null;
  };

  public func toSmallestUnits(usdCents : Nat, decimals : Nat) : Nat {
    if (decimals <= 2) return usdCents;

    var multiplier : Nat = 1;
    var index : Nat = 0;
    while (index + 2 < decimals) {
      multiplier *= 10;
      index += 1;
    };
    usdCents * multiplier;
  };
};