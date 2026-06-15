import Types "../../shared/Types";
import CyclePolicy "../../shared/CyclePolicy";

module {
  public let MIN_CHILD_CYCLES : Nat = CyclePolicy.MIN_CHILD_CYCLES;
  public let MAX_CHILD_CYCLES : Nat = CyclePolicy.MAX_CHILD_CYCLES;
  let MAX_USD_CENTS : Nat = 10_000_000;

  public func defaultConfig() : Types.PricingConfig {
    {
      serviceFeeUsdCents = 300;
      monthlyFundingUsdCents = 200;
      creationCycles = 750_000_000_000;
      monthlyCycles = 50_000_000_000;
      cycleBuffer = 200_000_000_000;
    };
  };

  public func conservativeCycleConfig(
    current : Types.PricingConfig
  ) : Types.PricingConfig {
    let defaults = defaultConfig();
    {
      current with
      creationCycles = defaults.creationCycles;
      monthlyCycles = defaults.monthlyCycles;
      cycleBuffer = defaults.cycleBuffer;
    };
  };

  public func quote(
    config : Types.PricingConfig,
    template : Types.Template,
    fundingMonths : Nat,
  ) : Types.PricingBreakdown {
    let fundingUsdCents = fundingMonths * config.monthlyFundingUsdCents;
    {
      templateUsdCents = template.basePriceUsdCents;
      serviceFeeUsdCents = config.serviceFeeUsdCents;
      fundingUsdCents;
      totalUsdCents = template.basePriceUsdCents + config.serviceFeeUsdCents + fundingUsdCents;
      initialCycles = config.creationCycles + config.cycleBuffer + (fundingMonths * config.monthlyCycles);
    };
  };

  public func validate(config : Types.PricingConfig) : ?Text {
    if (
      config.serviceFeeUsdCents > MAX_USD_CENTS or
      config.monthlyFundingUsdCents > MAX_USD_CENTS
    ) {
      return ?"USD pricing values are too large.";
    };

    let smallestPlanCycles = config.creationCycles + config.cycleBuffer + config.monthlyCycles;
    if (smallestPlanCycles < MIN_CHILD_CYCLES) {
      return ?"The one-month plan must allocate at least 1T cycles.";
    };

    let largestPlanCycles = config.creationCycles + config.cycleBuffer + (6 * config.monthlyCycles);
    if (largestPlanCycles > MAX_CHILD_CYCLES) {
      return ?"The six-month plan exceeds the factory's 5T cycle limit.";
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
