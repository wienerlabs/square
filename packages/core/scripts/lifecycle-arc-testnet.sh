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
export FUND_CLIENT="${FUND_CLIENT:-3.2}"
export BUDGET_USDC="${BUDGET_USDC:-0.25}"
export AGENT_ID="${AGENT_ID:-892531}"
echo "lifecycle against chain $CHAIN_ID via $RPC_URL, budget $BUDGET_USDC USDC, agent $AGENT_ID"
npm run lifecycle
