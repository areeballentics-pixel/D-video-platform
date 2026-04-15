#!/bin/bash
# Nightly Postgres backup for the video platform.
#
# Install as a cron job on the VPS:
#   chmod +x /opt/video-platform/backup.sh
#   sudo crontab -e
#   # Add the line below (runs every night at 02:15 server time):
#   15 2 * * * /opt/video-platform/backup.sh >> /var/log/video-platform-backup.log 2>&1
#
# Retention: keeps the last 14 daily dumps in /var/backups/video-platform.
# For off-site backups, rsync this directory to S3 / another VPS / Google Drive.

set -euo pipefail

# Change to the project directory so `docker compose` finds compose files
cd "$(dirname "$(readlink -f "$0")")"

# Load env vars (POSTGRES_USER, POSTGRES_DB)
if [ -f .env ]; then
	set -a
	# shellcheck disable=SC1091
	. ./.env
	set +a
else
	echo "ERROR: .env not found in $(pwd)"
	exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-/var/backups/video-platform}"
mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/db_${TIMESTAMP}.sql.gz"

echo "[$(date)] Starting backup → $BACKUP_FILE"

# Dump from the running postgres container
docker compose -f docker-compose.prod.yml exec -T postgres \
	pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
	| gzip > "$BACKUP_FILE"

# Verify the dump isn't empty (<1KB is almost certainly a failure)
if [ $(stat -c%s "$BACKUP_FILE") -lt 1024 ]; then
	echo "ERROR: backup file is suspiciously small — investigate"
	exit 1
fi

# Retention: keep 14 days
find "$BACKUP_DIR" -name "db_*.sql.gz" -mtime +14 -delete

echo "[$(date)] Backup complete ($(du -h "$BACKUP_FILE" | cut -f1))"
