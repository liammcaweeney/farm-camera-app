# CLAUDE.md

> This file is a persistent project brief for [Claude Code](https://claude.ai/code). It gives Claude the context it needs to work on this codebase across sessions — architecture, SSH access, deployment commands, and known quirks. It's the equivalent of onboarding a developer.

## Project

Ansible provisioning for a Raspberry Pi camera system. All infrastructure is managed from this directory on the Mac and applied to the Pi via SSH.

## SSH

- `rpi` → `192.168.18.35` (local network; DHCP-reserved on the router for MAC `88:a2:9e:7f:ef:a2`)
- `rpi-mdns` → `rpi.local` (mDNS fallback)
- `rpi-ts` → `<tailscale-ip>` (Tailscale)
- User: `admin`
- Key has a passphrase — run `ssh-add ~/.ssh/id_rsa` before running Ansible
- All aliases set `ConnectionAttempts 5` / `ServerAliveInterval 15`. The WiFi link is weak and single attempts frequently time out during banner exchange — retry before concluding the Pi is down.
- Saturating the uplink (e.g. a large `docker pull`) starves SSH completely. If the Pi goes unreachable mid-task, check for a running pull before assuming a crash.

## Running Ansible

```bash
ansible-playbook -i inventory.ini playbook.yml
```

## Updating Docker Services

After editing `docker-compose.yml` or `Caddyfile`, push to the Pi and restart the affected service:

```bash
scp docker-compose.yml Caddyfile rpi-ts:/home/admin/rpi/
ssh rpi-ts "cd /home/admin/rpi && sudo docker compose up -d <service>"
```

For www files (HTML, etc.) only — no restart needed, just scp:
```bash
scp www/<file> rpi-ts:/home/admin/rpi/www/
```

Always verify changes work before asking the user to test — use `curl` to check HTTP responses from `https://<your-domain>`.

## Architecture

```
Browser → router port-forward :80/:443 → Pi Caddy (terminates TLS, Let's Encrypt)
                                              → oauth2-proxy :4180 (Google auth)
                                                   → Caddy :8081 (internal backend)
                                                        → static files /srv/cameras
                                                        → mediamtx :8889 (WebRTC WHEP)
                                                        → mediamtx :8888 (HLS)
                                                        → portainer :9000
                                                        → glances :61208
                                                        → tapo-ptz :3001
```

**The Oracle VPS is gone** (free-tier instance reclaimed, discovered 2026-08-07). There is no reverse SSH tunnel any more. The Pi sits behind a plain port-forward on a public, non-CGNAT home IP and serves HTTPS itself.

This was only possible because the home connection has a real routable IP (`194.46.233.45` at time of writing, residential so it can rotate). The VPS existed originally to work around CGNAT; if the ISP ever moves this line behind CGNAT, direct exposure stops working and the fallback is Cloudflare Tunnel (outbound-only, no port-forward, but it cannot carry UDP TURN).

## Public URL

`https://<your-domain>` — DuckDNS pointing at the **home WAN IP**.

`duckdns/duck.sh` runs every 5 min from admin's crontab. It deliberately sends **no** `&ip=` parameter, so DuckDNS records the source IP of the request — the current home WAN IP. It previously hardcoded the VPS IP, which is why DNS kept resolving to a dead host after the VPS was reclaimed. Never reintroduce a hardcoded `ip=`.

The same script rewrites coturn's `external-ip` and restarts it when the WAN IP changes.

## Services

- Cameras index: `https://<your-domain>/cameras/`
- Portainer: `https://<your-domain>/portainer/`
- Glances: `https://<your-domain>/monitoring/`
- NVR: `https://<your-domain>/nvr/`
- Old Parlour PTZ: `https://<your-domain>/cameras/tapo.html`

## Cameras

> **Status 2026-09-12:** Pi is on `192.168.18.x`. Only cam3 (Old Parlour, `.61`) and cam4 (Heifers, `.59`) are reachable; cam5 (`.56`) is silent and cam1/cam2 (NVR) and rosie are still on the old `192.168.1.x` subnet. `EXPECTED` in `check-tunnel.sh` is deliberately empty — a populated list bounced the mediamtx container every 5 minutes against absent cameras. Tapo cams sit behind a WiFi extender (all share ARP MAC `e6:67:1e:74:da:e5`) and get DHCP addresses that can rotate — verify with `ffprobe rtsp://<user>:<pass>@<ip>/stream2` before assuming a config is right.

| Path | Source | Codec | Notes |
|------|--------|-------|-------|
| cam1 | rtsp://192.168.1.230 channel 1 | H265 | NVR |
| cam2 | rtsp://192.168.1.230 channel 2 | H265 | NVR |
| cam3 | rtsp://192.168.18.61/stream2 (user `oldparlour`) | H264 | Old Parlour — Tapo C520WS PTZ (`tapo-ptz`) |
| cam4 | rtsp://192.168.18.59/stream2 (user `theback`) | H264 | Heifers — Tapo PTZ (`tapo-ptz2`) |
| cam5 | rtsp://192.168.18.56/stream2 (user `camera`) | H264 | Dry Cows — Tapo PTZ (`tapo-ptz4`) |
| rosie | rtsp://192.168.1.125/stream2 (user `hayshed`) | H264 | Rosie Cam — Tapo PTZ (`tapo-ptz3`) |

All use `rtspTransport: tcp` — UDP caused FU-A packet errors causing frame drops.

Thumbnails are generated by `grab-thumbs.sh` (systemd service `cam-thumbs`) using ffmpeg reading from mediamtx RTSP on `localhost:8554`. ffmpeg reads from mediamtx, NOT directly from cameras — direct camera RTSP connections caused stream degradation.

To add a new camera:
1. Add path to `mediamtx.yml`
2. Add grab line to `grab-thumbs.sh` and restart: `sudo systemctl restart cam-thumbs`
3. Add entry to `CAMERAS` array in `www/index.html`
4. Create individual camera page (copy cam2.html pattern)

## WebRTC / Streaming

- **WHEP endpoint**: `/whep/{cam}/whep` → mediamtx :8889
- **HLS endpoint**: `/hls/{cam}/index.m3u8` → mediamtx :8888
- **ICE**: Uses STUN + TURN. With a public IP the Pi advertises a directly-reachable host candidate via `webrtcAdditionalHosts: [<your-domain>]` in `mediamtx.yml` — a hostname rather than a literal IP so it follows DuckDNS when the WAN IP rotates. Direct beats relay; TURN is now only a fallback for symmetric-NAT clients.
- **TURN server**: `turn:<your-domain>:3478` — coturn **moved from the VPS to the Pi** (`coturn.conf`, docker-compose service `coturn`, `network_mode: host`). Credentials unchanged, in `www/*.html` and `mediamtx.yml`.
- coturn pins `listening-ip`/`relay-ip` to the LAN IP. Without that, host networking makes it auto-discover and listen on every docker bridge (172.x) and tailscale0 — useless as relay addresses.
- On the VPS an open relay only exposed the VPS. On the Pi it would expose the home LAN, so `coturn.conf` denies RFC1918 ranges and allow-lists only the Pi itself.
- Verify coturn with a STUN binding request to `192.168.18.35:3478` — a `0x0101` success response with a matching transaction ID confirms it end-to-end. Port 3478 is not yet forwarded on the router, so it is LAN-only until the cameras return.
- **iOS**: Goes through TURN relay. tapo.html uses HLS on iOS (WebRTC doesn't render through TURN relay on iOS). cam1/cam2 fall back to HLS naturally (H265 WebRTC unreliable on iOS).
- **"Falling back to HLS..." + black screen on both Tapo cams (2026-09-12)**: root cause was the TP-Link WiFi extender the cameras hang off (`192.168.18.41`/`.44`, all clients behind it share ARP MAC `e6:67:1e:74:da:e5`). Small pings looked fine (~6% loss) but video-sized frames dropped ~35–45%: `ping -s 1400 -i 0.03 -w 30 -q 192.168.18.41` from the Pi (0% to the gateway as control). Cameras' RTSP TCP streams stalled 8–10s at a time → mediamtx `[RTSP source] TCP timeout` → WebRTC sessions `terminated`, HLS `segment duration changed … 18s` → black. Not a config problem; fix is the extender (reboot / reposition / 5 GHz backhaul). Quick stall check with no viewers: sample `curl localhost:9997/v3/paths/get/cam3 | jq .bytesReceived` once a second — it must climb every second.
- **Stall detection**: All camera pages use `keepLive()` — detects if `currentTime` freezes for 3s or lags >4s behind wall clock, then reconnects WebRTC.

## Auth

- oauth2-proxy handles Google OAuth
- **`/api/wedding-rsvp` is unauthenticated.** It previously carried a `remote_ip 172.16.0.0/12` guard, which passed only because tunnelled traffic arrived from the Docker gateway. With traffic now arriving from real internet addresses that guard would 403 every request, so it was removed. The endpoint was already publicly reachable through the VPS, so this is parity — but it is an open POST endpoint with no rate limiting.
- Any Google account allowed (`--email-domain=*`)
- Logs at `/home/admin/rpi/logs/oauth2-proxy.log`
- To list emails that have logged in: `grep -oE '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' /home/admin/rpi/logs/oauth2-proxy.log | sort -u`
- Cookie expires after 30 days (`--cookie-expire=720h`)

## Public Access (port forwarding)

`tunnel-vps` is **disabled and no longer used**. Public traffic arrives via router port-forwards on the Huawei ONT (`IPv4 Port Mapping` page, WAN `1_TR069_VOIP_INTERNET_R_VID_10`), all to `192.168.18.35`:

| Port | Proto | Purpose | Configured |
|------|-------|---------|-----------|
| 80 | TCP | HTTP→HTTPS redirect, ACME HTTP-01 | ✅ |
| 443 | TCP | HTTPS, ACME TLS-ALPN-01 | ✅ |
| 8189 | UDP | mediamtx WebRTC | ❌ pending cameras |
| 8890 | TCP | mediamtx WebRTC TCP fallback | ❌ pending cameras |
| 3478 | TCP+UDP | coturn | ❌ pending cameras |
| 49160–49200 | UDP | coturn relay range | ❌ pending cameras |

Router quirks: the ONT truncates names in the mapping list, and `Port Trigger Configuration` is a *different, wrong* page (triggering only opens ports temporarily after outbound traffic). NAT hairpin works, so testing the public IP from inside the LAN is valid.

`/usr/local/bin/check-tunnel.sh` still runs every 5 min but has no tunnel to restart — its site check is now report-only, logging to `cam-health` via `journalctl -t cam-health`.

## PTZ Controls

Tapo C520WS PTZ is controlled via ONVIF through the `tapo-ptz` container (Node.js service on port 3001).

- Camera IP: `192.168.18.61:2020` (Old Parlour / cam3; cam4/cam5/rosie have their own `tapo-ptz2/3/4` containers)
- Preset race condition fix: always `await ptz(0,0,0)` before `absoluteMove` in `gotoPreset`
- Touch/mouseup stop skips when target is a preset button (`.preset-btn`, `.preset-save`)

## WiFi

Configured via Netplan (`/etc/netplan/50-wifi.yaml`). Networks and credentials are in `playbook.yml` and `setup.md`. Current network: `McAweeneys` on `192.168.18.0/24`.

Power save is disabled by the `wifi-powersave-off` systemd unit (see `playbook.yml`) — it caused multi-second RTTs. The link is still weak regardless.

**Changing WiFi with the Pi offline:** macOS cannot mount the ext4 rootfs, so `/etc/netplan/50-wifi.yaml` is unreachable from a Mac. Go through cloud-init on the FAT32 `system-boot` partition instead: edit `network-config`, add a `write_files` + `runcmd` block to `user-data` (needed because Ansible's `50-wifi.yaml` sorts after `50-cloud-init.yaml` and wins the netplan merge), and **bump `instance-id` in `meta-data`** — without that, cloud-init treats network config as already-applied and silently ignores the edit.

## DNS gotcha

Tailscale MagicDNS hijacks `/etc/resolv.conf` via systemd-resolved and, when unhealthy, answers **empty** rather than failing over — which silently breaks ACME renewals and image pulls while the Pi otherwise looks fine. The router's resolver (`192.168.18.1`) works; external resolvers (`8.8.8.8`, `1.1.1.1`) are blocked outbound by the router, so there is no fallback.

Fixed with `sudo tailscale set --accept-dns=false`. If DNS breaks again, check this first:

```bash
ssh rpi 'getent hosts acme-v02.api.letsencrypt.org; resolvectl status | grep "Current DNS Server"'
```

## Key Files

| File | Purpose |
|------|---------|
| `docker-compose.yml` | All Docker services |
| `Caddyfile` | Public TLS vhosts + internal backend (:8081) |
| `coturn.conf` | TURN server config (moved off the VPS) |
| `duck.sh` | DuckDNS updater — deployed to `/home/admin/duckdns/duck.sh` |
| `check-tunnel.sh` | Health checks — deployed to `/usr/local/bin/` |
| `mediamtx.yml` | RTSP→WebRTC/HLS bridge config |
| `grab-thumbs.sh` | ffmpeg thumbnail grabber (systemd: cam-thumbs) |
| `www/index.html` | Camera thumbnail grid |
| `www/tapo.html` | Tapo PTZ page (WebRTC on desktop, HLS on iOS) |
| `www/cam1.html` | Camera 1 full-screen page |
| `www/cam2.html` | Camera 2 full-screen page |
