export const SITE = 'https://streamcorner.st'
export const ASSETS = `${SITE}/assets/`

export const WORKER_CHUNKS = ['BCJZAtsV.js', 'TYiWbeTw.js', 'CZSRciDc.js', 'm8LErQpA.js']

export const MIRRORS = [
  'data.gigav.workers.dev',
  'data.yedmzoa.workers.dev',
  'data.ngagzipx.workers.dev',
  'data.miopks.workers.dev',
  'data.jccldjshj8sw.workers.dev',
  'data.l0o1afmju0.workers.dev',
  'data.nibflolsi9.workers.dev',
  'data.5j181.workers.dev',
  'data.rim1043.workers.dev',
  'data.kuig2.workers.dev',
  'data.senbon001.workers.dev',
  'data.senbon001-2.workers.dev',
  'data.senbon002.workers.dev',
  'data.senbon003.workers.dev',
  'data.kageyoshi001.workers.dev',
  'data.silentbyte125.workers.dev',
  'data.stealthwolf798-69b.workers.dev',
  'data.redjoy256.workers.dev',
  'data.anonfox144.workers.dev',
  'data.cripw4lk000.workers.dev',
  'data.phamviet444.workers.dev',
  'data.kanghaerin444.workers.dev',
  'data.minjikim444.workers.dev',
  'data.leehyein444.workers.dev',
  'data.daniellemarsh444.workers.dev',
]

export const FAILOVER_POOL = 5

export const PROVIDERS = {
  admin: { endpoint: '/?p=admin', key: 'stream_id' },
  mlb: { endpoint: '/?p=mlb', key: 'stream_id' },
  nfl: { endpoint: '/?p=nfl', key: 'stream_id' },
  nba: { endpoint: '/?p=nba', key: 'game_id' },
  alpha: { endpoint: '/?p=alpha', key: 'stream_id' },
  beta: { endpoint: '/?p=beta', key: 'stream_id' },
  '001': { endpoint: '/?p=001', key: 'stream_id' },
  extra003: { endpoint: '/?p=extra003', key: 'stream_id' },
  channels: { endpoint: '/?p=channels', key: 'stream_id' },
  slingtv: { endpoint: '/?p=slingtv_channels', key: 'channel_id' },
}

export const BRANDED = {
  paramount: ['/?p=paramount_hero', '/?p=paramount_schedule'],
  peacock: ['/?p=peacock_channels', '/?p=peacock_schedule'],
  skygo: [],
}

export const HARNESS_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>sc bridge</title></head>
<body><h1>streamcorner bridge</h1>
<script>
window.__ready = false;
window.__log = [];
function log(k, d) { window.__log.push({ t: Date.now(), k, d: String(d).slice(0, 2000) }); }
const w = new Worker('BCJZAtsV.js', { type: 'module', name: 'provider-data' });
w.onerror = e => log('workererror', (e.message || '') + ' @ line ' + (e.lineno || '?'));
const pending = new Map();
let seq = 100;
w.onmessage = e => {
  const { requestId, data, error } = e.data || {};
  const p = pending.get(requestId);
  if (!p) { log('unmatched', JSON.stringify(e.data).slice(0, 400)); return; }
  pending.delete(requestId);
  if (error) p.reject(new Error(String(error)));
  else p.resolve(data);
};
window.rpc = function (msg) {
  const requestId = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    w.postMessage({ requestId, ...msg });
    setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId);
        reject(new Error('worker timeout (20s)'));
      }
    }, 20000);
  });
};
log('boot', 'bridge ready');
window.__ready = true;
</script></body></html>
`
