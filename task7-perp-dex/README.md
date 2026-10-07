# Task 7 · Perp Dex 开发最新实战（以 Primit 为例）— Mini Perp-Dex

一个"链下撮合 + 链上结算"的最小可行永续合约交易所：撮合引擎在链下用价格-时间优先算法高速撮合，
链上 `Vault` 合约只负责托管保证金和净额结算，参考了 Primit / dYdX v3 这类"混合架构"永续 DEX 的设计思路。

```
avalanche-bootcamp/task7-perp-dex/
├── matching-engine/   # 撮合引擎（TypeScript, vitest），价格-时间优先 + 自成交保护 + IOC/FOK
├── contracts/         # Foundry：MockUSDC / MarketRegistry / Vault（3 个合约）
├── server/            # Express + WebSocket API，串联撮合引擎、SQLite 持久化、链上结算、做市机器人
├── demo/              # 纯静态前端，用于端到端演示截图
└── SECURITY_REVIEW.md # AI 安全审查报告（含真实修复）
```

## 一、必做部分：60 分 ✅ 全部完成

### 1. 撮合引擎（20 分）

```bash
cd matching-engine
npm install
npm test
```

```
✓ test/orderbook.test.ts (21 tests) 11ms
Test Files  1 passed (1)
     Tests  21 passed (21)
```

- ✅ `npm test` 全部通过（21 个用例）
- ✅ "时间优先"测试：`OrderBook — 时间优先` describe 块，3 个用例，覆盖"同价先到先得"、
  "同价多档依次消耗"、"更优价格优先于时间"
- ✅ "拒绝 self-trade"测试：`OrderBook — 自成交保护` describe 块，3 个用例，覆盖限价单、
  跳过自成交后继续撮合别人、市价单场景

### 2. 合约部署到 Fuji 测试网（20 分）

```bash
cd contracts
forge test        # 全部通过
cp .env.example .env  # 填入 PRIVATE_KEY
source .env
forge script script/Deploy.s.sol:Deploy --rpc-url $FUJI_RPC_URL --broadcast --private-key $PRIVATE_KEY
```

```
Ran 2 test suites: 17 tests passed, 0 failed, 0 skipped
```

- ✅ `forge test` 全部通过（17 个用例，含 Fuzz 测试与一条真实安全修复的回归测试）
- ✅ 3 个已部署合约：`MockUSDC`（保证金代币）、`MarketRegistry`（市场元数据登记表）、
  `Vault`（保证金托管 + 结算）—— 部署脚本 `script/Deploy.s.sol` 会依次部署这三个合约
- ✅ 部署脚本里包含一笔真实的 `deposit` 交易（`vault.deposit(1_000 * 10**6)`），交易哈希会出现在
  `broadcast/Deploy.s.sol/43113/run-latest.json` 里，也会打印在终端
- 合约地址：已完成真实部署，见下方"三、部署记录"

### 3. 端到端演示（20 分）

启动全套服务：

```bash
# 1) 启动撮合 + API + WebSocket 服务
cd server && npm install && cp .env.example .env && npm start

# 2) 打开 demo/index.html（本地静态服务器或直接双击），用两个不同浏览器 profile/两个钱包分别连接
cd ../demo && python3 -m http.server 8081
```

已经跑通的自动化端到端脚本（`server/test-e2e.mjs`）覆盖了所有必做验收点：

```bash
cd server && node test-e2e.mjs
```

```
=== 1. login (wallet signature) ===
login ok: 0x7c74...
login ok: 0x00A3...

=== 2. reject unauthenticated order ===
unauthenticated order status: 401 (expect 401)

=== 3. two different addresses complete a trade ===
trade executed: YES

=== 4. self-trade prevention sanity check ===
self-trade produced 0 trades: true

=== 6. IOC order ===
IOC filled 3, cancelled remaining 7: true

=== 7. FOK order (should be rejected, insufficient liquidity) ===
FOK cancelled with 0 trades: true
```

已完成的真实链上交易（见下方"三、部署记录"完整列表）：deploy 3 个合约 → 真实 `deposit`（1,000 mUSDC）→
真实 `withdraw`（200 mUSDC），全部在 Fuji 上广播成功。

还需要人工截图的部分（这几步涉及浏览器/钱包 UI 操作，必须你自己动手，脚本无法代劳）：
- [ ] 用 MetaMask/Core 签名登录成功的截图
- [ ] 链上 Vault 余额显示截图（`GET /balance/:address`，或 demo 页面上的余额区域）
- [ ] 两个不同地址（两个浏览器 / 两个钱包）完成一笔成交的截图（下单前后订单簿对比）

## 二、进阶部分：本次全部实现，共 40 分上限内尽量拿满

| 功能 | 分值 | 状态 | 说明 |
|---|---|---|---|
| 链上余额设置硬上限 | 8 | ✅ | `Vault.perUserCap` + `setPerUserCap()`，`test_PerUserCap_BlocksExcessDeposit` 覆盖 |
| 数据持久化（重启不丢失） | 10 | ✅ | `server/src/db.js` 用 `better-sqlite3` 落地订单/成交，启动时 `restoreOpenOrder()` 重建订单簿；**踩坑记录见下方** |
| WebSocket 私有 orders 频道 | 8 | ✅ | `/ws?address=0x..` 只推送该地址自己的 `order_update` / `settled` 事件，与公共频道（orderbook/trades）分离 |
| IOC / FOK 订单 | 8 | ✅ | 撮合引擎原生支持，`matching-engine` 21 个用例里有 5 个专门覆盖 IOC/FOK 边界情况 |
| 做市机器人（买卖各挂 3 档） | 10 | ✅ | `server/src/marketMaker.js`，围绕参考中间价挂 3 档阶梯报价，定时刷新撤单重挂 |
| AI 安全审查报告 + 修复真实问题 | 8 | ✅ | 见 `SECURITY_REVIEW.md`：发现并修复了 `Vault.deposit` 对 fee-on-transfer 代币记账错误的中危问题，附回归测试 |

### 持久化踩坑记录（工程细节，体现"重启不丢失"不是随便加个数据库就完事）

第一版实现只在**taker 自己的订单**发生变化时写库，结果发现：一个订单作为**maker（挂在盘口上，被后来的单子吃掉）**
时，它的 `remaining`/`status` 变化只在内存里更新了，从来没有重新写回 SQLite。于是重启后，会把这些早就被
吃单吃掉的"幽灵挂单"当成还活着的挂单重新塞回订单簿，导致重启前后订单簿状态不一致。

修复方式：每次撮合后，除了持久化 taker 订单本身，还要找出这笔撮合里所有涉及到的 maker 订单 id
（`trades[].buyOrderId` / `sellOrderId`），把它们当前的最新状态也一并 upsert 进数据库。验证方法：手动
启停服务 3 轮，每轮跑一遍 `test-e2e.mjs` 制造出"部分成交挂单 + 完全成交挂单 + IOC 剩余作废"三种状态，
确认重启后订单簿快照和重启前完全一致（细节见开发过程中的调试记录）。

同时也处理了一个相关的边界情况：IOC/FOK 订单在未完全成交时状态会被标记为 `partially_filled`，但它的
`remaining` 已经被清零、不应该被当作"还挂着的单子"来恢复——启动时按 `remaining > 0` 而不是单纯按
`status` 过滤，避免恢复出数量为 0 的"幽灵订单"。

## 三、部署记录（已完成真实部署 ✅）

已用 `wallet/README.md` 里的演示钱包在 Fuji 测试网真实广播，全部链上可验证（`cast receipt` 确认
`status: 1 (success)`）：

| 合约/交易 | 地址 / 哈希 |
|---|---|
| MockUSDC | [`0x206d1B4D35c1f081C82939F1d97A05B5cb5BEF93`](https://testnet.snowtrace.io/address/0x206d1B4D35c1f081C82939F1d97A05B5cb5BEF93) |
| MarketRegistry | [`0xFAc25DcAFa454E8667Bc8D10d45444bCF89C4251`](https://testnet.snowtrace.io/address/0xFAc25DcAFa454E8667Bc8D10d45444bCF89C4251) |
| Vault | [`0x70655BC76367E97633a77E490942A907AAf4698B`](https://testnet.snowtrace.io/address/0x70655BC76367E97633a77E490942A907AAf4698B) |
| 部署者 / operator | `0xF7ac5cF5D95256E960DF21229B140edFE31b5c9b` |
| Vault 部署交易 | [`0x2dea0ae5da35ffb7c1bba85edc79b14820110d87b0db68082935c7ddc2877fc4`](https://testnet.snowtrace.io/tx/0x2dea0ae5da35ffb7c1bba85edc79b14820110d87b0db68082935c7ddc2877fc4) |
| 首笔 `deposit`（1,000 mUSDC） | [`0xdba61354515bea2db30022990cddf5ff4f2a94d44e47099a4532970ee5c51b2a`](https://testnet.snowtrace.io/tx/0xdba61354515bea2db30022990cddf5ff4f2a94d44e47099a4532970ee5c51b2a) |
| 一笔真实 `withdraw`（200 mUSDC） | [`0x42d54e2dc5c09d67e34bbe452585dbec8450cffed77810071f8e6741183a2278`](https://testnet.snowtrace.io/tx/0x42d54e2dc5c09d67e34bbe452585dbec8450cffed77810071f8e6741183a2278) |
| 部署后 Vault 净余额（deployer） | 800 mUSDC（1,000 存入 − 200 取出） |

把上面的 `Vault` 地址和 operator 私钥填进 `server/.env` 的 `VAULT_ADDRESS` / `OPERATOR_PRIVATE_KEY`
（`server/src/index.js` 已经内置了 `ethers` 合约调用逻辑，检测到这两个变量非空就会在每笔撮合成交后
自动调用链上 `Vault.settle()`），这样启动的就是一套真正连到 Fuji 上这个已部署合约的撮合服务，而不只是
纯链下模拟。

### 3.2 真实端到端验证：链下撮合 → 链上真实结算（已完成 ✅）

这是整个 Task7 里最能体现"链下撮合引擎 + 链上资金托管"架构闭环的一步，所以专门做了一次完整的真实验证，
而不是只在本地单测里 mock：

1. 用 `cast wallet new` 生成两个全新的交易者钱包（不是随机测试地址，是真实持有链上状态的账户）：
   - Trader A（卖方）：`0xe4b03aa3112Bb83a37e40411048fB24E56Fbf023`
   - Trader B（买方）：`0x4Cb059f685340C7e4805Ee99C644556C2C58f830`
2. 分别给两个地址转入 gas 费 AVAX、转入 100 mUSDC，并各自用自己的私钥真实调用
   `MockUSDC.approve` + `Vault.deposit(100000000)`，在 Fuji 上把 100 mUSDC 存进已部署的真实 Vault
   合约（不是喂给撮合引擎一个假余额）。
3. 启动 `server/`，配置 `VAULT_ADDRESS` + `OPERATOR_PRIVATE_KEY`（operator 是部署 Vault 时设置的
   同一个地址），日志打印 `[settlement] on-chain settlement ENABLED`。
4. 用两个交易者的真实私钥各自完成钱包签名登录，然后下一对互相成交的限价单（`server/onchain_settle_test.mjs`，
   已保留在仓库里可重复运行）：Trader A 卖 10 @ 2500，Trader B 买 10 @ 2500 → 撮合引擎立刻在内存里
   成交，随后服务端自动异步调用 `vaultContract.settle(buyTraderId, sellTraderId, 25000, tradeRef)`。
5. **链上验证结果**：

   | 项目 | 值 |
   |---|---|
   | 真实 `settle()` 交易哈希 | [`0xc9568f324acd43593388731af3e9e374d28c63579c3d05802b748995d3409e2a`](https://testnet.snowtrace.io/tx/0xc9568f324acd43593388731af3e9e374d28c63579c3d05802b748995d3409e2a)（`status: 1 success`） |
   | Trader A（卖方）Vault 余额变化 | 100,000,000 → **100,025,000**（+25,000 raw units，即赢得这笔成交金额） |
   | Trader B（买方）Vault 余额变化 | 100,000,000 → **99,975,000**（−25,000 raw units，即支付这笔成交金额） |
   | 触发方式 | 完全由撮合引擎自动触发，人工只负责下单，`settle()` 调用和金额都是服务端代码自动算出来的 |

   这证明了：链下订单簿撮合出的成交结果，**真实改变了 Fuji 测试网上 Vault 合约里的资金归属**，而不是
   只停留在内存/数据库里的模拟数字——这是"链下撮合、链上净额结算"架构里最核心也最容易只做样子的一环，
   这里是真枪实弹跑通的。

链上结算联动（可选）：把上面的 `VAULT_ADDRESS` 和一个有 gas 的 `OPERATOR_PRIVATE_KEY` 填进
`server/.env`，重启服务后，撮合出的每一笔链下成交都会自动调用 `Vault.settle()` 落到链上，
WebSocket 私有频道会推送 `settled` 事件和交易哈希。

### 3.3 安全加固：`VaultV2`（修复 SECURITY_REVIEW.md Finding #4，已部署、已在链上验证 ✅）

3.2 节验证的 `Vault.settle()` 有一个已知设计问题（详见 `SECURITY_REVIEW.md` Finding #4）：`operator`
可以在**任意**两个已存款地址之间转移余额，一旦 operator 热钱包私钥泄露，攻击者能把所有用户的资金
任意重新分配。`VaultV2.sol` 把这个权限从"任意转移"收紧成"每个用户自己签字同意的额度、期限内、可撤销"：

- 用户下单时用自己的私钥签一份 EIP-712 `SettlementAuthorization(from, maxAmount, nonce, deadline)`；
- operator 撮合成交后必须带着这份签名调用 `settleWithAuthorization(...)`，合约链上验证签名确实来自
  `from`，并且这笔加上之前已用掉的金额不能超过签名里承诺的 `maxAmount`；
- 用户可以随时 `cancelAuthorization(nonce)` 主动作废还没用完的授权。

`Vault.sol`（V1）原样保留在仓库里，作为"这个发现修复前长什么样"的对照记录；生产环境请使用 `VaultV2`。

**部署与真实链上证明（Fuji）：**

| 项目 | 值 |
|---|---|
| VaultV2 地址 | [`0x0425352bc3c5293D5629c27525969439Ab9C27b5`](https://testnet.snowtrace.io/address/0x0425352bc3c5293D5629c27525969439Ab9C27b5)（复用同一个 MockUSDC，未重新部署代币） |
| EIP-712 Domain | `name="MiniDexVault"`, `version="2"`, `chainId=43113` |
| 真实撮合 + 链上 `settleWithAuthorization` 交易 | [`0x100c315fe8629b419965afac43747157491ecc5ef7ca242480546923bc263849`](https://testnet.snowtrace.io/tx/0x100c315fe8629b419965afac43747157491ecc5ef7ca242480546923bc263849)，trader B 携带自签授权买入 10 units @2500，链上余额从 100/100 USDC 变为 99.975/100.025 USDC |
| 伪造签名被合约拒绝的证明 | 用无关私钥签一份"声称是买方授权"的签名直接对合约发起 `settleWithAuthorization`，`cast`/`eth_call` 返回自定义错误选择器 `0x8baa579f`（`InvalidSignature()`），证明防护在合约层强制生效 |

服务端新增 `VAULT_ABI_VERSION=v1|v2` 开关（`server/.env`）在两套结算逻辑间切换，`GET /settlement/domain`
返回 EIP-712 domain/types 给客户端签名，`POST /orders` 在 v2 模式下要求买单附带 `authorization`
对象。v1 模式的历史行为经 `server/test-e2e.mjs` 完整回归验证未受影响。合约测试见
`contracts/test/VaultV2.t.sol`（9/9 通过，覆盖有效签名、同一 nonce 多笔部分成交、超额度、过期、
用户撤销、伪造签名、非 operator 调用等场景）。完整设计动机、风险收窄分析见 `SECURITY_REVIEW.md`
Finding #4。

## 四、学习资源

- Foundry Book（测试、fork、fuzzing）：https://book.getfoundry.sh/
- dYdX v3 架构文档（链下撮合 + 链上结算的参考实现）：https://docs.dydx.exchange/
- Primit 产品与文档：https://primit.io
- 订单簿撮合算法讲解（price-time priority / pro-rata）：https://www.investopedia.com/terms/p/pricetimepriority.asp
- 自成交保护（STP）模式对比（不同交易所的实现差异）：https://www.cmegroup.com/education/self-match-prevention.html
- wagmi / viem（前端接钱包库）：https://wagmi.sh / https://viem.sh
- better-sqlite3 文档：https://github.com/WiseLibs/better-sqlite3
