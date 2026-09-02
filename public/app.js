let markets = [];

async function load() {
  try {
    const r = await fetch('/api/markets', { cache: 'no-store' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '資料暫時無法取得');
    const d = j.data;
    markets = d.markets || [];
    document.getElementById('count').textContent = `市場數量：${d.count}`;
    document.getElementById('updated').textContent = `最後更新：${formatTime(d.updatedAt)}`;
    document.getElementById('ws').textContent = `WebSocket：${d.websocket?.connected ? '已連線' : '未連線'}`;
    render();
  } catch {
    document.getElementById('markets').innerHTML = '<tr><td colspan="10">資料暫時無法取得</td></tr>';
  }
}

function render() {
  const q = document.getElementById('search').value.trim().toUpperCase();
  const sort = document.getElementById('sort').value;
  const rows = markets.filter(x => !q || x.symbol.includes(q)).slice().sort((a, b) => {
    if (sort === 'symbol') return a.symbol.localeCompare(b.symbol);
    return (Number(b[sort]) || 0) - (Number(a[sort]) || 0);
  });
  document.getElementById('markets').innerHTML = rows.map(x => `<tr>
    <td>${esc(x.symbol)}</td><td>${fmt(x.price)}</td><td class="${x.change24h >= 0 ? 'up' : 'down'}">${pct(x.change24h)}</td>
    <td>${fmt(x.volume)}</td><td>${fmt(x.oi)}</td><td>${oi(x.oiChanges?.['5m'])}</td><td>${oi(x.oiChanges?.['15m'])}</td><td>${oi(x.oiChanges?.['1h'])}</td>
    <td>${funding(x.funding)}</td><td>${formatTime(x.dataUpdatedAt)}</td>
  </tr>`).join('') || '<tr><td colspan="10">沒有符合條件的市場</td></tr>';
}
function esc(v) { return String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmt(v) { return v == null || Number.isNaN(Number(v)) ? '【資料不足，無法確認】' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 8 }); }
function pct(v) { return v == null || Number.isNaN(Number(v)) ? '【資料不足，無法確認】' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`; }
function oi(v) { return !v || v.pct == null ? '【資料不足，無法確認】' : `${v.pct >= 0 ? '+' : ''}${Number(v.pct).toFixed(2)}%`; }
function funding(v) { return v == null || Number.isNaN(Number(v)) ? '【資料不足，無法確認】' : `${(Number(v) * 100).toFixed(4)}%`; }
function formatTime(v) { return v == null ? '【資料不足，無法確認】' : new Date(Number(v)).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }); }

document.getElementById('search').addEventListener('input', render);
document.getElementById('sort').addEventListener('change', render);
load();
setInterval(load, 10000);
