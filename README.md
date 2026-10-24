# Pilot

Handing an AI agent a trading key is all or nothing. Pilot is an MCP server that sits between any agent (tested with Claude Code and Codex CLI; other MCP clients should work) and dreamDEX perps on Somnia testnet: it plans every opening order, shows the liquidation price, refuses what breaks your limits, and writes a receipt for each transaction.

```
agent → plan_order (SDK previews + your policy) → one-shot plan_id → place_order (re-checked on live state) → dreamDEX → journal
```

Built for the dreamDEX Perps Bounty, MVP track, category bots and agents.

## Demo excerpt

From [`DEMO.md`](DEMO.md), all re-read from the RPC; each hash opens its fill on dreamDEX's Hideki markets explorer. A real order and its close, driven by Claude Code, and an order from a second client:

| what | tx | on chain |
|---|---|---|
| long 0.1 SOL (IOC), filled 0.1 | [`0x05f85c8c9a560bdb4bb60aa9bfa1b849259e372ea183211e1c8eb739bb1aca56`](https://smk-dev-markets-explorer-hideki-euw4-uzavbo36ra-ez.a.run.app/tx/0x05f85c8c9a560bdb4bb60aa9bfa1b849259e372ea183211e1c8eb739bb1aca56) | success @ block 31569787 |
| close long 0.1 SOL, position after 0 | [`0xff5c0a063851acefb948c9a91217a35fe533d886193dc6bd9d8b174519e04472`](https://smk-dev-markets-explorer-hideki-euw4-uzavbo36ra-ez.a.run.app/tx/0xff5c0a063851acefb948c9a91217a35fe533d886193dc6bd9d8b174519e04472) | success @ block 31569804 |
| short 0.00031 BTC from Codex CLI (OpenAI); plan_order first showed liquidation at 234283.29, 189.78% from mark | [`0x385c1486498227de49b628ab9f1e2dc6f0a44819793fbe45806a39058e018080`](https://smk-dev-markets-explorer-hideki-euw4-uzavbo36ra-ez.a.run.app/tx/0x385c1486498227de49b628ab9f1e2dc6f0a44819793fbe45806a39058e018080) | success @ block 31576050 |

And a refusal, with nothing sent. With 0.2 SOL already open, Claude Code was told to request $60 more SOL (scripted prompt, `evidence/p6-prompt-cc.txt`) and planned it (an order of $59, sized at 0.57 SOL). The cap is on the position the order leaves, so pilot (rule `maxNotionalUsd`) answered:

> the position this order leaves would be $79.80 notional, above the $25 cap per market
> next safe action: no SOL order fits under the cap: the room left is 0.04 SOL, below the SOL minimum 0.1; close_position or a reducing order frees room

The agent planned nothing more. Brackets and cancels are on chain too, e.g. bracket `0x0a95c4234df79a4f294b44eb8ed77474180a850c2ce3f48e06296ad7ed72397f` (take-profit 105.55, stop-loss 100.43, success @ block 31581911) and its cancel `0x60b69767239c2d5647d7810535d556ebaddfb69c7423384a761658f98579cf31` (success @ block 31581985); see the Brackets and Cancels sections of `DEMO.md`.

## Who it is for

Anyone who wants an AI agent (tested with Claude Code and Codex CLI; other MCP clients should work) to place dreamDEX perps orders without handing it an unguarded key: bot and agent builders, and traders who want to try agent-driven trading on testnet with hard limits they set and a receipt for every order. The agent can plan, place, bracket, close and cancel; no pilot tool can change your limits. The loop: set your limits once, let your agents trade inside them session after session, and share the receipt (`pilot journal --card`).

Testnet only: Somnia Hideki (chain 50383). the bounty listing calls it the "Somnia Tokyo testnet". Use a burner key, never a wallet that holds anything real.

## What pilot adds over handing the agent the SDK

Give an agent the SDK and a key and it can send any order the exchange accepts. A trading form shows a person the numbers; pilot puts your limits between the agent and the exchange:

- **Limits no pilot tool can edit.** They live in a file that no pilot tool writes (`policy` is read-only).
- **The cap is on the position, not the order**, so small orders cannot stack past it (see the $60 refusal above).
- **Checked twice.** The policy, the liquidation distance and the margin are checked when the order is planned and again, on live state, when it is sent. A plan is one-shot and expires (60 seconds by default).
- **A next step, not just a no.** A refusal names the rule and a next safe action the agent can act on ("plan at least 0.1 SOL", "pick one of BTC, ETH, SOL"), and says so when no order fits.
- **It carries over between sessions.** Limits and the journal live in `~/.pilot`, so every new agent session starts from the same limits, the daily order cap counts across sessions and restarts, and the journal grows into one record of everything your agents did there.

## Tools

| Tool | What it does |
|---|---|
| `markets` | Lists the perp markets with mark price, max leverage, minimum size, lot and tick size, funding and open interest. |
| `account` | Reads the account live: STT for gas, USDso collateral, margin status, open positions with entry, mark and unrealized PnL, pending brackets, your policy limits and today's order count. |
| `plan_order` | Plans a market-taking order (IOC: fills now or not at all, never rests) without sending it: max size, margin, projected liquidation price, and a verdict against your policy. An ok plan gets a short-lived one-shot `plan_id`. |
| `place_order` | Sends an ok plan as a real transaction. Refuses an unknown, expired, used or stale plan, re-checks the policy and re-runs the liquidation and margin previews on live state. The limit price is re-derived from the live book and your slippage limit, and can only tighten. A reused `plan_id` is told what became of it (sent, refused, expired, or unknown) for 10 minutes after the plan expires. If the exchange itself refuses, the result says `refused_by: "exchange"` with the decoded reason when the SDK can read it. |
| `close_position` | Closes the whole position in a market from the live on-chain size. Never blocked by policy. Says when a bracket on that market is still armed (it would act on your next position there) and when something else shrank the position mid-close so the close flipped it. |
| `bracket` | Arms a linked take-profit and stop-loss (one cancels the other) on an open position. Reduce-only, held on chain. |
| `cancel_all` | Cancels pending brackets and any resting orders; brackets are confirmed on chain, not only from the indexer. If the journal cannot be read it still cancels what the indexer lists and says so (`journalUnreadable`). |
| `policy` | Shows your limits. Read-only: no tool can change them. |
| `journal` | Reads the append-only journal of every plan, refusal and transaction. |

Your limits live in `~/.pilot/policy.json` (or `$PILOT_POLICY`); see `policy.example.json`. Without a file the defaults apply: $25 maximum position notional per market, liquidation at least 15% from mark, BTC/ETH/SOL only, 20 opening orders a day, 1% slippage, plans valid 60 seconds. Keys you leave out of the file keep their default; an unknown key or a bad value makes the file invalid. An invalid file stops `plan_order`, `place_order`, `account` and `policy` until you fix the file, with an error that names the file and what is wrong; it never silently falls back. `close_position` still closes, at the default 1% slippage bound, and says so in `policyUnreadable` (`cancel_all`, `bracket`, `markets` and `journal` do not read the policy).

## Run it

Needs Node 22 or newer.

```bash
git clone https://github.com/edycutjong/dreamdex-pilot && cd dreamdex-pilot
npm ci
npm test
```

The server reads the key from the environment of the process that starts it. Export it in the shell you launch your client from (reads work without a key if you set `PILOT_ACCOUNT` to a public address):

```bash
export PILOT_PRIVATE_KEY=0x...   # testnet burner key (a wallet export without 0x works too)
```

Never paste or screenshot the key, or a terminal where it is exported.

Fund the burner before the first order: STT for gas (dreamDEX's docs: sign in at [app.testnet.dreamdex.io](https://app.testnet.dreamdex.io/perps), Link a Bot with the key's address, then Send it or Top up) and USDso collateral (or the docs' one-time 1,000 paper USDso credit; paper USDso opens positions only in its allowlisted markets, and `plan_order` refuses the others as `voucherBlocked`). `account` shows both balances.

**Claude Code**

```bash
claude mcp add pilot -- node "$PWD/bin/pilot.mjs"
```

**Codex CLI** (`~/.codex/config.toml`; `env_vars` passes the key through from your shell)

```toml
[mcp_servers.pilot]
command = "node"
args = ["/path/to/dreamdex-pilot/bin/pilot.mjs"]
env_vars = ["PILOT_PRIVATE_KEY"]
```

**MCP Inspector** (plan → place needs UI mode; the CLI line is for one-shot calls, see Honest limits; no Inspector-placed order is in the receipts)

```bash
npx @modelcontextprotocol/inspector node "$PWD/bin/pilot.mjs"
npx @modelcontextprotocol/inspector --cli node "$PWD/bin/pilot.mjs" --method tools/list
```

**No LLM, one real round trip** (sends real testnet transactions with your key: plan → place → close over stdio; `--bracket` also arms a bracket and cancels it)

```bash
PILOT_JOURNAL=/tmp/pilot-check.jsonl node scripts/roundtrip-via-mcp.mjs SOL 0.1 --bracket
```

## Receipts

`node bin/pilot.mjs journal --md` renders the journal as a document. [`DEMO.md`](DEMO.md) is that output for the recorded runs: real orders, closes, a bracket, cancels, and refusals, each transaction re-read from the RPC (`scripts/build-demo.sh`). The raw runs and journals are in [`evidence/`](evidence/).

`node bin/pilot.mjs journal --card` prints a short receipt of your own journal to share, tagging @DreamDEXSomnia: counts (refusals split into your policy limits and pilot's own checks, such as a size under the market minimum or an expired plan), your latest fill on the explorer, and a link back here.
For the journals behind `DEMO.md` it prints:

```text
My dreamDEX perps receipts via pilot (Somnia testnet) @DreamDEXSomnia:
9 orders opened, 9 closed, 2 brackets, 15 refused with nothing sent (11 by my limits).
Latest fill: https://smk-dev-markets-explorer-hideki-euw4-uzavbo36ra-ez.a.run.app/tx/0x664861a4af6429d74637f5f5be853dee21a6a935eae9e01913a485f0044c85a5
https://github.com/edycutjong/dreamdex-pilot
```

A bracket that fired on chain (a scripted MCP client, no LLM, outside the `DEMO.md` counts): `scripts/bracket-fire-via-mcp.mjs` opened 0.1 SOL (`0x41ed25b10f7f032cd287ac96f6e6d4648a05f7926dcceaaa168304d03293fd8c`), armed a bracket 0.1% either side of mark (`0x2abd71d7ff60eb707898f3c0966da34bd99774e0256cc29419cb14ab850760d4`), and about 10 minutes later the position was flat with no close sent, both legs no longer live on the stop registry, and `cancel_all` had nothing left to cancel (`evidence/p8-r05-bracket-fire.txt`, `evidence/p8-r05-bracket-fire-chain.txt`).

One exchange refusal in `DEMO.md` is marked **race injected**: the limit price was lowered in the sender to make the order unfillable, because pilot's freshness check leaves almost no window for a natural one (12 attempts at a 0.01% slippage bound all filled). The revert and the decoded reason are real; the book did not move.

## Safety

- Testnet only; the key comes from `PILOT_PRIVATE_KEY` and is never written to disk by pilot.
- `place_order` only sends a plan that `plan_order` approved, once, within its lifetime, and re-checks the policy, the live position and a fresh liquidation and margin preview when it sends. If another transaction holds the writer first, the plan's expiry and your policy are checked again right before the broadcast.
- The notional cap applies to the position an order leaves in that market, so small orders cannot stack past it. It is measured at the highest price the order can fill at: a buy's limit, a sell's top bid.
- One signing server per key: every MCP client session starts its own pilot server, and the first one to write holds a lock (`~/.pilot/locks`) until it exits. Another server for the same key keeps its read tools and plans, but its writes (orders, closes, brackets, cancels) are refused with nothing sent, so close from the session that holds it (`evidence/p8-r05-signer-lock.txt`: two servers on one key from a scripted MCP client; the second one's `place_order` came back `sent: false` while the first opened and closed).
- Closing and cancelling reduce risk, so your policy limits never block them, and neither does an invalid policy file (see above). A close can still stop, and says why: an empty book on that side, another order on that market already in flight, another pilot server holding the signer lock (below), a failed chain read, or the exchange refusing the IOC (with its decoded reason).

## Honest limits

- Testnet only. Nothing here has run on mainnet. Moving there means changing the chain, contract addresses and indexer in `src/client.mjs`, the network name in `src/server.mjs` and the explorer in `src/demo.mjs`, and re-checking that every market shares one margin bank, which `account` assumes (true for all 21 Hideki markets on 2026-10-24, `evidence/p8-r05-markets-check.txt`, from `scripts/markets-check.mjs`; the assumption is in `src/tools.mjs`).
- No Somnia Reactivity or Somnia Agents yet: pilot reads and writes through the markets SDK only.
- If the SDK fails its own replay of a reverted transaction, pilot returns code `unknown` and says the reason could not be read, rather than guessing one.
- A crash between a landed send and its journal row is not counted toward the daily cap.
- Pilot guards its own tools, not the rest of the agent. An agent that also has shell or file tools (Claude Code and Codex CLI do) could edit the policy file or read the key from the environment it inherits. For a trading session, deny the client's shell and file tools (both clients have permission settings) and keep the burner small.
- Plans live in the server's memory only, so restarting the server drops them.
- At the default $25 cap a small account stays under 1x leverage, where a long has no reachable liquidation price, so the 15% liquidation rule did not bind in the agent runs. `DEMO.md` shows it refusing a 6.7x plan (liquidation 12.8% from mark) under a test policy that lifts the cap, plans only.
- MCP Inspector's CLI mode starts a new server for every call, so a `plan_id` from `plan_order` is gone by the next call (`evidence/p3-mcp-cli-client.txt`); its UI mode is meant to keep one server process while connected (not exercised here).
- `markets` and `account` do not flag markets closed to paper USDso; `plan_order` refuses them (`voucherBlocked`) from the exchange's own preview.

## X posts

Posts about pilot that tag @DreamDEXSomnia:

1. _link to post 1 goes here_
2. _link to post 2 goes here_
3. _link to post 3 goes here_

## License

MIT
