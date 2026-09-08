# ServOS WiFi on-site authoriser (`agent.mjs`)

The piece that puts guests **online** on UniFi. The branded portal + capture + loyalty all run in
the cloud — but UniFi only lets a device onto the internet when something calls the **console's
API to authorize it**, and that call has to happen **on the venue network** (the console isn't
internet-reachable and uses a self-signed cert). This tiny agent does exactly that: it polls
ServOS for "who just signed up here and isn't online yet?" and authorises each device on the
local UniFi console. It's the software version of Stampede's on-site box.

- **Demo:** run it on your Mac while it's on the venue WiFi/LAN.
- **Production:** run it on a tiny always-on device at the venue (a £30 mini-PC / Raspberry Pi),
  or build it into the hardware ServOS ships. One per venue.

## Prerequisites
1. **Node 18+** on the machine (`node -v`; if missing: `brew install node`).
2. **A LOCAL UniFi admin** (not your Ubiquiti cloud login — that has MFA the agent can't pass):
   UniFi → **Settings → Admins & Users → Add** → give it **Local Access Only** + a username &
   password. Use those below.
3. Your **Supabase service_role key** — Supabase dashboard → Project Settings → API →
   `service_role` (keep it private; it stays on this machine).
4. Your console's **LAN address** (e.g. `https://192.168.1.1`) and **site** (usually `default`).

## Run
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 \
UNIFI_URL=https://192.168.1.1 \
UNIFI_USER=servos-agent \
UNIFI_PASS='your-local-admin-password' \
UNIFI_SITE=default \
SUPA_URL=https://tbetcegmszzotrwdtqhi.supabase.co \
SUPA_KEY='<your service_role key>' \
LOCATION_ID=7218c716-eeb4-4f96-b284-f3500823595c \
MINUTES=1440 \
node agent.mjs
```
You should see `✓ logged in to UniFi console`. Then connect a phone to the guest WiFi → fill the
portal → within a few seconds the agent prints `✓ online: <mac>` and the phone gets internet.

`NODE_TLS_REJECT_UNAUTHORIZED=0` is required because the console uses a self-signed cert on the
LAN; the agent only talks to your console + Supabase, so it's safe here.

## How it fits
```
guest signs up → wifi-capture (CRM + loyalty)  ── cloud
                       │  (wifi_captures row, authorized=false)
   agent polls ServOS ◄┘  every 3s
   agent → local UniFi console: authorize-guest <mac>  ── on-site
                       └► device online; row marked authorized=true
```

> Production note: the demo agent uses the service_role key for simplicity. For multi-venue, swap
> to a scoped per-venue agent token + a `wifi-agent` poll/ack edge function (small follow-up).
