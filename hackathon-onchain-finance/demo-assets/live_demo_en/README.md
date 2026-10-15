# 完整操作 Demo 视频（英文配音）· Live Demo, English Narration

**文件**：`avavault-perp-live-demo-en.mp4` · 1920×1080 · 25 fps · H.264 + AAC · 3 分 30 秒
**内容**：把 demo 网站完整跑一遍——连接钱包 → 存入 mUSDC 保证金 → 存入 SRT-RWA 抵押 →
测算对冲 → 下单成交 → 链上结算 → Snowtrace 验证 → 仓位 / 合约层保证金面板。
**全程真实**：真实钱包（私钥在本地注入浏览器）、真实撮合引擎、真实 Avalanche Fuji 链上交易，
不是幻灯片也不是摆拍。与 `avavault-perp-pitch-*.mp4`（讲稿式 Pitch 视频）互补：这一版是操作实录。

---

## 一、视频里真实发生的 6 笔链上交易（可在 Snowtrace 逐笔复核）

| # | 动作 | 交易哈希 | 区块 | 合约 |
|---|---|---|---|---|
| 1 | 领取 1,000 mUSDC（faucet） | [`0x4748bf42…4fb58`](https://testnet.snowtrace.io/tx/0x4748bf42b8e0845b85799fd25c4ed0e1d6fc9a13ef0296204f82b633bec4fb58) | 59514528 | MockUSDC |
| 2 | 授权 VaultV2 划转 | [`0xf2ce8288…5330e`](https://testnet.snowtrace.io/tx/0xf2ce8288da98cd030f290a436dd44325db3c7fc0070ca5bd4ae89d52f7e5330e) | 59514531 | MockUSDC |
| 3 | 存入 1,000 mUSDC 保证金 | [`0x9328ca7e…f8ce7`](https://testnet.snowtrace.io/tx/0x9328ca7e0e5a48993c7fd5003ac40bb8d5a76c970ac9f5d39057e15eed7f8ce7) | 59514533 | VaultV2 |
| 4 | 授权 MultiCollateralVaultV2 划转 RWA | [`0x8c39bf16…de35f`](https://testnet.snowtrace.io/tx/0x8c39bf162a8515c98ff5279e9ca8647281a0148f3eeda1a80f3b0881882de35f) | 59514538 | RWAToken |
| 5 | 存入 100 SRT-RWA 抵押 | [`0xaac81783…f1a5d`](https://testnet.snowtrace.io/tx/0xaac817834758fb876ec88c7a5e1535444796fb0c47ab91393347029e7f1a5d93) | 59514540 | MultiCollateralVaultV2 |
| 6 | **成交后的链上净额结算**（EIP-712 授权 + operator 提交） | [`0x0a25c317…0edd3`](https://testnet.snowtrace.io/tx/0x0a25c31786ed479d88a2e4790cda5fdd4db1a4fb447a54f3448d935341a0edd3) | 59514566 | VaultV2 |

前 5 笔由演示钱包 `0xF7ac5cF5D95256E960DF21229B140edFE31b5c9b` 发出；第 6 笔由撮合服务的
operator 钱包在成交瞬间自动发出（买方签名授权、operator 执行）。

成交明细（服务端记录，与第 6 笔哈希对应）：

```
trade-1  价格 2499 × 数量 99
买方 0x25e95715712aa2f94793cB81e797F03044Ae9F50（演示做市钱包）
卖方 0xF7ac5cF5D95256E960DF21229B140edFE31b5c9b（视频里的演示账户）
settledTxHash 0x0a25c31786ed479d88a2e4790cda5fdd4db1a4fb447a54f3448d935341a0edd3
```

结算后的两张仓位（撮合引擎读数）：

| 账户 | 方向 | 数量 | 入场价 | 占用保证金 | 强平价 |
|---|---|---|---|---|---|
| 卖方（演示账户） | Short | 99 | 2499 | 49,481 | 2856 |
| 买方（做市钱包） | Long | 99 | 2499 | 247,401 | 0 |

---

## 二、画面时间轴

| 时间 | 场景 | 说明 |
|---|---|---|
| 00:00–00:05 | 片头 | 标题卡 |
| 00:05–00:23 | Step 1 · 页面就绪 | API 已就绪（链上结算已开启）；页面自动读取合约层保证金面板 |
| 00:23–00:39 | Step 2 · 订单簿 | 双边深度 2499 / 2501（演示做市钱包铺的真实挂单，VaultV2 里有 1000 mUSDC） |
| 00:39–00:55 | Step 3 · 连接钱包并登录 | 只签名一条登录消息，不动资金；显示链上保证金余额与 RWA 余额 |
| 00:55–01:12 | Step 4 · 存入稳定币保证金 | 3 笔真实交易（领取 / 授权 / 存入 1,000 mUSDC） |
| 01:12–01:48 | Step 5 · 存入 RWA 抵押 | 2 笔真实交易；TWAP 窗口未热身 → 估值如实显示 0 且明确标注"不计入保证金" |
| 01:48–02:05 | Step 6 · 测算对冲仓位 | 名义 250,000 → 建议空单 99；参考价来源：盘口最优卖价 2501 |
| 02:05–02:26 | Step 7 · 下单成交 + 链上结算 | 吃单成交，operator 凭买方 EIP-712 授权在链上结算，日志回显真实哈希 |
| 02:26–02:35 | Step 8 · 我的仓位 | Short 99 @ 2499，占用保证金 49,481，强平价 2856 |
| 02:35–02:43 | Step 9 · 最近成交 | trade-1 已结算（链上结算列标记） |
| 02:43–02:51 | Step 10 · 链上合约面板 | 列出 Fuji 全部部署，含 PerpMarginAccount / SimpleMarkOracle |
| 02:51–03:00 | Step 11 · 合约层保证金 | 独立标记价 2350、保险基金 0.198 mUSDC、累计兜底 0.002 / 坏账 0（实时读链） |
| 03:00–03:24 | Step 12 · Snowtrace 验证 | 打开刚刚那笔结算交易：Status Success，To = VaultV2 |
| 03:24–03:30 | 片尾 | 合约地址卡 |

旁白为英文（合成语音），全程英文字幕，含片头/片尾卡片文案。

---

## 三、英文旁白全文

1. **Introduction** — Hi, this is AvaVault Perp — a perpetual futures margin layer that accepts tokenized real world assets as collateral. I'm running the whole flow live on the Avalanche Fuji testnet, with a real wallet, real transactions, and real on chain settlement. Let's go through it step by step.
2. **Backend + order book** — The page is connected to a local matching engine, which is wired to the contracts deployed on Fuji. The order book already has live depth around a reference price of twenty five hundred, seeded by a demo market maker that holds real test mUSDC in the vault.
3. **Connect wallet** — First, I connect the wallet. Logging in only signs a message — no funds move. The account panel now shows the address, its on chain vault margin balance of one thousand test mUSDC, and whether this wallet is recognized as an asset side account.
4. **Deposit margin** — Next, I deposit stablecoin margin. That fires three real transactions: claim one thousand test mUSDC from the faucet, approve the vault, and deposit. Settlement is charged against the buyer's vault balance, so funding the account is exactly what makes a real on chain fill possible.
5. **RWA collateral + TWAP** — Now the interesting part — collateralizing the real world asset. I approve and deposit one hundred SRT RWA tokens into the MultiCollateralVaultV2. The vault prices collateral with a sixty second time weighted average price instead of a spot price, so a brand new deposit has no value until that window has warmed up. Right now it reads zero — and notice how the interface handles it: the deposit is real, the value is zero, and it is explicitly marked as not counted toward margin. Conservatively reporting zero beats printing a number that could be manipulated.
6. **Hedge sizing** — With collateral in place, I size the hedge. The engine takes the asset value and the hedge ratio, pulls a reference price from the best ask in the book, and returns a suggested short size — ninety nine contracts — together with whether the required margin is covered.
7. **Fill + settlement** — Placing the order crosses the spread and fills immediately against the maker's resting bid. The matching engine then settles that trade on chain: the buyer signs an E I P seven one two authorization, and the operator submits it to the vault. Watch the settlement log — it comes back with a real transaction hash, not a placeholder.
8. **Position + contract panels** — Here is the result: a short position of ninety nine contracts with an average entry of two thousand four hundred and ninety nine, and margin reserved against the position. Recent trades shows the fill, and confirms it is settled on chain. Two panels are worth a closer look. The contracts panel lists every deployment on Fuji, including PerpMarginAccount — the contract level margin engine we deployed earlier today. Its panel reads live from the chain: the independent mark price, the insurance fund balance, and cumulative coverage versus bad debt.
9. **Snowtrace + close** — Finally, the proof. This is the settlement transaction that just landed: status success, on Fuji, verifiable by anyone on Snowtrace. Every hash in this demo was produced live — run it again and the hashes will change, because the trades are real. That is the full loop: real world asset collateral, on chain valuation, perpetual margin, and real settlement. Thanks for watching.

---

## 四、诚实边界（答辩时按这个口径讲）

- 画面 UI 标签仍是中文（录制时只把语言切换器设为 English，语言层未做全量英文化）。**旁白与字幕是英文**；
  数值、按钮、面板无需翻译即可核对。要全英文界面，可补齐 `task7-perp-dex/demo/index.html` 的 `I18N_STATIC` 词条后重录。
- RWA 抵押估值此刻显示 0，是因为 TWAP 窗口刚存入还没热身——这是合约的保守设计（宁可报 0 也不用可被
  操纵的瞬时价），不是故障。视频里如实呈现。
- RWA 估值当前**只展示、不计入**可用保证金（服务端未配置 `MARGIN_QUOTE_USD_PRICE`）；"合约层把 RWA 估值
  当保证金"的完整链路证据在 [`../contracts/SMOKE_EVIDENCE.md`](../contracts/SMOKE_EVIDENCE.md)
  （存款 → 开仓 → 改标记价 → 强平四笔真实交易）。
- 交易标的（2499 / 2501 盘口）是演示市场，不声称与 SRT-RWA 同标的；这一步验证的是仓位测算与结算路径。
- 视频用的是**本地**撮合服务，链上结算走的与线上部署完全相同的 VaultV2 + operator 通道；线上 Render 后端是同一份代码。

---

## 五、怎么复现 / 重录

```bash
# 1) 依赖
cd task7-perp-dex/matching-engine && npm ci && npm run build
cd ../server && npm ci
cd ../demo && npm install && npx playwright install chromium && npx playwright install-deps chromium

# 2) 起服务（本地撮合 + 链上结算；做市钱包需在 VaultV2 里有 mUSDC）
cd ../server && PORT=4000 \
  FUJI_RPC_URL=https://api.avax-test.network/ext/bc/C/rpc \
  VAULT_ADDRESS=0x0425352bc3c5293D5629c27525969439Ab9C27b5 VAULT_ABI_VERSION=v2 \
  OPERATOR_PRIVATE_KEY=$PRIVATE_KEY \
  MULTICOLLATERAL_VAULT_ADDRESS=0xb999cb61A4fb2FE71d1C5FBA7aD506F619dD7884 \
  ADMIN_RESET_TOKEN=local-demo-token DEMO_MAKER_PRIVATE_KEY=$MAKER_KEY \
  DEMO_MID_PRICE=2500 HEDGE_FALLBACK_REF_PRICE=2500 DB_PATH=/tmp/avavault-demo.sqlite \
  node src/index.js
cd ../demo && python3 -m http.server 8080 --bind 127.0.0.1     # 静态页面

# 3) 铺演示盘口
curl -X POST -H 'x-admin-token: local-demo-token' -H 'Content-Type: application/json' \
     -d '{}' http://127.0.0.1:4000/admin/seed-book

# 4) 按旁白节奏录制（英文界面、真实钱包注入）
DEMO_TRADER_KEY=$PRIVATE_KEY node live_demo_en/record_narrated_demo.mjs

# 5) 合成（片头片尾 + 配音 + 字幕；内存小的机器务必单线程）
python3 live_demo_en/post_produce.py
```

本目录内的素材：

| 文件 | 说明 |
|---|---|
| `avavault-perp-live-demo-en.mp4` | 成片 |
| `record_narrated_demo.mjs` | 录制脚本：注入真实钱包（含 `eth_sendTransaction`）、按旁白节奏拍摄、输出场景边界 |
| `post_produce.py` | 合成脚本：逐场景切分（RWA 段 1.228x 轻微降速）→ 片头片尾 → 配音对齐 → 烧英文字幕 |
| `narration.json` | 9 段英文旁白文案（字幕来源） |
| `timing.json` | 旁白实测时长（录制节奏依据） |
| `scenes.json` | 本次录制的场景边界（后期对齐记录） |

> 再次录制会生成**全新的交易哈希**（nonce / 时间戳不同），属正常现象——这正是"真发生"的证据。
