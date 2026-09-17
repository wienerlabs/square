#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
source "${SQUARE_DEPLOYER_ENV:-$HOME/.square/arc-testnet-deployer.env}"
set +a
export RPC_URL="${RPC_URL:-$ARC_TESTNET_RPC_URL}"
export CHAIN_ID=5042002
export LIFECYCLE_ACTORS_FILE="${LIFECYCLE_ACTORS_FILE:-$HOME/.square/arc-testnet-actors.env}"
export GAS_PRICE_WEI="${GAS_PRICE_WEI:-21200000000}"
export FUND_PER_ACTOR="${FUND_PER_ACTOR:-1}"
# A keeper cranks nothing under its profitability bar: about 5.6 USDC a job at Arc's
# gas price and the deployed fee since square#399 made it assume a gated finalize's
# real gas and average its receipts (docs/design/mandate-to-payment.md). Keeper mode
# funds bigger jobs, with room for the receipts and the gas price to move: six of
# them, their bonds and the gas.
if [ "${LIFECYCLE_FINALIZER:-self}" = "keeper" ]; then
  export FUND_CLIENT="${FUND_CLIENT:-70}"
  export BUDGET_USDC="${BUDGET_USDC:-10}"
else
  export FUND_CLIENT="${FUND_CLIENT:-3.2}"
  export BUDGET_USDC="${BUDGET_USDC:-0.25}"
fi
# The provider's ERC-8004 agent. 892531 was registered on the 2026-09-09 run and is
# reused, so a run costs no registration; REGISTER_AGENT=1 registers a fresh one instead,
# which is what square#31's second step wants in its report. AGENT_ID wins over
# REGISTER_AGENT in the runner, so it is left unset in that case.
if [ "${REGISTER_AGENT:-0}" = "1" ]; then
  unset AGENT_ID
else
  export AGENT_ID="${AGENT_ID:-892531}"
fi
# square#31, square#336: once a keeper runs against the stack, LIFECYCLE_FINALIZER=keeper
# leaves every settlement to it and records its transactions; the runner's own crank
# would only race it. The keeper cranks nothing under its profitability bar, so the
# budget has to clear it (docs/design/mandate-to-payment.md, "Running it").
export LIFECYCLE_FINALIZER="${LIFECYCLE_FINALIZER:-self}"
echo "lifecycle against chain $CHAIN_ID via $RPC_URL, budget $BUDGET_USDC USDC, agent ${AGENT_ID:-registered on this run}, settled by $LIFECYCLE_FINALIZER"
npm run lifecycle
