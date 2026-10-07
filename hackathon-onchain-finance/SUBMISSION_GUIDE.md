# 提交操作全流程（照着抄就行）

> 我已经实际打开了官方提交页面 `https://build.avax.network/events/project-submission?event=093982ed-7037-4765-a066-56a5d3cff8cb`
> 看了一遍。提交是一个 **3 步表单（Step 1 of 3）**。
> **第 1 步的字段我是直接看到的、如实记录；第 2、3 步需要登录你自己的账号才能看到内容**，
> 我没有也不应该用你的账号登录，所以第 2、3 步是根据官方页面上明确写的"提交要求"反推的，
> 实际字段名可能略有出入，但大方向（上传仓库链接 + 演示文稿 + 其他材料 → 确认提交）不会错。
> 进去之后如果字段跟我写的对不上，别慌，照着"这一项该填什么"去对应着填就行。

## 开始之前，先把这几样东西准备好放在手边

- [ ] 你 fork 并 push 完代码之后的 **GitHub 仓库链接**（例如 `https://github.com/<你的用户名>/Avalanche-101-Bootcamp`）
- [ ] 两个 Demo 视频文件：`hackathon-onchain-finance/demo-assets/avavault-perp-pitch-zh.mp4`（中文）
      和 `avavault-perp-pitch-en.mp4`（英文），选一个提交，不确定选哪个就都准备着
- [ ] Pitch Deck：`avavault-perp-pitch-zh.pptx` 或 `-en.pptx`
- [ ] 一个能登录的邮箱 / Google 账号 / GitHub 账号（三选一，用来登录 Builder Hub）
- [ ] 5 分钟，不要在最后 10 分钟才开始，上传视频文件需要一点时间

## ⚠️ 关于截止时间的一个提醒

你转发给我的社群公告写的是 **10/7 23:59**，但我刚打开官方页面，上面显示的是
**"Submissions close on October 8, 2026, at 05:59 AM Asia/Shanghai"**——两者差了 6 小时。
**保险起见，按更早的 10/7 23:59 当真正的截止时间来对待**，官方页面多出来的 6 小时当缓冲，
不要当成你还有更多时间。

---

## Step 1 / 3：General Section（项目基本信息）—— 我已实际看到这一步的字段

打开提交链接后，会先要求登录（邮箱验证码 / Google / GitHub 三选一，选你常用的那个）。
登录后进入 Step 1，字段如下：

### Project Name（项目名称）
```
AvaVault Perp
```

### Short Description（一句话简介，建议英文，字数一般有限制，控制在 1-2 句）
```
A margin vault that lets users open perpetual positions directly against real-world-asset (RWA) yield tokens, priced live via an on-chain DEX oracle — no need to sell the RWA to get trading margin.
```
如果平台支持中文或你想交中文版：
```
把"收租金的房子"变成"能交易永续合约的保证金"——用户存入 RWA 收益权代币，由 DEX 实时估值后打折计入保证金，无需先变现即可开仓永续合约。
```

### Full Description（完整项目介绍，可以放长文本，建议中英都准备，用哪个看平台输入框）

英文版（直接复制）：
```
AvaVault Perp lets real-world-asset (RWA) yield tokens — like tokenized real-estate rental
income — be used directly as margin for perpetual futures trading, without forcing the holder
to sell the token first.

Problem: RWA tokens are mostly "dead assets" on-chain — holders can only collect yield, with
poor liquidity and a single use case. Meanwhile perpetual traders need stablecoin or blue-chip
margin; cashing out a yield-bearing token to get that margin means losing the upside exposure.

Insight: if an RWA token has even a thin liquidity pool on a DEX, it has a price any smart
contract can read in real time. We combined three pieces of on-chain finance infrastructure
into one system:
- A DEX price oracle that reads live reserves from a real LFJ V1 pool on Avalanche Fuji
- An RWA token representing real-estate rental income rights (ERC20 + AccessControl)
- A multi-collateral margin vault that values deposited RWA tokens via the DEX oracle, applies
  a haircut, and credits the result as usable margin for a perpetual-trading engine

Everything is really deployed on Avalanche Fuji testnet — the contracts, the deposit
transaction, and a signature-authorized settlement between two counterparties are all
verifiable on Snowtrace. We chose Avalanche specifically because its sub-second finality and
near-zero gas fees make frequent on-chain price reads and margin settlement practical; our real
transactions cost a fraction of a cent in AVAX.

This project reuses and extends three pieces of smart-contract infrastructure (DEX oracle
integration, RWA tokenization, and an off-chain-matching / on-chain-settled perpetual exchange
vault) built during the Avalanche Builder Launchpad bootcamp, fused into a single new product
for the On-chain Finance & Trading track.
```

中文版（如果平台输入框支持中文，或者你想中英双语都贴上去）：
```
AvaVault Perp 让房地产租金收益权这类 RWA 代币，不需要先卖出变现，就能直接作为永续合约的
交易保证金。

问题：RWA Token 大多数时候是"死资产"——持有人只能拿着收分红，流动性差、用途单一；而永续
合约交易者需要稳定币/主流资产作保证金，把收益资产变现换保证金，就意味着卖出、失去原本的
收益敞口。

洞察：只要 RWA Token 在 DEX 上有一个哪怕流动性不深的交易对，它就有一个任何合约都能实时
读取的价格。我们把三块链上金融基础设施拼在了一起：一个从 Avalanche Fuji 上真实 LFJ V1
资金池读取实时储备量的 DEX 价格预言机；一个代表房地产租金收益权的 RWA Token（ERC20 +
AccessControl 权限体系）；一个多抵押品保证金金库，用 DEX 预言机给存入的 RWA Token 估值、
打折后计入可用保证金，供下游的永续合约撮合引擎使用。

全部合约均已真实部署到 Avalanche Fuji 测试网——合约本身、真实的存款交易、以及两个交易对手
之间基于签名授权完成的结算，都可以在 Snowtrace 上直接查证。选择 Avalanche 正是因为它的
亚秒级最终确认和接近于零的 Gas 费，让这种高频读取链上价格、频繁结算保证金的场景真正可行；
我们这次的真实链上交易，手续费都只有几分之一美分的 AVAX。

这个项目复用并扩展了 Avalanche Builder Launchpad 训练营里学到的三块智能合约基础设施
（DEX 价格预言机接入、RWA 代币化、链下撮合+链上结算的永续合约金库），融合成一个面向
链上金融与交易赛道的新产品。
```

### Tracks（赛道选择）
下拉菜单里选：
```
Onchain Finance & Trading
```

### Website（可选）
留空，或者填一个 Snowtrace 上 `MultiCollateralVault` 合约地址的链接，相当于"项目主页"：
```
https://testnet.snowtrace.io/address/0x9128AE5F8cf51eB35A69C29c55B07A7776603b0B
```

### Socials（可选）
如果没有专门为这个项目开 Twitter/X 账号，留空即可，不影响提交。

### Team & Collaboration（团队信息）
- 如果你是单人参赛：这里不用邀请任何人，直接跳过
- 下面有一个勾选框："I consent to share this project's information with Avalanche Team1 so
  they can reach out to offer local support." —— 这是"同意 Team1 联系你提供本地支持/孵化
  资源"，**建议勾选**，对拿到后续生态资源、孵化机会有帮助，不勾选也完全不影响本次评审

填完点 **Continue** 或 **Save & Continue Later**（如果没填完想先保存退出）。

---

## Step 2 / 3：提交链接和文件（根据官方"提交要求"推断，实际字段可能略有不同）

官方在页面上写的硬性要求是：
> "Your project must include a GitHub repo, slides for your pitch, and any additional content."
> "Submit your project through the Avalanche Builder Hub, add your team members, and upload
> your GitHub repo, presentation slides along with any other file that support your submission."

照这个说法，Step 2 大概率是这几类填空：

1. **GitHub 仓库链接**：粘贴你 fork 之后的仓库地址，例如：
   ```
   https://github.com/<你的GitHub用户名>/Avalanche-101-Bootcamp
   ```
   如果要求具体到某个文件夹，可以在链接后面加路径指到 `hackathon-onchain-finance/`，例如：
   ```
   https://github.com/<你的GitHub用户名>/Avalanche-101-Bootcamp/tree/main/hackathon-onchain-finance
   ```

2. **Pitch Deck 上传**：如果是"上传文件"类型的输入框，直接上传
   `avavault-perp-pitch-zh.pptx`（或 `-en.pptx`）。如果输入框只接受 PDF，用 PowerPoint /
   WPS / Keynote 打开这个 pptx 文件，另存为/导出为 PDF 再上传。

3. **Demo 视频**：这一项平台可能是两种形式之一：
   - **直接上传文件**：如果看到"上传视频"或者"any other file"这样的输入框，直接把
     `avavault-perp-pitch-zh.mp4`（约 7MB 出头）拖进去。
   - **只能填链接**：如果只有一个 URL 输入框，你需要先把视频传到一个公开可访问的地方再贴
     链接过去，推荐这几个（任选一个）：
     - YouTube：上传时选"不公开列出 Unlisted"（不是 Private，Private 别人打不开），拿到
       分享链接
     - B 站：设为"仅自己可见"通常评审也打不开，建议设为公开或"好友可见"里选对外
     - Google Drive：上传后右键"获取链接"，权限改成"知道链接的任何人可查看"

4. **"any other file"（其他支持材料）**：如果还有一个"额外文件"的位置，可以把
   `hackathon-onchain-finance/README.md` 导出成 PDF 一并上传，或者干脆留空，不是必填项。

## Step 3 / 3：Review & Submit（预览确认）

大概率是把前两步填的内容汇总展示一遍，让你最后检查。确认：
- 项目名称、简介没有错别字
- GitHub 链接点开能访问（不是 404，不是私有仓库）
- 视频链接能正常播放
- 选的赛道是 **Onchain Finance & Trading**

确认无误后点 **Submit**。提交完成后页面应该会有成功提示，建议顺手截一张图留底。

---

## 提交完之后

- 去活动的 Telegram/微信群里报备一声"已提交"，方便万一系统出问题时有人能帮你核实
- 入围名单、是否需要你本人出面做现场 Demo、以及获奖公布的具体日期，以活动群里的最新通知
  为准——我手头没有能验证这几个日期的可靠信息来源，这里不编造具体时间，请留意群公告
