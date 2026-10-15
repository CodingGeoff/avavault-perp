// 给"服务端演示做市钱包"（DEMO_MAKER_PRIVATE_KEY）领取并存入 mUSDC 保证金。
//
// 为什么需要：服务端铺出来的买单被演示者的对冲空单吃掉时，链上结算是从**买方**
// 的 Vault 余额里扣钱的。做市钱包余额为 0 → 成交能撮合、结算必失败 → 第 7 步
// 拿不出 Snowtrace 凭证。跑一次这个脚本就能把做市钱包变成"真的有钱的对手方"。
//
// 用法：
//   # 1) 没有现成钱包时，先生成一个（输出私钥，写进 Render 的 DEMO_MAKER_PRIVATE_KEY）
//   node fund_demo_maker.mjs --generate
//
//   # 2) 给它一点 Fuji 测试 AVAX 付 gas（脚本会告诉你缺多少、去哪领）
//   3) 领取 mUSDC 并存入 VaultV2
//   DEMO_MAKER_PRIVATE_KEY=0x... node fund_demo_maker.mjs --amount 1000
//
// 注意：这个钱包只用于演示做市，永远不要放真实资产。
import { ethers } from "ethers";

const RPC_URL = process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc";
const MOCK_USDC = process.env.MOCK_USDC || "0x206d1B4D35c1f081C82939F1d97A05B5cb5BEF93";
const VAULT_V2 = process.env.VAULT_ADDRESS || "0x0425352bc3c5293D5629c27525969439Ab9C27b5";
const AMOUNT = process.env.AMOUNT || "1000"; // mUSDC（6 位小数）

const ERC20_ABI = [
  "function faucet(uint256 amount) external",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];
const VAULT_ABI = ["function deposit(uint256) external", "function balanceOf(address) view returns (uint256)"];

function generate() {
  const w = ethers.Wallet.createRandom();
  console.log("已生成演示做市钱包（仅测试网用途）：");
  console.log(`  address     = ${w.address}`);
  console.log(`  private key = ${w.privateKey}`);
  console.log("下一步：");
  console.log("  1. 在 Render 环境变量里设置 DEMO_MAKER_PRIVATE_KEY=<上面的私钥>（sync:false，不要提交进仓库）");
  console.log("  2. 用 https://faucet.avax.network/ 给这个地址领 Fuji 测试 AVAX（付 gas）");
  console.log(`  3. DEMO_MAKER_PRIVATE_KEY=${w.privateKey} node fund_demo_maker.mjs --amount 1000`);
  console.log("  4. 部署后 POST /admin/seed-book（带 x-admin-token）铺盘口，或设 SEED_DEMO_LIQUIDITY=1 让它启动即铺");
}

async function fund() {
  const key = process.env.DEMO_MAKER_PRIVATE_KEY;
  if (!key) {
    console.error("缺少 DEMO_MAKER_PRIVATE_KEY。想新建一个请先跑： node fund_demo_maker.mjs --generate");
    process.exit(1);
  }
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(key, provider);
  const net = await provider.getNetwork();
  if (net.chainId !== 43113n) {
    console.error(`RPC 指向的不是 Fuji（chainId=${net.chainId}）。请检查 FUJI_RPC_URL。`);
    process.exit(1);
  }

  const avax = await provider.getBalance(wallet.address);
  console.log(`做市钱包 ${wallet.address}`);
  console.log(`  AVAX 余额   = ${ethers.formatEther(avax)}（付 gas 用）`);
  if (avax === 0n) {
    console.error("  ✗ 没有 AVAX，无法发交易。先到 https://faucet.avax.network/ 给上面这个地址领测试 AVAX，再重跑本脚本。");
    process.exit(1);
  }

  const usdc = new ethers.Contract(MOCK_USDC, ERC20_ABI, wallet);
  const vault = new ethers.Contract(VAULT_V2, VAULT_ABI, wallet);
  const decimals = Number(await usdc.decimals());
  const amount = ethers.parseUnits(AMOUNT, decimals);

  const walletUsdc = await usdc.balanceOf(wallet.address);
  if (walletUsdc < amount) {
    console.log(`  领取 ${ethers.formatUnits(amount, decimals)} mUSDC …`);
    const tx = await usdc.faucet(amount - walletUsdc);
    const r = await tx.wait();
    console.log(`  ✓ faucet 成功 ${r.hash}`);
  } else {
    console.log(`  钱包已有 ${ethers.formatUnits(walletUsdc, decimals)} mUSDC，跳过领取`);
  }

  console.log("  授权 VaultV2 …");
  const approveTx = await usdc.approve(VAULT_V2, amount);
  const approveR = await approveTx.wait();
  console.log(`  ✓ approve 成功 ${approveR.hash}`);

  console.log("  存入 VaultV2 作为结算保证金 …");
  const depTx = await vault.deposit(amount);
  const depR = await depTx.wait();
  console.log(`  ✓ deposit 成功 ${depR.hash}`);

  const vaultBal = await vault.balanceOf(wallet.address);
  console.log(`  Vault 保证金余额 = ${ethers.formatUnits(vaultBal, 6)} mUSDC`);
  console.log(`  Snowtrace: https://testnet.snowtrace.io/address/${wallet.address}`);
  console.log("完成。现在 POST /admin/seed-book 铺出的买单被吃掉时，链上结算会真的成功。");
}

if (process.argv.includes("--generate")) generate();
else fund().catch((e) => { console.error("失败:", e.shortMessage || e.message); process.exit(1); });
