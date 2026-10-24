// Read-only: STT gas balance, USDso margin, voucher eligibility for the configured account.
import { formatUnits, createPublicClient, http } from "viem";
import { readMarkets, accountAddress, json, CHAIN } from "../src/client.mjs";
const m = readMarkets();
const account = accountAddress();
const btc = (await m.client.listPerpMarkets()).find((p) => p.baseSymbol === "BTC");
const [stt, ma, voucher] = await Promise.all([
  createPublicClient({ chain: CHAIN, transport: http() }).getBalance({ address: account }),
  m.client.getMarginAccount(btc.marginBank, account),
  m.client.getPerpVoucherEligibility(btc.marginBank, account).catch((e) => ({ error: e.name })),
]);
console.log(json({ account, stt: stt == null ? "n/a" : formatUnits(stt, 18), unlockedUsdso: formatUnits(ma.unlockedCollateralBalance, 18), activePools: ma.activePerpPools.length, voucher }));
process.exit(0);
