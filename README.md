# OKX 全市場市場掃描器 Phase 1

私人使用的人工決策輔助系統。只讀取 OKX 公開市場資料，不執行任何交易。

## 安全邊界

- 不使用 OKX 私人帳戶 API。
- 不使用 API Key、Secret Key、Passphrase。
- 不登入、不會員、不付款、不 VIP。
- 不自動下單、不自動平倉。
- 前端不保存任何憑證。

## 官方資料來源

本專案 API 定義以 OKX 官方 API V5 文件為準：https://www.okx.com/docs-v5/en/

OKX 官方文件明確將 Market Data 與 Public Data REST API 定義為不需要身份驗證。

### REST

| 功能 | Endpoint | Phase 1 狀態 |
|---|---|---|
| 永續合約清單 | `GET /api/v5/public/instruments?instType=SWAP` | 已實作；再依 `state=live`、USDT quote/settle 過濾 |
| 全市場 Ticker | `GET /api/v5/market/tickers?instType=SWAP` | 已實作 |
| 單一 Ticker | `GET /api/v5/market/ticker?instId=...` | 已實作 |
| K 線 | `GET /api/v5/market/candles` | 已實作；5m/15m/1H/4H |
| 歷史 K 線 | `GET /api/v5/market/history-candles` | Client 已實作 |
| 最新成交 | `GET /api/v5/market/trades` | 已實作 |
| 歷史成交 | `GET /api/v5/market/history-trades` | Client 已實作 |
| OI | `GET /api/v5/public/open-interest` | 已實作 |
| Funding | `GET /api/v5/public/funding-rate` | 已實作 |
| Funding 歷史 | `GET /api/v5/public/funding-rate-history` | 已實作；官方資料最長 3 個月 |
| Order Book | `GET /api/v5/market/books` | 已實作 |

### WebSocket Public

- URL：`wss://ws.okx.com:8443/ws/v5/public`
- `open-interest`：已實作。
- `funding-rate`：已實作。
- `liquidation-orders`：已實作。
- 以上均不使用私有頻道。

OKX 官方文件指出 liquidation-orders 是「近期強平訂單」資料，不能代表 OKX 全部強平數量；因此本專案不把它標示為全市場總強平量。

## OI 變化的重要限制

OKX 公開 REST `open-interest` 提供目前 OI。Phase 1 不假造 5M/15M/1H 歷史 OI。

本專案的 OI 5M、15M、1H 變化，是伺服器啟動後實際採樣的 OI 與對應時間點比較：

- 未累積滿指定時間：`【資料不足，無法確認】`
- 不從 K 線推導 OI。
- 不從其他交易所補 OI。
- 不把目前 OI 重複填成歷史 OI。

## K 線統一格式

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

後端以 Unix milliseconds / UTC 儲存；前端以台灣時區顯示時間。

## Trades

標準化欄位：

```text
timestamp
price
size
side
tradeId
source
```

`side` 使用 OKX 官方定義的 taker side，不自行推測買賣方向。

## Order Book

標準化並計算：

- bids
- asks
- Bid Volume
- Ask Volume
- Bid/Ask Ratio
- Spread

掛單資料只代表 Order Book，不視為已成交資金。Phase 1 不建立 Whale Radar 或 CVD。

## Cache / Rate Limit / Error Handling

- TTL cache：市場清單、Ticker、K 線、OI、Funding。
- Axios timeout。
- 429、5xx、網路錯誤採 exponential backoff retry。
- API 錯誤回傳 `資料暫時無法取得`，不以 0 取代缺失資料。
- WebSocket disconnect 自動重新連線。

OKX 官方目前文件列出的主要 REST 限速包括：instruments 20 requests/2s；tickers 20 requests/2s；candles 40 requests/2s；history candles 20 requests/2s；trades 100 requests/2s；history trades 20 requests/2s；open interest 20 requests/2s；funding history 10 requests/2s。實際限制仍以 OKX 官方文件當前版本為準。

## Dashboard

首頁：`/`

顯示：

- 市場數量
- 最後更新時間
- 交易對
- 價格
- 24H 漲跌
- Volume
- OI
- OI 5M / 15M / 1H
- Funding

所有 UI 為繁體中文。

## API Routes

- `GET /api/health`
- `GET /api/instruments`
- `GET /api/markets`
- `GET /api/realtime`
- `GET /api/candles/:instId?bar=5m`
- `GET /api/trades/:instId?limit=100`
- `GET /api/orderbook/:instId?sz=20`
- `GET /api/funding/:instId`
- `GET /api/funding-history/:instId?limit=100`

## 執行

```bash
npm install
npm test
npm run start
```

預設：`http://localhost:10000`

## Phase 1 明確不包含

- EMA
- RSI
- MACD
- CVD
- Whale Radar
- 評分
- LONG / SHORT 訊號
- 回測
- 自動交易

## 已知資料限制

1. OKX 公開 OI REST endpoint 提供目前 OI；5M/15M/1H 歷史變化必須由本專案實際採樣累積，首次啟動時無法直接取得完整歷史 OI。
2. Funding 歷史公開資料官方目前最多 3 個月。
3. History Trades 官方目前提供最近 3 個月資料。
4. Liquidation Orders WebSocket 是近期強平訂單流，不代表 OKX 全部強平量。
5. Order Book 是掛單簿，不是成交資料。
6. 「全市場」的即時行情與 OI 可由 bulk endpoint 取得；Trades、Order Book、Funding 的詳細資料是以 instrument 為單位取得或透過 Public WebSocket 訂閱，不把不存在的 bulk historical data 假造成存在。

## 下一階段

只有在 Phase 1 資料層確認穩定後，才建立：價格結構 → 成交資料 → CVD → OI → Volume → 大型成交 → 資金狀態 → 訊號評分 → 歷史回測。

本專案不宣稱任何盈利能力、勝率或投資結果。
