# Deploying to Hostinger VPS (Ubuntu 24.04)

End-to-end guide for a single-VPS deployment. Server + Postgres + Redis + Caddy live on the VPS; the dashboard goes to Vercel separately.

---

## 0. Prerequisites

- Hostinger VPS (KVM 2 or bigger) running Ubuntu 24.04
- Root SSH access (e.g. `ssh root@46.202.163.128`)
- A domain you can edit DNS for (e.g. `yourplatform.com`)
- This repo pushed to a Git host (GitHub/GitLab/etc.) — you'll clone it on the VPS

## 1. Point DNS at the VPS

Before anything else, create an `A` record so the domain resolves:

| Type | Name | Value                | TTL   |
|------|------|----------------------|-------|
| A    | `api`| `46.202.163.128`     | 3600  |

So `api.yourplatform.com` → your VPS. Wait a few minutes for propagation. Verify with:

```bash
dig +short api.yourplatform.com
# → 46.202.163.128
```

Caddy won't issue an SSL cert until this resolves correctly.

## 2. Harden the VPS (10 minutes, one-time)

SSH in as root first, then do these in order:

```bash
# 2a. Update everything
apt update && apt upgrade -y

# 2b. Create a non-root sudo user (replace `deploy` with your preferred name)
adduser deploy
usermod -aG sudo deploy

# 2c. Copy your SSH key to the new user (run this FROM YOUR LAPTOP, not the VPS):
#     ssh-copy-id deploy@46.202.163.128
#     — OR manually: mkdir /home/deploy/.ssh && paste your pubkey into authorized_keys

# 2d. Disable password login + root SSH (from within the VPS)
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl reload ssh

# 2e. Firewall — allow only SSH + HTTP + HTTPS
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp   # HTTP/3
ufw --force enable

# 2f. Fail2ban for SSH brute-force protection
apt install -y fail2ban
systemctl enable --now fail2ban
```

**IMPORTANT**: open a second SSH session as `deploy@...` and verify you can sudo BEFORE closing the root session. Otherwise if SSH key setup has any bug you'll lock yourself out.

## 3. Install Docker + Compose

From now on, run everything as the `deploy` user (`ssh deploy@46.202.163.128`).

```bash
# Docker Engine + Compose plugin (official install script)
curl -fsSL https://get.docker.com | sudo sh

# Let the deploy user run docker without sudo
sudo usermod -aG docker $USER
# Log out and back in for the group change to take effect
exit
```

Re-SSH, then verify:

```bash
docker version
docker compose version
```

## 4. Clone the repo + configure

```bash
sudo mkdir -p /opt/video-platform
sudo chown $USER:$USER /opt/video-platform
cd /opt/video-platform
git clone https://github.com/YOUR-USERNAME/YOUR-REPO.git .

# Create the production env file from the template
cp .env.prod.example .env
```

Now edit `.env` and fill in real values:

```bash
nano .env
```

Minimum required fields:
- `DOMAIN` → `api.yourplatform.com`
- `POSTGRES_PASSWORD` → long random string (`openssl rand -base64 32`)
- `JWT_SECRET_KEY` → `openssl rand -hex 32`
- `SERVER_ENCRYPTION_KEY` → `python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` (install python3-cryptography first if needed: `sudo apt install python3-cryptography`)
- `ADMIN_API_KEY` → `openssl rand -hex 16`
- `ALLOWED_ORIGINS` → your Vercel dashboard URL once you have it; for now leave blank or put `*` temporarily

**⚠️ BACK UP `SERVER_ENCRYPTION_KEY` IMMEDIATELY** — password manager AND on paper. If you lose it, every tenant's videos become unrecoverable.

## 5. Launch everything

```bash
# Build and start in detached mode
docker compose -f docker-compose.prod.yml up -d --build

# Watch the logs as Caddy provisions the SSL cert (first time takes ~30s)
docker compose -f docker-compose.prod.yml logs -f caddy
# Look for: "certificate obtained successfully"
# Ctrl+C to exit the log tail (containers keep running)

# Verify everything is healthy
docker compose -f docker-compose.prod.yml ps

# Smoke test
curl https://api.yourplatform.com/health
# Expected: {"status":"ok","version":"0.1.0"}
```

If Caddy fails to get a cert, it's almost always because:
1. DNS isn't pointing to the VPS yet (check `dig`)
2. Port 80 isn't actually reachable (check UFW + Hostinger firewall panel)

## 6. Create the first tenant + admin

```bash
docker compose -f docker-compose.prod.yml exec server \
    python scripts/bootstrap_tenant.py \
        --tenant-name "Your Academy" \
        --tenant-slug your-academy \
        --admin-email admin@yourplatform.com \
        --admin-password 'PickAStrongPassword!'
```

It will print the tenant master key in hex. **Save it** (password manager + paper backup).

## 7. Deploy dashboard to Vercel

1. Push the repo (if not already) to GitHub.
2. In Vercel: **Import Project** → pick the repo → set the **Root Directory** to `dashboard/`.
3. Add environment variable:
   - `NEXT_PUBLIC_API_URL` = `https://api.yourplatform.com`
4. Deploy. Vercel gives you a URL like `your-app.vercel.app`.
5. (Optional) Add a custom domain `admin.yourplatform.com` in Vercel → Vercel handles the SSL.
6. Come back to the VPS and update CORS:
   ```bash
   nano .env
   # Set: ALLOWED_ORIGINS=https://admin.yourplatform.com
   docker compose -f docker-compose.prod.yml up -d server
   ```

## 8. Build the production player `.exe`

On your Windows dev machine (where you build the Tauri app):

```powershell
cd player
$env:SVP_SERVER_URL = "https://api.yourplatform.com"
cd src-tauri
cargo clean
cd ..
npm install
cargo tauri build
# Output: src-tauri/target/release/bundle/msi/SecureVideoPlayer_0.1.0_x64_en-US.msi
```

Distribute that `.msi` to students (via your website, WhatsApp, USB, whatever).

## 9. Set up nightly backups

```bash
cd /opt/video-platform
chmod +x backup.sh

# Add to root's crontab (root needs to be able to write to /var/backups)
sudo crontab -e
```

Add this line:

```
15 2 * * * /opt/video-platform/backup.sh >> /var/log/video-platform-backup.log 2>&1
```

Runs every night at 02:15. Backups land in `/var/backups/video-platform/`, 14-day retention. Rsync them off-box weekly:

```bash
# Example: sync to your laptop once a week via cron or manually
rsync -avz deploy@46.202.163.128:/var/backups/video-platform/ ~/backups/video-platform/
```

## 10. Routine operations

```bash
# View logs
docker compose -f docker-compose.prod.yml logs -f server
docker compose -f docker-compose.prod.yml logs -f caddy

# Restart a single service
docker compose -f docker-compose.prod.yml restart server

# Apply code updates
cd /opt/video-platform
git pull
docker compose -f docker-compose.prod.yml up -d --build

# Shell into the running server (for debugging)
docker compose -f docker-compose.prod.yml exec server bash

# Run a migration manually (usually auto-runs on startup via Dockerfile CMD)
docker compose -f docker-compose.prod.yml exec server alembic upgrade head

# Stop everything
docker compose -f docker-compose.prod.yml down

# Stop + wipe volumes (⚠️ DELETES ALL DATA — only for fresh starts)
docker compose -f docker-compose.prod.yml down -v
```

## 11. Monitoring (light-touch)

For an MVP, the basics:

```bash
# Disk + memory
df -h
free -h

# Container resource usage
docker stats --no-stream

# Check that Caddy cert is still valid (auto-renews 30 days before expiry)
docker compose -f docker-compose.prod.yml exec caddy \
    caddy list-certificates
```

When you're ready for real monitoring, add UptimeRobot (free) pinging `https://api.yourplatform.com/health` every 5 minutes → email you if it goes down.

---

## Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| `curl: (35) OpenSSL SSL_connect` | DNS not pointing at VPS | Check `dig api.yourplatform.com` |
| `docker logs caddy` shows `http: no certificate available` | Port 80 blocked | `sudo ufw status`, check Hostinger's panel firewall too |
| `docker compose up` fails "permission denied" | Docker group not applied | Log out and back in |
| Server 500s with `ModuleNotFoundError: arq` | Old pyproject.toml | `git pull` (we added `arq` to deps), `docker compose build --no-cache server` |
| Uploads fail at >2GB | Caddy or server limit | Already set to 3GB in Caddyfile + 2.5GB in FastAPI |
| Player shows "session expired" repeatedly | CORS blocked | Add dashboard URL to `ALLOWED_ORIGINS`, restart server |

---

## Cost Estimate

- Hostinger VPS KVM 2: **~₹550/mo** ($7/mo)
- Domain (first year usually included with Hostinger): **~₹0-900/yr**
- Vercel dashboard hosting: **Free** (hobby tier covers you up to substantial traffic)
- SSL certificate: **Free** (Caddy + Let's Encrypt)
- UptimeRobot: **Free**

**Total: ~$7-10/month** for the full stack. Scales to a few thousand active students before you need to upgrade the VPS.
