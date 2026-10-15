// 喂价解析 + 标记价预言机重置的单元回归（不拉起服务端、不连链）：
//   node test-feedparse.mjs   （需要先在 ../matching-engine 里 npm run build）
import assert from "node:assert";
import { MarkOracle, parseFeedPrice } from "./src/markOracle.js";

assert.equal(parseFeedPrice(2500), 2500n);
assert.equal(parseFeedPrice({ price: 2500 }), 2500n);
assert.equal(parseFeedPrice({ price: "2500.9" }), 2500n);
assert.equal(parseFeedPrice({ "avalanche-2": { usd: 35.9 } }), 35n); // CoinGecko 形状
assert.throws(() => parseFeedPrice({ price: 0 }));
assert.throws(() => parseFeedPrice({ foo: "bar" }));
assert.throws(() => parseFeedPrice(null));

const oracle = new MarkOracle({});
oracle.addTradeSample(2500n, Date.now());
oracle.reset();
assert.equal(await oracle.getMark(), null); // 重置后无样本可用，不臆造标记价

console.log("PASS  feed price parsing (plain/binance/coingecko shapes, rejects junk)");
console.log("PASS  mark oracle reset clears samples");
