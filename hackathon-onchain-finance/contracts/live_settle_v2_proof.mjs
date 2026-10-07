import { ethers } from "ethers";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing ${name}. This script needs a throwaway Fuji testnet private key, ` +
      `set as an env var (see .env.example). Never use a key that holds real funds.`
    );
  }
  return v;
}


// 黑客松 MultiCollateralVaultV2 的真实链上证明脚本：
// 1) trader A 用自己的私钥签一份 EIP-712 授权（最多同意转出 300 RWA）
// 2) operator 拿着这份签名调用 settleWithAuthorization，转 200 RWA 给 trader B —— 应该成功
// 3) 攻击者伪造一份"声称是 trader A"的签名（其实用别的私钥签的）—— 应该在链上被拒绝
const RPC = "https://api.avax-test.network/ext/bc/C/rpc";
const VAULT2 = "0xb999cb61A4fb2FE71d1C5FBA7aD506F619dD7884";
const RWA = "0x1cC1650E2Da5c2357c811B90187D1022b70B70Ad";
const OPERATOR_PK = requireEnv("DEMO_OPERATOR_KEY");
const TRADER_A_PK = requireEnv("DEMO_TRADER_A_KEY");
const TRADER_A = "0xe4b03aa3112Bb83a37e40411048fB24E56Fbf023";
const TRADER_B = "0x4Cb059f685340C7e4805Ee99C644556C2C58f830";

const ABI = [
  "function settleWithAuthorization(address from, address to, address token, uint256 amount, bytes32 tradeRef, uint256 maxAmount, uint256 nonce, uint256 deadline, bytes signature) external",
  "function rawBalance(address,address) view returns (uint256)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const operator = new ethers.Wallet(OPERATOR_PK, provider);
  const traderA = new ethers.Wallet(TRADER_A_PK, provider);
  const vault = new ethers.Contract(VAULT2, ABI, operator);

  const domain = { name: "MultiCollateralVault", version: "2", chainId: 43113, verifyingContract: VAULT2 };
  const types = {
    SettlementAuthorization: [
      { name: "from", type: "address" },
      { name: "token", type: "address" },
      { name: "maxAmount", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  const maxAmount = ethers.parseEther("300");
  const nonce = Date.now();
  const deadline = Math.floor(Date.now() / 1000) + 3600;

  console.log("=== before ===");
  console.log("trader A balance:", await vault.rawBalance(TRADER_A, RWA));
  console.log("trader B balance:", await vault.rawBalance(TRADER_B, RWA));

  const validSig = await traderA.signTypedData(domain, types, { from: TRADER_A, token: RWA, maxAmount, nonce, deadline });

  console.log("\n=== 1) valid authorization -> real settleWithAuthorization tx ===");
  const tx = await vault.settleWithAuthorization(
    TRADER_A, TRADER_B, RWA, ethers.parseEther("200"), ethers.id("hackathon-demo-trade-1"),
    maxAmount, nonce, deadline, validSig
  );
  const receipt = await tx.wait();
  console.log("tx hash:", receipt.hash, "status:", receipt.status);

  console.log("\n=== after ===");
  console.log("trader A balance:", await vault.rawBalance(TRADER_A, RWA));
  console.log("trader B balance:", await vault.rawBalance(TRADER_B, RWA));

  console.log("\n=== 2) forged signature (signed by a random unrelated key, claiming to be trader A) ===");
  const forger = ethers.Wallet.createRandom();
  const forgedSig = await forger.signTypedData(domain, types, {
    from: TRADER_A, token: RWA, maxAmount, nonce: nonce + 1, deadline,
  });
  try {
    const badTx = await vault.settleWithAuthorization(
      TRADER_A, TRADER_B, RWA, ethers.parseEther("50"), ethers.id("hackathon-demo-forged"),
      maxAmount, nonce + 1, deadline, forgedSig
    );
    await badTx.wait();
    console.log("UNEXPECTED: forged tx succeeded!");
  } catch (e) {
    console.log("EXPECTED on-chain rejection:", e.shortMessage || e.reason || e.message);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
