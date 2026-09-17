# Where Square stands, September 2026

A market assessment and a roadmap, written on 17 September 2026, the day after
Arc mainnet launched. It answers two questions: does this project make sense, and
what is missing. Every figure in it is sourced at the end.

## What moved

**Arc mainnet went live on 16 September 2026.** Its founding validators are
BlackRock, DTCC, ICE, Mastercard, Visa, Standard Chartered, MoneyGram, SBI,
Sumitomo, Galaxy and Worldpay. Gas is USDC. Circle describes Arc as "the first
blockchain designed from genesis for AI agents as economic actors" and shipped
Agent Stack the same day: Agent Wallets, an Agent Marketplace, Nanopayments,
Circle CLI and Circle Skills. Testnet did not close. Mainnet is chain 1243,
testnet remains 5042002, and a hardcoded chain id now needs a second branch
rather than an edited value.

**In agent payments the narrative is growing faster than the usage.** x402 has
165 million transactions and 69,000 active agents, but on-chain data puts real
commerce at roughly 28,000 dollars a day, with about half of activity classified
as gamified. Through late 2025 the speculative share rose from under 6 per cent
in October to 67 per cent in December. The infrastructure arrived first; the
economy it is meant to carry has not.

**Regulation is moving toward Square rather than away from it.** Under the GENIUS
Act, FinCEN and OFAC published a proposed rule on 8 April 2026 treating permitted
payment stablecoin issuers as financial institutions under the Bank Secrecy Act,
with customer identification, anti money laundering and sanctions compliance
programmes required. The industry conversation is shifting from know your
customer to know your agent: verifiable identities for financial bots, tied to
legal entities.

**And the layer Square writes its reputation records into has been measured, and
it is mostly empty.** An empirical study of the ERC-8004 ecosystem found that of
32,343 agents registered on Ethereum only 3 per cent expose a valid registration
file; that 98.7 per cent of feedback on Ethereum carries no payment proof and no
task linkage, 100 per cent on BNB Smart Chain and 99.3 per cent on Base; that the
median record costs 0.0027 dollars to write, against a median agent payment volume
259 times larger; and that on Base 90.6 per cent of reviewers share funding
provenance with other reviewers.

## Does the project make sense

Yes, and more so than a week ago. Three reasons, each measurable.

**The architecture already occupies what the literature calls future work.**
"Compliance-Aware Agentic Payments on Stablecoin Rails" proposes exactly Square's
shape: a policy registry, escrow, dispute resolution. It does not use zero
knowledge proofs, relying on deterministic on-chain checks, and it lists
privacy-preserving compliance verification as an open problem. Square's
`ComplianceModule`, its Groth16 verifier and its Poseidon commitment are an
answer to that open problem.

**The evidence gap is real and Square closes it structurally.** The study's third
finding is that ratings carry no verifiable interaction. Square's hook writes its
validation record inside `complete`, in the transaction that credits the payee,
and binds it to the job through the validation request opened at submit. The
study's fourth finding is that a record costs fractions of a cent to forge; in
Square, producing one requires funding a job, waiting out the challenge window and
settling it. That is a property of the contract, not a claim in a brochure.

**Two of Arc's own four stated frontiers describe Square.** Arc's request for
builders names outcome marketplaces under the agentic economy, and bounded agents
with risk limits under intelligent accounts. `PolicyRegistry.dailyLimit` together
with `spentToday` is the second one exactly.

Three things should be said plainly against that.

Competition now comes from the chain's operator. Circle Agent Stack ships agent
wallets, an agent marketplace and nanopayments. Square has no business in that
territory and should not enter it; Square's territory is escrow, dispute and
mandate, none of which Agent Stack addresses.

There is an incumbent on the same primitive. Virtuals Protocol's Agent Commerce
Protocol is the principal production deployment of ERC-8183, live on Base and
Arbitrum, with 12.3 million commerce memos. Square has no users. The difference is
the compliance gate, bonded arbitration and the receivable market, but a
difference is only a difference once somebody uses it.

And the hardest of the three: **no compliance claim can be made today, because the
ceremony has not been held.** The README says so itself, in the words that a single
machine could forge a proof for any statement. That is honesty rather than a
defect, but it is also the one thing standing in front of an institutional
conversation.

## What is missing, in order

| # | Gap | Why it matters | Where it is written |
|---|---|---|---|
| 1 | The phase 2 ceremony has not been held (#16) | The whole compliance claim rests on this key and is void without it | `docs/disclosure/zk-setup-status.md`, `docs/ceremony/README.md` |
| 2 | The validation record did not carry the payment | The evidence claim was half built: task linkage without payment proof | `contracts/src/SquareHook.sol`, closed by #405 |
| 3 | No user has ever used it | Against 12.3 million memos elsewhere, Square has demonstration transactions | `docs/deploy/lifecycle-5042002-2026-09-09.md` |
| 4 | The shared stack is 21 selectors behind and no address is verified | Deploying the app or the keeper from `main` against it would revert | `docs/deploy/README.md` section 5 |
| 5 | No service is hosted | Railway is decided, the project does not exist, nothing runs continuously | `docs/decisions/service-hosting.md` |
| 6 | Nothing is published to npm | The only installation path is clone and build | `docs/decisions/distribution-channel.md` |
| 7 | The circuit's fifth rule binds nothing | `payment_category` is the operator's own statement with nothing on chain to check it against | `circuits/README.md` |
| 8 | Privacy rests on one operator-held salt | A weak `policy_salt` recovered a 25 USDC ceiling in 50 tries and 10 ms | `circuits/README.md` |

Items 7 and 8 are already written down in the repository. That is the right place
for them: a reader who learns a limitation from the project has been told
something, rather than having caught it.

## The roadmap

Four goals, in one order. They are not parallel, and the order follows from one
observation:

> The ceremony has the longest lead time and needs no code, while the evidence
> claim can be made in full without it. So the ceremony starts now and runs in the
> background, the product reaches a network on the strength of its evidence, and
> the grant application carries the proof of both.

### A. Evidence, the new headline claim

The claim is: **every reputation record Square writes has been paid for. The
record exists because money moved, and forging one costs the job it names.**

- **A1, done in #405.** `SquareHook`'s `responseHash` commits to the settlement:
  the job, the payee, the amount the kernel credited, the token, the screening
  commitment and the two check outcomes. A record is now written for every settled
  job rather than only for gated ones, the response follows the money, and the tag
  moved to `square.settlement`.
- **A2, done in #405.** The preimage is emitted as `EvidenceRecorded`, because a
  commitment nobody can recompute is not evidence.
- **A3.** The indexer gains an endpoint serving an agent's payment-backed record
  set, with amounts, transaction hashes and preimages. `/jobs/provider/:address`
  exists but is a job list, not an evidence feed.
- **A4, done in #405.** `npm run check:evidence` reads a job's event, the
  registry's stored hash and the kernel's own settlement facts, and requires all
  three to agree.
- **A5, done in #405.** `docs/design/evidence-records.md` defines the tag, the
  commitment and the answer to each of the study's four findings.
- **A6.** The README and the site lead with the claim.

### B. Arc mainnet, chain 1243

- **B1.** Redeploy the testnet first (#324). It closes the 21 selector gap and
  rehearses the mainnet run.
- **B2.** `packages/core/src/deployments.ts` gains a second branch: a chain id, a
  network profile and a deployment record. The file is already keyed by chain id,
  so this is an addition rather than an edit, and the testnet entries stay because
  testnet stays.
- **B3.** Mainnet launches with the compliance gate off. Escrow, the challenge
  window, bonded arbitration, the receivable market and the evidence records all
  work without it, and turning it on before the ceremony would contradict the
  repository's own disclosure.
- **B4.** Ownership moves to a Safe, which the README already requires before
  mainnet.

### C. The ceremony, starting now

Coordination rather than code, and the longest lead time of anything here. The
checklist in `docs/ceremony/README.md` has open boxes: participant count,
invitation list, at least one institutional participant, window open and close,
beacon round, publication location. The announcement is drafted with four
bracketed values. Arc's new institutional ecosystem is a real source for that
invitation list.

### D. Grant and standards

- **D1.** Arc Developer Grants and the Builders Fund are strongest once A and B
  have evidence behind them: an outcome marketplace running on a network,
  payment-backed reputation records, and a ceremony with a date.
- **D2.** Two standards contributions. The evidence record written up as an
  ERC-8004 profile, which answers the study's canonical tag and verifiable
  interaction gaps directly. And the compliance gate described as an ERC-8183
  extension, where the academic gap gives a ready frame.

## Sources

- Circle, Arc mainnet launch: https://www.circle.com/pressroom/circle-launches-arc-mainnet-an-economic-operating-system-for-the-internet
- Circle Agent Stack: https://www.circle.com/blog/introducing-circle-agent-stack-financial-infrastructure-for-the-agentic-economy
- Arc, request for builders: https://www.arc.io/blog/the-unfinished-business-of-finance-machine-commerce-and-global-money
- Arc mainnet chain id, and testnet continuing: https://trustswap.com/arc/mainnet-live
- Chainalysis on x402 adoption: https://www.chainalysis.com/blog/x402-agentic-payments-adoption/
- CoinDesk on x402 demand: https://www.coindesk.com/markets/2026/03/11/coinbase-backed-ai-payments-protocol-wants-to-fix-micropayment-but-demand-is-just-not-there-yet
- Can Trustless Agents Be Trusted? An Empirical Study of the ERC-8004 Decentralized AI Agent Ecosystem, arXiv:2606.26028: https://arxiv.org/abs/2606.26028
- Compliance-Aware Agentic Payments on Stablecoin Rails, arXiv:2605.00071: https://arxiv.org/pdf/2605.00071
- ERC-8183, Agentic Commerce: https://eips.ethereum.org/EIPS/eip-8183
- Virtuals Protocol, Agent Commerce Protocol: https://whitepaper.virtuals.io/about-virtuals/agent-commerce-protocol-acp
- Holland and Knight on the FinCEN and OFAC proposal: https://www.hklaw.com/en/insights/publications/2026/04/fincen-and-ofac-propose-aml-sanctions-rules-for-stablecoin-issuers
- Federal Register, permitted payment stablecoin issuer programme requirements: https://www.federalregister.gov/documents/2026/04/10/2026-06963/permitted-payment-stablecoin-issuer-anti-money-launderingcountering-the-financing-of-terrorism
