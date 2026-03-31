# Network Map

## Overview

Single flat network: `192.168.1.0/24`
DHCP server: Starlink Router (`192.168.1.1`)
The 2nd router has DHCP disabled — acts as a dumb passthrough, everything gets IPs from Starlink.

## Topology

```
         [Starlink .1]
         DHCP for all
               |
    [Switch .187 TP-Link ES205GP]
    |      |       |        |
AP .111  AP .209  Pi .46  Bridge .165
  |        |                  |
  +--------+             ~~~wireless~~~
  WiFi                        |
  |                      Bridge .203
MacBook .188                  |
                     [2nd Router .2]
                      DHCP off, dumb
                            |
                        NVR .230
                        /       \
                    Cam 1      Cam 2
                 (no IP)      (no IP)
```

## Device List

| IP | MAC | Vendor | Device |
|---|---|---|---|
| 192.168.1.1 | `74:24:9f:eb:e2:e0` | Tibro | Starlink Router (DHCP server) |
| 192.168.1.2 | `e6:67:1e:74:95:ad` | — | 2nd Router, Linksys WRT-based (DHCP off, dumb mode) |
| 192.168.1.46 | `88:a2:9e:7f:ef:a2` | — | Raspberry Pi (this device) |
| 192.168.1.111 | `98:ba:5f:ac:96:98` | TP-Link | Access Point |
| 192.168.1.165 | `e6:67:1e:74:95:ad` | — | P2P Bridge (local side, on switch) — HTTP realm "BRAP" |
| 192.168.1.187 | `8c:86:dd:bd:76:f4` | TP-Link | Switch (ES205GP, 5-port) |
| 192.168.1.188 | `88:66:5a:08:59:bd` | Apple | MacBook |
| 192.168.1.203 | `e4:67:1e:75:da:e1` | Shen Zhen NUO XIN Cheng | P2P Bridge (remote side) |
| 192.168.1.209 | `78:20:51:83:60:ec` | TP-Link | Access Point |
| 192.168.1.230 | `e6:67:1e:74:95:ad` | Topsvision | NVR — 2 cameras attached directly |

## NVR Access

- **Web UI:** `http://192.168.1.230` — credentials `admin` / `admin` (IE-only plugin required for live view)
- **RTSP streams:** credentials must be embedded in the URL path (not HTTP Basic Auth):
  ```
  rtsp://192.168.1.230/user=admin&password=&channel=1&stream=0.sdp  ← Camera 1
  rtsp://192.168.1.230/user=admin&password=&channel=2&stream=0.sdp  ← Camera 2
  ```
- **Stream format:** H.265 (HEVC), 1280x720 @ 25fps + PCM audio
- **SDK port:** 34567 (XMeye protocol)

## Pi Services (docker-compose at /home/admin/rpi/)

| Container | Port | Description |
|---|---|---|
| caddy | 80 | Reverse proxy / file server |
| portainer | — | Docker management UI at `/portainer/` |
| glances | — | System monitoring at `/monitoring/` |
| mediamtx | 8889, 8189/udp | Pulls RTSP from NVR, serves WebRTC + LL-HLS |

**Camera viewer:** `http://<tailscale-ip>/cameras`
- WebRTC primary (~0.5s lag), falls back to LL-HLS (~1-2s lag) if WebRTC unsupported

## Notes

- `.2`, `.165`, and `.230` share MAC `e6:67:1e:74:95:ad` — the local bridge (`.165`) is ARP proxying for remote devices; all traffic destined for `.2` and `.230` is sent to the bridge's MAC and forwarded wirelessly. The `e6` prefix indicates a locally administered (software-generated) MAC, not a real hardware address
- Telnet (port 23) open on `.165` and `.203` — old firmware, security risk
- The switch `.187` was showing a password reset page — worth securing
- NVR RTSP returns 403 if credentials are in HTTP Basic Auth header — must use URL path format
