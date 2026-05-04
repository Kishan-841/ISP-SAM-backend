# SAM backend — VM deployment guide

Deploys SAM (Express + Postgres) on the Gazon ISP VM (Ubuntu 24.04) alongside
the existing CRM compose project. Frontend stays on Vercel and hits this
backend over HTTPS at `sam.gazonindia.com`.

## Prerequisites on the VM

- Docker + Docker Compose v2 (already installed if the CRM is running there)
- nginx (for TLS termination on `sam.gazonindia.com`)
- certbot (for Let's Encrypt cert provisioning)
- DNS: an A record `sam.gazonindia.com` → the VM's public IP

## 1. First-time setup

```sh
ssh gazoncrm@202.136.68.13

# Clone the SAM backend repo (or git pull if already cloned)
cd ~
git clone https://github.com/Kishan-841/ISP-SAM-backend.git sam-backend
cd sam-backend

# Generate the production env file
cp .env.production.example .env

# Generate fresh secrets on the VM. Copy each output into the .env file.
openssl rand -hex 32      # → POSTGRES_PASSWORD
openssl rand -hex 32      # → JWT_SECRET
openssl rand -hex 32      # → CRM_WEBHOOK_SECRET
# Keep CRM_WEBHOOK_SECRET handy — you'll set the same value on the CRM side.

nano .env                 # paste the values, set ADMIN_EMAIL / ADMIN_PASSWORD
chmod 600 .env            # tighten permissions

# Bring it up
docker compose up -d --build

# Tail logs while it boots
docker compose logs -f backend
```

On first boot the entrypoint runs `prisma migrate deploy` (creates all
tables in the `sam` Postgres database), then starts the Express server on
port 5500. You should see `SAM backend listening on :5500`.

Verify locally on the VM:

```sh
curl -i http://127.0.0.1:5500/health
# → HTTP/1.1 200 OK
# → {"status":"ok"}
```

## 2. nginx + TLS for `sam.gazonindia.com`

Create `/etc/nginx/sites-available/sam.gazonindia.com`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name sam.gazonindia.com;
    # certbot adds the cert + redirects below.
}
```

Enable it and provision the cert:

```sh
sudo ln -s /etc/nginx/sites-available/sam.gazonindia.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d sam.gazonindia.com
```

Certbot will rewrite the file to add HTTPS + cert paths. Then add the
proxy block — edit the 443 server block certbot just created and add inside
it:

```nginx
    # Webhook + JSON API: proxy through to the SAM container on loopback.
    location / {
        proxy_pass http://127.0.0.1:5500;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;

        # CRITICAL: do NOT alter the request body. SAM's HMAC verifies over
        # raw bytes; any rewrite breaks signatures.
        proxy_request_buffering off;
        client_max_body_size 10m;       # commercial-change approval uploads
        proxy_read_timeout 30s;
    }
```

Reload:

```sh
sudo nginx -t && sudo systemctl reload nginx
curl -i https://sam.gazonindia.com/health   # → 200 from anywhere on the internet
```

## 3. Connect the CRM to production SAM

On the CRM side (the existing repo, not this one):

```sh
# In CRM /.env (production)
SAM_WEBHOOK_URL=https://sam.gazonindia.com/integrations/crm/customer-activated
SAM_WEBHOOK_SECRET=<the same value you put in SAM's CRM_WEBHOOK_SECRET>
SAM_WEBHOOK_ENABLED=false      # leave OFF until you've smoke-tested
```

Restart the CRM container after the env change:

```sh
cd ~/isp-crm-backend          # or wherever the CRM compose lives
docker compose up -d --force-recreate backend
```

## 4. Smoke test (5-step checklist before flipping the switch)

These prove the bridge works end-to-end without sending real customer data.

```sh
# 1. Both servers' clocks are in agreement (replay window is ±5 min)
date -u

# 2. Migration tables exist
docker compose exec db psql -U sam_user -d sam -c "\d integration_events"

# 3. SAM is reachable from the public internet via TLS
curl -i https://sam.gazonindia.com/health    # 200 {"status":"ok"}

# 4. Send a signed test webhook from the SAM VM (same machine has the secret)
docker compose exec backend node -e "
  const c=require('crypto'),
        ts=Math.floor(Date.now()/1000),
        body=JSON.stringify({
          eventId:c.randomUUID(),
          eventType:'customer.activated',
          occurredAt:new Date().toISOString(),
          customer:{
            externalId:'smoke-test-'+Date.now(),
            companyName:'Smoke Test Co',
            currentMrr:1,
            onboardingDate:new Date().toISOString().slice(0,10),
          },
        }),
        sig=c.createHmac('sha256',process.env.CRM_WEBHOOK_SECRET).update(ts+'.').update(body).digest('hex');
  fetch('http://127.0.0.1:5500/integrations/crm/customer-activated',{
    method:'POST',
    headers:{'Content-Type':'application/json','X-CRM-Signature':sig,'X-CRM-Timestamp':String(ts)},
    body,
  }).then(r=>r.text()).then(console.log);
"
# Expect: {"status":"processed", ...}

# 5. Confirm it landed
docker compose exec db psql -U sam_user -d sam -c \
  "SELECT status, account_id FROM integration_events ORDER BY received_at DESC LIMIT 1"
# Expect: status=PROCESSED, account_id is a UUID
```

If all 5 pass, flip the kill-switch on the CRM:

```sh
# In CRM /.env
SAM_WEBHOOK_ENABLED=true

docker compose up -d --force-recreate backend
```

Then activate ONE real (or dummy) customer through the CRM Accounts UI.
Within ~1s, check the SAM Integration Log page (`/integrations` in the SAM
frontend) — it should appear as PROCESSED.

## 5. Day-to-day ops

```sh
# Pull new code & restart
cd ~/sam-backend
git pull
docker compose up -d --build backend

# Re-apply migrations only (without rebuilding)
docker compose exec backend pnpm exec prisma migrate deploy

# Tail logs
docker compose logs -f backend
docker compose logs -f db

# psql shell
docker compose exec db psql -U sam_user -d sam

# Stop / start
docker compose stop
docker compose start

# Backup the Postgres volume
docker run --rm \
  -v sam-backend_pgdata:/data \
  -v $(pwd)/backups:/backups \
  alpine \
  tar czf /backups/pgdata-$(date +%Y%m%d).tar.gz -C /data .
```

## Rollback

If a deploy goes bad:

```sh
git log --oneline -10                # find the previous good commit
git checkout <previous-sha>
docker compose up -d --build backend
```

The `integration_events` table preserves every webhook receipt regardless
of code version, so audit data isn't lost during a rollback.
