# ServOS WiFi relay

A tiny fixed-IP forwarder that lets ServOS authorise WiFi guests on UniFi **cloud-only**.

**Why it's needed:** Ubiquiti's cloud (`unifi.ui.com`) blocks requests from Supabase's shared
server IPs (CloudFront 403). This relay runs on **one small box with a stable IP** that Ubiquiti
accepts. ServOS → relay → Ubiquiti. **One relay serves every venue** — it is *not* a per-venue box.
It holds no secrets and only forwards to `*.ui.com`.

It's the same trick the big WiFi platforms use (their docs list fixed IPs to allow).

---

## Deploy (Fly.io — ~£2/month, dedicated IPv4)

You only do this **once, ever**.

1. Install the Fly CLI and sign in:
   ```bash
   curl -L https://fly.io/install.sh | sh
   fly auth login
   ```
2. From this folder (`wifi-relay/`), create the app (don't deploy yet):
   ```bash
   fly launch --no-deploy --copy-config --name servos-wifi-relay
   ```
3. Give it a **dedicated IPv4** (this is the stable IP Ubiquiti will see):
   ```bash
   fly ips allocate-v4
   ```
   Note the address it prints.
4. Set a secret token (any long random string — generate one):
   ```bash
   fly secrets set RELAY_TOKEN="$(openssl rand -hex 24)"
   ```
   Copy the value you set — you'll give it to ServOS. (See it again any time with
   `fly secrets list` shows only names; if unsure, just set a fresh one and reuse it below.)
5. Deploy:
   ```bash
   fly deploy
   ```
6. Your relay URL is `https://servos-wifi-relay.fly.dev`. Check it:
   ```bash
   curl https://servos-wifi-relay.fly.dev/health      # → {"ok":true,...}
   ```

> Any host works (a £4 VPS, Railway, Render, etc.) — it just needs Node 20+, a stable public
> address, and to run `RELAY_TOKEN=… node relay.mjs`. Fly is simplest for a dedicated IPv4.

---

## Connect it to ServOS

Give Claude / set in Supabase these two function secrets (project `tbetcegmszzotrwdtqhi`):

```
UNIFI_RELAY_URL   = https://servos-wifi-relay.fly.dev
UNIFI_RELAY_TOKEN = <the RELAY_TOKEN you set above>
```

Once set, the `wifi-authorize` edge function automatically routes UniFi cloud-account calls through
the relay. No redeploy needed. Then Back Office → WiFi → **Test** should connect. ✅

---

## How it fits

```
guest signs up → wifi-capture (CRM + loyalty)            ── Supabase cloud
                      │
            wifi-authorize (unifi_cloud)                 ── Supabase cloud (IP blocked by Ubiquiti)
                      │  POST /forward {url, headers, body}
                      ▼
            this relay (fixed allowed IP)                ── one small box, all venues
                      │  logs into unifi.ui.com + authorises the device
                      ▼
            Ubiquiti cloud → venue console → guest online
```
