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
| `src/PerpMarginAccount.sol` | 把抵押估值在合约层绑成永续仓位保证金：仓位/杠杆/独立标记价强平/保险基金兜底穿仓（待部署，测试见下） |

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

## 部署 PerpMarginAccount（可选，测试通过后再做）

部署需要：保证金代币地址、已部署的 `MultiCollateralVaultV2` 地址、一个标记价
预言机地址（`IMarkPriceOracle.getMarkPrice()`）、quote 美元价（放大 1e6）。
先用 `forge script` 写部署脚本或直接用 `forge create`，部署后把新地址登记进
服务端的文档与前端合约面板，并用一笔小额仓位在 Fuji 上做端到端验证后，再在
项目 README 的部署记录里补上地址与交易哈希——未部署前不要对外宣称已上线。

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
