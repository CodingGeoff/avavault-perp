# AvaVault Perp

**Avalanche Buildathon submission — Track: Onchain Finance & Trading**

Turns a real-world-asset (RWA) yield token into usable perpetual-trading margin,
without forcing the holder to sell it first. Priced live by reading a real DEX pool
on Avalanche Fuji — not a hardcoded number.

> One sentence: RWA tokens are mostly "dead" on-chain (hold it, collect yield, nothing
> else); perp traders need stablecoin margin. If an RWA token has even a thin DEX pool,
> it has a price any contract can read in real time — so we built a margin vault that
> reads that price, applies a haircut, and lets the token be used as collateral directly.

## What's in this repo

| Folder | What it is | Role in this submission |
| --- | --- | --- |
| [`hackathon-onchain-finance/`](./hackathon-onchain-finance) | **The actual hackathon submission.** `RWAToken.sol`, `MultiCollateralVault.sol` / `MultiCollateralVaultV2.sol` (TWAP pricing + EIP-712 signature-gated settlement), Foundry tests (fork-tested against real Fuji state), deployment scripts, the pitch deck, and both narrated demo videos. | **Start here** — full README, architecture, deployed contract addresses, and real on-chain proof are in [`hackathon-onchain-finance/README.md`](./hackathon-onchain-finance/README.md). |
| [`task7-perp-dex/`](./task7-perp-dex) | A perpetual-exchange matching engine + vault (order book, WebSocket API, EIP-712 settlement) built as an earlier, standalone piece of infrastructure. | This is the system actually shown live in the demo video's trading-engine segment (connect wallet → place order → real on-chain settlement → Snowtrace proof), and it's the "operator-settlement" trust model that `MultiCollateralVault.settle()` reuses. It is **not itself the hackathon deliverable** — see the Project Continuity note below. |

## Everything here is really deployed — not mocked

All contracts referenced in this repo are live on Avalanche Fuji testnet, with real
deployment and settlement transactions verifiable on Snowtrace. Addresses, transaction
hashes, and the exact proof for each security property (TWAP resists same-block
manipulation; forged signatures are rejected on-chain) are documented in
[`hackathon-onchain-finance/README.md`](./hackathon-onchain-finance/README.md).

## Project continuity: what's new in this hackathon vs. pre-existing

This project fuses three smart-contract techniques that were each originally built as
separate, earlier coursework exercises (DEX-oracle pricing, RWA tokenization, and an
off-chain-matching/on-chain-settled exchange vault — all predating this hackathon's
submission window). **What was newly designed, written, and deployed during the
hackathon** is the fusion itself:

- `MultiCollateralVault.sol` and `MultiCollateralVaultV2.sol` — new contracts that combine
  the three techniques into one margin vault.
- The TWAP-oracle collateral valuation and the EIP-712 signature-gated settlement, both
  integrated into this specific vault and proven on-chain against real attack attempts.
- All Fuji deployments, the deposit/settlement transactions, the pitch deck, and both demo
  videos (with an originally-synthesized, royalty-free background score).

Full disclosure and a component-by-component breakdown is in the submission form's
"Project Continuity & Development" section and mirrored in
[`hackathon-onchain-finance/README.md`](./hackathon-onchain-finance/README.md).

## Live demo

- **Frontend (static, always on):** https://codinggeoff.github.io/avavault-perp/
- **API / matching engine / on-chain settlement (free-tier, may cold-start after idle):**
  deployed via the `render.yaml` blueprint in this repo — see [`DEPLOY.md`](./DEPLOY.md)
  for the one-time setup steps and the live URL once deployed.
- **Contracts on Avalanche Fuji testnet (permanent, always verifiable):**
  [`RWAToken`](https://testnet.snowtrace.io/address/0x1cC1650E2Da5c2357c811B90187D1022b70B70Ad) ·
  [`MultiCollateralVault`](https://testnet.snowtrace.io/address/0x9128AE5F8cf51eB35A69C29c55B07A7776603b0B) ·
  [`MultiCollateralVaultV2`](https://testnet.snowtrace.io/address/0xb999cb61A4fb2FE71d1C5FBA7aD506F619dD7884) ·
  [`VaultV2` (perp matching demo)](https://testnet.snowtrace.io/address/0x0425352bc3c5293D5629c27525969439Ab9C27b5)

## Running it locally

See the Quick Start / testing sections in each subfolder's own README:
- [`hackathon-onchain-finance/README.md`](./hackathon-onchain-finance/README.md) — Foundry tests, deployment script.
- [`task7-perp-dex/README.md`](./task7-perp-dex/README.md) — matching engine tests, server, demo UI.

Scripts under `task7-perp-dex/demo/`, `task7-perp-dex/server/*test*.mjs`, and
`hackathon-onchain-finance/contracts/live_settle_v2_proof.mjs` need throwaway Fuji
testnet private keys passed via environment variables (see the `.env.example` file next
to each script) — **never put a key that holds real funds in these.**

## License

MIT (see individual files for any third-party license notices, e.g. the vendored
`ethers.js` UMD build).
