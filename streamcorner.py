#!/usr/bin/env python3
"""
StreamCorner embed retriever
============================

Retrieves stream listings and embed URLs from streamcorner.st.

HOW IT WORKS (reverse-engineered protocol)
------------------------------------------
* The site's SPA does NOT fetch JSON from streamcorner.st itself. All data
  comes from a pool of Cloudflare Worker mirrors:

      POST https://data.<mirror>.workers.dev/corner?p=<page>          (list)
      POST https://data.<mirror>.workers.dev/corner?p=<page>&id=<id>  (detail)

* Every POST body is a ~200-byte ENCRYPTED payload (magic bytes 92 70 27 63
  + per-request nonce) built by an obfuscated provider worker
  (assets/BCJZAtsV.js) with custom crypto that is impractical to reimplement.

* Therefore this tool BRIDGES the site's own worker: it serves the worker
  bundle on localhost, instantiates it inside a headless Chromium page, and
  relays the exact postMessage RPCs the real frontend uses. The worker does
  the encryption/mirror-failover/decryption; you get clean JSON.

  This completely sidesteps both Cloudflare on streamcorner.st (never visited)
  and the `disable-devtool` script (never loaded).

REQUIREMENTS
------------
    pip install playwright curl-cffi
    playwright install chromium

USAGE
-----
    python streamcorner.py providers
    python streamcorner.py list channels
    python streamcorner.py list all
    python streamcorner.py detail channels amc
    python streamcorner.py embeds channels --limit 5
    python streamcorner.py resolve channels amc        # -> manifest (m3u8/mpd)
    python streamcorner.py m3u channels --limit 20 --out channels.m3u
    python streamcorner.py list nba --raw --out nba.json

Known providers: admin mlb nfl nba alpha beta 001 extra003 channels
                 slingtv (slingtv_channels) paramount peacock skygo
                 ("all" sweeps every provider)

M3U8/MPD NOTE: embed hosts run Cloudflare Turnstile against automated
browsers, so manifest resolution re-hosts the player page locally (host
name spoofed via --host-resolver-rules) and routes every request through
curl_cffi. Resolved DASH manifests may be DRM-protected (Widevine/PlayReady)
- playback then requires a license, i.e. the site's own player.
"""

import argparse
import json
import os
import random
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import functools
from urllib.parse import urlparse
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

# --------------------------------------------------------------------------
# Constants extracted from the SPA bundle (Bk__IvcK.js / D-qTnGKO.js)
# --------------------------------------------------------------------------

SITE = "https://streamcorner.st"
ASSETS = SITE + "/assets/"

# Obfuscated provider worker + its import closure
WORKER_CHUNKS = ["BCJZAtsV.js", "TYiWbeTw.js", "CZSRciDc.js", "m8LErQpA.js"]

# Mirror pool ("qo" array in Bk__IvcK.js) - data plane Cloudflare Workers
MIRRORS = [
    "data.gigav.workers.dev", "data.yedmzoa.workers.dev",
    "data.ngagzipx.workers.dev", "data.miopks.workers.dev",
    "data.jccldjshj8sw.workers.dev", "data.l0o1afmju0.workers.dev",
    "data.nibflolsi9.workers.dev", "data.5j181.workers.dev",
    "data.rim1043.workers.dev", "data.kuig2.workers.dev",
    "data.senbon001.workers.dev", "data.senbon001-2.workers.dev",
    "data.senbon002.workers.dev", "data.senbon003.workers.dev",
    "data.kageyoshi001.workers.dev", "data.silentbyte125.workers.dev",
    "data.stealthwolf798-69b.workers.dev", "data.redjoy256.workers.dev",
    "data.anonfox144.workers.dev", "data.cripw4lk000.workers.dev",
    "data.phamviet444.workers.dev", "data.kanghaerin444.workers.dev",
    "data.minjikim444.workers.dev", "data.leehyein444.workers.dev",
    "data.daniellemarsh444.workers.dev",
]
FAILOVER_POOL = 5          # the app shuffles mirrors and takes 5 per request
POLITENESS_DELAY = 0.35    # seconds between detail calls

# Provider registry ("pi" / "Xo" / "Qo" maps in Bk__IvcK.js)
PROVIDERS = {
    "admin":    {"endpoint": "/?p=admin",            "key": "stream_id"},
    "mlb":      {"endpoint": "/?p=mlb",              "key": "stream_id"},
    "nfl":      {"endpoint": "/?p=nfl",              "key": "stream_id"},
    "nba":      {"endpoint": "/?p=nba",              "key": "game_id"},
    "alpha":    {"endpoint": "/?p=alpha",            "key": "stream_id"},
    "beta":     {"endpoint": "/?p=beta",             "key": "stream_id"},
    "001":      {"endpoint": "/?p=001",              "key": "stream_id"},
    "extra003": {"endpoint": "/?p=extra003",         "key": "stream_id"},
    "channels": {"endpoint": "/?p=channels",         "key": "stream_id"},
    "slingtv":  {"endpoint": "/?p=slingtv_channels", "key": "channel_id"},
}
# Branded providers use the same data plane via their own endpoints
BRANDED = {
    "paramount": ["/?p=paramount_hero", "/?p=paramount_schedule"],
    "peacock":   ["/?p=peacock_channels", "/?p=peacock_schedule"],
    "skygo":     [],
}

HARNESS_HTML = """<!DOCTYPE html>
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
"""

BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


# --------------------------------------------------------------------------
# Asset bootstrap
# --------------------------------------------------------------------------

def download_chunks(cache_dir: Path, refresh: bool = False) -> Path:
    """Download the provider worker chunks into cache_dir (with curl_cffi)."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    missing = [c for c in WORKER_CHUNKS if refresh or not (cache_dir / c).exists()]
    if missing:
        try:
            from curl_cffi import requests as cr
            getter = lambda url: cr.get(url, impersonate="chrome", timeout=30)
        except ImportError:
            try:
                import requests as rq
                getter = lambda url: rq.get(
                    url, timeout=30, headers={"User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"})
            except ImportError:
                sys.exit("Need curl-cffi (preferred) or requests to bootstrap: "
                         "pip install curl-cffi")
        for chunk in missing:
            url = ASSETS + chunk
            print(f"[bootstrap] fetching {url}", file=sys.stderr)
            r = getter(url)
            r.raise_for_status()
            (cache_dir / chunk).write_bytes(r.content)
    (cache_dir / "harness.html").write_text(HARNESS_HTML, encoding="utf-8")
    return cache_dir


class _QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *a):  # silence request logging
        pass


def serve_dir(directory: Path):
    """Serve directory on an ephemeral localhost port; return (server, port)."""
    handler = functools.partial(_QuietHandler, directory=str(directory))
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv, srv.server_address[1]


# --------------------------------------------------------------------------
# Browser bridge
# --------------------------------------------------------------------------

class WorkerBridge:
    """Runs the site's provider worker in headless Chromium and relays RPCs."""

    def __init__(self, assets_dir: Path):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            sys.exit("Playwright is required:  pip install playwright "
                     "&& playwright install chromium")
        self._pw = sync_playwright().start()
        self._browser = None
        self._page = None
        self._assets = assets_dir

    def start(self):
        launch_kwargs = dict(headless=True, args=[
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
        ])
        self._browser = self._pw.chromium.launch(**launch_kwargs)
        page = self._browser.new_context().new_page()
        srv, port = serve_dir(self._assets)
        self._srv = srv
        try:
            page.goto(f"http://127.0.0.1:{port}/harness.html",
                      wait_until="domcontentloaded", timeout=30000)
            page.wait_for_function("window.__ready === true", timeout=20000)
        except Exception:
            srv.shutdown()
            raise
        self._page = page
        return self

    def rpc(self, operation: str, request_urls, provider_id: str,
            provider_name: str, retries: int = 2):
        """Send one provider-list / provider-detail operation."""
        msg = {"operation": operation, "requestUrls": request_urls,
               "providerId": provider_id, "providerName": provider_name}
        last_err = None
        for attempt in range(retries + 1):
            try:
                return self._page.evaluate("m => window.rpc(m)", msg)
            except Exception as e:  # browser died or worker failed -> recover
                last_err = e
                err = str(e)
                if "timeout" in err and attempt < retries:
                    # worker refused these mirrors; try a different subset
                    continue
                # page/browser may have crashed -> relaunch once
                try:
                    self._browser.close()
                except Exception:
                    pass
                self.start()
        raise RuntimeError(f"rpc failed after retries: {last_err}")

    def close(self):
        for closer in (lambda: self._browser and self._browser.close(),
                       lambda: self._srv and self._srv.shutdown(),
                       lambda: self._pw.stop()):
            try:
                closer()
            except Exception:
                pass


# --------------------------------------------------------------------------
# Protocol helpers
# --------------------------------------------------------------------------

def mirror_candidates(rng: random.Random):
    pool = MIRRORS[:]
    rng.shuffle(pool)
    return [f"https://{m}" for m in pool[:FAILOVER_POOL]]


def page_param(endpoint: str) -> str:
    """'/?p=channels' -> 'channels' (mirrors $o() in the SPA)."""
    from urllib.parse import urlparse, parse_qs
    q = parse_qs(urlparse(endpoint).query)
    return q.get("p", [""])[0]


def op_list(bridge, provider: str, rng):
    """provider-list for one provider endpoint."""
    cfg = PROVIDERS.get(provider)
    if cfg:
        base = f"/corner?p={page_param(cfg['endpoint'])}"
    elif provider in BRANDED and BRANDED[provider]:
        base = f"/corner?p={page_param(BRANDED[provider][-1])}"
    else:
        # passthrough: the p param doubles as an arbitrary page key
        base = f"/corner?p={provider}"
    urls = [m + base for m in mirror_candidates(rng)]
    return bridge.rpc("provider-list", urls, provider, provider.upper())


def op_detail(bridge, provider: str, item_id: str, rng):
    """provider-detail: /corner?p=<page>&id=<id> (mirrors $o()/Ai())."""
    cfg = PROVIDERS.get(provider)
    key = (cfg or {}).get("key", "stream_id")
    page = page_param(cfg["endpoint"]) if cfg else provider
    from urllib.parse import urlencode
    qs = urlencode({"p": page, "id": str(item_id)})
    urls = [m + f"/corner?{qs}" for m in mirror_candidates(rng)]
    return bridge.rpc("provider-detail", urls, provider, provider.upper())


# --------------------------------------------------------------------------
# Manifest resolver (embed page -> m3u8/mpd)
# --------------------------------------------------------------------------

def _detect_manifest(body: bytes):
    head = body[:1024]
    if b"#EXTM3U" in head or b"#EXT-X" in head:
        return "m3u8"
    if b"<MPD" in head[:512]:
        return "mpd"
    return None


class ManifestResolver:
    """Runs the embed host's own player page with:
      * the real host name spoofed via --host-resolver-rules (Turnstile is
        domain-bound and never fires for the locally-served document),
      * every network request fulfilled through curl_cffi (CF-proof),
      * manifest URLs detected by response content.

    One chromium process is reused per embed host.
    """

    def __init__(self, ua: str = BROWSER_UA, settle_s: int = 12):
        self._ua = ua
        self._settle = settle_s
        self._pw = None
        self._browser = None
        self._proc = None
        self._host = None
        self._page = None

    def _launch(self, host: str):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            sys.exit("Playwright is required:  pip install playwright "
                     "&& playwright install chromium")
        try:
            from curl_cffi import requests as cr
        except ImportError:
            sys.exit("curl-cffi is required for manifest resolution: "
                     "pip install curl-cffi")
        self._cr = cr
        self._pw = sync_playwright().start()
        # free ports
        s = socket.socket(); s.bind(("127.0.0.1", 0)); cdp = s.getsockname()[1]; s.close()
        s = socket.socket(); s.bind(("127.0.0.1", 0)); web = s.getsockname()[1]; s.close()
        self._port = web
        self._proc = subprocess.Popen([
            self._pw.chromium.executable_path, "--headless=new",
            f"--remote-debugging-port={cdp}",
            "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
            "--autoplay-policy=no-user-gesture-required",
            f"--host-resolver-rules=MAP {host} 127.0.0.1",
            f"--user-agent={self._ua}", "--window-size=1280,720",
            "about:blank",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(2.5)
        self._browser = self._pw.chromium.connect_over_cdp(f"http://127.0.0.1:{cdp}")
        self._page = self._browser.contexts[0].new_page()
        self._page.set_viewport_size({"width": 1280, "height": 720})
        self._host = host
        self._cache = {}

    def resolve(self, embed_url: str, max_manifests: int = 4) -> list:
        """Return [{'url','type','content_type','length','head'}...]"""
        purl = urlparse(embed_url)
        host, origin = purl.netloc, f"{purl.scheme}://{purl.netloc}"
        if self._host != host:
            self.close()
            self._launch(host)

        # fetch + patch the real player page (curl_cffi passes CF)
        r0 = self._cr.get(embed_url, impersonate="chrome", timeout=25, headers={
            "User-Agent": self._ua, "Referer": "https://streamcorner.st/"})
        html = r0.text
        html = re.sub(r"<script[^>]+popa[^>]+></script>", "", html)
        html = re.sub(r"<script[^>]+cloudflareinsights[^>]*>\s*</script>", "", html)
        token = embed_url.split("p=", 1)[1] if "p=" in embed_url else ""

        manifests = []

        def handle(route):
            url = route.request.url
            if url.startswith("data:"):
                route.continue_(); return
            local_prefix = f"http://{host}:{self._port}/"
            if url.startswith(local_prefix):
                route.fulfill(status=200,
                              content_type="text/html; charset=utf-8", body=html)
                return
            fetch_url = url
            if f"{host}:{self._port}" in url:
                fetch_url = origin + url.split(f"{host}:{self._port}", 1)[1]
            try:
                if fetch_url in self._cache:
                    status, ct, body = self._cache[fetch_url]
                else:
                    r = self._cr.get(fetch_url, impersonate="chrome", timeout=25,
                                     headers={"User-Agent": self._ua,
                                              "Accept": "*/*",
                                              "Referer": embed_url})
                    status = r.status_code
                    ct = r.headers.get("content-type", "application/octet-stream")
                    body = r.content
                    self._cache[fetch_url] = (status, ct, body)
                    mtype = _detect_manifest(body)
                    if mtype and len(manifests) < max_manifests + 8:
                        manifests.append({"url": fetch_url, "type": mtype,
                                          "content_type": ct, "length": len(body),
                                          "head": body[:300].decode("utf-8", "replace")})
                route.fulfill(status=status, content_type=ct,
                              headers={"Access-Control-Allow-Origin": "*"},
                              body=body)
            except Exception:
                route.abort()

        page = self._page
        page.route("**/*", handle)
        try:
            page.goto(f"http://{host}:{self._port}/?p={token}",
                      wait_until="domcontentloaded", timeout=40000)
            for _ in range(max(1, self._settle // 4)):
                time.sleep(4)
                if manifests:
                    time.sleep(3)   # grab a second manifest if the player loads one
                    break
        finally:
            try:
                page.unroute("**/*", handle)
            except Exception:
                pass
        return manifests[:max_manifests]

    def close(self):
        for closer in (lambda: self._browser and self._browser.close(),
                       lambda: self._proc and self._proc.terminate(),
                       lambda: self._pw and self._pw.stop()):
            try:
                closer()
            except Exception:
                pass
        self._browser = self._proc = self._pw = self._page = None
        self._host = None


def resolve_embed_manifests(embeds, settle_s=12, max_per_embed=4):
    """Resolve manifests for a list of {'source','url'} embeds."""
    out = []
    resolver = ManifestResolver(settle_s=settle_s)
    try:
        for e in embeds:
            try:
                mans = resolver.resolve(e["url"])
            except Exception as ex:
                mans = [{"_error": str(ex)[:200]}]
            out.append({"source": e.get("source"), "embed_url": e.get("url"),
                        "manifests": mans})
            print(f"  [resolve] {e.get('source')}: "
                  f"{len([m for m in mans if 'url' in m])} manifest(s)", file=sys.stderr)
    finally:
        resolver.close()
    return out


# --------------------------------------------------------------------------
# Record normalization (alias fields documented from the normalizer code)
# --------------------------------------------------------------------------

ID_ALIASES = ("stream_id", "content_id", "contentId", "serviceKey",
              "tile_id", "game_id", "channel_id", "id")
URL_ALIASES = ("embed_url", "embedUrl", "stream_url", "manifest_url",
               "url", "href", "upsellUrl")
COLLECTIONS = ("channels", "items", "events", "live", "vods")


def first_present(rec, aliases, default=None):
    for a in aliases:
        v = rec.get(a)
        if v:
            return v
        if a == "contentId" and isinstance(rec.get("contentCANVideo"), dict):
            v = rec["contentCANVideo"].get("contentId")
            if v:
                return v
    if isinstance(rec.get("button"), dict) and rec["button"].get("url"):
        return rec["button"]["url"]
    return default


def normalize_item(rec, provider=None):
    if not isinstance(rec, dict):
        return rec
    rid = first_present(rec, ID_ALIASES)
    out = {
        "id": rid,
        "name": rec.get("event_name") or rec.get("title") or rec.get("name"),
        "category": rec.get("category"),
        "league": rec.get("league"),
        "time": rec.get("time_et") or rec.get("time") or rec.get("time_label"),
        "poster": rec.get("poster") or rec.get("image"),
    }
    for extra in ("home_team", "away_team", "home_score", "away_score",
                  "chatroom", "description", "status"):
        if rec.get(extra) not in (None, ""):
            out[extra] = rec[extra]
    if provider and rid:
        out["page_url"] = f"{SITE}/stream/{provider}/{rid}"
    embed = first_present(rec, URL_ALIASES)
    if embed:
        out["embed_url"] = embed
    return {k: v for k, v in out.items() if v is not None}


def normalize_collection(payload):
    """Unwrap any of channels[]/items[]/events[]/live[]/vods[] shapes."""
    if payload is None:
        return []
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in COLLECTIONS:
            if isinstance(payload.get(key), list):
                return payload[key]
        for key in COLLECTIONS:  # nested rails-style payloads
            rails = payload.get(key)
            if isinstance(rails, dict):
                for k2 in COLLECTIONS:
                    if isinstance(rails.get(k2), list):
                        return rails[k2]
    return [payload]


def extract_embeds(detail):
    """streams[]/sources[] plus live[]/vods[]/items[]/events[]/channels[]
    collections with source_name + embed_url from a detail payload."""
    recs = []
    if isinstance(detail, dict):
        recs = [detail]
    elif isinstance(detail, list):
        recs = [r for r in detail if isinstance(r, dict)]
    out = []
    seen = set()
    for rec in recs:
        pools = []
        for key in ("streams", "sources") + COLLECTIONS:
            v = rec.get(key)
            if isinstance(v, list):
                pools.extend(x for x in v if isinstance(x, dict))
        for s in pools:
            url = first_present(s, URL_ALIASES)
            if url and url not in seen:
                seen.add(url)
                out.append({"source": s.get("source_name") or s.get("source")
                            or s.get("title") or "STREAM", "url": url})
        direct = first_present(rec, URL_ALIASES)
        if direct and direct not in seen and not pools:
            seen.add(direct)
            out.append({"source": rec.get("source_name") or "STREAM", "url": direct})
    return out


# --------------------------------------------------------------------------
# CLI commands
# --------------------------------------------------------------------------

def cmd_providers(args):
    rows = [{"provider": p, "endpoint": c["endpoint"], "key_field": c["key"]}
            for p, c in PROVIDERS.items()]
    for p, eps in BRANDED.items():
        rows.append({"provider": p, "endpoint": ", ".join(eps) or "(detail-only)",
                     "key_field": "contentId/stream_id"})
    print(json.dumps(rows, indent=2 if not args.raw else None))


def cmd_list(args, bridge, rng):
    out = {}
    for provider in providers_for(args.provider):
        try:
            payload = op_list(bridge, provider, rng)
        except Exception as e:
            payload = {"_error": str(e)[:200]}
        if args.raw:
            emit(payload, args)
            continue
        items = normalize_collection(payload)
        norm = [normalize_item(i, provider) for i in items]
        out[provider] = {"count": len(norm), "items": norm}
    if args.raw:
        return
    if args.provider == "all":
        emit(out, args)
    else:
        emit(out[args.provider], args)


def cmd_detail(args, bridge, rng):
    payload = op_detail(bridge, args.provider, args.id, rng)
    if args.raw:
        emit(payload, args)
        return
    rec = payload[0] if isinstance(payload, list) and payload else payload
    norm = normalize_item(rec, args.provider) if isinstance(rec, dict) else {}
    emit({"provider": args.provider, "id": args.id,
          "embeds": extract_embeds(payload), "record": norm}, args)


def cmd_embeds(args, bridge, rng):
    """List + resolve embed URLs for the first N items (politeness delayed)."""
    payload = op_list(bridge, args.provider, rng)
    items = normalize_collection(payload)
    results = []
    for it in items[:args.limit]:
        rid = first_present(it, ID_ALIASES)
        if not rid:
            continue
        time.sleep(POLITENESS_DELAY)
        try:
            detail = op_detail(bridge, args.provider, rid, rng)
        except Exception as e:
            detail = {"_error": str(e)[:200]}
        entry = normalize_item(it, args.provider)
        entry["embeds"] = extract_embeds(detail)
        results.append(entry)
        shown = ", ".join(f"{e['source']}" for e in entry["embeds"]) or "no embeds"
        print(f"  [{args.provider}] {rid}: {shown}", file=sys.stderr)
    if args.manifests and results:
        bridge.close()                      # free the sync API before a new one
        for entry in results:
            if entry.get("embeds"):
                try:
                    entry["manifests"] = resolve_embed_manifests(
                        entry["embeds"][:args.max_sources], settle_s=args.settle)
                except Exception as e:
                    entry["manifests"] = [{"_error": str(e)[:200]}]
    emit({"provider": args.provider, "resolved": len(results), "items": results}, args)


def cmd_resolve(args, bridge, rng):
    """Fetch detail for provider+id and resolve manifests from its embeds."""
    payload = op_detail(bridge, args.provider, args.id, rng)
    embeds = extract_embeds(payload)
    if args.source:
        embeds = embeds[args.source - 1: args.source]
    if not embeds:
        emit({"provider": args.provider, "id": args.id,
              "error": "no embed URLs in detail record"}, args)
        return
    rec = payload[0] if isinstance(payload, list) and payload else payload
    base = normalize_item(rec, args.provider) if isinstance(rec, dict) else {}
    bridge.close()                          # free the sync API before a new one
    resolved = resolve_embed_manifests(embeds[:args.max_sources],
                                       settle_s=args.settle)
    emit({"provider": args.provider, "id": args.id, "record": base,
          "resolved": resolved}, args)


def cmd_m3u(args, bridge, rng):
    """Build an M3U/IPTV playlist (manifest URLs when resolvable)."""
    payload = op_list(bridge, args.provider, rng)
    items = normalize_collection(payload)
    rows = []
    for it in items[:args.limit]:
        rid = first_present(it, ID_ALIASES)
        if not rid:
            continue
        time.sleep(POLITENESS_DELAY)
        try:
            detail = op_detail(bridge, args.provider, rid, rng)
            embeds = extract_embeds(detail)
        except Exception:
            embeds = []
        name = (it.get("event_name") or it.get("title") or it.get("name")
                or it.get("home_team") and f"{it.get('away_team')} @ {it.get('home_team')}"
                or rid)
        rows.append({"rid": rid, "name": name,
                     "logo": it.get("poster") or it.get("image") or "",
                     "group": it.get("category") or it.get("league") or args.provider,
                     "embeds": embeds})
    if args.manifests:
        bridge.close()                      # free the sync API before a new one
    lines = ["#EXTM3U"]
    count = 0
    for row in rows:
        embeds = row["embeds"]
        url = ""
        if args.manifests and embeds:
            try:
                resolved = resolve_embed_manifests(embeds[:1], settle_s=args.settle)
                mans = [m for r in resolved for m in r.get("manifests", [])
                        if "url" in m]
                if mans:
                    url = mans[0]["url"]
            except Exception:
                pass
        if not url and embeds:
            url = embeds[0]["url"]          # fallback: embed page URL
        if not url:
            continue
        lines.append(f'#EXTINF:-1 tvg-id="{row["rid"]}" tvg-logo="{row["logo"]}" '
                     f'group-title="{row["group"]}",{row["name"]}')
        lines.append(url)
        count += 1
        print(f"  [m3u] {row['rid']}: {url[:80]}", file=sys.stderr)
    text = "\n".join(lines) + "\n"
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"saved {count} entries -> {args.out}", file=sys.stderr)
    else:
        print(text)


def providers_for(arg: str):
    if arg != "all":
        return [arg]
    return list(PROVIDERS.keys())


def emit(obj, args):
    text = json.dumps(obj, indent=None if args.raw else 2, ensure_ascii=False)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"saved -> {args.out}", file=sys.stderr)
    else:
        print(text)


def main():
    ap = argparse.ArgumentParser(
        description="Retrieve StreamCorner listings and embed URLs",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("USAGE")[1])
    ap.add_argument("--cache-dir", default=str(Path.home() / ".cache" / "streamcorner"))
    ap.add_argument("--refresh", action="store_true",
                    help="re-download worker chunks from the site")
    ap.add_argument("--seed", type=int, default=None, help="mirror shuffle seed")
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--raw", action="store_true", help="output raw JSON payloads")
    common.add_argument("--out", help="write result JSON to file")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("providers", help="list known providers/endpoints",
                   parents=[common])

    p_list = sub.add_parser("list", help="list streams/events for a provider",
                            parents=[common])
    p_list.add_argument("provider")

    p_det = sub.add_parser("detail", help="fetch detail/embed for one stream id",
                           parents=[common])
    p_det.add_argument("provider")
    p_det.add_argument("id")

    p_emb = sub.add_parser("embeds", help="list + resolve embeds (first N items)",
                           parents=[common])
    p_emb.add_argument("provider")
    p_emb.add_argument("--limit", type=int, default=10)
    p_emb.add_argument("--manifests", action="store_true",
                       help="also resolve m3u8/mpd manifests (slow)")
    p_emb.add_argument("--settle", type=int, default=12,
                       help="seconds to let the player run per embed")
    p_emb.add_argument("--max-sources", type=int, default=2,
                       help="max embed sources to resolve per item")

    p_res = sub.add_parser("resolve", help="resolve m3u8/mpd manifest for one stream",
                           parents=[common])
    p_res.add_argument("provider")
    p_res.add_argument("id")
    p_res.add_argument("--source", type=int, default=None,
                       help="1-based embed source index (default: all)")
    p_res.add_argument("--settle", type=int, default=12)
    p_res.add_argument("--max-sources", type=int, default=2)

    p_m3u = sub.add_parser("m3u", help="build an M3U/IPTV playlist",
                           parents=[common])
    p_m3u.add_argument("provider")
    p_m3u.add_argument("--limit", type=int, default=20)
    p_m3u.add_argument("--manifests", action="store_true",
                       help="resolve manifests instead of embed page URLs (slow)")
    p_m3u.add_argument("--settle", type=int, default=12)

    args = ap.parse_args()
    rng = random.Random(args.seed)

    assets = download_chunks(Path(args.cache_dir), refresh=args.refresh)
    bridge = WorkerBridge(assets)
    try:
        bridge.start()
        if args.cmd == "providers":
            cmd_providers(args)
        elif args.cmd == "list":
            cmd_list(args, bridge, rng)
        elif args.cmd == "detail":
            cmd_detail(args, bridge, rng)
        elif args.cmd == "embeds":
            cmd_embeds(args, bridge, rng)
        elif args.cmd == "resolve":
            cmd_resolve(args, bridge, rng)
        elif args.cmd == "m3u":
            cmd_m3u(args, bridge, rng)
    finally:
        bridge.close()


if __name__ == "__main__":
    main()
