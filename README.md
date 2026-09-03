# OKX 全市場市場研究與決策輔助平台

本專案是私人使用的人工決策輔助系統，只讀取 OKX 公開市場資料，進行資料保存、統計、異常研究與歷史事件研究。

**本專案不執行任何交易。**

## 安全邊界
- 只使用 OKX Public Market Data REST / Public WebSocket。
- 不使用 Private API、API Key、Secret Key、Passphrase 或登入。
- 不包含下單、平倉、交易執行或帳戶操作。
- 不產生 LONG / SHORT、買入 / 賣出指令。
- 不保證獲利、勝率或未來結果。
- Telegram 不具交易控制能力。

## 官方資料來源
OKX API 定義唯一依 OKX 官方 V5 文件：https://www.okx.com/docs-v5/en/

目前使用的公開資料：
- `GET /api/v5/public/instruments?instType=SWAP`
- `GET /api/v5/market/tickers?instType=SWAP`
- `GET /api/v5/market/candles`
- `GET /api/v5/market/trades`
- `GET /api/v5/market/books`
- `GET /api/v5/public/open-interest`
- `GET /api/v5/public/funding-rate`
- `GET /api/v5/public/funding-rate-history`
- Public WebSocket `tickers`
- Public WebSocket `candle5m`
- Public WebSocket `trades`
- Public WebSocket `open-interest`
- Public WebSocket `funding-rate`
- Public WebSocket `liquidation-orders`

OKX 官方文件指出公開市場資料可透過 Public Data 取得；WebSocket public channel 用於市場資料。`liquidation-orders` 是公開強平訂單流，不代表 OKX 全市場完整強平總量。

## 市場篩選
市場清單動態讀取 OKX Instruments，不硬編碼市場數量。只保留：
- `instType=SWAP`
- `state=live`
- `quoteCcy=USDT` 或 `settleCcy=USDT`

## PostgreSQL
Render 重啟不會依賴本地記憶體保存歷史資料。設定 `DATABASE_URL` 後，啟動時自動執行 `db/schema.sql`。

資料表：
1. `instruments`
2. `ticker_snapshots`
3. `candles`
4. `trades`
5. `orderbook_snapshots`
6. `open_interest_snapshots`
7. `funding_snapshots`
8. `funding_history`
9. `liquidation_events`
10. `market_anomalies`
11. `research_events`
12. `schema_meta`

資料庫時間使用 UTC；前端使用 `Asia/Taipei` 顯示。預設資料保留 7 天，可用 `DATA_RETENTION_DAYS` 調整。

如果 `DATABASE_URL` 未設定，系統仍可提供公開 API 的即時資料，但歷史持久化、CVD 歷史、OI 歷史與事件研究會標示資料不足，不會用 0 或估算值補資料。

## OI 歷史
OI 使用實際 OKX 公開 OI 採樣保存：
- `oi`
- `oiCcy`
- `oiUsd`
- `timestamp`

變化週期：5m、15m、1h、4h、24h。比較點必須存在於資料庫；沒有足夠歷史資料即顯示 `【資料不足，無法確認】`。不從價格或 K 線推導 OI。

## CVD
CVD 僅使用 OKX Public Trades 的官方 `side`、`sz` 與 `tradeId`。計算定義：`buy` size 加總、`sell` size 減去；其他未識別值不加入計算。

這是依 OKX 公開成交資料建立的統計量，不把 side 延伸解釋為不存在官方依據的「真正買方 / 賣方資金流」。資料量不足時不估算。

## Market Structure
使用中性分類：
- 上漲 / OI 增加
- 上漲 / OI 減少
- 下跌 / OI 增加
- 下跌 / OI 減少
- 持平 / OI 無變化

這些分類只描述價格與 OI 的共同變化，不代表方向預測。

## Volume / OI / Funding Anomaly
異常基準來自實際歷史資料。Volume anomaly 使用近 24 小時資料計算 mean、median、標準差與 z-score。預設 z-score 閾值集中於 `config.js`，可由環境變數調整；閾值不是經過市場獲利驗證的門檻。

Funding 提供 current funding、funding history、fundingTime、nextFundingTime，以及後續可計算的歷史分布。平台不預測下一次 funding，也不把 funding 直接包裝成方向訊號。

## Order Book
保存 best bid、best ask、spread、bid volume、ask volume、bid/ask ratio、depth imbalance 與前 N 檔資料。

**Order Book 是未成交掛單，不代表實際成交流向。**

## Liquidation
使用 OKX Public WebSocket `liquidation-orders` 保存：
- instId
- side
- bkPx
- sz
- ts

可以統計最近 5m / 15m / 1h 事件數與排行，但不稱為「OKX 全市場總清算量」。

## Historical Event Research
異常事件以 T0 記錄。事件資料會等待未來實際 K 線資料到達，再計算：
- T+5m
- T+15m
- T+1h
- T+4h
- T+24h
- absolute / percentage return
- MFE
- MAE
- sample size
- average return
- median return
- positive outcome %
- negative outcome %

統計結果只描述歷史樣本，不代表未來勝率或獲利保證。樣本不足時顯示 `【資料不足，無法確認】`。

## API
- `GET /api/health`
- `GET /api/instruments`
- `GET /api/markets`
- `GET /api/candles/:instId?bar=5m|15m|1H|4H`
- `GET /api/trades/:instId?limit=100`
- `GET /api/orderbook/:instId?sz=20`
- `GET /api/funding/:instId`
- `GET /api/funding-history/:instId?limit=100`
- `GET /api/oi/:instId`
- `GET /api/cvd/:instId`
- `GET /api/anomalies`
- `GET /api/anomalies/:instId`
- `GET /api/liquidations/:instId`
- `GET /api/structure/:instId`
- `GET /api/research/:instId`
- `GET /api/rankings`
- `GET /api/realtime`

成功格式：`{ok:true,data:...}`。失敗格式：`{ok:false,error:"資料暫時無法取得"}`。

## Rate Limit / Retry
所有 REST 請求經中央 limiter，並使用 timeout、有限 retry、exponential backoff、429 / 5xx handling、malformed response handling。禁止 infinite retry。中央 limiter 預設 18 requests / 2 seconds，具體 OKX endpoint 限制仍以官方文件為準。

## WebSocket
Public WebSocket 具備：
- heartbeat
- ping / pong
- reconnect exponential backoff
- subscription 去重
- reconnect 後重新訂閱
- ticker / candle / trades / OI / funding / liquidation

## Render 設定
1. 建立 Render PostgreSQL。
2. 將 Render PostgreSQL 的連線字串設定為 Web Service 的 `DATABASE_URL`。
3. 保持 `OKX_REST_BASE_URL=https://www.okx.com`，除非 OKX 官方文件或部署區域要求不同。
4. `OKX_PUBLIC_WS_URL=wss://ws.okx.com:8443/ws/v5/public`。
5. Deploy 後檢查 `/api/health` 的 `database` 與 `websocket` 狀態。

本專案不需要 API Key、Secret Key 或 Passphrase。

## 測試
Unit Test：
```bash
npm install
npm test
```

Live OKX API Test 需要具備可連線的 Node.js 執行環境；若目前執行環境無法實際執行，結果必須標示：

`【資料不足，無法確認】`

Unit Test 不等同 Live OKX API Test，也不等同 PostgreSQL connection test。

## 檔案架構
- `server.js`：HTTP API 與啟動流程
- `config.js`：環境變數、cache、限速、異常閾值、保留期限
- `okx.js`：OKX Public REST client
- `market.js`：市場資料查詢與研究 API 資料組裝
- `cache.js`：TTL cache
- `logger.js`：結構化日誌
- `normalize.js`：OKX 公開資料標準化
- `rateLimiter.js`：中央 REST limiter
- `ws.js`：Public WebSocket、heartbeat、重連與訂閱
- `db.js`：PostgreSQL 連線、migration 與持久化
- `collector.js`：市場資料持續採集與研究資料更新
- `analytics.js`：CVD、z-score、結構分類與統計函式
- `db/schema.sql`：資料表與索引
- `public/`：繁體中文 Dashboard
- `test/`：Unit Tests

## 最終安全聲明
**本專案不執行任何交易。**

所有資料、異常與歷史統計均為研究用途。任何歷史統計都不能被解讀為未來結果保證。
