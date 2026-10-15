# 演示彩排手册 + 深度审查结论（2026-10-15）

> 回答三件事：①今天按正式流程彩排会不会干扰今晚正式演示；②为什么每次哈希都不一样；
> ③外部评审列出的 11 条优化逐条核实后的真实状态、这次改了什么、还剩什么。

---

## 一、彩排会不会干扰正式演示？会，分三层

### 1. 链上层（不可逆，但影响小、可控）
- **每笔成交都是一笔真实 Fuji 交易**：服务端 operator 调用 `VaultV2.settleWithAuthorization`，
  买方 Vault 余额减少、卖方增加，金额 = 成交价 × 数量（最小单位）。以演示口径
  2500 × 10 = 25000 最小单位 = **0.025 mUSDC/笔**，而一次存款是 1,000 mUSDC，
  彩排几十笔也耗不完。**风险低，但余额数字会和截图对不上**——正式演示前重新点一次
  "领取并存入保证金"即可把余额顶回整齐数字。
- **EIP-712 授权是一次性额度**：前端每笔买单都用 `Date.now()+随机数` 生成新 nonce 重新签名，
  彩排不会把正式演示的授权"用掉"。✅ 无干扰。
- **operator 钱包 gas**：每笔结算消耗少量 Fuji 测试 AVAX。彩排几十笔无碍，但正式演示前
  应确认 operator 地址 AVAX 余额 > 0.1（水龙头可补）。
- **RWA 金库 TWAP 需要热身 + 显式推进**：`MultiCollateralVaultV2.deposit()` 会尽力调用 `pokeOracle`，
  但如果离上一个 checkpoint 不到 60 秒，更新会静默返回 false；时间到后 `view` 读取也不会自行推进。
  当前演示页新增“推进 TWAP 并刷新估值（链上）”按钮：窗口到期后点一次，确认交易，再刷新账户读数。
  若要在台上展示，至少提前一个窗口（当前 60 秒；生产建议 10–30 分钟）完成存款与 oracle 更新。

### 2. 服务端层（会污染，这次已加一键重置）
SQLite + 内存里会留存：未成交的 GTC 挂单、净仓位（方向/入场价/占用保证金）、成交历史、
标记价 TWAP 样本、资金费时钟、登录会话。后果：
- 彩排留下的仓位会让正式演示一开场就带着旧仓位、旧强平价；
- 盘口里彩排的挂单还在，评委下单可能先吃到彩排的单，成交价和话术对不上；
- Render 免费层重启**不会**自动清空（订单/仓位/会话都落了库），不能靠"重启大法"。

**这次新增的解决办法**：`POST /admin/reset-demo`（需在 Render 环境变量设置
`ADMIN_RESET_TOKEN` 后才开启，请求带 `x-admin-token` 头）一键清空订单簿/成交/仓位/
保险基金/标记价样本（保留登录会话，钱包不用重签）。正式演示前执行一次即可回到干净状态：

```bash
curl -X POST https://avavault-perp-dex-api.onrender.com/admin/reset-demo \
  -H "x-admin-token: <你的 ADMIN_RESET_TOKEN>"
```

链上余额它清不掉（也不该清）——按上面链上层的方法重新存款顶回即可。

### 3. 前端/环境层
- 登录会话已落库且 7 天有效，服务端重启不用重新签；但**换浏览器/清缓存**仍要重新连接钱包。
- Render 免费层 15 分钟无流量会休眠，冷启动 30–50 秒。正式演示前 10 分钟先打开页面
  把 API 唤醒（页面有自动重试），或按 DEPLOY.md 挂 UptimeRobot 保活。

**结论：今天可以放心按正式流程彩排，前提是正式开演前做一遍下面的检查清单。**

### 正式演示前 15 分钟检查清单
- [ ] 打开演示页，等 API 状态显示"已就绪（链上结算已开启）"（冷启动预留 1 分钟）
- [ ] `POST /admin/reset-demo` 清掉彩排状态，刷新页面确认盘口/仓位/成交为空
- [ ] 钱包重新领取+存入 1,000 mUSDC，确认 Vault 余额为整数
- [ ] 确认 operator AVAX 余额、钱包 Fuji 网络（43113）
- [ ] （如展示 RWA 估值）提前完成 RWA 存款并等满一个 TWAP 窗口
- [ ] 录屏备份在手边（demo-assets 里已有），现场网络/水龙头出问题时直接切录屏

---

## 二、为什么每次哈希都不一样？这是正常的，不是故障

交易哈希 = 对**已签名交易字节**做 keccak256。同一笔业务每次签名时，以下字段必然不同：
operator 的账户 **nonce**（每笔递增）、gas 价格、交易被打包的区块与时间戳、业务侧的
`tradeRef = keccak(tradeId)`（tradeId 是递增序号）、EIP-712 授权的 nonce/deadline。
**所以两次演示哈希相同反而意味着交易被重放了。** 评委验证真伪看的是：合约地址不变、
Snowtrace 上交易状态 success、事件日志（Settled/Deposited）与余额变化对得上——这些每次都一致。
PPT/录屏里引用的历史哈希（如 `0x452c…256`）是"某一次真实发生的证明"，现场会生成
**新的**哈希，话术应讲"这是刚刚现场产生的一笔新交易"，不要试图对上 PPT 里的旧哈希。

---

## 三、11 条评审意见逐条核实（很多条其实已经做完了）

| # | 评审意见 | 仓库真实状态 | 这次处理 |
|---|---|---|---|
| 1 | RWA 金库没接进永续保证金 | **合约层已闭环，服务层仍按部署配置**：链上 `PerpMarginAccount`（`0xB329…1610`）已部署 Fuji，直接读 VaultV2 的 `totalAccountValue()`、按 `quotePriceE6` 折算成 mUSDC 计入可用保证金，存款→开仓→改标记价→强平四个动作均有真实交易（`hackathon-onchain-finance/contracts/SMOKE_EVIDENCE.md`）；服务层 Render 侧仍缺 quote→mUSDC 换算（`MARGIN_QUOTE_USD_PRICE` 未配置时估值只展示、不计入 `effectiveMargin`）。 | 现场话术以合约层为准（可当场打开 Snowtrace 逐笔复核）；不要把静态 `MARGIN_QUOTE_USD_PRICE` 当作安全生产预言机；服务层启用前仍需补带新鲜度/失效处理的价格源。 |
| 2 | 没有仓位/杠杆/标记价/资金费/强平，只是现货净额结算 | **对链上 Vault 部分成立，对系统整体已过时（链上仓位合约已上线）**：`matching-engine/src/positions.ts` 有净仓位/VWAP 入场/1–20x 杠杆/维持保证金/强平价，`markOracle.js` 是"外部喂价 > 成交 TWAP > 最新价"的独立标记价，资金费按标记价对指数价溢价结算（无独立指数时费率恒 0），强平有罚金入保险基金+穿仓兜底+坏账记账，且全部落库可恢复。准确的话术仍建议用"**永续交易的保证金与结算层 + 链下仓位引擎**"，因为仓位状态在链下、链上只结算净额。 | 话术边界写入本手册；链上版 `PerpMarginAccount.sol` 已部署 Fuji 并跑通完整链路（见 `contracts/SMOKE_EVIDENCE.md`），但服务端撮合仍走链下仓位引擎 + 链上净额结算，两者尚未接成一条流水线 |
| 3 | 价格来源单一、池子薄、固定 70% 静态折价 | TWAP 防同笔操纵成立；"持续操纵整个窗口+浅池"确实防不住，这是真问题。 | **已改**：动态折价——相邻两个 TWAP 窗口偏离 >10% 后额外打折（封顶再打 5 折），波动越大折扣越狠，且指标本身仍是 TWAP、单笔拉不动（见 `effectiveHaircutBps`）。准入流动性门槛仍未做（需要在 listCollateral 加池子储备下限，建议赛后做）。 |
| 4 | WebSocket 私有频道无鉴权 | **已修复（评审信息滞后）**：私有推送只认登录发放的 sessionToken，只带 `?address=` 的连接只能看公开订单簿。 | 无需改；正式演示话术可主动提这条已修复+有伪造签名回归测试 |
| 5 | 会话存内存、重启掉线、无过期 | **已修复**：会话落 SQLite、7 天过期、重启自动恢复；且有 IP 级限流。不是 JWT，但已是持久化+有过期的服务端会话，效果等同于评审的诉求。 | 无需改 |
| 6 | 部署手工、无 CI | 属实：无 `.github/`，gh-pages 靠手动同步，是真接缝。 | **已改**：新增 `.github/workflows/ci.yml`（撮合引擎 45 测试 + 服务端 5 套集成测试 + 两套合约 forge test）和 `pages.yml`（demo 变更自动发布 gh-pages） |
| 7 | operator 单私钥、owner 权限未收尾 | 属实，且要注意：**DEPLOY.md 里印着 demo operator 私钥**——测试网可接受，但这是会被评委截图的点。V2 的 EIP-712 授权已把 operator 作恶半径限死在"用户签过的额度/期限"内。 | 未改合约权限结构（多签+时间锁是部署配置问题：把 owner/operator 换成 Safe 多签地址即可，合约接口不用改）；**强烈建议把 DEPLOY.md 里的私钥改为"向维护者索取"并轮换该 operator** |
| 8 | 清算引擎是衍生品生死线 | 链下引擎有完整强平链（见 #2）；链上 `PerpMarginAccount.liquidate()` 任何人可触发、只读独立标记价预言机。 | **链上强平已实测**：改标记价 2500→2350 使仓位权益 -1000 跌破维持保证金 4700，`liquidate()` 触发，`Liquidated` 事件显示缺口 1000 全额由保险基金兜底、坏账 0（tx 见 `contracts/SMOKE_EVIDENCE.md`）；开放清算人网络仍待后续 |
| 9 | 前端是 Demo 工具、2500 是静态价、无持仓面板 | **部分过时**：前端已有持仓面板（入场/标记/浮盈/强平价/平仓按钮）、成交历史、价格走势。2500 是做市机器人/种子的参考中间价，标记价实际走 TWAP/外部喂价。缺的是真实 AVAX 指数喂价接入生产。 | **已改一半**：喂价解析已支持 CoinGecko/Binance 形状（`parseFeedPrice`），设 `MARK_PRICE_FEED_URL` 即可接真实价。但注意量纲：当前系统价格是整数口径，接 AVAX 真实价（~$10 量级）会让整个盘口价格体系换锚，**演示期间不要开**，赛后连同价格精度一起改 |
| 10 | RWA 真实化（准入/白名单/证明上链） | 属实，合约只有 owner 登记抵押品这一层，没有发行方白名单与证明存证。 | 未改（商务/合规为主）。建议赛后先在 README 补一节准入流程设计（发行方 KYC→审计报告 IPFS 哈希上链→owner 登记），成本半天、答题硬度提升明显 |
| 11 | 多抵押品只登记了一种、计价还是 WAVAX | 属实，且有一个隐藏 bug 级问题：`totalAccountValue()` 直接相加不同 quote 的估值。 | **已改（防错）**：`listCollateral` 现在拒绝登记与已有抵押品不同 quote 的资产（`QuoteTokenMismatch`），杜绝混加；真正的 USD 统一计价需给每种抵押品配 quote→USD 换算（`PerpMarginAccount.quotePriceE6` 已是单 quote 的雏形），赛后扩展为 per-collateral 价格表 |

## 四、这次审查新发现并顺手修掉的问题
1. **`PerpMarginAccount.withdraw` 可被 RWA-only 用户触发算术 panic，且语义错误**：
   `freeMargin` 计入 RWA 估值，但合约并不持有对应的保证金代币。原逻辑只按 `freeMargin`
   放行，用户只存 RWA 时 `marginBalance -= amount` 直接 underflow（panic 0x11 而非业务错误），
   更深一层等于允许拿 RWA 估值套现保证金代币。已改为可提额 = min(自由保证金, 实际存入余额)，
   并加回归测试 `test_WithdrawRwaOnlyCannotCashOutMarginToken`。
2. **同 quote 约束**（见 #11）：防止未来登记第二种抵押品时无声混加计价单位。
3. **动态折价**（见 #3）与 TwapOracle 的上一窗口均价存储。

## 五、还没做、按性价比排序的待办
1. **部署 `PerpMarginAccount` 到 Fuji 并把地址写进 README**（半天，含部署后冒烟）——直接补上 #1/#8 的最后一公里，是所有待办里对评审感知提升最大的一件。需要部署钱包私钥+Fuji 测试 AVAX，脚本 `DeployPerpMarginAccount.s.sol` 已就绪。注意脚本默认 `QUOTE_PRICE_E6=35_000_000`、初始标记价 2500，部署时按当时 WAVAX 市价改。
2. **轮换 demo operator 私钥并从 DEPLOY.md 移除明文**（10 分钟）——安全观感问题，越早越好。
3. **安全接入 quote→mUSDC 价格源**（不能只填一个静态 `MARGIN_QUOTE_USD_PRICE` 就宣称已完成）——当前页面只展示 WAVAX 计价的 RWA 估值；只有在价格源具备新鲜度/失效保护、精度换算经过测试后，才应让它进入可用保证金。短期演示继续如实标注“未计入”，保持 `MARGIN_ENFORCE=false`。
4. 给 `listCollateral` 加最低流动性门槛（池子储备下限）+ README 补 RWA 准入流程一节。
5. 价格精度改造后接真实 AVAX 指数价（标记价与盘口同锚），再考虑多抵押品 USD 价格表。
6. owner/operator 换多签（Safe）+ 关键参数时间锁。

## 六、本次改动清单（均已跑测试或语法校验）
- 合约：`TwapOracle` 存上一窗口均价；`MultiCollateralVaultV2.effectiveHaircutBps` 动态折价 + 同 quote 登记约束；`PerpMarginAccount.withdraw` 修复 + 回归测试。（沙箱无 forge 且链外网受限，合约测试由新增 CI 在 GitHub 上跑；服务端/引擎测试已本地验证。）
- 引擎：`OrderBook/PositionManager/TwapMarkPrice.reset()` + 2 个新单测（共 45 个全过）。
- 服务端：`/admin/reset-demo`、`parseFeedPrice` 多形状喂价解析、`test-feedparse.mjs`（本地通过）。
- 运维：CI + Pages 自动发布两个 workflow；`render.yaml` 增加 `ADMIN_RESET_TOKEN`（sync:false，不入库明文）。

## 七、演示现场复盘（2026-10-15）

用户贴出的日志显示：钱包登录、mUSDC 领取/授权/存入、RWA 授权/存入都已完成；但三次 `no reference price available` 是 `/hedge/quote` 的测算请求失败，**不是链上交易，也没有 perp 成交或扣款**。失败原因是标记价外部喂价未配、成交历史为空、盘口无最佳买卖价。它与 RWA 金库的 WAVAX-TWAP 抵押估值是两条不同链路。

账户里的 `0.279999999999999999` 是 quote token（当前 WAVAX，18 位小数）计价的 RWA 链上 TWAP 折价估值；不是 0.28 mUSDC。当前服务端没有安全 quote→mUSDC 换算，所以 `effectiveMargin=1000 mUSDC` 只等于 VaultV2 余额，RWA 值虽显示但未计入。页面改为按 4 位小数展示 `0.28 WAVAX`，并在标题提示完整原始值及未计入原因。

本次 UI / 服务端处理：
- 可选“演示导览”默认不显示提词内容；“讲稿”开关才显示讲解要点；可单独重新开始导览，完成检测不会阻止重走。
- 顶部从 1–4 编号教学卡改为一行工作流地图；演示控制台折叠，提供自检、刷新、清空、铺盘、全部重跑和链上提款。提款前检查当前净仓位为 0。
- `/demo/status` 明确核心必需项与可选项；`/hedge/quote` 参考价来源会明示市场数据或配置兜底。无数据时返回每一层缺失原因与补齐方式；前端对旧服务端也会用一个明确标注的本地演示值重试，避免停在裸英文错误上。
- 新增 `/admin/seed-book` 和服务端 `DemoLiquidity`，但只在配置 `ADMIN_RESET_TOKEN` 后开放；买盘带真实 EIP-712 授权，且检查做市钱包 Vault 余额。还新增本地 `demo/seed_counterparty.mjs` 和 `demo/fund_demo_maker.mjs`。
- TWAP 不会“等 60 秒自动更新”：若存入时窗口没到，需等足 60 秒后调用 `pokeOracle`。前端现有单独链上按钮会先预检时间窗，再提交更新交易。
- 页面与讲稿不再声称测试代币是真实房产、配置兜底价是真实行情，或当前合成盘口可以完整对冲 SRT-RWA。

演示稿见仓库根目录 `DEMO_PRESENTATION_SCRIPT.md`。
