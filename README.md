# NearLaunch for ICP

NearLaunch is a chain-abstracted ICP app launcher. A user signs in with
Internet Identity, chooses an approved template, configures it, pays through a
NEAR Intents 1Click deposit address, and receives a live ICP canister with
cycles and the user's principal installed as a controller.

## Architecture

- `launcher_frontend`: certified asset canister containing the Vite UI.
- `launcher_backend`: templates, fixed-price orders, settlement proofs, and
  deployment status. It also stores pricing, payment labels, order availability,
  canceled-order audit state, and the web-admin allowlist.
- `launcher_factory`: holds approved child Wasm, creates canisters, funds them
  with cycles, and installs the selected configuration.
- `app_template`: the generated Motoko landing-page canister.
- `relayer/server.mjs`: an off-chain Node service that keeps the NEAR 1Click
  credential secret and is the only principal authorized to confirm payment.

NEAR Intents does not currently settle directly to ICP. The implemented flow
uses NEAR 1Click to swap the user's source token into the configured treasury
asset. After a successful swap, the relayer records a replay-safe settlement
proof on ICP and the factory spends its prefunded cycles to create the app.

## Prerequisites

- Node.js 22 or newer
- pnpm 10
- `icp` CLI 0.3.2
- Mops 2.13 or newer
- `ic-wasm`

Install project dependencies:

```bash
pnpm install --frozen-lockfile
mops install
```

Validate everything before deployment:

```bash
pnpm check
```

## Local Deployment

The bootstrap script creates a local plaintext identity, starts the managed
PocketIC network, deploys all three project canisters, tops up the factory,
builds and uploads the approved child Wasm, and prints the frontend URL.
Plaintext identity storage is used only for local development.

```bash
pnpm bootstrap:local
```

In a second terminal, run the mock payment relayer:

```bash
ICP_RELAYER_IDENTITY=nearlaunch-local RELAYER_MOCK=true pnpm relayer
```

Open the frontend URL printed by the bootstrap script. The deployed local
frontend is built with `VITE_RELAYER_URL=http://127.0.0.1:8787`.

Useful local commands:

```bash
icp network status --json
icp canister call launcher_backend getStats '()' -e local --query
icp canister call launcher_factory getCycleBalance '()' -e local --query
icp network stop
```

To use a separate local relayer identity, create it before bootstrapping and
pass both identity names:

```bash
icp identity new nearlaunch-relayer --storage plaintext
ICP_DEPLOY_IDENTITY=nearlaunch-local \
ICP_RELAYER_IDENTITY=nearlaunch-relayer \
pnpm bootstrap:local
```

## NEAR 1Click Relayer

Copy `.env.example` to `.env` and configure:

```dotenv
RELAYER_MOCK=false
RELAYER_ALLOWED_ORIGIN=https://YOUR_FRONTEND_CANISTER.icp0.io
NEAR_1CLICK_API_KEY=YOUR_1CLICK_API_KEY
SETTLEMENT_RECIPIENT=YOUR_TREASURY_ACCOUNT.near
ICP_ENVIRONMENT=ic
ICP_API_HOST=https://icp-api.io
ICP_BACKEND_CANISTER=dsp3h-giaaa-aaaag-ayuqq-cai
ICP_RELAYER_PEM_PATH=/absolute/path/to/nearlaunch-relayer.pem
VITE_RELAYER_URL=https://relayer.example.com
```

`RELAYER_ALLOWED_ORIGIN` accepts a comma-separated list when the frontend is
served from more than one origin. Configure origins only, without paths. A
trailing slash is normalized, so both `https://example.com` and
`https://example.com/` match the browser origin `https://example.com`.

Configure the partner credential issued by the NEAR Intents Partner Dashboard.
The relayer supports `X-API-Key` through `NEAR_1CLICK_API_KEY` and bearer
authentication through `NEAR_1CLICK_JWT`. Never place either credential in a
`VITE_*` variable or frontend code.

The production relayer uses the ICP JavaScript agent directly and therefore
does not require `icp-cli` on the server. Export a dedicated relayer identity
to a protected PEM file:

```bash
icp identity new nearlaunch-relayer
icp identity export nearlaunch-relayer > nearlaunch-relayer.pem
chmod 600 nearlaunch-relayer.pem

RELAYER_PRINCIPAL="$(icp identity principal --identity nearlaunch-relayer)"
icp canister call launcher_backend setSettlementRelayer \
  "(principal \"$RELAYER_PRINCIPAL\")" \
  -e ic --identity nearlaunch-deployer
```

Place the PEM file on the relayer host outside the public web root and set
`ICP_RELAYER_PEM_PATH` to its absolute path. `ICP_BACKEND_CANISTER` must be the
deployed canister ID rather than the project name when agent mode is used.

For local development, the relayer can instead use `icp-cli`:

```dotenv
ICP_RELAYER_PEM_PATH=
ICP_RELAYER_IDENTITY=nearlaunch-local
ICP_CLI=/absolute/path/from-command-v-icp
```

Run the relayer on a trusted HTTPS host with persistent storage for
`relayer/.data/quotes.json` and read access to the configured protected
identity:

```bash
pnpm relayer
```

Verify production is actually in live mode before enabling orders:

```bash
curl https://relayer.example.com/health
# Expected:
# "mode":"live"
# "ready":true
# "backendConnectionMode":"agent"
# "backendConnected":true
# "backendIdentityAuthorized":true
```

Do not enable orders while `ready` is false. In particular,
`ICP_CLI_NOT_FOUND` means the old CLI execution mode cannot locate the
executable, and `ICP_RELAYER_NOT_AUTHORIZED` means the principal reported by
the health response still needs to be passed to `setSettlementRelayer`.

The frontend asset policy allowlists the relayer origin in
`public/.ic-assets.json5`. If the production relayer URL changes, update both
`VITE_RELAYER_URL` and the `connect-src` origin in that file, then redeploy the
frontend. The same policy explicitly permits `clipboard-write` for the
frontend origin so users can copy their Internet Identity principal.

The default settlement asset is native NEAR USDC with six decimals. If you
change it, update both the backend and relayer to the same value:

```bash
icp canister call launcher_backend setSettlementConfig \
  '(record { assetId = "YOUR_ASSET_ID"; decimals = 6 })' \
  -e ic --identity nearlaunch-deployer
```

## Mainnet Deployment

### 1. Create and fund identities

Use protected keyring storage for mainnet:

```bash
icp identity new nearlaunch-deployer
icp identity new nearlaunch-relayer
icp identity principal --identity nearlaunch-deployer
icp identity principal --identity nearlaunch-relayer
```

Send ICP to the deployer principal, then verify and convert part of it to
cycles:

```bash
icp token balance -e ic --identity nearlaunch-deployer
icp cycles mint --cycles 50t -e ic --identity nearlaunch-deployer
icp cycles balance -e ic --identity nearlaunch-deployer
```

### 2. Deploy the platform

Set the public relayer URL at build time and deploy with enough initial cycles:

```bash
VITE_RELAYER_URL=https://relayer.example.com \
icp deploy -e ic --identity nearlaunch-deployer --cycles 3t
```

Record the canister IDs:

```bash
icp canister status launcher_backend -e ic -i
icp canister status launcher_factory -e ic -i
icp canister status launcher_frontend -e ic -i
```

### 3. Fund and configure the factory

The factory pays the creation and initial-cycle cost for every generated app.
The conservative defaults allocate:

- 1-month plan: 1T cycles
- 3-month plan: 1.1T cycles
- 6-month plan: 1.25T cycles

The factory also requires a separate 1T safety reserve plus a 0.25T deployment
overhead buffer for the management-canister creation fee and any measured
post-create top-up needed before Wasm installation. The corresponding readiness
balances are 2.25T, 2.35T, and 2.5T. The reserve/overhead is held by the
factory and only a measured top-up shortfall is transferred to each child.

Existing deployments keep their stable pricing configuration after an
upgrade. Apply the conservative preset once to migrate an older installation;
this preserves the existing USD prices:

```bash
icp canister call launcher_backend applyConservativeCyclePreset '()' \
  -e ic --identity nearlaunch-deployer
```

Check the live balance and the six-month readiness target before topping up:

```bash
icp canister call launcher_factory getCycleBalance '()' -e ic --query
icp canister call launcher_factory getReadiness \
  '(1_250_000_000_000)' -e ic --query

# Replace AMOUNT with the displayed shortfall, or use a rounded-up value.
icp canister top-up launcher_factory --amount AMOUNT \
  -e ic --identity nearlaunch-deployer

ICP_ENVIRONMENT=ic \
ICP_DEPLOY_IDENTITY=nearlaunch-deployer \
pnpm template:build

ICP_ENVIRONMENT=ic \
ICP_DEPLOY_IDENTITY=nearlaunch-deployer \
pnpm template:upload
```

Authorize the relayer principal:

```bash
RELAYER_PRINCIPAL="$(icp identity principal --identity nearlaunch-relayer)"
icp canister call launcher_backend setSettlementRelayer \
  "(principal \"$RELAYER_PRINCIPAL\")" \
  -e ic --identity nearlaunch-deployer
```

### 4. Grant web admin access

Sign in to the deployed frontend. The full principal appears in the "My apps"
section and can be selected manually even if browser clipboard access is
unavailable. Copy it, then grant it admin access from the deployment owner
identity:

```bash
WEB_ADMIN_PRINCIPAL="PASTE_YOUR_COPIED_PRINCIPAL"
icp canister call launcher_backend addAdmin \
  "(principal \"$WEB_ADMIN_PRINCIPAL\")" \
  -e ic --identity nearlaunch-deployer
```

Reload the frontend. The Admin section can now update pricing, settlement
labels, cycle allocations, templates, and whether new orders are enabled. The
"Apply conservative cycle preset" button sets the child allocations to 1T,
1.1T, and 1.25T without changing the customer-facing USD prices. The owner
retains the exclusive ability to add/remove admins and replace the settlement
relayer. Admin principals are stored on-chain; do not put them in a public
frontend environment variable.

### 5. Add recovery controllers

Add a separately secured recovery principal to each platform canister before
launch:

```bash
icp canister settings update launcher_backend \
  --add-controller RECOVERY_PRINCIPAL -e ic --identity nearlaunch-deployer
icp canister settings update launcher_factory \
  --add-controller RECOVERY_PRINCIPAL -e ic --identity nearlaunch-deployer
icp canister settings update launcher_frontend \
  --add-controller RECOVERY_PRINCIPAL -e ic --identity nearlaunch-deployer
```

### 6. Start production services

Deploy the relayer with `RELAYER_MOCK=false`, its protected PEM identity, the
1Click API key, treasury recipient, backend canister ID, and the exact
frontend origin. Restart the relayer after changing its environment. Then
visit:

```text
https://FRONTEND_CANISTER_ID.icp0.io
```

Monitor factory cycles regularly:

```bash
icp canister call launcher_factory getCycleBalance '()' \
  -e ic --query
```

## Order Cancellation And Preview

Orders with no payment quote can be canceled immediately by their owner. The
backend retains the original order for audit purposes, removes it from
`getMyDeployments`, clears outstanding authorizations, and rejects any later
quote, settlement, refund, or deployment attempt for that order.

Quoted orders use a second short-lived authorization. The relayer verifies that
the deposit address belongs to the order and checks 1Click before submitting the
cancellation on-chain. Mock quotes can be canceled while they are
`PENDING_DEPOSIT`. Real quotes must be past their deadline and still report
`PENDING_DEPOSIT`; detected, processing, incomplete, successful, failed, or
refunded payments are not automatically canceled.

The launcher renders a script-free sandboxed preview while the user edits the
form and again from the exact configuration stored in the selected order. The
preview mirrors the generated app template's current HTML and CSS, but the
deployed child canister remains the source of truth.

After deploying this interface change, upgrade `launcher_backend` and
`launcher_frontend`, then restart the relayer so it loads the regenerated
backend Candid declarations:

```bash
icp deploy launcher_backend -e ic --identity nearlaunch-deployer
VITE_RELAYER_URL=https://relayer.example.com \
icp deploy launcher_frontend -e ic --identity nearlaunch-deployer
```

## Operational Notes

- Payment settlement is idempotent: each proof ID can be consumed once.
- Payment quote registration requires a short-lived authorization minted for
  the authenticated order owner, preventing another browser from replacing an
  order's deposit address.
- Only the configured relayer may register quotes or settle/refund orders.
- New orders are rejected before payment if the template Wasm is missing or
  the factory does not have the quoted child cycles plus its readiness reserve
  and deployment overhead.
- Each child must receive at least 1T cycles after canister creation fees and
  may receive no more than 5T. Generated apps use a 30-day freezing threshold,
  while the platform canisters retain their more conservative 90-day threshold.
- The generated app template has no timers, inter-canister calls, or HTTPS
  outcalls. Browser-to-relayer requests run off-chain and do not consume
  canister cycles.
- The factory accepts only owner-uploaded Wasm whose SHA-256 matches.
- Child canisters are created with the factory and user as controllers.
- State uses stable Motoko data structures and survives upgrades.
- Adding the canceled-order indexes is an implicit compatible Motoko upgrade;
  the persisted `DeploymentOrder` record and status variant are unchanged.
- The launcher frontend is certified. Generated child pages currently use the
  raw ICP HTTP domain because their dynamic response is not yet certified.
  Replace the child renderer with certified HTTP responses or generated asset
  canisters before treating child-page content as cryptographically verified.

## References

- [ICP CLI documentation](https://cli.internetcomputer.org/)
- [ICP app skills](https://skills.internetcomputer.org/)
- [NEAR 1Click quickstart](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart)
- [NEAR 1Click API reference](https://docs.near-intents.org/integration/distribution-channels/1click-api/)
