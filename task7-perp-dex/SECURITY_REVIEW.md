# Mini Perp-Dex 安全审查报告（AI 辅助）

> 审查范围：`contracts/src/Vault.sol`、`contracts/src/MarketRegistry.sol`、`contracts/src/MockUSDC.sol`、
> `matching-engine/src/orderbook.ts`。
> 审查方式：结合手动代码阅读 + 针对每类常见漏洞模式（重入、权限校验、取整/精度、Fee-on-Transfer 代币、
> 价格操纵、拒绝服务）逐条排查，并对高风险发现编写回归测试验证修复效果。

## Finding #1（中危，已修复）：`Vault.deposit` 直接信任外部传入的 `amount`，未处理 Fee-on-Transfer 代币

**位置**：`Vault.sol` 的 `deposit(uint256 amount)`（修复前）

**问题描述**：
修复前的实现是：

```solidity
collateralToken.safeTransferFrom(msg.sender, address(this), amount);
balanceOf[msg.sender] = balanceOf[msg.sender] + amount; // 直接按传入的 amount 记账
```

如果 `collateralToken` 是一个收手续费/通缩型代币（转账时会销毁或扣留一部分，实际到账 < 转账发起时声明的
`amount`），Vault 的内部账本会比合约实际持有的代币数量"虚高"。随着越来越多此类存款发生，账本总额会
持续超过真实余额，最终会导致**后面提现的用户无法按记账余额足额取出资金**——这是真实发生过的一类 DeFi
漏洞（典型案例：多个借贷/金库协议因为未对 fee-on-transfer / rebase 代币做特殊处理而出现坏账）。

虽然本项目默认使用的 `MockUSDC` 不收手续费，但 Vault 是一个通用金库合约，其安全性不应该依赖于"外部集成
的代币恰好行为正常"这个假设——防御性编程要求金库自己验证真实到账数量。

**修复**：改为"转账前后自身余额差值"记账，而不是相信调用方传入的名义数量：

```solidity
uint256 balanceBefore = collateralToken.balanceOf(address(this));
collateralToken.safeTransferFrom(msg.sender, address(this), amount);
uint256 received = collateralToken.balanceOf(address(this)) - balanceBefore;
...
balanceOf[msg.sender] = balanceOf[msg.sender] + received;
```

**回归测试**：`test/mocks/FeeOnTransferToken.sol`（模拟一个转账收 2% 税的代币）+
`test_Security_DepositRecordsActualReceivedAmount_NotFeeOnTransferAmount`，验证修复后内部记账
（980 ether）与 Vault 实际持有代币数量（980 ether）始终一致，不会出现"账本 > 实际余额"的情况。

```
[PASS] test_Security_DepositRecordsActualReceivedAmount_NotFeeOnTransferAmount() (gas: 926272)
```

## Finding #2（低危 → ✅ 已在 V2 中正式修复）：`DexPricedSale` 依赖单一 DEX 池的瞬时价格

**位置**：`task3-dex-oracle/contracts/src/DexPricedSale.sol` 的 `getCurrentPrice()` / `quote()`

**问题描述**：直接读取 `router.getAmountsOut()` 得到的是当前区块的瞬时储备价格，在流动性较浅的池子里，
攻击者可以用闪电贷在同一笔交易内先拉高/砸低价格、再调用受害合约按被操纵后的价格成交、随后再把价格套利
拉回，从中获利（经典的"单一现货价格作为 Oracle"攻击模式）。

**V1 阶段的缓解措施**（仍保留在 `DexPricedSale.sol` 中作为历史记录）：
1. `buy()` 里要求调用方传入 `minShopOut` 滑点保护；
2. 引入 `maxPriceImpactBps`（默认 5%），如果单笔成交价格与调用前读取的价格偏离过大会直接 revert。

**✅ 已完成的正式修复（`DexPricedSaleV2.sol` + `TwapOracle.sol`）**：新增基于 UniswapV2 累积价格
计数器的 `TwapOracle`，把"价格影响保护"从"和同一笔交易内的瞬时价格比较"改成"和跨区块时间窗口的
TWAP 均价比较"，从根本上堵死了"闪电贷在同一笔交易内操纵价格"这条路径。已部署到 Fuji 并完成**真实链上
操纵证明**：用一笔大额 swap 把池子瞬时价格砸偏后调用 `buy()`，合约用 `PriceDeviatesTooMuch` 真实
revert。部署地址、修复设计细节、完整 fork 测试见 `task3-dex-oracle/README.md` 第 3.2 节。
`DexPricedSale`（V1）保留在仓库中不动，作为这个真实发现的历史记录，生产环境请使用 V2。

## Finding #3（信息级，已修复）：撮合引擎里市价单的价格哨兵值是死代码

**位置**：`matching-engine/src/orderbook.ts` 的 `placeOrder()`

**问题描述**：市价单在创建 `Order` 对象时，会给 `price` 字段填一个哨兵值（买单 `2^255`，卖单 `0`），
但实际撮合逻辑 `matchAgainstBook` 里对市价单永远走 `crosses(side, null, makerPrice)` 分支，这个哨兵值
从未被读取或参与比较。保留它容易在未来维护时被误用（比如有人错误地直接读取 `order.price` 而不检查
`order.type`），属于潜在的"逻辑地雷"。

**处理**：在代码注释中明确标注该字段仅为占位、不参与撮合判断，并在文档中提示后续开发者优先通过
`order.type === "market"` 判断，而不要依赖 `order.price` 的具体数值。（考虑到改动会牵涉类型定义和多处
调用点，且不影响任何已通过的测试用例，本次选择"标注 + 文档化"而非重构，避免在业务功能交付期引入不必要的
改动面。）

## Finding #4（信息级 → ✅ 已在 V2 中正式修复）：`Vault.settle` 的 operator 权限集中

**位置**：`Vault.sol` 的 `settle()`

**说明**：`operator` 地址可以在任意两个已存款地址之间转移余额，这是链下撮合结果落地为链上余额变化的
必要设计（撮合引擎不可能让每个用户都对每笔成交单独签名再上链，否则失去了"链下撮合、链上净额结算"的性能
优势）。已有的边界：operator **不能**凭空铸造资金，也不能把资金转到不存在记录的第三方之外的任意地址（只能
在 `balanceOf` 映射内部转移，且带 `tradeRef` 存证）；因此即使 operator 私钥泄露，最坏情况是"用户之间的
资金被恶意重新分配"，而不是"资金被整体卷走"。`Vault.sol`（V1）保留在仓库中不动，作为这个发现的历史记录。

### ✅ 已完成的正式修复：`VaultV2.sol` 的 `settleWithAuthorization`

**设计**：把"任意重分配"收窄成"每个用户自己预先签字同意的额度、期限内，可撤销"。新增
EIP-712 `SettlementAuthorization(from, maxAmount, nonce, deadline)` 结构：

- 用户（比如撮合系统里的买方）在下单时用自己的私钥对这份授权签名，声明"最多同意从我账上转出
  `maxAmount`，在 `deadline` 之前有效"；
- operator 撮合成交后，带着这份签名调用 `settleWithAuthorization(from, to, amount, tradeRef,
  maxAmount, nonce, deadline, signature)`；合约用 `ECDSA.recover` 验证签名确实来自 `from`，
  并用 `usedAmount[from][nonce]` 累加已用额度（支持同一个 nonce 下的多次部分成交），超过
  `maxAmount` 直接 revert；
- 用户可以随时 `cancelAuthorization(nonce)` 主动作废一份尚未用完的授权；
- 即使 operator 私钥完全泄露，攻击者能拿到的签名授权也只有"用户自己愿意签、金额和时间都受限、
  随时可撤销"的额度，而不是用户的全部余额——这和 0x Protocol / dYdX v3 等真实 DEX 处理"链下撮合、
  链上结算"信任边界的思路一致（签名约束的是"操作者权限的大小和有效期"，而不是"具体成交对手方"，
  因为撮合引擎在用户下单那一刻确实还不知道最终会和谁成交）。

**实盘部署与真实链上证明（Fuji，非 fork 模拟）**：

| 项目 | 值 |
|---|---|
| VaultV2 地址 | [`0x0425352bc3c5293D5629c27525969439Ab9C27b5`](https://testnet.snowtrace.io/address/0x0425352bc3c5293D5629c27525969439Ab9C27b5) |
| EIP-712 Domain | `name="MiniDexVault"`, `version="2"`, `chainId=43113` |
| 真实撮合 + 链上结算交易 | [`0x100c315fe8629b419965afac43747157491ecc5ef7ca242480546923bc263849`](https://testnet.snowtrace.io/tx/0x100c315fe8629b419965afac43747157491ecc5ef7ca242480546923bc263849) —— trader A 挂卖单 10 units @2500，trader B 携带自己签署的 EIP-712 授权挂买单，服务端撮合成交后自动调用 `settleWithAuthorization`，链上 `balanceOf` 从各自 100 USDC 变为卖方 100.025 / 买方 99.975 USDC，状态码 success |
| 伪造签名的拒绝证明（直接对合约发送交易，绕过服务端） | 用不属于任何一方的私钥签一份"声称是 trader B 授权"的签名，`cast call` 静态调用返回 `0x8baa579f`（即合约自定义错误 `InvalidSignature()` 的选择器），交易在 gas 估算阶段即被拒绝，证明拒绝逻辑在**合约层**强制生效，不依赖服务端"自觉" |

服务端 (`server/src/index.js`) 通过 `VAULT_ABI_VERSION=v1|v2` 环境变量在两套结算逻辑之间切换，
新增 `GET /settlement/domain` 端点供客户端获取 EIP-712 domain/types 进行签名，`POST /orders` 在
v2 模式下要求买单附带 `authorization` 对象。v1 模式下的历史行为经完整 E2E 回归测试验证未受影响
（`server/test-e2e.mjs` 全部场景通过）。

合约测试：`contracts/test/VaultV2.t.sol`，9 个用例全部通过（有效授权成交、同一 nonce 下多笔部分
成交、超额度 revert、过期 revert、用户主动撤销后 revert、伪造签名 revert、非 operator 调用 revert、
`deposit`/`withdraw`/`perUserCap` 行为不变）。

**生产环境的下一步建议**（未来可选的进一步加固，非本次范围）：给 `operator` 本身也加多签或时间锁，
把"授权签名验证"和"operator 密钥保管"两层防御叠加起来。

---

## 复测结果

修复 Finding #1 后，完整测试套件（含新增回归测试）：

```bash
cd contracts && forge test -vv
```

```
Ran 5 tests for test/MarketRegistry.t.sol:MarketRegistryTest   ... 5 passed
Ran 12 tests for test/Vault.t.sol:VaultTest                     ... 12 passed
Ran 2 test suites: 17 tests passed, 0 failed, 0 skipped
```

加入 `VaultV2.t.sol`（Finding #4 修复）后的最新完整复测：

```
Ran 5 tests for test/MarketRegistry.t.sol:MarketRegistryTest   ... 5 passed
Ran 12 tests for test/Vault.t.sol:VaultTest                     ... 12 passed
Ran 9 tests for test/VaultV2.t.sol:VaultV2Test                  ... 9 passed
Ran 3 test suites: 26 tests passed, 0 failed, 0 skipped
```

V1 的 `Vault.t.sol` 全部保持通过，证明 V2 是纯新增、不影响历史合约的行为——`Vault.sol` 继续作为
"未修复前长什么样"的对照物保留在仓库里。
