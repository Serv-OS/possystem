# ServOS WiFi relay

One small box with a **fixed public IPv4** (Fly app `servos-wifi-relay`, **37.16.1.154**,
`servos-wifi-relay.fly.dev`). **One box serves every venue.** It has two jobs:

1. **Forwarder.** Lets ServOS authorise WiFi guests on UniFi cloud-only. Ubiquiti's cloud
   (`unifi.ui.com`) blocks requests from Supabase's shared server IPs (CloudFront 403). ServOS →
   relay → Ubiquiti. Holds no secrets; only forwards to `*.ui.com`; token-guarded.
2. **WiFi front door** (since 29 Sep 2026). Serves each venue's captive portal page from that one
   fixed IP, so UniFi only has to allow one address before a guest signs in.

Files: `relay.mjs` (the networking), `portal.mjs` (the pure routing decisions, tested by
`src/lib/wifiRelayPortal.test.js` in `npm test`), `Dockerfile`, `fly.toml`.

---

## Why the front door exists

UniFi's hotspot **External Portal Server** box takes an **IPv4 only**, and its
**Pre-Authorization Allowances** match IPs. We pointed it at our Vercel web host with
Domain = `coffee-boy-huddersfield.serv-os.app`. But the venue host resolves to **rotating Vercel
anycast IPs** (216.150.1.x, 216.150.16.x, different per resolver), so UniFi blocked some of them:
iOS showed "Cannot verify server identity" (the router answered itself), and after allowing the
/24 ranges nothing popped up at all (Coffee Boy Huddersfield, 29 Sep 2026).

Now guests land on `<venue>.wifi.serv-os.app`, which **always** resolves to 37.16.1.154:

| Request on `<slug>.wifi.serv-os.app` | What the relay does |
|---|---|
| `GET /guest/s/<site>/?id=&ap=&ssid=&t=&url=` (UniFi's redirect) | `302` to `/wifi?id=&ap=&ssid=&t=&url=&site=` on the same host |
| `/_sb/ops/*` | reverse proxy to `https://tbetcegmszzotrwdtqhi.supabase.co/*` (Ops) |
| `/_sb/plat/*` | reverse proxy to `https://yhzjgyrkyjabvhblqxzu.supabase.co/*` (Platform) |
| anything else | reverse proxy to `https://<slug>.serv-os.app` (the venue's normal site on Vercel) |

`<slug>.wifi.dev.serv-os.app` does the same against `https://<slug>.dev.serv-os.app` (dev tier).

- The web app knows these hosts (`src/lib/customerHost.js`, `src/lib/wifiPortal.js`): same slug as
  the venue host, and on them **both Supabase clients use `/_sb/ops` and `/_sb/plat` on the same
  origin**. On every other host nothing changes.
- All methods, bodies and headers (`apikey`, `authorization` …) pass through; hop-by-hop headers are
  stripped; status and body pass through untouched (still compressed); nothing is cached; redirects
  are not followed, and a `Location` pointing at the upstream is mapped back to the portal host.
  WebSockets (Supabase Realtime) work under `/_sb/*` only.
- **Not an open proxy:** the only upstreams are the two Supabase projects and
  `<slug>.serv-os.app` / `<slug>.dev.serv-os.app`, with the slug matching `^[a-z0-9-]{1,63}$` and
  not an operator name (`app`, `admin`, `api`, `www`, `dev` …). Nothing in a request can name
  another host.
- Off a portal host the old routes are unchanged: `GET /` and `GET /health` → health JSON,
  `POST /forward` → the forwarder. `?to=<slug>` works on any host as a fallback (it sets a
  one-hour `sv_portal` cookie so the page's own files follow), e.g.
  `https://servos-wifi-relay.fly.dev/wifi?to=coffee-boy-huddersfield`. The web app never reads
  `?to=` (it finds the venue from the hostname or `?loc=`), so the relay first answers a GET with
  `?to=` and no `loc=` by a `302` to the same address plus `&loc=<slug>`; the page then opens on the
  venue. That fallback is for checking a venue's page; its Supabase calls go direct, so it is not a
  captive portal.

### What UniFi gets (Back Office → WiFi shows these per venue, with Copy buttons)

| UniFi field | Value |
|---|---|
| External Portal Server | `37.16.1.154` |
| Domain (older: "Redirect using hostname"), Secure Portal on | `<venue>.wifi.serv-os.app` |
| Pre-Authorization Allowances | `37.16.1.154`, `fonts.googleapis.com`, `fonts.gstatic.com` |

The old Vercel /24 ranges and the two `supabase.co` hosts are no longer needed there.

---

## DNS and certificates (serv-os.app is on Vercel DNS)

Checked 29 Sep 2026: the prod records below **already exist** and the cert is **Issued**.

**Prod (`*.wifi.serv-os.app`)**

| Type | Name | Value |
|---|---|---|
| A | `*.wifi` | `37.16.1.154` |
| CNAME | `_acme-challenge.wifi` | the target `fly certs add` prints (today `wifi.serv-os.app.onr9d05.flydns.net`) |

```bash
fly certs add '*.wifi.serv-os.app' -a servos-wifi-relay     # prints the _acme-challenge CNAME
fly certs show '*.wifi.serv-os.app' -a servos-wifi-relay    # wait for "Issued"
```

**Dev tier (`*.wifi.dev.serv-os.app`), only if you test on dev.** A wildcard covers ONE label, so
the prod cert does not cover it. Today `x.wifi.dev.serv-os.app` still resolves to Vercel (through
the `*.dev` wildcard) and TLS fails, so **Back Office shows the live `<venue>.wifi.serv-os.app` on
every tier** (dev and prod share the Supabase projects, so real venues appear in the dev Back
Office too). Once the two records below exist and the cert is Issued, set
`WIFI_DEV_FRONT_DOOR_READY = true` in `src/lib/wifiPortal.js` and dev Back Office will show
`<venue>.wifi.dev.serv-os.app`. The relay and the web app already handle that host.

| Type | Name | Value |
|---|---|---|
| A | `*.wifi.dev` | `37.16.1.154` |
| CNAME | `_acme-challenge.wifi.dev` | the target `fly certs add '*.wifi.dev.serv-os.app'` prints |

**Do not add an AAAA record.** The app has no IPv6 address, and a phone that reaches the portal over
IPv6 would not match UniFi's IPv4 allowance.

Check: `dig +short A anything.wifi.serv-os.app` must print `37.16.1.154` (for dev:
`anything.wifi.dev.serv-os.app`, and `fly certs show '*.wifi.dev.serv-os.app' -a servos-wifi-relay`
must say Issued).

---

## Deploy

From this folder (`wifi-relay/`):

```bash
fly deploy
```

That is all for a change to `relay.mjs` / `portal.mjs` (secrets and the IP stay). Then check:

```bash
curl https://servos-wifi-relay.fly.dev/health                        # {"ok":true,"service":"servos-wifi-relay"}
curl -sI 'https://coffee-boy-huddersfield.wifi.serv-os.app/guest/s/default/?id=aa:bb:cc:dd:ee:ff'
                                                                      # 302, location: /wifi?id=…&site=default
curl -s https://coffee-boy-huddersfield.wifi.serv-os.app/ | grep '<title>'   # the venue's page
curl -sI 'https://servos-wifi-relay.fly.dev/wifi?to=coffee-boy-huddersfield'
                                                                      # 302, location: /wifi?to=…&loc=…
```

Run it locally: `PORT=18791 RELAY_TOKEN=anything node relay.mjs`, then
`curl -H 'Host: coffee-boy-huddersfield.wifi.serv-os.app' http://127.0.0.1:18791/`.

### First time only (already done: app, dedicated IPv4 37.16.1.154, RELAY_TOKEN)

1. Install the Fly CLI and sign in:
   ```bash
   curl -L https://fly.io/install.sh | sh
   fly auth login
   ```
2. Create the app (don't deploy yet):
   ```bash
   fly launch --no-deploy --copy-config --name servos-wifi-relay
   ```
3. Give it a **dedicated IPv4** (the stable IP Ubiquiti and UniFi see):
   ```bash
   fly ips allocate-v4
   ```
4. Set a secret token (any long random string):
   ```bash
   fly secrets set RELAY_TOKEN="$(openssl rand -hex 24)"
   ```
   Copy the value; ServOS needs it (below). `fly secrets list` shows names only, so if unsure set
   a fresh one and update Supabase too.
5. `fly deploy`, then `curl https://servos-wifi-relay.fly.dev/health`.

> Any host with a stable public IPv4 and Node 20+ works (`RELAY_TOKEN=… node relay.mjs`), but the
> front door also needs the wildcard DNS and TLS above, which Fly handles.

---

## Connect the forwarder to ServOS

Supabase function secrets (project `tbetcegmszzotrwdtqhi`):

```
UNIFI_RELAY_URL   = https://servos-wifi-relay.fly.dev
UNIFI_RELAY_TOKEN = <the RELAY_TOKEN you set above>
```

The `wifi-authorize` edge function then routes UniFi cloud-account calls through the relay. No
redeploy needed. Back Office → WiFi → **Re-check** should go green.

Optional relay env: `OPS_SUPABASE_URL` / `PLAT_SUPABASE_URL` move the `/_sb` upstreams (only ever
to another `https://<ref>.supabase.co`).

---

## How it fits

```
guest joins the WiFi → UniFi redirects to https://<venue>.wifi.serv-os.app/guest/s/default/?id=…
                      │
            this relay (37.16.1.154)  ── 302 /wifi?id=…, then serves the page (from Vercel)
                      │                  and /_sb/ops, /_sb/plat (from Supabase)
                      ▼
            wifi-capture (CRM + loyalty)                 ── Supabase cloud
                      │
            wifi-authorize (unifi_cloud)                 ── Supabase cloud (IP blocked by Ubiquiti)
                      │  POST /forward {url, headers, body}
                      ▼
            this relay again (fixed allowed IP)
                      │  logs into unifi.ui.com + authorises the device
                      ▼
            Ubiquiti cloud → venue console → guest online
```
