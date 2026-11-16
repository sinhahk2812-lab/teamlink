# TeamLink

A serverless office messenger for small and mid-size teams (built for 30+ people), inspired by
[IP Messenger](https://ipmsg.org/). Works on Windows, macOS and Linux.

On the office network it needs no server at all: computers find each other automatically and talk
directly. People working from home can join through a small optional relay.

## What it does

| Feature | Notes |
| --- | --- |
| Automatic member list | UDP broadcast discovery, grouped by department, online / away status |
| 1-to-1 chat | Delivery receipts; messages to offline people are delivered when they come back |
| Group chats | Any member can rename the group, add or remove people, or leave |
| Everyone channel | Broadcast to the whole team (IP Messenger's "broadcast") |
| Sealed messages | Receiver must click to open; sender sees when it was opened |
| Absence mode | Away status with an automatic reply (once per person) |
| Files and folders | Receiver pulls the file directly from the sender; folder structure is kept |
| Screenshots | Paste with Ctrl+V / Cmd+V or drag and drop; images show inline |
| Search | Full history is stored locally (SQLite) and searchable |
| Encryption | End to end for every message and file, on LAN and through the relay |
| Remote members | Optional relay server; LAN is always preferred when both are available |

## Run it

Requires [Node.js 22 or newer](https://nodejs.org/). Same steps on Windows, macOS and Linux:

```bash
npm install
```

```bash
npm start
```

First run on each computer:

1. Click your name (top left) and set display name and department.
2. Open Settings (gear icon) and enter the **team code**. Everyone must use exactly the same code.
3. Allow the app through the firewall when the system asks (Windows Defender prompt on Windows,
   "Local Network" permission on macOS). Without this, other computers cannot find you.

TeamLink stays in the background so messages always arrive: closing the window or choosing Quit only hides it
in the tray. To really stop it, right-click the tray icon and choose "Exit TeamLink completely". The installed app
also starts with the computer (switch this off in Settings).

When you download a received file, the app asks where to save it.

## Build installers

```bash
npm run dist
```

This produces an installer for the system you run it on (`.exe` on Windows, `.dmg` on macOS,
`.AppImage` on Linux) in `dist/`. A macOS build has to be made on a Mac and a Windows build
on Windows; `.github/workflows/build.yml` builds all three on GitHub Actions on every push to `main` and publishes them on the
repository's Releases page under the version from `package.json`.

The installers are not code-signed. Windows SmartScreen and macOS Gatekeeper will warn on first launch
(on macOS: right-click the app and choose Open). Buy signing certificates if you want to remove the warnings.

## Remote teammates (relay)

Run the relay on any machine reachable from the internet (a small VPS is plenty):

```bash
PORT=8080 RELAY_TOKEN=choose-a-secret node relay/server.js
```

Put it behind HTTPS (Caddy, nginx or a PaaS) and enter the `wss://...` address and the token in
Settings on every computer. `relay/Dockerfile` is included.

The relay only forwards encrypted blobs between members of the same team and stores nothing.
It cannot read messages or files. Both people must be online at the same time for delivery; until
then messages wait on the sender's computer (up to 7 days).

## Network details

| What | Port | Change it |
| --- | --- | --- |
| Discovery | UDP 24250 (broadcast) | `udpPort` in `config.json` |
| Messages and files | TCP, random free port | `tcpPort` in `config.json` |
| Relay | outbound WebSocket only | Settings |

Offices with several subnets or a VPN: list the other subnets' broadcast addresses (or individual IPs)
under Settings, "Extra addresses to search".

Data (identity key, settings, history) lives in the per-user app data folder:
`%APPDATA%\TeamLink` on Windows, `~/Library/Application Support/TeamLink` on macOS, `~/.config/TeamLink` on Linux.

## Security model

- Each install creates an X25519 key pair. The user ID is a hash of the public key, so an ID cannot be faked.
- Every pair of users derives an AES-256-GCM key (X25519 + HKDF, salted with the team code). All messages
  and file data use it, on the LAN and through the relay.
- Devices that do not know the team code are ignored and cannot decrypt anything.
- Known limits: no forward secrecy (a stolen device key exposes that device's past traffic if it was recorded),
  history is stored unencrypted on each computer (use disk encryption), display names are not verified
  beyond team-code membership, and someone who knows the team code can join. Change the code when someone leaves.

## How this relates to IP Messenger

IP Messenger is open source (BSD licence) and its protocol is documented, so nothing had to be reverse
engineered. TeamLink keeps the same architecture (UDP broadcast for member discovery, direct TCP for data,
pull-based file transfer, sealed messages, absence mode, broadcast) but is a new implementation with its own
wire format: JSON frames, modern encryption, group chats and a relay. It does **not** interoperate with
existing IP Messenger clients.

## Project layout

```
core/       engine: discovery, encryption, delivery, groups, files, local API (no Electron dependency)
ui/         the interface (plain HTML/CSS/JS)
electron/   desktop shell: window, tray, file dialogs
relay/      optional relay server
test/       end-to-end test: npm test
```

`npm run headless` runs the engine without Electron and prints a local URL to open in a browser.
