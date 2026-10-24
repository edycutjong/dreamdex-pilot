import { createPublicClient, http } from "viem";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";

const txHashes = [
  "0x05f85c8c9a560bdb4bb60aa9bfa1b849259e372ea183211e1c8eb739bb1aca56",
  "0x0a95c4234df79a4f294b44eb8ed77474180a850c2ce3f48e06296ad7ed72397f",
  "0x1811edb9319f2096eb6d2dd9536cbb9091642b3277e79cf7afa451d15ebc6f83",
  "0x1af6a83e73b52a31961f428f02cc3a9070553785030efafd11c55f133968aef4",
];

const rpcUrl = "https://hideki-dev.smk.somnia.host";
const client = createPublicClient({
  chain: hidekiTestnet,
  transport: http(rpcUrl),
});

async function checkTxs() {
  console.log("=== Fetching tx details from RPC ===");
  let found = 0, errors = 0;
  for (const hash of txHashes) {
    try {
      const receipt = await Promise.race([
        client.getTransactionReceipt({ hash }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000))
      ]);
      console.log(`${hash.slice(0,10)}... status=${receipt?.status || "unknown"} block=${receipt?.blockNumber || "unknown"}`);
      found++;
    } catch (e) {
      console.log(`${hash.slice(0,10)}... ERROR: ${e.message}`);
      errors++;
    }
  }
  console.log(`\nFetched: ${found}/${txHashes.length}, Errors: ${errors}`);
}

checkTxs().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
