# OKX 全市場市場掃描器 Phase 1

私人使用的人工決策輔助系統。Phase 1 只建立 OKX 公開市場資料層，不執行任何交易。

## 1. 安全邊界

- 只使用 OKX Public Market Data。
- 不使用 OKX Private API。
- 不使用 API Key、Secret Key、Passphrase。
- 不登入、不會員、不付款、不 VIP、不廣告。
- 不自動下單、不自動平倉、不執行任何交易。
- 不建立 LONG / SHORT 訊號。
- 不宣稱盈利能力、勝率或投資結果。

## 2. 官方 API 定義

API 規格唯一以 OKX 官方 API V5 文件為準：
https://www.okx.com/docs-v5/en/

OKX 官方文件將 Public Data REST API 定義為不需要 authentication。

### REST API

| 功能 | Endpoint | Phase 1 |
|---|---|---|
| Instruments | `GET /api/v5/public/instruments?instType=SWAP` | 已實作 |
| Tickers | `GET /api/v5/market/tickers?instType=SWAP` | 已實作 |
| Ticker | `GET /api/v5/market/ticker?instId=...` | 已實作 |
| Candles | `GET /api/v5/market/candles` | 已實作 |
| History Candles | `GET /api/v5/market/history-candles` | Client 已實作 |
| Trades | `GET /api/v5/market/trades` | 已實作 |
| History Trades | `GET /api/v5/market/history-trades` | Client 已實作 |
| Open Interest | `GET /api/v5/public/open-interest` | 已實作 |
| Funding Rate | `GET /api/v5/public/funding-rate` | 已實作 |
| Funding History | `GET /api/v5/public/funding-rate-history` | 已實作 |
| Order Book | `GET /api/v5/market/books` | 已實作 |

### Public WebSocket

- URL：`wss://ws.okx.com:8443/ws/v5/public`
- `open-interest`
- `funding-rate`
- `liquidation-orders`

`liquidation-orders` 官方定義為近期強平訂單，不代表 OKX 全部強平總量。資料的 `details` 內含 `side`、`bkPx`、`sz`、`ts`；本專案只保存官方欄位對應的 symbol、side、price、size、timestamp。

## 3. 市場清單

不寫死 BTC、ETH、SOL 等交易對。

啟動時呼叫 Public Instruments：

`instType=SWAP`

只保留：

- `state=live`
- `quoteCcy=USDT` 或 `settleCcy=USDT`

因此市場數量完全依 OKX 當時 Public Instruments API 回傳結果決定。

## 4. K 線

支援：

- 5m
- 15m
- 1H
- 4H

標準化欄位：

```text
timestamp
open
high
low
close
volume
volumeCurrency
volumeQuote
confirmed
```

OKX K 線原始資料為 `[ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm]`。`vol` 對衍生品為合約數量；`volCcy` 對衍生品為基礎貨幣數量；`volCcyQuote` 為報價貨幣數量。`confirm=0` 代表未完成，`confirm=1` 代表完成。

後端以 Unix milliseconds 儲存；前端以 `Asia/Taipei` 顯示。

## 5. Ticker / Volume

Ticker 使用：

- `last` → price
- `open24h` → 24H 漲跌計算基準
- `volCcy24h` → Volume，對 SWAP 為 base currency
- `vol24h` → contract volume
- `ts` → timestamp

Dashboard 將 Volume 標示為「幣」，避免把 contract volume 誤稱為 USDT volume。若需要 USDT 報價成交量，使用 K 線的 `volCcyQuote`，不是 Ticker 的 `volCcy24h`。

## 6. Open Interest

OKX Public Open Interest 欄位：

- `oi`：合約數量
- `oiCcy`：幣的數量
- `oiUsd`：USD 數量

Dashboard 主 OI 使用 `oiUsd`，單位明確標示 USD。

5M / 15M / 1H 不使用虛構歷史資料。伺服器只比較啟動後實際採樣的 `oiUsd`：

- 尚未累積指定時間 → `【資料不足，無法確認】`
- 不從 K 線推導 OI
- 不從其他交易所補 OI
- 不把目前 OI 重複當成歷史 OI

## 7. Funding

支援：

- Current Funding Rate
- Funding Time
- Next Funding Time
- Funding History

OKX 官方 Funding History 可回傳最多三個月資料。本專案不自行推算 Funding。

## 8. Trades

標準化：

```text
timestamp
price
size
side
tradeId
source
```

`side` 保留 OKX 官方欄位值，不自行重新解釋成買單或賣單。

## 9. Order Book

標準化：

- bids
- asks
- Bid Volume
- Ask Volume
- Bid/Ask Ratio
- Spread

OKX Public Order Book 的衍生品 quantity 為 contracts。Order Book 是掛單資料，不代表實際成交或真實資金流。

## 10. Cache / Rate Limit / Error Handling

所有 REST 公開資料經中央 request limiter，並搭配 TTL cache、timeout、retry、exponential backoff。

主要 OKX 官方 REST 限速（文件目前版本）：

- Instruments：20 requests / 2 seconds
- Tickers：20 requests / 2 seconds
- Candles：40 requests / 2 seconds
- History Candles：20 requests / 2 seconds
- Trades：100 requests / 2 seconds
- History Trades：20 requests / 2 seconds
- Open Interest：20 requests / 2 seconds
- Order Book：40 requests / 2 seconds

本專案中央 limiter 使用保守的 18 requests / 2 seconds，避免前端大量刷新造成突發 request。

錯誤處理：

- 429：retry + exponential backoff
- 5xx：retry + exponential backoff
- 網路錯誤：有限次 retry
- timeout：有限次 retry
- malformed OKX response：視為失敗
- 最終失敗：`{ok:false,error:"資料暫時無法取得"}`
- 不以 `0` 或 `null → 0` 偽造資料

## 11. WebSocket 穩定性

- 只使用 Public WebSocket。
- reconnect 使用 exponential backoff。
- 最大 reconnect delay：30 秒。
- 斷線不讓 Server 崩潰。
- reconnect 後重新建立 subscriptions。
- subscription batch 去重。
- 支援 `ping` / `pong` heartbeat。
- `liquidation-orders` 解析官方 `details` 結構。

## 12. Dashboard

首頁 `/` 為繁體中文，顯示：

- 市場數量
- 最後更新
- WebSocket 狀態
- 交易對
- 價格
- 24H 漲跌
- Volume（幣）
- OI（USD）
- OI 5M / 15M / 1H
- Funding
- 資料時間

提供：

- 搜尋交易對
- 依 24H 漲跌排序
- 依 Volume 排序
- 依 OI 排序
- 依 Funding 排序

Phase 1 不提供任何交易訊號。

## 13. API Routes

- `GET /api/health`
- `GET /api/instruments`
- `GET /api/markets`
- `GET /api/oi/:instId`
- `GET /api/realtime`
- `GET /api/candles/:instId?bar=5m`
- `GET /api/trades/:instId?limit=100`
- `GET /api/orderbook/:instId?sz=20`
- `GET /api/funding/:instId`
- `GET /api/funding-history/:instId?limit=100`

## 14. Unit Test

目前測試覆蓋：

1. Instruments 過濾
2. K 線 normalization
3. Ticker normalization
4. OI normalization
5. Funding normalization
6. Trade normalization
7. Order Book normalization
8. Cache TTL
9. Request limiter

Mock / unit test 只驗證程式邏輯，不代表 OKX Live API 成功。

## 15. Live OKX API Test

執行環境若沒有網路或無法執行 Node.js，Live OKX API 測試結果必須標示：

`Live OKX API 測試：【資料不足，無法確認】`

禁止以 Unit Test 取代 Live API 測試。

## 16. 執行

```bash
npm install
npm test
npm start
```

預設：`http://localhost:10000`

Node.js：`>=20`

## 17. Phase 1 不包含

- EMA
- RSI
- MACD
- CVD
- Whale Radar
- LONG / SHORT
- 訊號評分
- 回測
- 自動下單
- 自動平倉
- 任何交易執行

Phase 1 唯一目標：建立正確、穩定、可驗證的 OKX 公開市場資料層。
