CREATE TABLE IF NOT EXISTS instruments (
  inst_id TEXT PRIMARY KEY,
  inst_type TEXT NOT NULL,
  quote_ccy TEXT,
  settle_ccy TEXT,
  state TEXT NOT NULL,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ticker_snapshots (
  id BIGSERIAL PRIMARY KEY, inst_id TEXT NOT NULL, ts TIMESTAMPTZ NOT NULL, price NUMERIC, change_24h NUMERIC, volume NUMERIC, volume_contracts NUMERIC, raw JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS ticker_snapshots_inst_ts_idx ON ticker_snapshots(inst_id, ts DESC);
CREATE TABLE IF NOT EXISTS candles (
  inst_id TEXT NOT NULL, bar TEXT NOT NULL, ts TIMESTAMPTZ NOT NULL, open NUMERIC, high NUMERIC, low NUMERIC, close NUMERIC, volume NUMERIC, volume_currency NUMERIC, volume_quote NUMERIC, confirmed BOOLEAN NOT NULL, raw JSONB NOT NULL DEFAULT '{}'::jsonb, PRIMARY KEY(inst_id, bar, ts)
);
CREATE INDEX IF NOT EXISTS candles_ts_idx ON candles(inst_id, bar, ts DESC);
CREATE TABLE IF NOT EXISTS trades (
  trade_id TEXT NOT NULL, inst_id TEXT NOT NULL, ts TIMESTAMPTZ NOT NULL, price NUMERIC, size NUMERIC, side TEXT, source TEXT, raw JSONB NOT NULL DEFAULT '{}'::jsonb, PRIMARY KEY(inst_id, trade_id)
);
CREATE INDEX IF NOT EXISTS trades_inst_ts_idx ON trades(inst_id, ts DESC);
CREATE TABLE IF NOT EXISTS orderbook_snapshots (
  id BIGSERIAL PRIMARY KEY, inst_id TEXT NOT NULL, ts TIMESTAMPTZ NOT NULL, best_bid NUMERIC, best_ask NUMERIC, spread NUMERIC, bid_volume NUMERIC, ask_volume NUMERIC, bid_ask_ratio NUMERIC, depth_imbalance NUMERIC, bids JSONB NOT NULL DEFAULT '[]'::jsonb, asks JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS orderbook_inst_ts_idx ON orderbook_snapshots(inst_id, ts DESC);
CREATE TABLE IF NOT EXISTS open_interest_snapshots (
  inst_id TEXT NOT NULL, ts TIMESTAMPTZ NOT NULL, oi NUMERIC, oi_ccy NUMERIC, oi_usd NUMERIC, raw JSONB NOT NULL DEFAULT '{}'::jsonb, PRIMARY KEY(inst_id, ts)
);
CREATE INDEX IF NOT EXISTS oi_inst_ts_idx ON open_interest_snapshots(inst_id, ts DESC);
CREATE TABLE IF NOT EXISTS funding_snapshots (
  inst_id TEXT NOT NULL, ts TIMESTAMPTZ NOT NULL, funding_rate NUMERIC, funding_time TIMESTAMPTZ, next_funding_time TIMESTAMPTZ, raw JSONB NOT NULL DEFAULT '{}'::jsonb, PRIMARY KEY(inst_id, ts)
);
CREATE INDEX IF NOT EXISTS funding_inst_ts_idx ON funding_snapshots(inst_id, ts DESC);
CREATE TABLE IF NOT EXISTS funding_history (
  inst_id TEXT NOT NULL, funding_time TIMESTAMPTZ NOT NULL, funding_rate NUMERIC, realized_rate NUMERIC, raw JSONB NOT NULL DEFAULT '{}'::jsonb, PRIMARY KEY(inst_id, funding_time)
);
CREATE TABLE IF NOT EXISTS liquidation_events (
  id BIGSERIAL PRIMARY KEY, inst_id TEXT NOT NULL, ts TIMESTAMPTZ NOT NULL, side TEXT, bk_px NUMERIC, size NUMERIC, raw JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS liquidation_inst_ts_idx ON liquidation_events(inst_id, ts DESC);
CREATE TABLE IF NOT EXISTS market_anomalies (
  id BIGSERIAL PRIMARY KEY, inst_id TEXT NOT NULL, ts TIMESTAMPTZ NOT NULL, anomaly_type TEXT NOT NULL, severity TEXT NOT NULL, measured_value NUMERIC, baseline JSONB NOT NULL DEFAULT '{}'::jsonb, metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS anomalies_inst_ts_idx ON market_anomalies(inst_id, ts DESC);
CREATE INDEX IF NOT EXISTS anomalies_type_ts_idx ON market_anomalies(anomaly_type, ts DESC);
CREATE TABLE IF NOT EXISTS research_events (
  id BIGSERIAL PRIMARY KEY, anomaly_id BIGINT NOT NULL REFERENCES market_anomalies(id) ON DELETE CASCADE, inst_id TEXT NOT NULL, t0 TIMESTAMPTZ NOT NULL, t5_price NUMERIC, t15_price NUMERIC, t1h_price NUMERIC, t4h_price NUMERIC, t24h_price NUMERIC, t5_return NUMERIC, t15_return NUMERIC, t1h_return NUMERIC, t4h_return NUMERIC, t24h_return NUMERIC, mfe NUMERIC, mae NUMERIC, completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS research_inst_t0_idx ON research_events(inst_id, t0 DESC);
CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
