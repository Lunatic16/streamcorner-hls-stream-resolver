export const SITE = 'https://streamcorner.st'
export const ASSETS = `${SITE}/assets/`

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

export function createHarnessHtml(catalogModule) {
  if (!/^[A-Za-z0-9_-]+\.js$/.test(catalogModule)) {
    throw new Error('Invalid catalog module filename')
  }
  const modulePath = JSON.stringify(`./${catalogModule}`)
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>sc bridge</title></head>
<body><h1>streamcorner bridge</h1>
<script type="module">
window.__ready = false;
window.__bootError = '';
window.__log = [];
function log(k, d) { window.__log.push({ t: Date.now(), k, d: String(d).slice(0, 2000) }); }
try {
  const catalog = await import(${modulePath});
  if (typeof catalog.u !== 'function' || typeof catalog.e !== 'function') {
    throw new Error('catalog module does not expose u/e');
  }
  window.rpc = async function (msg) {
    if (msg.operation === 'provider-list') return catalog.u(msg.providerId);
    if (msg.operation === 'provider-detail') {
      const firstUrl = msg.requestUrls && msg.requestUrls[0];
      const id = firstUrl ? new URL(firstUrl).searchParams.get('id') : '';
      if (!id) throw new Error('provider detail id missing');
      return catalog.e(msg.providerId, id);
    }
    throw new Error('unsupported catalog operation: ' + msg.operation);
  };
  log('boot', 'catalog module ready');
} catch (error) {
  window.__bootError = String(error && error.message || error);
  log('booterror', window.__bootError);
}
window.__ready = true;
</script></body></html>
`
}
