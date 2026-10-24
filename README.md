# Pilot

An MCP server that lets an AI agent trade dreamDEX perps on Somnia testnet, with limits and a receipt for every order.

Work in progress. Today it has one tool:

| Tool | What it does |
|---|---|
| `markets` | Lists the dreamDEX perp markets with mark price, max leverage, minimum size, lot and tick size, funding and open interest. |

## Run it

```bash
git clone https://github.com/edycutjong/dreamdex-pilot && cd dreamdex-pilot
npm ci
npm test
claude mcp add pilot -- node "$PWD/bin/pilot.mjs"
```

Testnet only (Somnia Hideki, chain 50383). Use a burner key, never a wallet that holds anything real.

`scripts/spike.mjs` places one minimum-size SOL buy and closes it, with the planning reads first
(`getMaxPerpOrderSize`, `previewPerpOrderMargin`, `previewPerpLiquidationPrice`). It reads the key from
`PILOT_PRIVATE_KEY` and writes what happened to `evidence/`.

## License

MIT
