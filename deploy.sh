#!/bin/bash
set -e

# Load .env
set -a; source .env; set +a

REMOTE=rpi-ts
REMOTE_DIR=/home/admin/rpi

# Generate files from templates
envsubst < mediamtx.yml.template > mediamtx.yml
envsubst < www/cam1.html.template > www/cam1.html
envsubst < www/cam2.html.template > www/cam2.html
envsubst < www/tapo.html.template > www/tapo.html

# Deploy
scp docker-compose.yml mediamtx.yml Caddyfile "$REMOTE:$REMOTE_DIR/"
scp www/cam1.html www/cam2.html www/tapo.html www/index.html "$REMOTE:$REMOTE_DIR/www/"

# Restart services (pass service names as args, or restart all)
SERVICES="${*:-mediamtx oauth2-proxy}"
ssh "$REMOTE" "cd $REMOTE_DIR && sudo docker compose up -d $SERVICES"
