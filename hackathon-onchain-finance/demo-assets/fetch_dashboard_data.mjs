// 真实连到 Avalanche Fuji 公共 RPC，读取已经真实部署的合约状态，
// 不是写死的假数字——这个脚本跑完会生成 dashboard_data.json，
// 再由 render_dashboard.mjs 拼成一个静态 HTML 仪表盘用于截图。
import { ethers } from "ethers";
import fs from "fs";

const RPC = "https://api.avax-test.network/ext/bc/C/rpc";
const provider = new ethers.JsonRpcProvider(RPC);

const RWA_TOKEN = "0x1cC1650E2Da5c2357c811B90187D1022b70B70Ad";
const VAULT = "0x9128AE5F8cf51eB35A69C29c55B07A7776603b0B";
const PAIR = "0x7590d84174571d89732451bb77BB4C38F7183b85";
const DEPLOYER = "0xF7ac5cF5D95256E960DF21229B140edFE31b5c9b";

const erc20Abi = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];
const vaultAbi = [
  "function collateralValue(address user, address token) view returns (uint256)",
  "function totalAccountValue(address user) view returns (uint256)",
  "function supportedCollateralsCount() view returns (uint256)",
];
const pairAbi = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];

async function main() {
  const rwa = new ethers.Contract(RWA_TOKEN, erc20Abi, provider);
  const vault = new ethers.Contract(VAULT, vaultAbi, provider);
  const pair = new ethers.Contract(PAIR, pairAbi, provider);

  const [name, symbol, decimals, totalSupply, deployerBal, vaultBal] = await Promise.all([
    rwa.name(),
    rwa.symbol(),
    rwa.decimals(),
    rwa.totalSupply(),
    rwa.balanceOf(DEPLOYER),
    rwa.balanceOf(VAULT),
  ]);

  let collateralValue = null, totalAccountValue = null, supportedCount = null;
  try {
    collateralValue = await vault.collateralValue(DEPLOYER, RWA_TOKEN);
    totalAccountValue = await vault.totalAccountValue(DEPLOYER);
    supportedCount = await vault.supportedCollateralsCount();
  } catch (e) {
    console.error("vault read warning:", e.message);
  }

  let reserves = null;
  try {
    const [r0, r1] = await pair.getReserves();
    reserves = { reserve0: r0.toString(), reserve1: r1.toString() };
  } catch (e) {
    console.error("pair read warning:", e.message);
  }

  const blockNumber = await provider.getBlockNumber();

  const data = {
    fetchedAtBlock: blockNumber,
    network: "Avalanche Fuji C-Chain (43113)",
    rwaToken: {
      address: RWA_TOKEN,
      name,
      symbol,
      decimals: Number(decimals),
      totalSupply: ethers.formatUnits(totalSupply, decimals),
      deployerBalance: ethers.formatUnits(deployerBal, decimals),
      vaultBalance: ethers.formatUnits(vaultBal, decimals),
    },
    vault: {
      address: VAULT,
      collateralValueOfDeployer_inQuote18: collateralValue !== null ? ethers.formatUnits(collateralValue, 18) : null,
      totalAccountValue_inQuote18: totalAccountValue !== null ? ethers.formatUnits(totalAccountValue, 18) : null,
      supportedCollateralsCount: supportedCount !== null ? supportedCount.toString() : null,
    },
    pair: {
      address: PAIR,
      reserves,
    },
  };

  fs.writeFileSync("./dashboard_data.json", JSON.stringify(data, null, 2));
  console.log(JSON.stringify(data, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
