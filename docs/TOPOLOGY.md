# ServOS — Topology & Architecture Diagrams

> System, deployment, data-flow and integration topology. Diagrams are [Mermaid](https://mermaid.js.org)
> (render natively on GitHub and in most IDEs). Last updated: 27 June 2026.

---

## 1. System context (who talks to what)

```mermaid
flowchart TB
  subgraph Clients["Clients / devices"]
    POS["POS terminal<br/>(Sunmi Android APK · WebView)"]
    KIOSK["Self-service kiosk<br/>+ Stripe reader"]
    MPOS["Mobile POS / phone"]
    BO["Back Office<br/>(browser)"]
    CUST["Customers<br/>(online ordering / QR / tracker)"]
    BOARD["Menu board TV"]
  end

  subgraph Vercel["Vercel (frontend + serverless)"]
    SPA["React SPA<br/>(one build, ~17 surfaces)"]
    AIPROXY["/api/ai<br/>(serverless proxy)"]
  end

  subgraph Supabase["Supabase (backend)"]
    OPS["Ops DB (Postgres + RLS)<br/>orders · menu · stock · workforce · delivery"]
    PLAT["Platform DB (Postgres + RLS)<br/>users · gift cards · loyalty"]
    EF["Edge Functions (Deno, 60+)<br/>hold secrets · tenant-aware auth"]
    RT["Realtime"]
    ST["Storage<br/>assets · receipts · APK"]
  end

  subgraph Ext["External services"]
    STRIPE["Stripe"]
    RYFT["Ryft"]
    HUBRISE["HubRise (3PO in)"]
    STUART["Stuart (courier)"]
    RESEND["Resend (email)"]
    TWILIO["Twilio (SMS)"]
    MAPBOX["Mapbox"]
    ANTHROPIC["Anthropic (Claude)"]
  end

  POS & KIOSK & MPOS & BO & CUST & BOARD --> SPA
  SPA -->|REST / Realtime| OPS
  SPA --> PLAT
  SPA -->|invoke| EF
  SPA --> AIPROXY --> ANTHROPIC
  SPA <-->|live sync| RT
  SPA --> ST
  EF --> OPS & PLAT
  EF --> STRIPE & RYFT & STUART & RESEND & TWILIO
  HUBRISE -->|inbound webhook| EF
  STUART -->|status webhook| EF
  STRIPE & RYFT -->|payment webhook| EF
  SPA --> MAPBOX
```

---

## 2. Deployment topology & promotion

```mermaid
flowchart LR
  DEVR["Developer"] -->|push| GH["GitHub<br/>Serv-OS/possystem<br/>(secret-scan push protection)"]
  GH -->|branch develop| DEV["Vercel · dev env<br/>dev.serv-os.app · possystem-liard · dev.pos-up.com"]
  GH -->|branch main| PROD["Vercel · production<br/>app.serv-os.app"]
  DEVR -->|supabase CLI| EFD["Edge Functions (Ops DB)"]
  DEVR -->|Management API · authorised| MIG["DB migrations (numbered, reversible)"]
  APK["Sunmi APK"] -->|self-update| STO["Supabase Storage"]
  DEV -. active QA line .- PROD
```

*Edge-function deploys that write new columns run **after** the corresponding migration.*

---

## 3. Order → payment → fulfilment (request lifecycle)

```mermaid
sequenceDiagram
  participant C as Customer / staff
  participant SPA as React SPA
  participant EF as Edge Functions
  participant DB as Ops DB
  participant PAY as Stripe/Ryft
  participant COUR as Stuart / HubRise

  C->>SPA: Build order (menu, mods, address)
  SPA->>EF: quote (delivery) — address→geocode→courier price
  EF->>COUR: live price + ETA
  EF-->>SPA: fee + ETA (surcharge policy applied)
  C->>SPA: Pay
  SPA->>PAY: tokenised payment (card never touches ServOS)
  PAY-->>SPA: success
  SPA->>DB: closed_checks (immutable sale) + order_queue (kitchen)
  SPA->>EF: dispatch courier (idempotent reserve-then-act)
  EF->>COUR: create job (scheduled at ready-time if future)
  COUR-->>EF: status webhook / EF polls → courier_deliveries
  EF->>EF: Resend (receipt) + Twilio (confirmation/tracking)
  SPA-->>C: branded tracker (live map, ETA, status)
```

---

## 4. Multi-tenancy & trust boundary

```mermaid
flowchart TB
  subgraph Browser["Browser / device (untrusted)"]
    UI["SPA — pinned active location_id<br/>anon / device / BO session"]
  end
  subgraph Edge["Edge Functions (trust boundary)"]
    RT1["requireToken<br/>(operational reads — incl. anon POS)"]
    RA["requireAccess<br/>(BO user w/ user_locations, or super-admin)"]
  end
  subgraph Data["Postgres"]
    RLS["RLS-protected operational tables<br/>(filtered by location_id)"]
    SR["Service-role-only tables<br/>(delivery, hubrise, workforce PII)<br/>RLS on · no client policies"]
  end
  UI -->|JWT| RT1 --> RLS
  UI -->|JWT| RA --> SR & RLS
  UI -.->|direct, RLS-fenced| RLS
  UI -. blocked .-x SR
```

*Secrets (Stripe/Ryft/Twilio/Resend/Stuart/HubRise) and per-tenant courier credentials live behind
the edge tier and are never returned to the browser.*

---

## 5. Delivery fulfilment seam (own-courier vs aggregators)

```mermaid
flowchart LR
  ORDER["Delivery order"] --> MODE{delivery_mode}
  MODE -->|self| KITCHEN["Fires to POS/KDS<br/>venue delivers"]
  MODE -->|courier| BACKEND{dispatch_backend}
  BACKEND -->|stuart| STUART["Stuart — per-location account<br/>quote · schedule · dispatch · track"]
  BACKEND -.->|uber_api / hubrise_bridge<br/>(parked)| PARKED["Retired/parked seam"]
  INBOUND["Deliveroo / Uber Eats / Just Eat"] -->|HubRise webhook| HUB["Inbound 3PO orders<br/>→ Orders Hub + KDS"]
```

---

## 6. Surfaces from one codebase

```mermaid
flowchart TB
  CODE["Single React build"]
  CODE --> A["POS · Bar · Tables · KDS"]
  CODE --> B["Kiosk · MPOS · Time Clock"]
  CODE --> C["Online ordering · QR · Order tracker"]
  CODE --> D["Back Office (menu, reports, workforce, ops, delivery, channels)"]
  CODE --> E["Loyalty portal · Gift cards · Review card"]
  CODE --> F["Menu board · Owner app · AI assistant"]
```
