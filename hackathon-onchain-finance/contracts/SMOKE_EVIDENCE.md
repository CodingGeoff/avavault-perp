# PerpMarginAccount 链上冒烟证据（Avalanche Fuji 测试网）

> 这份文件记录的是**合约层真打通**的最硬材料：存款 → 开仓 → 改标记价 → 强平
> 四个动作，全部是 Fuji 测试网上的真实交易，逐笔可在 Snowtrace 上打开复核。
> 原始机器可读证据：`smoke/perp_margin_smoke_20261015T094517Z.json`（同目录 `.log` 是完整控制台输出）。

## 部署记录（2026-10-15）

| 合约 | 地址 | 部署交易 |
|---|---|---|
| `SimpleMarkOracle`（独立标记价预言机） | [`0x713Ef730F1f04350752e3684Af0ebDF4288eC482`](https://testnet.snowtrace.io/address/0x713Ef730F1f04350752e3684Af0ebDF4288eC482) | [`0x629c66…e1d8`](https://testnet.snowtrace.io/tx/0x629c665ab5ace53a040e9de1f07bd59df516bcb2412e714f5c32639b3b34e1d8) |
| `PerpMarginAccount`（合约层仓位保证金） | [`0xB329713EbF8c72a3ffD5605fa720482c58601610`](https://testnet.snowtrace.io/address/0xB329713EbF8c72a3ffD5605fa720482c58601610) | [`0x88320d…35b0`](https://testnet.snowtrace.io/tx/0x88320d2b86a72abc1695892c2914692f61b7ae0ee3c307c5870cfdf212cc35b0) |

绑定关系（部署时写入，可用 `cast call` 复核）：

- `marginToken` = [`0x206d1B4D35c1f081C82939F1d97A05B5cb5BEF93`](https://testnet.snowtrace.io/address/0x206d1B4D35c1f081C82939F1d97A05B5cb5BEF93)（mUSDC，6 位小数，`faucet()` 可公开领取）
- `collateralValuer` = [`0xb999cb61A4fb2FE71d1C5FBA7aD506F619dD7884`](https://testnet.snowtrace.io/address/0xb999cb61A4fb2FE71d1C5FBA7aD506F619dD7884)（已上线的 `MultiCollateralVaultV2`，RWA 抵押估值的来源）
- `markOracle` = 上表 `SimpleMarkOracle`
- `quotePriceE6` = **9_620_000**（部署当天 WAVAX ≈ $9.62：CoinGecko 9.61 / Coinbase 9.622 / Kraken 9.622 / DexScreener WAVAX-USDC 9.61）
- `INITIAL_MARK_PRICE` = 2500（与演示盘口同锚）
- 部署钱包 / owner / operator = `0xF7ac5cF5D95256E960DF21229B140edFE31b5c9b`（仓库 `DEPLOY.md` 里的 demo operator key，测试网专用）

部署脚本与参数：`script/DeployPerpMarginAccount.s.sol`；地址清单另存于 `deployments/fuji.json`（前端与文档统一引用它）。
冒烟脚本可重跑：`source .env && bash script/smoke_perp_margin.sh`（参数见脚本头部注释，四个动作的哈希会重新生成，属正常现象）。

## 四个动作的真实交易

交易账户：`0xF7ac5cF5D95256E960DF21229B140edFE31b5c9b`
（该地址在 VaultV2 里有 0.28 quote 的 RWA 估值 → 按 `quotePriceE6` 折算 2,693,599（≈2.69 mUSDC）计入本合约可用保证金，
所以「RWA 估值在合约层当保证金」这条不是只跑在单测里，链上也走了真实通路。）

| # | 动作 | 合约调用 | 交易哈希 | 区块 |
|---|---|---|---|---|
| 1 | **存款** deposit(1_000_000) = 1 mUSDC | `PerpMarginAccount.deposit` | [`0x2ed4fb88fbcd749e80f1d16ae34843bc1552c6495129bcde03f9a4c49ea1ba00`](https://testnet.snowtrace.io/tx/0x2ed4fb88fbcd749e80f1d16ae34843bc1552c6495129bcde03f9a4c49ea1ba00) | 59495200 |
| 2 | **开仓** 40 手 @ 2500，20x（占用保证金 5,000） | `PerpMarginAccount.applyPositionDelta` | [`0x6abe967036b465beb585ad5438dce1c0c1b971da21c843cec9ae3cdd847f852c`](https://testnet.snowtrace.io/tx/0x6abe967036b465beb585ad5438dce1c0c1b971da21c843cec9ae3cdd847f852c) | 59495202 |
| 3 | **改标记价** 2500 → 2350（-6%） | `SimpleMarkOracle.setPrice` | [`0x48e2cbfb1c26e6d568ff13583135eda3ed3f8976781e7be45c9f803c3827aa32`](https://testnet.snowtrace.io/tx/0x48e2cbfb1c26e6d568ff13583135eda3ed3f8976781e7be45c9f803c3827aa32) | 59495206 |
| 4 | **强平** | `PerpMarginAccount.liquidate` | [`0xcd7041a63b926c30fe5b7c47bb6dd9f03b85a08bdfeb2e9f5b3894323919991e`](https://testnet.snowtrace.io/tx/0xcd7041a63b926c30fe5b7c47bb6dd9f03b85a08bdfeb2e9f5b3894323919991e) | 59495209 |

辅助动作（同一个脚本里，用于让强平演示包含「穿仓由保险基金兜底」）：

| 动作 | 交易哈希 |
|---|---|
| `mUSDC.approve(PerpMarginAccount, 1,100,000)` | [`0x1f5f66e326ec3af03f3023256bcd057f70f07bf8d35e11b22fed2574407fb29b`](https://testnet.snowtrace.io/tx/0x1f5f66e326ec3af03f3023256bcd057f70f07bf8d35e11b22fed2574407fb29b) |
| `PerpMarginAccount.fundInsurance(100_000)` | [`0xff488f0d676eee0b5a3a57c9ef3b46f0f8b030a0a1e6bc103cb9a6487ee1c2c9`](https://testnet.snowtrace.io/tx/0xff488f0d676eee0b5a3a57c9ef3b46f0f8b030a0a1e6bc103cb9a6487ee1c2c9) |

## 链上状态的前后对照（读数取自 JSON 证据对应的那次运行）

| 读数 | 动作 1 存款后 | 动作 2 开仓后 | 动作 3 改标记价后 | 动作 4 强平后 |
|---|---|---|---|---|
| 仓位 `positions[trader]`（size / entry / margin） | `0 / 0 / 0` | `40 / 2500 / 5000` | `40 / 2500 / 5000` | `0 / 0 / 0`（已全平清空） |
| 标记价 `getMarkPrice()` | 2500 | 2500 | **2350** | 2350 |
| 未实现盈亏 `unrealizedPnl` | 0 | 0 | **-6000**（(2350-2500)×40） | 0（仓位已清） |
| 仓位权益 / 维持保证金 | - | 5000 / 5000 | **-1000 / 4700** → `isLiquidatable = true` | - |
| 保证金余额 `marginBalance` | 1,995,000 | 1,995,000 | 1,995,000 | **1,990,000** |
| 保险基金 `insuranceBalance` | 199,000 | 199,000 | 199,000 | **198,000**（兜底支出 1,000） |
| 累计兜底 / 坏账 | 1,000 / 0 | 1,000 / 0 | 1,000 / 0 | **2,000 / 0** |
| 可强平判定 `isLiquidatable` | false | false | **true** | false（已无仓位） |

（`marginBalance` / `insuranceBalance` / 累计兜底是**账户累计值**，含此前一次同脚本运行留下的
995,000 / 99,000 / 1,000。**本次运行的增量**见下表，这四行的数字才是"这一遍演示"的净效应。）

| 本次运行净效应 | 值 |
|---|---|
| 已实现盈亏 `realizedPnl` | **-6,000**（40 手 × (2350-2500)） |
| 保证金余额变化 | **-5,000**（恰好等于该仓位占用的保证金，自由保证金分文未动） |
| 保险基金净变化 | +100,000（脚本注入）− 1,000（兜底）= **+99,000** |
| 兜底缺口 / 坏账 | 本次 **1,000 / 0**（累计 2,000 / 0） |

强平交易里的 `Liquidated` 事件（`cast abi-decode` 解出，原始数据见 JSON 证据）：

```
markPrice = 2350   pnl = -6000   returnedMargin = 0   deficit = 1000   insuranceCovered = 1000   badDebt = 0
```

解读：入场价 2500 的 40 手多单，在标记价跌到 2350 后仓位权益为 **-1000**（亏 6000，占用保证金只有 5000），
这是**穿仓**（亏穿了自己占用的保证金）。合约按设计执行：先扣保险基金 1000 补缺口、坏账 0，
用户账户的自由保证金分文未动（损失被限制在该仓位占用的 5000 以内），保险基金兜底后仍为可支撑状态。

## 同一脚本的两次独立运行（都能在 Snowtrace 上打开）

同一脚本跑了两次（参数完全相同：存款 1 mUSDC、40 手 @ 2500 20x、标记价 2500→2350），
两次交易哈希不同但链上效果一致 —— 这正是"每次演示哈希都不一样，属正常现象"的现成例证。

| 动作 | 第一次运行（留痕于链上） | 第二次运行（本文档引用的 JSON 证据） |
|---|---|---|
| 1 存款 | [`0x53ed7f…f3ba`](https://testnet.snowtrace.io/tx/0x53ed7f21043a02806d0cf8ddf4496aaa94916eeb07849e3dc75cb7a95160f3ba) | [`0x2ed4fb…ba00`](https://testnet.snowtrace.io/tx/0x2ed4fb88fbcd749e80f1d16ae34843bc1552c6495129bcde03f9a4c49ea1ba00) |
| 2 开仓 | [`0x52437b…f852`](https://testnet.snowtrace.io/tx/0x52437b10df9d8225d1af65b2e83dc75be551f71f043d688df3197ca83009d6b7) | [`0x6abe96…843c`](https://testnet.snowtrace.io/tx/0x6abe967036b465beb585ad5438dce1c0c1b971da21c843cec9ae3cdd847f852c) |
| 3 改标记价 | [`0x874131…bbc6`](https://testnet.snowtrace.io/tx/0x8741312cfdd64d9d4b63c6e3430363581ac54a78dba29db139c1277b515bbc64) | [`0x48e2cb…aa32`](https://testnet.snowtrace.io/tx/0x48e2cbfb1c26e6d568ff13583135eda3ed3f8976781e7be45c9f803c3827aa32) |
| 4 强平 | [`0xa47cec…1991`](https://testnet.snowtrace.io/tx/0xa47cec1225a3e86b10d7fb2fb5910e7b41f5269f2506d75748000778ebea415b) | [`0xcd7041…991e`](https://testnet.snowtrace.io/tx/0xcd7041a63b926c30fe5b7c47bb6dd9f03b85a08bdfeb2e9f5b3894323919991e) |

## 怎么自己复核（三条命令，不依赖本仓库）

```bash
RPC=https://api.avax-test.network/ext/bc/C/rpc

# 1) 标记价（独立预言机）
cast call 0x713Ef730F1f04350752e3684Af0ebDF4288eC482 "getMarkPrice()(uint256)" --rpc-url $RPC   # 2350

# 2) 强平事件（解码 Liquidated）
cast receipt 0xcd7041a63b926c30fe5b7c47bb6dd9f03b85a08bdfeb2e9f5b3894323919991e --rpc-url $RPC
cast events --tx-hash 0xcd7041a63b926c30fe5b7c47bb6dd9f03b85a08bdfeb2e9f5b3894323919991e --rpc-url $RPC

# 3) 强平后账户状态
cast call 0xB329713EbF8c72a3ffD5605fa720482c58601610 "insuranceBalance()(uint256)" --rpc-url $RPC          # 198000
cast call 0xB329713EbF8c72a3ffD5605fa720482c58601610 "totalInsuranceCovered()(uint256)" --rpc-url $RPC      # 2000
cast call 0xB329713EbF8c72a3ffD5605fa720482c58601610 "totalBadDebt()(uint256)" --rpc-url $RPC               # 0
```

> 注：上表里的 `marginBalance` / `insuranceBalance` / `totalInsuranceCovered` 是账户累计值，
> 包含本脚本第一次运行留下的 995,000 / 99,000 / 1,000；「本次运行」的净效应见上文增量表。

## 前端展示（同一份链上读数，浏览器里真实渲染）

前端（`task7-perp-dex/demo/index.html`，GitHub Pages 上的静态站）新增了两个只读面板，
数据全部来自上面这两个合约的公共 RPC `eth_call`，不需要连接钱包：

| 截图 | 说明 |
|---|---|
| `hackathon-onchain-finance/demo-assets/onchain-perp-margin-panel.png` | 「链上仓位保证金」卡片：实时显示独立标记价、保险基金余额、累计兜底/坏账 |
| `hackathon-onchain-finance/demo-assets/onchain-contracts-panel.png` | 「链上合约」卡片：新增 PerpMarginAccount / SimpleMarkOracle 两个 Snowtrace 链接 |

两张截图都是改动后页面在无头 Chromium 里真实渲染并连公共 RPC 读到的值（截图时标记价为 2350、
保险基金 0.198 mUSDC、兜底 0.002 / 坏账 0），不是设计稿。

## 本地回归测试（同一份合约，不需要 fork/私钥）

```bash
cd hackathon-onchain-finance/contracts
forge install --no-git          # 若 lib/ 为空
forge test                      # 25/25 通过（含 PerpMarginAccount 12 个用例）
```

`PerpMarginAccount.t.sol` 覆盖：存取与自由保证金限制、RWA 估值计入保证金并据此开仓、
保证金不足/杠杆越界被拒、仅 operator 可记账、VWAP 入场与部分平仓盈亏、反手、
独立标记价强平（罚金入保险基金）、穿仓缺口由保险基金兜底后记坏账、健康仓位不可强平。
