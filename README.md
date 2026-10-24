# Pilot

Handing an AI agent a trading key is all or nothing. Pilot is an MCP server that puts limits you set between any agent (tested with Claude Code and Codex CLI; other MCP clients should work) and dreamDEX perps on the Somnia Tokyo testnet: it checks every opening order against your position cap, liquidation distance and allowed markets, checks again on live state when it sends, names a next step the agent can take when it refuses, and writes a receipt for each transaction.

```
agent → plan_order (SDK previews + your policy) → one-shot plan_id → place_order (re-checked on live state) → dreamDEX → journal
```

Built for the dreamDEX Perps Bounty, MVP track, category bots and agents.

## Demo excerpt

Every transaction below was re-read from the RPC; each order hash opens its fill on dreamDEX's Hideki markets explorer.

**Refused, then steered: Codex CLI (OpenAI).** Asked for a 0.0005 BTC short and told to stay under the policy (`evidence/p3-prompt-codex.txt`), Codex planned it and pilot refused it (rule `maxNotionalUsd`), with nothing sent:

> the position this order leaves would be $40.11 notional, above the $25 cap per market
> next safe action: reduce size to at most 0.00031 BTC

Codex planned exactly 0.00031 BTC and it filled. From [`DEMO.md`](DEMO.md) (journal `p3-mcp-run-codex-journal.jsonl`), with a Claude Code round trip under it:

| what | tx | on chain |
|---|---|---|
| short 0.00031 BTC from Codex CLI, the size pilot named; plan_order showed liquidation at 234283.29, 189.78% from mark | [`0x385c1486498227de49b628ab9f1e2dc6f0a44819793fbe45806a39058e018080`](https://smk-dev-markets-explorer-hideki-euw4-uzavbo36ra-ez.a.run.app/tx/0x385c1486498227de49b628ab9f1e2dc6f0a44819793fbe45806a39058e018080) | success @ block 31576050 |
| close short 0.00031 BTC | [`0xc0b61e172fc9ad9940aeec271a9294450caed65668e8b8844acadeeeb9454113`](https://smk-dev-markets-explorer-hideki-euw4-uzavbo36ra-ez.a.run.app/tx/0xc0b61e172fc9ad9940aeec271a9294450caed65668e8b8844acadeeeb9454113) | success @ block 31576075 |
| long 0.1 SOL from Claude Code (IOC), filled 0.1 | [`0x05f85c8c9a560bdb4bb60aa9bfa1b849259e372ea183211e1c8eb739bb1aca56`](https://smk-dev-markets-explorer-hideki-euw4-uzavbo36ra-ez.a.run.app/tx/0x05f85c8c9a560bdb4bb60aa9bfa1b849259e372ea183211e1c8eb739bb1aca56) | success @ block 31569787 |
| close long 0.1 SOL, position after 0 | [`0xff5c0a063851acefb948c9a91217a35fe533d886193dc6bd9d8b174519e04472`](https://smk-dev-markets-explorer-hideki-euw4-uzavbo36ra-ez.a.run.app/tx/0xff5c0a063851acefb948c9a91217a35fe533d886193dc6bd9d8b174519e04472) | success @ block 31569804 |

**The cap is on the position, not the order.** With 0.2 SOL open (planned at $20.54), Claude Code, limited to pilot's tools, planned a 0.1 SOL add: about $10, under the $25 cap on its own. Pilot refused it, with nothing sent:

> the position this order leaves would be $30.80 notional, above the $25 cap per market
> next safe action: no SOL order fits under the cap: the room left is 0.04 SOL, below the SOL minimum 0.1; close_position or a reducing order frees room

The agent planned nothing more and closed: open [`0xf8c951805cdeedee74a95a77414c6494334f8712de076485c84202f643c3336b`](https://smk-dev-markets-explorer-hideki-euw4-uzavbo36ra-ez.a.run.app/tx/0xf8c951805cdeedee74a95a77414c6494334f8712de076485c84202f643c3336b) (block 31928406), close [`0x63b68fd2baffe8db70b8f1e5dc6df236db00336f1d870eb8df2c0c05e8e41324`](https://smk-dev-markets-explorer-hideki-euw4-uzavbo36ra-ez.a.run.app/tx/0x63b68fd2baffe8db70b8f1e5dc6df236db00336f1d870eb8df2c0c05e8e41324) (block 31928458), both success on the RPC re-read (`evidence/p9-undercap-cc.txt`, on the code of commit 85e9c0d, which later commits change only in the `DEMO.md` renderer; outside the `DEMO.md` counts).

**Liquidation distance.** Under a test policy that lifts the cap to $1000 (plans only, nothing sent), a 3 SOL long (6.7x) was refused: "liquidation would sit 12.80% from mark, closer than the 15% minimum" (`DEMO.md`, journal `p6-liquidation-rule-journal.jsonl`).

Brackets and cancels are on chain too, e.g. bracket `0x0a95c4234df79a4f294b44eb8ed77474180a850c2ce3f48e06296ad7ed72397f` (take-profit 105.55, stop-loss 100.43, success @ block 31581911) and its cancel `0x60b69767239c2d5647d7810535d556ebaddfb69c7423384a761658f98579cf31` (success @ block 31581985); see the Brackets and Cancels sections of `DEMO.md` (the explorer shows fills only, so bracket and cancel hashes are not linked; `DEMO.md` re-reads them from the RPC).

## Who it is for

Anyone who wants an AI agent (tested with Claude Code and Codex CLI; other MCP clients should work) to place dreamDEX perps orders without handing it an unguarded key: bot and agent builders, and traders who want to try agent-driven trading on testnet with hard limits they set and a receipt for every order. The agent can plan, place, bracket, close and cancel; no pilot tool can change your limits. The loop: set your limits once, let your agents trade inside them session after session, and share the receipt (`node bin/pilot.mjs journal --card`).

Testnet only: the Somnia Tokyo testnet, as the bounty listing names it; dreamDEX's docs call that chain Hideki (chain id 50383). Use a burner key, never a wallet that holds anything real.

## What pilot adds over handing the agent the SDK

Give an agent the SDK and a key and it can send any order the exchange accepts. A trading form shows a person the numbers; pilot puts your limits between the agent and the exchange:

- **Limits no pilot tool can edit.** They live in a file that no pilot tool writes (`policy` is read-only).
- **The cap is on the position, not the order**, so small orders cannot stack past it (see the 0.1 SOL refusal above).
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

Your limits live in `~/.pilot/policy.json` (or `$PILOT_POLICY`); see `policy.example.json`. Without a file the defaults apply: $25 maximum position notional per market, liquidation at least 15% from mark, BTC/ETH/SOL only, 20 opening orders a day, 1% slippage, plans valid 60 seconds. Keys you leave out of the file keep their default; an unknown key or a bad value makes the file invalid. An invalid file stops `plan_order`, `place_order` and `policy` until you fix the file, with an error that names the file and what is wrong; it never silently falls back. `account` still lists positions and brackets and puts that error under `policy.unreadable`, and `close_position` still closes, at the default 1% slippage bound, saying so in `policyUnreadable` (`cancel_all`, `bracket`, `markets` and `journal` do not read the policy).

## Run it

Needs Node 22 or newer.

```bash
git clone https://github.com/edycutjong/dreamdex-pilot && cd dreamdex-pilot
npm ci
npm test
```

**Try it with no key.** Reads work without a key when `PILOT_ACCOUNT` names a public address; this one is the demo burner (the `from` of every transaction in `DEMO.md`). The MCP Inspector does not hand your shell's environment to the server, so values go in with `-e`. The second call is refused by the default $25 cap, with nothing sent (`evidence/p9-keyless-mcp-cli.txt`):

```bash
npx @modelcontextprotocol/inspector --cli -e PILOT_ACCOUNT=0x440E03bb3AAdBE65D5Bf2Ad7f84A64c509ff438b node bin/pilot.mjs --method tools/call --tool-name account
npx @modelcontextprotocol/inspector --cli -e PILOT_ACCOUNT=0x440E03bb3AAdBE65D5Bf2Ad7f84A64c509ff438b node bin/pilot.mjs --method tools/call --tool-name plan_order --tool-arg market=SOL --tool-arg side=long --tool-arg notional_usd=60
```

**To trade**, the server reads the key from the environment of the process that starts it. Set it in the shell you launch your client from, without echoing it or leaving it in your shell history:

```bash
read -rs PILOT_PRIVATE_KEY && export PILOT_PRIVATE_KEY   # paste a testnet burner key, then Enter (a wallet export without 0x works too)
```

Never paste or screenshot the key, or a terminal where it is exported. Pilot guards its own tools only: a client that also has a shell or file tools could read the key from the environment it inherits or edit your policy file, so trade with those tools off (Claude Code and Codex lines below).

Fund the burner before the first order: STT for gas (dreamDEX's docs: sign in at [app.testnet.dreamdex.io](https://app.testnet.dreamdex.io/perps), Link a Bot with the key's address, then Send it or Top up) and USDso collateral (or the docs' one-time 1,000 paper USDso credit; paper USDso opens positions only in its allowlisted markets, and `plan_order` refuses the others as `voucherBlocked`). `account` shows both balances.

**No LLM, one real round trip** (sends real testnet transactions with your key: plan → place → close over stdio; `--bracket` also arms a bracket and cancels it)

```bash
PILOT_JOURNAL=/tmp/pilot-check.jsonl node scripts/roundtrip-via-mcp.mjs SOL 0.1 --bracket
```

**Claude Code**

```bash
claude mcp add pilot -- node "$PWD/bin/pilot.mjs"
```

For a trading session with pilot's tools only (no shell, no file tools; `--tools ""` goes last). The same flags were checked headless with a throwaway key (`claude -p` with `--allowedTools mcp__pilot` added so pilot's tools run without a prompt): the agent listed only pilot's nine tools and no shell or file tools, could not read the key, and the policy file was not written (`evidence/p9-restricted-cc.txt`):

```bash
mkdir -p ~/.pilot && printf '{"mcpServers":{"pilot":{"command":"node","args":["%s/bin/pilot.mjs"]}}}\n' "$PWD" > ~/.pilot/claude-mcp.json
claude --strict-mcp-config --mcp-config ~/.pilot/claude-mcp.json --tools ""
```

**Codex CLI** (`~/.codex/config.toml`; `env_vars` passes the key through from your shell)

```toml
[mcp_servers.pilot]
command = "node"
args = ["/path/to/dreamdex-pilot/bin/pilot.mjs"]
env_vars = ["PILOT_PRIVATE_KEY"]
```

For a trading session, start Codex with a read-only sandbox and `PILOT_*` kept out of its shell. Codex keeps a shell; in a `codex exec` check with the same two settings and a throwaway key, its shell saw `PILOT_PRIVATE_KEY` unset and its write to the policy file was refused (`evidence/p9-restricted-codex.txt`). Only those two paths were tested:

```bash
codex -s read-only -c 'shell_environment_policy.exclude=["PILOT_*"]'
```

**MCP Inspector** (plan → place needs one server process across calls, which UI mode is meant to keep, not exercised here; the CLI line is for one-shot calls, see Honest limits; no Inspector-placed order is in the receipts; pass environment values with `-e`, as in the no-key lines above)

```bash
npx @modelcontextprotocol/inspector node "$PWD/bin/pilot.mjs"
npx @modelcontextprotocol/inspector --cli node "$PWD/bin/pilot.mjs" --method tools/list
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

X post 3 (planned, below) shares this card.

A bracket that fired on chain (a scripted MCP client, no LLM, outside the `DEMO.md` counts): `scripts/bracket-fire-via-mcp.mjs` opened 0.1 SOL ([`0x41ed25b10f7f032cd287ac96f6e6d4648a05f7926dcceaaa168304d03293fd8c`](https://smk-dev-markets-explorer-hideki-euw4-uzavbo36ra-ez.a.run.app/tx/0x41ed25b10f7f032cd287ac96f6e6d4648a05f7926dcceaaa168304d03293fd8c)), armed a bracket 0.1% either side of mark (`0x2abd71d7ff60eb707898f3c0966da34bd99774e0256cc29419cb14ab850760d4`), and about 10 minutes later the position was flat with no close sent, both legs no longer live on the stop registry, and `cancel_all` had nothing left to cancel (`evidence/p8-r05-bracket-fire.txt`, `evidence/p8-r05-bracket-fire-chain.txt`).


## Safety

- Testnet only; the key comes from `PILOT_PRIVATE_KEY` and is never written to disk by pilot.
- `place_order` only sends a plan that `plan_order` approved, once, within its lifetime, and re-checks the policy, the live position and a fresh liquidation and margin preview when it sends. If another transaction holds the writer first, the plan's expiry and your policy are checked again right before the broadcast.
- The notional cap applies to the position an order leaves in that market, so small orders cannot stack past it. It is measured at the highest price the order can fill at: a buy's limit, a sell's top bid.
- One signing server per key: every MCP client session starts its own pilot server, and the first one to write holds a lock (`~/.pilot/locks`) until it exits. Another server for the same key keeps its read tools and plans, but its writes (orders, closes, brackets, cancels) are refused with nothing sent, so close from the session that holds it (`evidence/p8-r05-signer-lock.txt`: two servers on one key from a scripted MCP client; the second one's `place_order` came back `sent: false` while the first opened and closed).
- Closing and cancelling reduce risk, so your policy limits never block them, and neither does an invalid policy file (see above). A close can still stop, and says why: an empty book on that side, another order on that market already in flight, another pilot server holding the signer lock (below), a failed chain read, or the exchange refusing the IOC (with its decoded reason).

## Honest limits

- Testnet only. Nothing here has run on mainnet. Moving there means changing the chain, contract addresses and indexer in `src/client.mjs`, the network name in `src/server.mjs` and the explorer in `src/demo.mjs`, and re-checking that every market shares one margin bank, which `account` assumes (true for all 21 Hideki markets on 2026-10-24, `evidence/p8-r05-markets-check.txt`, from `scripts/markets-check.mjs`; the assumption is in `src/tools.mjs`).
- One exchange refusal in `DEMO.md` is marked **race injected**: the limit price was lowered in the sender to make the order unfillable, because no natural one could be recorded through pilot's freshness check (12 attempts at a 0.01% slippage bound all filled). The revert and the decoded reason are real; the book did not move.
- A close is a plain IOC order: the SDK's reduce-only intent exists for stop orders (`bracket`) only. If something else shrinks the position while a close is in flight (a bracket firing, another client), the close can open the other side; `close_position` reads the position back and says so (`flipped`).
- No Somnia Reactivity or Somnia Agents yet: pilot reads and writes through the markets SDK only.
- If the SDK fails its own replay of a reverted transaction, pilot returns code `unknown` and says the reason could not be read, rather than guessing one.
- A crash between a landed send and its journal row is not counted toward the daily cap.
- Pilot guards its own tools, not the rest of the agent. An agent that also has shell or file tools (Claude Code and Codex CLI do) could edit the policy file or read the key from the environment it inherits. For a trading session, turn those tools off or fence them in (Run it: Claude Code with no built-in tools; Codex with a read-only sandbox and `PILOT_*` kept out of its shell, which still leaves it a shell; each checked with a throwaway key) and keep the burner small.
- Plans live in the server's memory only, so restarting the server drops them.
- At the default $25 cap, an account holding more than $25 of USDso stays under 1x leverage (the test burner held about $49.50, `evidence/p8-r05-bracket-fire.txt`), where a long has no reachable liquidation price, so the 15% liquidation rule did not bind in the agent runs. `DEMO.md` shows it refusing a 6.7x plan (liquidation 12.8% from mark) under a test policy that lifts the cap, plans only.
- MCP Inspector's CLI mode starts a new server for every call, so a `plan_id` from `plan_order` is gone by the next call (`evidence/p3-mcp-cli-client.txt`); its UI mode is meant to keep one server process while connected (not exercised here).
- `markets` and `account` do not flag markets closed to paper USDso; `plan_order` refuses them (`voucherBlocked`) from the exchange's own preview.

## X posts

Posts about pilot that tag @DreamDEXSomnia:

1. _link to post 1 goes here_
2. _link to post 2 goes here_
3. _link to post 3 goes here_

## License

MIT
