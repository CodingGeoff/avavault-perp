# AvaVault Perp 合约（Foundry）

合约说明、部署地址与链上证据见上一级目录的 `../README.md`。本文件只讲怎么在本地
把合约编译、测试跑起来。

## 合约一览

| 文件 | 作用 |
| --- | --- |
| `src/RWAToken.sol` | RWA 收益权代币（SRT-RWA） |
| `src/MultiCollateralVault.sol` | 多抵押金库 V1（瞬时价估值 + operator 结算，保留作对照） |
| `src/MultiCollateralVaultV2.sol` | 多抵押金库 V2（TWAP 估值 + EIP-712 签名授权结算），已部署 Fuji |
| `src/TwapOracle.sol` | 基于 UniswapV2 累积价格的 TWAP 预言机 |
| `src/PerpMarginAccount.sol` | 把抵押估值在合约层绑成永续仓位保证金：仓位/杠杆/独立标记价强平/保险基金兜底穿仓（**已部署 Fuji**，地址与冒烟证据见 `SMOKE_EVIDENCE.md`） |

## 环境准备（第一次）

```bash
# 1) 安装 Foundry（forge/cast/anvil）
curl -L https://foundry.paradigm.xyz | bash
foundryup

# 2) 在本目录安装依赖（forge-std、OpenZeppelin，与 foundry.toml 的 remappings 对应）
cd hackathon-onchain-finance/contracts
forge install
```

## 编译与测试

```bash
forge build

# 全部测试。其中 PerpMarginAccount 的测试是自包含 Mock（不需要 fork、不需要私钥）：
forge test

# 只跑新合约的测试并看详细日志：
forge test --match-contract PerpMarginAccountTest -vvv

# V1/V2 金库测试基于 Fuji fork，需要先配 RPC：
cp .env.example .env   # 填入 FUJI_RPC_URL（PRIVATE_KEY 只在部署脚本需要）
forge test --match-contract MultiCollateralVaultV2 -vvv
```

`PerpMarginAccount.t.sol` 覆盖：存取与自由保证金限制、RWA 估值在合约层计入
保证金并据此开仓、保证金不足与杠杆越界被拒、仅 operator 可记账、VWAP 入场与
部分平仓盈亏、反手、独立标记价触发强平（罚金入保险基金）、穿仓缺口由保险
基金兜底后记坏账、健康仓位不可强平。

## 部署 PerpMarginAccount（已部署 Fuji ✅）

合约层仓位保证金系统已经真实部署到 Fuji 测试网，并做完了
**存款 → 开仓 → 改标记价 → 强平** 的链上冒烟：

| 合约 | 地址 |
|---|---|
| `PerpMarginAccount` | [`0xB329713EbF8c72a3ffD5605fa720482c58601610`](https://testnet.snowtrace.io/address/0xB329713EbF8c72a3ffD5605fa720482c58601610) |
| `SimpleMarkOracle`（独立标记价） | [`0x713Ef730F1f04350752e3684Af0ebDF4288eC482`](https://testnet.snowtrace.io/address/0x713Ef730F1f04350752e3684Af0ebDF4288eC482) |

四个动作的交易哈希、链上读数前后对照、以及"三条命令自己复核"的复现步骤，全部在
[`SMOKE_EVIDENCE.md`](./SMOKE_EVIDENCE.md)；机器可读证据在 `smoke/`，地址清单在
`deployments/fuji.json`（前端合约面板与本文档引用同一份）。

需要重跑冒烟或换机部署时：

```bash
cp .env.example .env      # 填 PRIVATE_KEY（部署钱包，需要少量 Fuji 测试 AVAX 与 mUSDC）
source .env

# 重跑冒烟（存款 → 开仓 → 改标记价 → 强平，四个动作各一笔真实交易）
bash script/smoke_perp_margin.sh

# 需要重新部署时（脚本里有默认参数，部署前按当时市价核对 QUOTE_PRICE_E6）
forge script script/DeployPerpMarginAccount.s.sol:DeployPerpMarginAccount \
  --rpc-url $FUJI_RPC_URL --broadcast --private-key $PRIVATE_KEY
```

部署/冒烟用到的参数：`MARGIN_TOKEN`（mUSDC）、`COLLATERAL_VAULT`（已部署的
`MultiCollateralVaultV2`）、`QUOTE_PRICE_E6`（quote 代币美元价 ×1e6，部署当天 WAVAX ≈
$9.62 → `9620000`）、`INITIAL_MARK_PRICE`（2500，与演示盘口同锚）。部署后记得把
`deployments/fuji.json`、`SMOKE_EVIDENCE.md`、前端合约面板与项目 README 的部署记录同步更新——
未复核前不要对外宣称已上线。

---

## Foundry

**Foundry is a blazing fast, portable and modular toolkit for Ethereum application development written in Rust.**

Foundry consists of:

- **Forge**: Ethereum testing framework (like Truffle, Hardhat and DappTools).
- **Cast**: Swiss army knife for interacting with EVM smart contracts, sending transactions and getting chain data.
- **Anvil**: Local Ethereum node, akin to Ganache, Hardhat Network.
- **Chisel**: Fast, utilitarian, and verbose solidity REPL.

## Documentation

https://book.getfoundry.sh/

## Usage

### Build

```shell
$ forge build
```

### Test

```shell
$ forge test
```

### Format

```shell
$ forge fmt
```

### Gas Snapshots

```shell
$ forge snapshot
```

### Anvil

```shell
$ anvil
```

### Deploy

```shell
$ forge script script/Counter.s.sol:CounterScript --rpc-url <your_rpc_url> --private-key <your_private_key>
```

### Cast

```shell
$ cast <subcommand>
```

### Help

```shell
$ forge --help
$ anvil --help
$ cast --help
```
