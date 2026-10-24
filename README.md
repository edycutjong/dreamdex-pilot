# Pilot

An MCP server that lets an AI agent trade dreamDEX perps on Somnia testnet: it plans every order first, shows the liquidation price, refuses what breaks your limits, and writes a receipt for each transaction.

Testnet only (Somnia Hideki, chain 50383). Use a burner key, never a wallet that holds anything real.

## Tools

| Tool | What it does |
|---|---|
| `markets` | Lists the perp markets with mark price, max leverage, minimum size, lot and tick size, funding and open interest. |
| `account` | Reads the account live: STT for gas, USDso collateral, margin status, open positions with entry, mark and unrealized PnL, pending brackets, policy headroom. |
| `plan_order` | Plans a market-taking (IOC) order without sending it: max size, margin, projected liquidation price, and a verdict against your policy. An ok plan gets a short-lived one-shot `plan_id`. |
| `place_order` | Sends an ok plan as a real transaction. Refuses an unknown, expired, used or stale plan, re-checks the policy and re-runs the liquidation and margin previews on live state. If the exchange itself refuses, the result says `refused_by: "exchange"` with the decoded reason. |
| `close_position` | Closes the whole position in a market from the live on-chain size. Never blocked by policy. Says when a bracket on that market is still armed (it would act on your next position there) and when something else shrank the position mid-close so the close flipped it. |
| `bracket` | Arms a linked take-profit and stop-loss (one cancels the other) on an open position. Reduce-only, held on chain. |
| `cancel_all` | Cancels pending brackets and any resting orders; brackets are confirmed on chain, not only from the indexer. |
| `policy` | Shows your limits. Read-only: no tool can change them. |
| `journal` | Reads the append-only journal of every plan, refusal and transaction. |

Your limits live in `~/.pilot/policy.json` (or `$PILOT_POLICY`); see `policy.example.json`. Without a file the defaults apply: $25 maximum position notional per market, liquidation at least 15% from mark, BTC/ETH/SOL only, 20 opening orders a day, 1% slippage, plans valid 60 seconds. An invalid file stops the server's trading tools instead of silently falling back.

## Run it

```bash
git clone https://github.com/edycutjong/dreamdex-pilot && cd dreamdex-pilot
npm ci
npm test
```

The server reads the key from the environment of the process that starts it. Export it in the shell you launch your client from (reads work without a key if you set `PILOT_ACCOUNT` to a public address):

```bash
export PILOT_PRIVATE_KEY=0x...   # testnet burner key
```

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

**MCP Inspector** (UI mode runs one server process for the session; its CLI mode starts a new server for every call, so a `plan_id` from `plan_order` does not exist in the next call, see `evidence/p3-mcp-cli-client.txt`)

```bash
npx @modelcontextprotocol/inspector node "$PWD/bin/pilot.mjs"
npx @modelcontextprotocol/inspector --cli node "$PWD/bin/pilot.mjs" --method tools/list
```

## Receipts

`node bin/pilot.mjs journal --md` renders the journal as a document. [`DEMO.md`](DEMO.md) is that output for the recorded runs: real orders, closes, a bracket, cancels, and refusals, each transaction re-read from the RPC (`scripts/build-demo.sh`). The raw runs and journals are in [`evidence/`](evidence/).

One exchange refusal in `DEMO.md` is marked **race injected**: the limit price was lowered in the sender to make the order unfillable, because pilot's freshness check leaves almost no window for a natural one (12 attempts at a 0.01% slippage bound all filled). The revert and the decoded reason are real; the book did not move.

## Safety

- Testnet only; the key comes from `PILOT_PRIVATE_KEY` and is never written to disk by pilot.
- `place_order` only sends a plan that `plan_order` approved, once, within its lifetime, and re-checks the policy, the live position and a fresh liquidation and margin preview when it sends.
- The notional cap applies to the position an order leaves in that market, so small orders cannot stack past it.
- Closing and cancelling reduce risk, so policy never blocks them.

## License

MIT
