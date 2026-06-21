import Nat "mo:core/Nat";

module {
  public let FACTORY_RESERVE_CYCLES : Nat = 1_000_000_000_000;
  public let CHILD_CREATION_OVERHEAD_CYCLES : Nat = 250_000_000_000;
  public let MIN_CHILD_CYCLES : Nat = 1_000_000_000_000;
  public let MAX_CHILD_CYCLES : Nat = 5_000_000_000_000;
  public let TRILLION_CYCLES : Nat = 1_000_000_000_000;
  public let INITIAL_DEPLOY_CYCLES : Nat = 2_000_000_000_000;
  public let MIN_TOP_UP_CYCLES : Nat = 100_000_000_000;
  public let MAX_TOP_UP_CYCLES : Nat = 3_000_000_000_000;

  public func readinessReserveCycles() : Nat {
    FACTORY_RESERVE_CYCLES + CHILD_CREATION_OVERHEAD_CYCLES;
  };

  public func requiredFactoryBalance(childCycles : Nat) : Nat {
    childCycles + readinessReserveCycles();
  };

  public func deploymentDebitLimit(childCycles : Nat) : Nat {
    childCycles + CHILD_CREATION_OVERHEAD_CYCLES;
  };

  public func childCycleTarget(requestedCycles : Nat) : Nat {
    Nat.max(requestedCycles, MIN_CHILD_CYCLES);
  };
};