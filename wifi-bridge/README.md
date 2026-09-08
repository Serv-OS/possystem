# ServOS WiFi Portal Bridge

The one small always-on service that lets UniFi's external captive portal use our cloud-hosted
branded page. UniFi's **External Portal Server** field wants an **IP address** (not a domain) and
authorises guests via a call to the controller — so a cloud page alone can't be the target. This
bridge sits at a stable IP, receives UniFi's redirect, and bounces the guest to
`https://<slug>.serv-os.app/wifi` carrying the device params. **One instance serves every venue.**

```
Guest joins guest WiFi
  → UniFi 302 → http://<BRIDGE_IP>/guest/s/<site>/?id=<mac>&ap=<ap>&ssid=<ssid>&t=<t>&url=<orig>
  → bridge 302 → https://<slug>.serv-os.app/wifi?id=…&ap=…&ssid=…&site=…&orig=…
  → branded portal: capture → CRM, then get-online (voucher / local-API) via edge fns
```

Multi-tenant with no per-venue config here: the venue sets UniFi **"Redirect using Hostname"** to
`<slug>.portal.serv-os.app` (and `*.portal.serv-os.app` → this bridge's IP), and the bridge reads
the slug from the `Host` header. Fallbacks: `?to=<slug>`, then `DEFAULT_SLUG`.

## Deploy (Fly.io — easiest dedicated IPv4)
```bash
cd wifi-bridge
fly launch --no-deploy --name servos-wifi-bridge      # accept the fly.toml
fly ips allocate-v4                                    # dedicated IPv4 (~$2/mo) — THIS is the IP for UniFi
fly deploy
fly ips list                                           # note the v4 address
```
Then DNS: point `*.portal.serv-os.app` (A record) at that IPv4. (Set `CUSTOMER_ROOT=dev.serv-os.app`
in fly.toml `[env]` while testing against the dev tier.)

> Demo shortcut: skip the wildcard DNS, set `DEFAULT_SLUG=location1` in `[env]`, and just use the
> raw Fly IPv4 in UniFi. You'll get a TLS-name warning without the hostname toggle — fine to prove
> the flow.

## Configure UniFi (UX7 / Network 9.x)
1. Guest WiFi → Hotspot/Captive Portal **on**.
2. Authentication → **External Portal Server** → enter the **bridge IPv4** (no `https://`).
3. Enable **Redirect using Hostname** → `location1.portal.serv-os.app` (matches the bridge's TLS).
4. **Walled garden / pre-authorization:** the bridge IP, `*.serv-os.app`, `serv-os.app`,
   `tbetcegmszzotrwdtqhi.supabase.co`, `fonts.googleapis.com`, `fonts.gstatic.com`.
5. **Get-online:** Hotspot Manager → generate vouchers → paste into Back Office → WiFi → Setup
   (method = UniFi vouchers). (Seamless local-API authorise is the connect-once upgrade.)

## Local dev
```bash
DEFAULT_SLUG=location1 CUSTOMER_ROOT=dev.serv-os.app deno run --allow-net --allow-env main.ts
curl -i "http://localhost:8080/guest/s/default/?id=aa:bb:cc:dd:ee:ff&ap=11:22:33:44:55:66&ssid=Guest"
# → 302 Location: https://location1.dev.serv-os.app/wifi?id=…&ap=…&ssid=Guest&site=default
```
