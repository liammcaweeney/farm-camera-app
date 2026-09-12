#!/bin/bash
# DuckDNS updater. No &ip= param — DuckDNS uses the source IP of this request,
# which is the home WAN IP. Tracks residential IP changes automatically.
# Token lives in /home/admin/rpi/.env as DUCKDNS_TOKEN.

set -u
LOG=/home/admin/duckdns/duck.log
# Pull just the one key rather than sourcing .env — that file has unquoted
# values and parenthesised comments that can trip `source`.
DUCKDNS_TOKEN=$(grep -E '^DUCKDNS_TOKEN=' /home/admin/rpi/.env | cut -d= -f2-)

RESULT=$(curl -s "https://www.duckdns.org/update?domains=killywilly&token=${DUCKDNS_TOKEN}")
echo "$(date -Is) $RESULT" >> "$LOG"

# Keep the log from growing forever
tail -n 500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
