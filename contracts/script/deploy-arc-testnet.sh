#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
source "${SQUARE_DEPLOYER_ENV:-$HOME/.square/arc-testnet-deployer.env}"
source "${SQUARE_ACTORS_ENV:-$HOME/.square/arc-testnet-actors.env}"
set +a
export USDC_ADDRESS="${USDC_ADDRESS:-0x3600000000000000000000000000000000000000}"
export IDENTITY_REGISTRY="${IDENTITY_REGISTRY:-0x8004A818BFB912233c491871b3d84c89A494BD9e}"
export REPUTATION_REGISTRY="${REPUTATION_REGISTRY:-0x8004B663056A597Dffe9eCcC1965A193B7388713}"
export VALIDATION_REGISTRY="${VALIDATION_REGISTRY:-0x8004Cb1BF31DAf7788923b405b754f57acEB4272}"
export PLATFORM_FEE_BP="${PLATFORM_FEE_BP:-100}"
export EVALUATOR_FEE_BP="${EVALUATOR_FEE_BP:-50}"
export CHALLENGE_WINDOW="${CHALLENGE_WINDOW:-120}"
export DISPUTE_WINDOW="${DISPUTE_WINDOW:-300}"
export FINALIZE_GRACE="${FINALIZE_GRACE:-600}"
export BOND_BPS="${BOND_BPS:-1000}"
export MIN_BOND="${MIN_BOND:-1000000}"
export ARBITER_THRESHOLD="${ARBITER_THRESHOLD:-2}"
export MIN_REPUTATION_BUDGET="${MIN_REPUTATION_BUDGET:-100000}"
export ARBITERS="${ARBITERS:-$ARBITER_A_ADDRESS,$ARBITER_B_ADDRESS,$CRANKER_ADDRESS}"
export SCREENING_MAX_AGE="${SCREENING_MAX_AGE:-3600}"
export SCREENER_ADDRESS="${SCREENER_ADDRESS:-0x0000000000000000000000000000000000000000}"
export INSTALL_SCREENING="${INSTALL_SCREENING:-true}"

# The endpoint comes from a dotfile, and a wrong one deploys somewhere else
# without complaint: the constructors make no external calls, so the missing
# USDC and registry addresses do not revert, and the script writes its record
# under whatever block.chainid it found. Ask the node which chain it is before
# a single transaction goes out, and tell forge the same so it checks too.
EXPECTED_CHAIN_ID="${ARC_TESTNET_CHAIN_ID:-5042002}"
actual_chain_id="$(cast chain-id --rpc-url "$ARC_TESTNET_RPC_URL")"
if [ "$actual_chain_id" != "$EXPECTED_CHAIN_ID" ]; then
  echo "error: $ARC_TESTNET_RPC_URL is chain $actual_chain_id, not $EXPECTED_CHAIN_ID; nothing was broadcast." >&2
  echo "       Fix ARC_TESTNET_RPC_URL in the deployer env file, or set ARC_TESTNET_CHAIN_ID on purpose." >&2
  exit 1
fi

if [ "$INSTALL_SCREENING" = "true" ] && [ "$SCREENER_ADDRESS" = "0x0000000000000000000000000000000000000000" ]; then
  echo "error: INSTALL_SCREENING=true and no SCREENER_ADDRESS; nothing was broadcast." >&2
  echo "       A registry that recognises no screener clears nobody, so every hire and every release" >&2
  echo "       on that hook would revert. Set SCREENER_ADDRESS to the screener's account" >&2
  echo "       (docs/deploy/railway.md), or INSTALL_SCREENING=false to deploy the registry uninstalled." >&2
  exit 1
fi

# VERIFY=0 turns it off when the explorer is down.
VERIFY="${VERIFY:-1}"
verify_args=""
if [ "$VERIFY" = "1" ]; then
  verify_args="--verify --verifier blockscout --verifier-url ${ARCSCAN_API_URL:-https://testnet.arcscan.app/api/}"
fi

BROADCAST="${BROADCAST:-1}"
broadcast_args="--broadcast --slow"
if [ "$BROADCAST" != "1" ]; then
  broadcast_args=""
  verify_args=""
fi

# The record keeps the commit it was compiled from, because that plus
# foundry.toml is what a later verification needs and the explorer cannot
# answer for us.
GIT_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
export GIT_COMMIT

echo "deployer=$DEPLOYER_ADDRESS chain=$actual_chain_id arbiters=$ARBITERS windows=$CHALLENGE_WINDOW/$DISPUTE_WINDOW/$FINALIZE_GRACE minReputationBudget=$MIN_REPUTATION_BUDGET commit=$GIT_COMMIT broadcast=$BROADCAST verify=$VERIFY screening=$INSTALL_SCREENING screeningMaxAge=$SCREENING_MAX_AGE screener=$SCREENER_ADDRESS"
# shellcheck disable=SC2086
forge script script/DeploySettlement.s.sol --rpc-url "$ARC_TESTNET_RPC_URL" --chain "$EXPECTED_CHAIN_ID" $broadcast_args $verify_args -vv "$@"
