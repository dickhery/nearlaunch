import Blob "mo:core/Blob";
import Cycles "mo:core/Cycles";
import Error "mo:core/Error";
import Int "mo:core/Int";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Result "mo:core/Result";
import Runtime "mo:core/Runtime";
import Sha256 "mo:sha2/Sha256";
import CyclePolicy "../shared/CyclePolicy";
import Types "../shared/Types";

shared (install) actor class LauncherFactory() = Self {
  let owner = do {
    if (install.caller.isAnonymous()) {
      Runtime.trap("Install launcher_factory with a named identity.");
    };
    install.caller;
  };
  let deployments = Map.empty<Nat, Types.FactoryDeployment>();
  let inFlight = Map.empty<Nat, Bool>();
  var appWasm : ?Blob = null;
  var appWasmHash : ?Blob = null;

  let FACTORY_RESERVE : Nat = CyclePolicy.FACTORY_RESERVE_CYCLES;
  let MIN_CHILD_CYCLES : Nat = CyclePolicy.MIN_CHILD_CYCLES;
  let MAX_CHILD_CYCLES : Nat = CyclePolicy.MAX_CHILD_CYCLES;
  let MAX_WASM_BYTES : Nat = 1_900_000;

  transient let launcherCanisterId = switch (
    Runtime.envVar<system>("PUBLIC_CANISTER_ID:launcher_backend")
  ) {
    case (?value) value;
    case (null) Runtime.trap("launcher_backend canister ID is not configured.");
  };
  transient let launcherPrincipal = Principal.fromText(launcherCanisterId);

  type CanisterSettings = {
    controllers : ?[Principal];
    compute_allocation : ?Nat;
    memory_allocation : ?Nat;
    freezing_threshold : ?Nat;
  };

  type CreateCanisterResult = {
    canister_id : Principal;
  };

  type CanisterStatus = {
    status : { #running; #stopping; #stopped };
    memory_size : Nat;
    cycles : Nat;
    settings : CanisterSettings;
    module_hash : ?Blob;
  };

  type ChildApp = actor {
    updateConfigForOwner : shared (Principal, Types.AppConfig) -> async ();
  };

  transient let ic : actor {
    create_canister : shared ({ settings : ?CanisterSettings }) -> async CreateCanisterResult;
    canister_status : shared ({ canister_id : Principal }) -> async CanisterStatus;
    deposit_cycles : shared ({ canister_id : Principal }) -> async ();
    install_code : shared ({
      mode : { #install; #reinstall; #upgrade };
      canister_id : Principal;
      wasm_module : Blob;
      arg : Blob;
    }) -> async ();
  } = actor "aaaaa-aa";

  func requireOwner(caller : Principal) {
    if (caller.isAnonymous()) Runtime.trap("Anonymous caller is not allowed.");
    if (caller != owner) Runtime.trap("Caller is not the factory owner.");
  };

  func requireLauncher(caller : Principal) {
    if (caller.isAnonymous()) Runtime.trap("Anonymous caller is not allowed.");
    if (caller != launcherPrincipal) Runtime.trap("Caller is not the launcher backend.");
  };

  func acquire(orderId : Nat) : Result.Result<(), Text> {
    if (inFlight.get(orderId) != null) return #err("Deployment is already in progress.");
    inFlight.add(orderId, true);
    #ok(());
  };

  func release(orderId : Nat) {
    inFlight.remove(orderId);
  };

  func failure(message : Text, canisterId : ?Principal) : Types.FactoryDeployResult {
    #err({ message; canisterId });
  };

  func updateFailure(message : Text, canisterId : ?Principal) : Types.FactoryUpdateResult {
    #err({ message; canisterId });
  };

  func childCycleTarget(requestedCycles : Nat) : Nat {
    CyclePolicy.childCycleTarget(requestedCycles);
  };

  func hasDeploymentCapacity(childCycles : Nat) : Bool {
    Cycles.balance() >= CyclePolicy.requiredFactoryBalance(childCycles);
  };

  func hasTopUpCapacity(shortfall : Nat) : Bool {
    Cycles.balance() >= shortfall + FACTORY_RESERVE;
  };

  func ensureChildFunded(canisterId : Principal, targetCycles : Nat) : async () {
    let status = await ic.canister_status({ canister_id = canisterId });
    if (status.cycles >= targetCycles) return;

    let shortfall = Int.abs(targetCycles.toInt() - status.cycles.toInt());
    if (not hasTopUpCapacity(shortfall)) {
      Runtime.trap("Factory does not have enough cycles to top up the child canister.");
    };

    await (with cycles = shortfall)
      ic.deposit_cycles({ canister_id = canisterId });
  };

  public query func getOwner() : async Principal {
    owner;
  };

  public query func getDeployment(orderId : Nat) : async ?Types.FactoryDeployment {
    deployments.get(orderId);
  };

  public query func getTemplateWasmInfo() : async {
    configured : Bool;
    hash : ?Blob;
    size : Nat;
  } {
    {
      configured = appWasm != null;
      hash = appWasmHash;
      size = switch (appWasm) {
        case (?wasm) wasm.size();
        case (null) 0;
      };
    };
  };

  public query func getCycleBalance() : async Nat {
    Cycles.balance();
  };

  public query func getReadiness(requiredCycles : Nat) : async Types.FactoryReadiness {
    let targetCycles = childCycleTarget(requiredCycles);
    let cycleBalance = Cycles.balance();
    let templateWasmSize = switch (appWasm) {
      case (?wasm) wasm.size();
      case (null) 0;
    };
    let templateWasmConfigured = appWasm != null;
    {
      cycleBalance;
      reserveCycles = CyclePolicy.readinessReserveCycles();
      maxChildCycles = MAX_CHILD_CYCLES;
      requiredCycles = targetCycles;
      templateWasmConfigured;
      templateWasmSize;
      canDeploy =
        templateWasmConfigured and
        targetCycles <= MAX_CHILD_CYCLES and
        cycleBalance >= CyclePolicy.requiredFactoryBalance(targetCycles);
    };
  };

  public shared ({ caller }) func uploadTemplateWasm(
    wasm : Blob,
    expectedHash : Blob,
  ) : async Result.Result<(), Text> {
    requireOwner(caller);
    if (wasm.size() == 0) return #err("Template Wasm is empty.");
    if (wasm.size() > MAX_WASM_BYTES) {
      return #err("Template Wasm exceeds the 1.9 MB ingress safety limit.");
    };

    let actualHash = Sha256.fromBlob(#sha256, wasm);
    if (actualHash != expectedHash) return #err("Template Wasm hash does not match.");

    appWasm := ?wasm;
    appWasmHash := ?actualHash;
    #ok(());
  };

  public shared ({ caller }) func deployOrder(
    request : Types.FactoryDeployRequest
  ) : async Types.FactoryDeployResult {
    requireLauncher(caller);
    let targetCycles = childCycleTarget(request.initialCycles);
    if (request.initialCycles < MIN_CHILD_CYCLES) {
      return failure("Requested child cycle allocation is below the factory's 1T minimum.", null);
    };
    if (targetCycles > MAX_CHILD_CYCLES) {
      return failure("Requested child cycle allocation exceeds the factory limit.", null);
    };

    let wasm = switch (appWasm) {
      case (?value) value;
      case (null) return failure("No approved app template Wasm has been uploaded.", null);
    };

    switch (acquire(request.orderId)) {
      case (#err(message)) return failure(message, null);
      case (#ok(())) {};
    };

    try {
      let existing = deployments.get(request.orderId);
      switch (existing) {
        case (?deployment) {
          if (deployment.owner != request.owner or deployment.templateId != request.templateId) {
            return failure("Order ID is already bound to different deployment details.", deployment.canisterId);
          };
          if (deployment.status == #Live) {
            return switch (deployment.canisterId) {
              case (?canisterId) #ok(canisterId);
              case (null) failure("Live deployment is missing its canister ID.", null);
            };
          };
        };
        case (null) {};
      };

      let canisterId = switch (existing) {
        case (?deployment) {
          switch (deployment.canisterId) {
            case (?value) value;
            case (null) {
              let created = await createChild(request, targetCycles);
              created;
            };
          };
        };
        case (null) {
          let created = await createChild(request, targetCycles);
          created;
        };
      };

      try {
        await ensureChildFunded(canisterId, targetCycles);
      } catch (error) {
        let message = "Canister funding failed: " # error.message();
        deployments.add(
          request.orderId,
          {
            orderId = request.orderId;
            owner = request.owner;
            templateId = request.templateId;
            status = #Failed;
            canisterId = ?canisterId;
            error = ?message;
          },
        );
        return failure(message, ?canisterId);
      };

      deployments.add(
        request.orderId,
        {
          orderId = request.orderId;
          owner = request.owner;
          templateId = request.templateId;
          status = #Installing;
          canisterId = ?canisterId;
          error = null;
        },
      );

      try {
        await ic.install_code({
          mode = #install;
          canister_id = canisterId;
          wasm_module = wasm;
          arg = to_candid ({
            owner = request.owner;
            templateId = request.templateId;
            config = request.config;
          } : Types.ChildInit);
        });

        deployments.add(
          request.orderId,
          {
            orderId = request.orderId;
            owner = request.owner;
            templateId = request.templateId;
            status = #Live;
            canisterId = ?canisterId;
            error = null;
          },
        );
        #ok(canisterId);
      } catch (error) {
        let message = "Template installation failed: " # error.message();
        deployments.add(
          request.orderId,
          {
            orderId = request.orderId;
            owner = request.owner;
            templateId = request.templateId;
            status = #Failed;
            canisterId = ?canisterId;
            error = ?message;
          },
        );
        failure(message, ?canisterId);
      };
    } catch (error) {
      let message = "Canister creation failed: " # error.message();
      deployments.add(
        request.orderId,
        {
          orderId = request.orderId;
          owner = request.owner;
          templateId = request.templateId;
          status = #Failed;
          canisterId = null;
          error = ?message;
        },
      );
      failure(message, null);
    } finally {
      release(request.orderId);
    };
  };

  public shared ({ caller }) func updateDeployment(
    request : Types.FactoryUpdateRequest
  ) : async Types.FactoryUpdateResult {
    requireLauncher(caller);

    let wasm = switch (appWasm) {
      case (?value) value;
      case (null) {
        return updateFailure("No approved app template Wasm has been uploaded.", ?request.canisterId);
      };
    };

    switch (acquire(request.orderId)) {
      case (#err(message)) return updateFailure(message, ?request.canisterId);
      case (#ok(())) {};
    };

    try {
      switch (deployments.get(request.orderId)) {
        case (?deployment) {
          if (deployment.owner != request.owner or deployment.templateId != request.templateId) {
            return updateFailure(
              "Order ID is already bound to different deployment details.",
              deployment.canisterId,
            );
          };
          switch (deployment.canisterId) {
            case (?existingCanisterId) {
              if (existingCanisterId != request.canisterId) {
                return updateFailure(
                  "Order ID is already bound to a different app canister.",
                  ?existingCanisterId,
                );
              };
            };
            case (null) {};
          };
        };
        case (null) {};
      };

      deployments.add(
        request.orderId,
        {
          orderId = request.orderId;
          owner = request.owner;
          templateId = request.templateId;
          status = #Installing;
          canisterId = ?request.canisterId;
          error = null;
        },
      );

      let initArg = to_candid ({
        owner = request.owner;
        templateId = request.templateId;
        config = request.config;
      } : Types.ChildInit);

      var reinstalled = false;
      try {
        await ic.install_code({
          mode = #upgrade;
          canister_id = request.canisterId;
          wasm_module = wasm;
          arg = initArg;
        });
      } catch (upgradeError) {
        if (not request.allowReinstall) {
          let message = "Template upgrade failed: " # upgradeError.message();
          deployments.add(
            request.orderId,
            {
              orderId = request.orderId;
              owner = request.owner;
              templateId = request.templateId;
              status = #Failed;
              canisterId = ?request.canisterId;
              error = ?message;
            },
          );
          return updateFailure(message, ?request.canisterId);
        };

        try {
          await ic.install_code({
            mode = #reinstall;
            canister_id = request.canisterId;
            wasm_module = wasm;
            arg = initArg;
          });
          reinstalled := true;
        } catch (reinstallError) {
          let message =
            "Template upgrade failed (" # upgradeError.message() #
            ") and reinstall failed: " # reinstallError.message();
          deployments.add(
            request.orderId,
            {
              orderId = request.orderId;
              owner = request.owner;
              templateId = request.templateId;
              status = #Failed;
              canisterId = ?request.canisterId;
              error = ?message;
            },
          );
          return updateFailure(message, ?request.canisterId);
        };
      };

      if (not reinstalled) {
        let child : ChildApp = actor (request.canisterId.toText());
        try {
          await child.updateConfigForOwner(request.owner, request.config);
        } catch (configError) {
          let message = "Template upgraded, but live config update failed: " # configError.message();
          deployments.add(
            request.orderId,
            {
              orderId = request.orderId;
              owner = request.owner;
              templateId = request.templateId;
              status = #Failed;
              canisterId = ?request.canisterId;
              error = ?message;
            },
          );
          return updateFailure(message, ?request.canisterId);
        };
      };

      deployments.add(
        request.orderId,
        {
          orderId = request.orderId;
          owner = request.owner;
          templateId = request.templateId;
          status = #Live;
          canisterId = ?request.canisterId;
          error = null;
        },
      );
      #ok(if (reinstalled) #Reinstalled else #Upgraded);
    } catch (error) {
      let message = "Live app update failed: " # error.message();
      deployments.add(
        request.orderId,
        {
          orderId = request.orderId;
          owner = request.owner;
          templateId = request.templateId;
          status = #Failed;
          canisterId = ?request.canisterId;
          error = ?message;
        },
      );
      updateFailure(message, ?request.canisterId);
    } finally {
      release(request.orderId);
    };
  };

  func createChild(request : Types.FactoryDeployRequest, targetCycles : Nat) : async Principal {
    if (not hasDeploymentCapacity(targetCycles)) {
      Runtime.trap("Factory does not have enough cycles for this deployment.");
    };

    deployments.add(
      request.orderId,
      {
        orderId = request.orderId;
        owner = request.owner;
        templateId = request.templateId;
        status = #Creating;
        canisterId = null;
        error = null;
      },
    );

    let created = await (with cycles = targetCycles)
      ic.create_canister({
        settings = ?{
          controllers = ?[Principal.fromActor(Self), request.owner];
          compute_allocation = null;
          memory_allocation = null;
          freezing_threshold = ?2_592_000;
        };
      });

    deployments.add(
      request.orderId,
      {
        orderId = request.orderId;
        owner = request.owner;
        templateId = request.templateId;
        status = #Created;
        canisterId = ?created.canister_id;
        error = null;
      },
    );
    created.canister_id;
  };
};
