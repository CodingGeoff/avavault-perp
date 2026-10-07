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


// 直接绕过服务端，模拟"operator 私钥泄露、攻击者拿着合法格式但签名人不对的授权去骗链上合约"的场景。
// 用 trader A 的私钥签一份声称是 trader B 授权的消息，验证 VaultV2 会拒绝（InvalidSignature）。
const RPC = "https://api.avax-test.network/ext/bc/C/rpc";
const VAULT_V2 = "0x0425352bc3c5293D5629c27525969439Ab9C27b5";
const OPERATOR_PK = requireEnv("DEMO_OPERATOR_KEY");
const TRADER_A_PK = requireEnv("DEMO_TRADER_A_KEY"); // wrong signer
const TRADER_B = "0x4Cb059f685340C7e4805Ee99C644556C2C58f830"; // claimed "from"
const TRADER_A = "0xe4b03aa3112Bb83a37e40411048fB24E56Fbf023";

const ABI = [
  "function settleWithAuthorization(address from, address to, uint256 amount, bytes32 tradeRef, uint256 maxAmount, uint256 nonce, uint256 deadline, bytes signature) external",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const operator = new ethers.Wallet(OPERATOR_PK, provider);
  const wrongSigner = new ethers.Wallet(TRADER_A_PK, provider);
  const vault = new ethers.Contract(VAULT_V2, ABI, operator);

  const domain = { name: "MiniDexVault", version: "2", chainId: 43113, verifyingContract: VAULT_V2 };
  const types = {
    SettlementAuthorization: [
      { name: "from", type: "address" },
      { name: "maxAmount", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  const maxAmount = "50000000";
  const nonce = Date.now().toString();
  const deadline = (Math.floor(Date.now() / 1000) + 3600).toString();

  // 攻击者用 trader A 的私钥签名，但在合约调用里声称 from = trader B（一个 A 无权代表的账户）
  const forgedSignature = await wrongSigner.signTypedData(domain, types, {
    from: TRADER_B,
    maxAmount,
    nonce,
    deadline,
  });

  console.log("submitting settleWithAuthorization with a signature from the WRONG account...");
  try {
    const tx = await vault.settleWithAuthorization(
      TRADER_B,
      TRADER_A,
      "1000000",
      ethers.id("forged-attempt"),
      maxAmount,
      nonce,
      deadline,
      forgedSignature
    );
    await tx.wait();
    console.log("UNEXPECTED: transaction succeeded! (this would be a real vulnerability)");
  } catch (e) {
    console.log("EXPECTED REJECTION on-chain:", e.shortMessage || e.message);
  }
}

main();
