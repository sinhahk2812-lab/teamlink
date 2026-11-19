# WhatsApp Intake

An agent on a team member's PC reads that member's work WhatsApp groups and pushes work messages into
TeamLink, so a task is not missed just because someone else already read the message.

This file covers: how it works, setup, a curl test, moving to a server later, and **how to remove the
feature completely** (last section).

## How it fits TeamLink

TeamLink has no central server, database, login or roles: every computer runs its own copy with its own
SQLite file, and computers talk to each other directly and encrypted. The intake follows the same shape.

| Spec item | How it works here |
| --- | --- |
| `POST /api/intake/whatsapp` | Each member's TeamLink can run this endpoint (off until they switch it on). |
| Per-user API keys | Each member generates their own key in their own app. Only the SHA-256 hash is stored. |
| Whose intake is it | The key. Members share their key *hash* with the team, so any running endpoint recognises any member's key. |
| Idempotent on (chat, source_id) for all users | The item id is a hash of (chat, source_id). The same message from two agents becomes one item with two reporters, on every computer. |
| Task model | There was none. An intake item is the task: assignee, status, due date, comments. |
| Statuses | Shared: New, In progress, Done. "Seen" is separate and per user. |
| Per-user seen | Kept only on your own computer, never synced. |
| Admin | No roles existed. The first member who clicks "Become the team admin" is the admin; computers accept team settings only from an admin they already know. Admins can add admins. |
| Real time | Pushed over the app's existing WebSocket; no polling. |

Not built, because there is nothing to attach to: "convert to / attach to an existing task" (no separate task
model exists) and "groups I belong to" (TeamLink cannot know WhatsApp membership). Instead, items go to the
whole team unless the group's mapping rule lists specific members.

## Setup (per member)

1. Open TeamLink, Settings, **WhatsApp Intake**.
2. Tick **Receive WhatsApp items on this computer**. Allow it through the firewall if Windows asks.
3. Click **Generate key** and copy the key. It is shown once.
4. Copy **My intake URL** and give the URL and key to the agent.

The intake URL is `http://<this-PC-IP>:24252/api/intake/whatsapp`. The Settings dialog shows the real
address with your PC's IP. An agent on the same PC can use `http://127.0.0.1:24252/api/intake/whatsapp`.

Once per team: one person clicks **Become the team admin** in the same dialog and fills in the mapping.

## API

`POST /api/intake/whatsapp` with `Authorization: Bearer <key>` and JSON:

```json
{
  "items": [{
    "source_id": "unique hash (dedupe)",
    "title": "short task title",
    "type": "review | update | new_task | deadline | question | file",
    "from": "WhatsApp sender name",
    "chat": "group name",
    "time": "2026-11-19T14:30:00+05:30",
    "text": "original message (Hinglish OK)",
    "links": ["https://..."],
    "priority": "high | normal"
  }]
}
```

- All fields except `links` and `priority` are required. 1 to 200 items per request, body up to 1 MB.
- Response `200`: `{ "created": 1, "skipped": 0, "ids": ["..."] }`. `ids` has one id per item sent, in order.
- `401` missing or wrong key. `400` bad payload (the body says which item and field). `403` intake switched off
  (yours, or the team's). `429` rate limit: 60 requests per minute per key; 20 failed keys per minute per address.
- Only `http://` and `https://` links are kept.
- `GET /api/intake/health` returns `{ "ok": true }` without a key.
- Every request is logged (time, address, user, status) for 30 days; admins see the latest in the dialog.

### curl test

```bash
curl -X POST "http://127.0.0.1:24252/api/intake/whatsapp" \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"items":[{"source_id":"test-1","title":"Test from curl","type":"new_task","from":"Chinmay","chat":"Axit Creatives","time":"2026-11-19T14:30:00+05:30","text":"Yeh ek test message hai","links":["https://drive.google.com/"],"priority":"high"}]}'
```

Run it twice: the first answer has `"created":1`, the second `"created":0,"skipped":1`.

## Mapping (admin)

- **Sender rule**: WhatsApp sender name, assigned to a TeamLink member.
- **Group rule**: WhatsApp group name, with a project, an optional default assignee, and optionally the
  members who may see that group's items (none selected = whole team).
- Assignee = sender rule's member, else group rule's member, else whoever reported the item.

## Configuration

Settings are saved per computer. Environment variables override them, for running without a screen:

| Variable | Default | Meaning |
| --- | --- | --- |
| `TEAMLINK_INTAKE` | off | `1` switches the endpoint on |
| `TEAMLINK_INTAKE_HOST` | `0.0.0.0` | interface to listen on (`127.0.0.1` = this PC only) |
| `TEAMLINK_INTAKE_PORT` | `24252` | port |
| `TEAMLINK_INTAKE_BASE_URL` | (none) | public address shown as "My intake URL", e.g. `https://teamlink.example.com` |

## Moving to a server later

Nothing in the agents changes except the URL.

1. On the server, run TeamLink headless with the same team code:
   `TEAMLINK_INTAKE=1 TEAMLINK_INTAKE_BASE_URL=https://teamlink.example.com node core/cli.js --teamCode "<team code>" --name "Intake server"`.
   It must reach the team: on the office LAN directly, or through the relay (`--relayUrl wss://...`).
2. Put HTTPS in front of port 24252 (Caddy or nginx reverse proxy).
3. Point every agent at `https://teamlink.example.com/api/intake/whatsapp`. Each member keeps their own key:
   the server learns the key hashes from the team automatically, so no keys are copied to the server.
4. Members can then switch their own PC's endpoint off.

Over plain `http://` on the LAN the key travels unencrypted; anyone who can sniff the office network could
read it. Use HTTPS (step 2) before exposing the endpoint outside the office.

## Limits to know

- A member who joins the team later does not receive items created before they joined.
- Anyone who knows the team code can claim admin if nobody has yet. Claim it first.
- Items are stored unencrypted in each computer's local database, like chat history.

## Removing the feature

### Just switch it off (no code change)

- A member: Settings, WhatsApp Intake, untick "Receive WhatsApp items". The port closes.
- The whole team: the admin unticks "WhatsApp Intake is on for the team". Every endpoint answers `403`.

### Remove it from the app

Everything the feature added is either in its own file or on a line marked `WHATSAPP-INTAKE`.

Own files:

- `core/intake.js` (endpoint, keys, storage, sync, admin)
- `ui/intake.js`, `ui/intake.css` (inbox and settings screens)
- `docs/whatsapp-intake.md` (this file)
- `scripts/remove-whatsapp-intake.js`

Marked lines in shared files: `core/messenger.js`, `core/server.js`, `ui/app.js`, `ui/index.html`,
`electron/main.js`, `test/e2e.js`.

One command does all of it. Look first:

```bash
node scripts/remove-whatsapp-intake.js
```

Then apply:

```bash
node scripts/remove-whatsapp-intake.js --apply
```

Then check and release:

```bash
npm test
```

Raise `version` in `package.json`, commit and push; the next build has no intake. This was tried on a copy
of the project: the script removed every marked line and the remaining 23 tests passed.

To do it by hand instead, list every marked line with:

```bash
grep -rn "WHATSAPP-INTAKE" core ui electron test
```

### Data left on each computer

Removing the code leaves four unused tables in each member's `teamlink.db` and two keys in `config.json`.
They are harmless. To delete them too, close TeamLink and run on that computer's database:

```sql
DROP TABLE IF EXISTS intake_items;
DROP TABLE IF EXISTS intake_comments;
DROP TABLE IF EXISTS intake_members;
DROP TABLE IF EXISTS intake_log;
```

and delete the `"intake"` and `"team"` entries from `config.json`.
