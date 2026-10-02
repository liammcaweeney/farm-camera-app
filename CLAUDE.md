# CLAUDE.md

> This file is a persistent project brief for [Claude Code](https://claude.ai/code). It gives Claude the context it needs to work on this codebase across sessions — architecture, SSH access, deployment commands, and known quirks. It's the equivalent of onboarding a developer.

## Project

Ansible provisioning for a Raspberry Pi camera system. All infrastructure is managed from this directory on the Mac and applied to the Pi via SSH.

## SSH

- `rpi` → `192.168.18.35` (local network; DHCP-reserved on the router for MAC `88:a2:9e:7f:ef:a2`)
- `rpi-mdns` → `rpi.local` (mDNS fallback)
- `rpi-ts` → `<tailscale-ip>` (Tailscale — SSH/admin only; it carries **no** camera or web traffic and is not part of the data path)
- User: `admin`
- Key has a passphrase — run `ssh-add ~/.ssh/id_rsa` before running Ansible
- All aliases set `ConnectionAttempts 5` / `ServerAliveInterval 15`. The Pi's WiFi is strong now (`-35 dBm`, 433 Mbit/s, 0% loss on 1400-byte pings, ~5 ms RTT, measured 2026-09-12) — if SSH times out, suspect something else first. Retry once before concluding the Pi is down.
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

This was only possible because the home connection has a real routable IP (`193.120.11.191` as of 2026-09-12; the user reports it is now static). The VPS existed originally to work around CGNAT; if the ISP ever moves this line behind CGNAT, direct exposure stops working and the fallback is Cloudflare Tunnel (outbound-only, no port-forward — but it cannot carry WebRTC UDP, so streaming would drop to HLS only).

**coturn/TURN was removed on 2026-09-12.** With the Pi on a public IP, ICE completes directly for every client (including phones on carrier NAT) because only one side needs to be reachable; UDP-blocked networks fall back to ICE-TCP on 8890. Do not reintroduce a relay.

## Public URL

`https://<your-domain>` — DuckDNS pointing at the **home WAN IP**.

`duckdns/duck.sh` runs every 5 min from admin's crontab. It deliberately sends **no** `&ip=` parameter, so DuckDNS records the source IP of the request — the current home WAN IP. It previously hardcoded the VPS IP, which is why DNS kept resolving to a dead host after the VPS was reclaimed. Never reintroduce a hardcoded `ip=`.


## Services

- Cameras index: `https://<your-domain>/cameras/`
- Portainer: `https://<your-domain>/portainer/`
- Glances: `https://<your-domain>/monitoring/`
- NVR: `https://<your-domain>/nvr/`
- Tapo PTZ: `https://<your-domain>/cameras/tapo.html`

## Cameras

> Status 2026-09-26: cam4 ("The Back") streams on `192.168.18.59` (`ready=true`). cam5 ("Dry Cows") was found at `192.168.18.60` after a factory reset — its config had the wrong user *and* IP (`camera@.56`); correct is `drycows@.60`. cam3 (`.61`) is absent from the LAN entirely: a full `192.168.18.0/24` sweep found only `.59` and `.60` with port 554 open. cam1/cam2 (NVR) and rosie still point at `192.168.1.x` and are unreachable.
>
> Cams joined to the router's own WiFi (e.g. cam5 on `SSID5`) show their real MAC in the router's *User Device Information* list, so DHCP reservations on it work. Clients behind the outdoor TP-Link EAP225 APs (router `LAN2`) can appear under a proxy MAC (`e6:67:1e:74:95:ad`) instead. The router list also shows Online/Offline per device: check it first when a cam vanishes. Real MACs, read over ONVIF `GetNetworkInterfaces`: cam4 `0C:EF:15:DE:DC:9B`, cam5 `0C:EF:15:DE:DD:E0` (both Tapo C520WS). When a cam goes missing, sweep for open 554 rather than assuming its old IP. `EXPECTED` in `check-tunnel.sh` is deliberately empty — a populated list bounced the mediamtx container every 5 minutes against absent cameras. Check live state with `curl -s localhost:9997/v3/paths/list` on the Pi.

| Path | Source | Codec | PTZ container | Notes |
|------|--------|-------|---------------|-------|
| cam1 | rtsp://192.168.1.230 channel 1 | H265 | — | NVR (offline) |
| cam2 | rtsp://192.168.1.230 channel 2 | H265 | — | NVR (offline) |
| cam3 | rtsp://192.168.18.61/stream2 | H264 | `tapo-ptz` | Tapo C520WS "Old Parlour" — `www/tapo.html` |
| cam4 | rtsp://192.168.18.59/stream2 | H264 | `tapo-ptz2` | Tapo "The Back" — user `theback` |
| cam5 | rtsp://192.168.18.60/stream2 | H264 | `tapo-ptz4` | Tapo "Dry Cows" — user `drycows`, `www/cam5.html` |
| rosie | rtsp://192.168.1.125/stream2 | H264 | `tapo-ptz3` | Tapo "Hayshed" — `www/rosie.html` (offline) |

Cameras behind the TP-Link extender have shown 35–45% loss on 1400-byte packets — test with `ping -s 1400 <cam-ip>` from the Pi before blaming mediamtx.

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
- **ICE**: **No STUN, no TURN.** Every player page sets `iceServers: []`. mediamtx advertises directly-reachable host candidates via `webrtcAdditionalHosts: [<your-domain>, 192.168.18.35]` in `mediamtx.yml` — the DuckDNS hostname for internet clients (follows the WAN IP if it changes) and the LAN IP so local clients connect without a NAT hairpin. Because the Pi side is public, the browser's NAT type is irrelevant: its check reaches the Pi, the Pi answers to the source address (peer-reflexive), done. Media then flows browser ↔ `:8189/udp` (or `:8890/tcp` where UDP is blocked) and never touches Caddy or oauth2-proxy — only the WHEP signalling POST does.
- **Verify a session is direct**: `chrome://webrtc-internals` → selected candidate pair should be `host`/`prflx`/`srflx`, never `relay`.
- **iOS**: tapo.html still uses HLS on iOS. That rule dates from the TURN era (WebRTC didn't render through the relay on iOS); with the direct path it is untested — worth retrying WebRTC on iOS for the H264 Tapo cams. cam1/cam2 fall back to HLS naturally (H265 WebRTC unreliable on iOS).
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
| 8189 | UDP | mediamtx WebRTC media | ⏳ user adding 2026-09-12 |
| 8890 | TCP | mediamtx WebRTC TCP fallback (UDP-blocked networks) | ⏳ user adding 2026-09-12 |

That is the complete list — four rules. coturn is gone, so 3478 and 49160–49200 must **not** be forwarded. Until 8189 is forwarded, WebRTC fails from the internet; LAN clients still connect via the `192.168.18.35` candidate, and HLS works from anywhere because it rides the HTTPS chain.

Router quirks: the ONT truncates names in the mapping list, and `Port Trigger Configuration` is a *different, wrong* page (triggering only opens ports temporarily after outbound traffic). NAT hairpin works, so testing the public IP from inside the LAN is valid.

`/usr/local/bin/check-tunnel.sh` still runs every 5 min but has no tunnel to restart — its site check is now report-only, logging to `cam-health` via `journalctl -t cam-health`.

## PTZ Controls

Tapo C520WS PTZ is controlled via ONVIF through the `tapo-ptz` container (Node.js service on port 3001).

- One container per camera, ONVIF on port 2020: `tapo-ptz` → `192.168.18.61` (cam3), `tapo-ptz2` → `192.168.18.59` (cam4), `tapo-ptz3` → `192.168.1.125` (rosie), `tapo-ptz4` → `192.168.18.60` (cam5). Caddy routes `/tapo-ptzN*` → `tapo-ptzN:3001`.
- Preset race condition fix: always `await ptz(0,0,0)` before `absoluteMove` in `gotoPreset`
- Touch/mouseup stop skips when target is a preset button (`.preset-btn`, `.preset-save`)

## WiFi

Configured via Netplan (`/etc/netplan/50-wifi.yaml`). Networks and credentials are in `playbook.yml` and `setup.md`. Current network: `McAweeneys` on `192.168.18.0/24`.

Power save is disabled by the `wifi-powersave-off` systemd unit (see `playbook.yml`) — it caused multi-second RTTs. With that fixed the link is strong (`-35 dBm`, 433 Mbit/s, 0% loss, 2026-09-12); do not treat Pi WiFi as the bottleneck. Check with `iw dev wlan0 link` and `ping -c 10 -s 1400 192.168.18.1`.

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
| `duck.sh` | DuckDNS updater — deployed to `/home/admin/duckdns/duck.sh` |
| `check-tunnel.sh` | Health checks — deployed to `/usr/local/bin/` |
| `mediamtx.yml` | RTSP→WebRTC/HLS bridge config |
| `grab-thumbs.sh` | ffmpeg thumbnail grabber (systemd: cam-thumbs) |
| `www/index.html` | Camera thumbnail grid |
| `www/tapo.html` | Tapo PTZ page (WebRTC on desktop, HLS on iOS) |
| `www/cam1.html` | Camera 1 full-screen page |
| `www/cam2.html` | Camera 2 full-screen page |
