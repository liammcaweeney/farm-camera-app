#!/bin/bash
# Health check: public site + mediamtx camera paths + cam-thumbs
# Runs every 5 min via admin cron.
#
# The Oracle VPS and its reverse SSH tunnel are gone — Caddy on this Pi now
# serves the public site directly. Nothing to restart on a tunnel failure, so
# section 1 only reports; a bad status here means router forward, DuckDNS, or
# the ISP, none of which this script can fix.

# 1. Public site reachability (report only)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://killywilly.duckdns.org/cameras/)
if [ "$STATUS" = "000" ] || [ "$STATUS" = "502" ] || [ "$STATUS" = "503" ] || [ "$STATUS" = "504" ]; then
  logger -t cam-health "public site unhealthy ($STATUS) — check router forward 80/443, DuckDNS record, Caddy cert"
fi

# 2. mediamtx camera paths — restart mediamtx if any expected path is not ready
#
# The cameras live on 192.168.1.x and the Pi has moved to 192.168.18.x, so none
# of them are reachable. Restarting mediamtx cannot fix an absent camera, and
# with a full list here this loop bounced the container every 5 minutes.
# Empty = skip the check. Repopulate when the cameras are back on this network:
#   EXPECTED="cam1 cam2 cam3 cam4 cam5 rosie"
EXPECTED=""
PATHS_JSON=$(curl -s --max-time 5 http://127.0.0.1:9997/v3/paths/list)
if [ -n "$PATHS_JSON" ] && echo "$PATHS_JSON" | python3 -c "import sys,json; json.load(sys.stdin)[\"items\"]" >/dev/null 2>&1; then
  BAD=""
  for p in $EXPECTED; do
    READY=$(echo "$PATHS_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(next((str(x[\"ready\"]).lower() for x in d[\"items\"] if x[\"name\"]==\"$p\"), \"missing\"))")
    if [ "$READY" != "true" ]; then
      BAD="$BAD $p($READY)"
    fi
  done
  if [ -n "$BAD" ]; then
    logger -t cam-health "unready paths:$BAD — restarting mediamtx"
    docker restart rpi-mediamtx-1 >/dev/null
  fi
else
  logger -t cam-health "mediamtx API unreachable, restarting container"
  docker restart rpi-mediamtx-1 >/dev/null
fi

# 3. cam-thumbs service
if ! systemctl is-active --quiet cam-thumbs; then
  logger -t cam-health "cam-thumbs not active, restarting"
  systemctl restart cam-thumbs
fi
