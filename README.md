# OKX 全市場市場掃描器 Phase 1

本專案是私人使用的人工決策輔助系統。Phase 1 只負責正確、穩定、可驗證地取得與保存 OKX Public Market Data。

**本專案不執行任何交易。**

## 安全邊界
- 只使用 OKX Public Market Data REST / Public WebSocket。
- 不使用 Private API、API Key、Secret Key、Passphrase、登入、會員、付款、VIP 或廣告。
- 不包含下單、平倉、交易執行或帳戶操作。
- 不產生 LONG / SHORT、買入 / 賣出交易指令。
- Phase 1 不加入 EMA、RSI、MACD、CVD、Whale Radar、回測或自動交易。

## 官方 API
API 規格唯一以 OKX 官方 V5 文件為準：
https://www.okx.com/docs-v5/en/

Public REST：
- `/api/v5/public/instruments?instType=SWAP`
- `/api/v5/market/tickers?instType=SWAP`
- `/api/v5/market/candles`
- `/api/v5/market/history-candles`
- `/api/v5/market/trades`
- `/api/v5/market/history-trades`
- `/api/v5/market/books`
- `/api/v5/public/open-interest?instType=SWAP`
- `/api/v5/public/funding-rate`
- `/api/v5/public/funding-rate-history`

Public WebSocket：`tickers`、`trades`、`open-interest`、`funding-rate`、`liquidation-orders`、`candle5m`。

目前 OKX 官方文件建議 production REST base URL 為 `https://openapi.okx.com`；Public WebSocket 為 `wss://ws.okx.com:8443/ws/v5/public`。不同區域依 OKX 官方 domain 規範處理。citeturn0search1turn0search2

## 市場清單
不硬編碼市場數量。動態取得 `instType=SWAP`，只保留 `state=live` 且 `quoteCcy=USDT` 或 `settleCcy=USDT`。實際數量完全以 OKX 回傳為準。

## 資料標準
K線保留 `[ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm]` 的原始意義並標準化為 timestamp/open/high/low/close/volume/volumeCurrency/volumeQuote/confirmed。`confirm=0` 未完成、`confirm=1` 已完成；timestamp 使用毫秒。資料庫 UTC 儲存，前端 Asia/Taipei 顯示。citeturn2search0

Ticker 對 derivatives 使用 `volCcy24h` 作為 base-currency volume，另保留 `vol24h` contracts 數量；不把 contract volume 說成 USDT volume。citeturn1search0

OI 保存 `oi`、`oiCcy`、`oiUsd`、timestamp。Dashboard 的主 OI 使用 USD。5m、15m、1h 變化必須有真實歷史比較點，沒有足夠資料即顯示 `【資料不足，無法確認】`，不反推 OI。

Funding 提供 current funding、funding time、next funding time、funding history；不自行推算或預測 funding。citeturn2search2

Trades 保存 timestamp、price、size、side、tradeId、source。OKX 官方 `side` 是 taker side，值為 `buy` / `sell`，本專案保留官方語義。citeturn1search0

Order Book 保存 bids、asks、best bid、best ask、spread、bid volume、ask volume、bid/ask ratio、timestamp、seqId。**Order Book 為掛單資料，不代表實際成交。** citeturn1search0

Liquidation Orders 使用 Public WebSocket。OKX 已停止舊平台歷史 liquidation REST endpoint，官方要求使用 WebSocket channel；本專案不宣稱資料代表 OKX 全市場完整爆倉總量。citeturn1search1

## Cache / Rate Limit
所有 REST 經中央 limiter，具備 timeout、有限 retry、exponential backoff、429、5xx 與 malformed response handling，禁止 infinite retry。預設 18 requests / 2 seconds；實際 endpoint limit 仍以 OKX 官方文件為準。citeturn0search0turn1search0

TTL：instruments 5m、ticker 1.5s、candles 5s、OI 5s、funding 30s、funding history 60s、trades 1.5s、order book 1s。

失敗統一回傳：`{"ok":false,"error":"資料暫時無法取得"}`，不以 0 偽造資料。

## WebSocket
具備 subscription 去重、reconnect 後重新訂閱、exponential backoff + jitter、heartbeat ping/pong、斷線不使 HTTP server 崩潰。`candle5m` 使用 Public WebSocket，不使用 Private WebSocket。citeturn0search1turn0search7

## API
- `GET /api/health`
- `GET /api/realtime`
- `GET /api/instruments`
- `GET /api/markets`
- `GET /api/candles/:instId?bar=5m|15m|1H|4H`
- `GET /api/trades/:instId?limit=100`
- `GET /api/orderbook/:instId?sz=10`
- `GET /api/funding/:instId`
- `GET /api/funding-history/:instId?limit=100`
- `GET /api/oi/:instId`
- `GET /api/liquidations/:instId?limit=100`

## Dashboard
繁體中文 Dashboard 提供市場數量、更新時間、WebSocket、資料庫狀態、搜尋、24H/Volume/OI/Funding 排序，以及 Price、24H change、Volume、OI、Funding、K線、Public Trades、Order Book、Liquidation Orders。**不提供交易訊號。**

## 測試
```bash
npm install
npm test
npm start
```
Node `>=20`。Unit Test 與 Live OKX API Test 分開；若執行環境無法實際連線 OKX，Live OKX API Test 必須標示 `【資料不足，無法確認】`。

## Render
Start command：`npm start`。可設定 `DATABASE_URL` 使用 PostgreSQL 持久化；不需要任何 OKX credentials。

## Phase 1 結束條件
只完成 OKX Public REST/WebSocket、動態 SWAP/USDT 市場清單、Ticker、K線、OI、Funding、Trades、Order Book、Liquidation Orders、Cache、Rate Limit、Retry、Error handling、PostgreSQL 與繁體中文 Dashboard。不進入策略、回測或自動交易。
