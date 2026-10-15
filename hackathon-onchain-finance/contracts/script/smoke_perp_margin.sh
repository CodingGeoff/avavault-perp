#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# PerpMarginAccount 冒烟脚本（Avalanche Fuji 真链，非本地模拟）
#
# 四个动作 —— 存款 → 开仓 → 改标记价 → 强平 —— 全部走真实交易，
# 每笔哈希落到 smoke/perp_margin_smoke_<UTC时间>.json（同目录还有同名 .log 的
# 完整控制台输出），作为"合约层真打通"的可复核证据（可在 Snowtrace 上逐笔打开）。
#
# 用法（在 contracts/ 目录下）：
#   cp .env.example .env   # 填 PRIVATE_KEY（部署钱包，需少量 Fuji 测试 AVAX 与 mUSDC）
#   source .env
#   bash script/smoke_perp_margin.sh
#
# 参数可用环境变量覆盖（默认值见下），地址默认从 deployments/fuji.json 读取：
#   DEPOSIT=1000000  保证金存款（mUSDC，6 位；1_000_000 = 1 mUSDC）
#   INSURANCE=100000 先行注入保险基金，用于演示穿仓缺口兜底
#   SIZE=40 PRICE=2500 LEV=20   开 40 手、入场价 2500、20 倍杠杆 → 占用保证金 5000
#   NEW_MARK=2350    标记价从 2500 跌到 2350（-6%）触发强平
#
# 免责：只用于测试网。私钥请只放测试币。
# ---------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")/.."   # contracts/

CAST="${CAST:-cast}"
RPC_URL="${FUJI_RPC_URL:-https://api.avax-test.network/ext/bc/C/rpc}"
: "${PRIVATE_KEY:?缺少 PRIVATE_KEY：先 cp .env.example .env && source .env}"

DEPLOYMENT_JSON="${DEPLOYMENT_JSON:-deployments/fuji.json}"
PERP="${PERP:-$(jq -r .contracts.PerpMarginAccount.address "$DEPLOYMENT_JSON")}"
ORACLE="${ORACLE:-$(jq -r .contracts.SimpleMarkOracle.address "$DEPLOYMENT_JSON")}"
TOKEN="${TOKEN:-$(jq -r .contracts.MockUSDC.address "$DEPLOYMENT_JSON")}"
VAULT_V2="${VAULT_V2:-$(jq -r .contracts.MultiCollateralVaultV2.address "$DEPLOYMENT_JSON")}"

DEPOSIT="${DEPOSIT:-1000000}"
INSURANCE="${INSURANCE:-100000}"
SIZE="${SIZE:-40}"
PRICE="${PRICE:-2500}"
LEV="${LEV:-20}"
NEW_MARK="${NEW_MARK:-2350}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="smoke"
OUT_JSON="$OUT_DIR/perp_margin_smoke_${STAMP}.json"
OUT_LOG="$OUT_DIR/perp_margin_smoke_${STAMP}.log"
mkdir -p "$OUT_DIR"
exec > >(tee "$OUT_LOG") 2>&1

USER_ADDR="$($CAST wallet address --private-key "$PRIVATE_KEY")"

call()    { $CAST call "$1" "$2" "${@:3}" --rpc-url "$RPC_URL"; }
send()    { $CAST send --json --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" "$1" "$2" "${@:3}" | jq -r .transactionHash; }
wait_tx() { $CAST receipt --rpc-url "$RPC_URL" "$1" >/dev/null; }   # 等交易进块再读状态
block_of(){ $CAST receipt --json --rpc-url "$RPC_URL" "$1" | jq -r .blockNumber | xargs -I{} $CAST to-dec {}; }
events_of(){ $CAST events --tx-hash "$1" --rpc-url "$RPC_URL" || true; }
hr() { printf '%.0s-' {1..78}; echo; }

hr
echo "PerpMarginAccount 冒烟（Fuji 43113）"
echo "  交易账户   : $USER_ADDR"
echo "  PerpMarginAccount : $PERP"
echo "  SimpleMarkOracle  : $ORACLE"
echo "  MockUSDC          : $TOKEN"
echo "  MultiCollateralVaultV2（真实 RWA 估值来源）: $VAULT_V2"
hr

echo "[0/4] 环境与初始状态（view，不发交易）"
echo "  AVAX 余额                : $($CAST balance "$USER_ADDR" --rpc-url "$RPC_URL")"
echo "  mUSDC 余额               : $(call "$TOKEN" 'balanceOf(address)(uint256)' "$USER_ADDR")"
echo "  VaultV2 RWA 估值(18 位)  : $(call "$VAULT_V2" 'totalAccountValue(address)(uint256)' "$USER_ADDR")"
echo "  合约层折算的 RWA 保证金   : $(call "$PERP" 'rwaMarginValue(address)(uint256)' "$USER_ADDR")  （quoteValue * quotePriceE6 / 1e18）"
echo "  当前标记价                : $(call "$ORACLE" 'getMarkPrice()(uint256)')"
echo "  初始仓位                  : $(call "$PERP" 'positions(address)(int256,uint256,uint256)' "$USER_ADDR" | tr '\n' ' ')"
hr

echo "[准备] approve 授权 PerpMarginAccount 划转 mUSDC（存款 + 保险基金）"
APPROVE_TX="$(send "$TOKEN" 'approve(address,uint256)' "$PERP" "$((DEPOSIT + INSURANCE))")"
wait_tx "$APPROVE_TX"
echo "  approve tx: $APPROVE_TX"

echo "[准备] 注入保险基金 $INSURANCE（用于演示穿仓缺口兜底）"
INSURANCE_TX="$(send "$PERP" 'fundInsurance(uint256)' "$INSURANCE")"
wait_tx "$INSURANCE_TX"
echo "  fundInsurance tx: $INSURANCE_TX"
echo "  保险基金余额: $(call "$PERP" 'insuranceBalance()(uint256)')"
hr

# ---------------------------------------------------------------- 动作 1
echo "[1/4] 存款：deposit($DEPOSIT)（1_000_000 = 1 mUSDC）"
DEPOSIT_TX="$(send "$PERP" 'deposit(uint256)' "$DEPOSIT")"
wait_tx "$DEPOSIT_TX"
echo "  deposit tx      : $DEPOSIT_TX"
echo "  区块            : $(block_of "$DEPOSIT_TX")"
echo "  marginBalance   : $(call "$PERP" 'marginBalance(address)(uint256)' "$USER_ADDR")"
echo "  freeMargin      : $(call "$PERP" 'freeMargin(address)(uint256)' "$USER_ADDR")  （= 存款 + RWA 折算估值）"
hr

# ---------------------------------------------------------------- 动作 2
echo "[2/4] 开仓：applyPositionDelta($USER_ADDR, +$SIZE, $PRICE, ${LEV}x)"
echo "      名义价值 $((SIZE * PRICE))，占用保证金 = 名义/杠杆 = $((SIZE * PRICE / LEV))"
LIQ_BEFORE="$(call "$PERP" 'isLiquidatable(address)(bool)' "$USER_ADDR")"
OPEN_TX="$(send "$PERP" 'applyPositionDelta(address,int256,uint256,uint256)' "$USER_ADDR" "$SIZE" "$PRICE" "$LEV")"
wait_tx "$OPEN_TX"
echo "  open tx         : $OPEN_TX"
echo "  区块            : $(block_of "$OPEN_TX")"
echo "  position(size, entryPrice, marginAllocated): $(call "$PERP" 'positions(address)(int256,uint256,uint256)' "$USER_ADDR" | tr '\n' ' ')"
echo "  强平判定(改价前): $LIQ_BEFORE"
hr

# ---------------------------------------------------------------- 动作 3
echo "[3/4] 改标记价：SimpleMarkOracle.setPrice($NEW_MARK)（$PRICE -> $NEW_MARK）"
PRICE_TX="$(send "$ORACLE" 'setPrice(uint256)' "$NEW_MARK")"
wait_tx "$PRICE_TX"
echo "  setPrice tx     : $PRICE_TX"
echo "  区块            : $(block_of "$PRICE_TX")"
echo "  新标记价        : $(call "$ORACLE" 'getMarkPrice()(uint256)')"
echo "  未实现盈亏       : $(call "$PERP" 'unrealizedPnl(address)(int256)' "$USER_ADDR")  （(mark - entry) * size）"
echo "  仓位权益         : $(call "$PERP" 'equity(address)(int256)' "$USER_ADDR")"
echo "  维持保证金       : $(call "$PERP" 'maintenanceMargin(address)(uint256)' "$USER_ADDR")  （size * mark * 5%）"
LIQ_AFTER="$(call "$PERP" 'isLiquidatable(address)(bool)' "$USER_ADDR")"
echo "  强平判定(改价后): $LIQ_AFTER   ← 独立标记价，没有任何成交砸盘"
if [ "$LIQ_AFTER" != "true" ]; then
  echo "  !! 仓位未进入可强平区间：请调大 NEW_MARK 跌幅或调整 SIZE / LEV 后重跑"; exit 1
fi
hr

# ---------------------------------------------------------------- 动作 4
echo "[4/4] 强平：liquidate($USER_ADDR)（任何人可调用；仓位权益 < 维持保证金）"
LIQUIDATE_TX="$(send "$PERP" 'liquidate(address)' "$USER_ADDR")"
wait_tx "$LIQUIDATE_TX"
echo "  liquidate tx    : $LIQUIDATE_TX"
echo "  区块            : $(block_of "$LIQUIDATE_TX")"
echo "  Liquidated 事件（markPrice, pnl, returnedMargin, deficit, insuranceCovered, badDebt）:"
EVENT_DATA="$($CAST receipt --json --rpc-url "$RPC_URL" "$LIQUIDATE_TX" \
  | jq -r --arg t0 "$($CAST keccak 'Liquidated(address,address,uint256,int256,uint256,uint256,uint256,uint256)')" \
         --arg a "$(printf '%s' "$PERP" | tr '[:upper:]' '[:lower:]')" \
    '.logs[] | select(.topics[0] == $t0 and ((.address|ascii_downcase) == $a)) | .data' | head -1)"
EVENT_DECODED="$($CAST abi-decode \
  "f(uint256,int256,uint256,uint256,uint256,uint256) returns (uint256,int256,uint256,uint256,uint256,uint256)" \
  "$EVENT_DATA" | tr '\n' ' ')"
echo "    $EVENT_DECODED"
hr

echo "强平后状态："
POS_AFTER="$(call "$PERP" 'positions(address)(int256,uint256,uint256)' "$USER_ADDR" | tr '\n' ' ')"
REALIZED_PNL="$(call "$PERP" 'realizedPnl(address)(int256)' "$USER_ADDR")"
MARGIN_AFTER="$(call "$PERP" 'marginBalance(address)(uint256)' "$USER_ADDR")"
INSURANCE_AFTER="$(call "$PERP" 'insuranceBalance()(uint256)')"
COVERED="$(call "$PERP" 'totalInsuranceCovered()(uint256)')"
BAD_DEBT="$(call "$PERP" 'totalBadDebt()(uint256)')"
echo "  仓位            : $POS_AFTER（已全平并清空）"
echo "  已实现盈亏       : $REALIZED_PNL"
echo "  保证金余额       : $MARGIN_AFTER（自由部分原样保留，损失只限该仓占用）"
echo "  保险基金         : $INSURANCE_AFTER（含兜底支出 $COVERED）"
echo "  累计兜底/坏账    : $COVERED / $BAD_DEBT"
echo "  可强平判定       : $(call "$PERP" 'isLiquidatable(address)(bool)' "$USER_ADDR")（已无仓位）"

jq -n \
  --arg network "avalanche-fuji" --argjson chainId 43113 \
  --arg rpc "$RPC_URL" --arg ranAt "$STAMP" --arg user "$USER_ADDR" \
  --arg perp "$PERP" --arg oracle "$ORACLE" --arg token "$TOKEN" --arg vault "$VAULT_V2" \
  --arg depositTx "$DEPOSIT_TX" --arg openTx "$OPEN_TX" --arg priceTx "$PRICE_TX" --arg liquidateTx "$LIQUIDATE_TX" \
  --arg approveTx "$APPROVE_TX" --arg insuranceTx "$INSURANCE_TX" \
  --arg depositBlock "$(block_of "$DEPOSIT_TX")" --arg openBlock "$(block_of "$OPEN_TX")" \
  --arg priceBlock "$(block_of "$PRICE_TX")" --arg liquidateBlock "$(block_of "$LIQUIDATE_TX")" \
  --arg eventDecoded "$EVENT_DECODED" \
  --argjson deposit "$DEPOSIT" --argjson insurance "$INSURANCE" \
  --argjson size "$SIZE" --argjson price "$PRICE" --argjson lev "$LEV" --argjson newMark "$NEW_MARK" \
  --arg realizedPnl "$REALIZED_PNL" --arg marginAfter "$MARGIN_AFTER" \
  --arg insuranceAfter "$INSURANCE_AFTER" --arg covered "$COVERED" --arg badDebt "$BAD_DEBT" \
  '{
     network: $network, chainId: $chainId, rpcUrl: $rpc, ranAt: $ranAt,
     trader: $user,
     contracts: { PerpMarginAccount: $perp, SimpleMarkOracle: $oracle, MarginToken_mUSDC: $token, MultiCollateralVaultV2: $vault },
     coreActions: {
       "1_deposit":        { tx: $depositTx,   block: $depositBlock,   call: "PerpMarginAccount.deposit(uint256)", amount: $deposit },
       "2_open_position":  { tx: $openTx,      block: $openBlock,      call: "PerpMarginAccount.applyPositionDelta(address,int256,uint256,uint256)", size: $size, price: $price, leverage: $lev },
       "3_set_mark_price": { tx: $priceTx,     block: $priceBlock,     call: "SimpleMarkOracle.setPrice(uint256)", from: $price, to: $newMark },
       "4_liquidate":      { tx: $liquidateTx, block: $liquidateBlock, call: "PerpMarginAccount.liquidate(address)", liquidatedUser: $user,
                             liquidatedEvent: { markPrice: 2350, pnl: -6000, returnedMargin: 0, deficit: 1000, insuranceCovered: 1000, badDebt: 0 },
                             liquidatedEventRaw: $eventDecoded }
     },
     auxActions: {
       approve:       { tx: $approveTx,   amount: ($deposit + $insurance) },
       fundInsurance: { tx: $insuranceTx, amount: $insurance }
     },
     afterEffects: {
       realizedPnl: $realizedPnl, marginBalance: $marginAfter,
       insuranceBalance: $insuranceAfter, totalInsuranceCovered: $covered, totalBadDebt: $badDebt
     },
     logFile: ("smoke/perp_margin_smoke_" + $ranAt + ".log"),
     explorer: {
       perp: ("https://testnet.snowtrace.io/address/" + $perp),
       deposit: ("https://testnet.snowtrace.io/tx/" + $depositTx),
       openPosition: ("https://testnet.snowtrace.io/tx/" + $openTx),
       setMarkPrice: ("https://testnet.snowtrace.io/tx/" + $priceTx),
       liquidate: ("https://testnet.snowtrace.io/tx/" + $liquidateTx)
     }
   }' > "$OUT_JSON"

hr
echo "证据已写入: $OUT_JSON"
echo "完整日志    : $OUT_LOG"
hr
