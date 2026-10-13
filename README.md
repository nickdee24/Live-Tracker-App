# Live Tracker

A live location-sharing web app (installable PWA) with join codes, a live map, an emergency "ping",
and arrive/leave alerts for named areas or postcodes.

## What it does

- **Join code groups.** Someone taps *Create a new group* and gets a 6-character code. Anyone with the
  code can join; everyone in the group can see everyone else's name and location.
- **Live map** (OpenStreetMap). Each person shows as a coloured circle with their name above it and
  how far they are from you (👤) and from **WN8 8NQ** (🏠 on the map), e.g. `👤 0.8 miles · 20 min walk`.
- **Location every 10 seconds** while sharing. People who haven't updated for a minute are greyed out.
- **Info bar at the bottom** for the selected person: current road/address, distance and walking time
  from WN8 8NQ, when the location was last updated, and battery level/charging.
- **Follow mode.** Selecting someone zooms to them and keeps the map centred on them as they move.
  Dragging the map stops following; tap *Follow* to resume.
- **Start / stop sharing** in the info bar. Sharing stays on (including after reopening the app)
  until the person taps *Stop sharing*. *Leave group* in ⋯ removes them completely.
- **Emergency ping.** Makes the other person's phone vibrate repeatedly, beep and show a full-screen
  red alert until they tap *I'm OK*. If they've enabled notifications, it also arrives as a push
  notification when the app is closed.
- **Arrive / leave alerts** (🔔 Alerts). Name an area and give a postcode (`WN8 8NQ`), a postcode
  district (`WN8`), a place name (`Ormskirk`), or pick a spot on the map, plus a radius. You get
  "Sam has arrived at School" / "Sam has left School" on screen (and as a notification if the app is
  in the background). Alerts are saved per device.

Walking time uses 3 mph and adds 20% to the straight-line distance to allow for roads.

## Run it on your computer

Needs Node.js 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000. Browsers only allow location on `https://` or `localhost`, so to try it
on a phone you need to deploy it (below) or use a tunnel such as `npx localtunnel --port 3000`
or `cloudflared tunnel --url http://localhost:3000`.

## Deploy (free / cheap options)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/nickdee24/live-tracker-app)

The button uses `render.yaml` (free plan, no card needed). On the free plan the server sleeps after
15 minutes with nobody connected (the next visit takes about a minute to wake) and forgets stored data
on restart; phones rejoin their group automatically when they reconnect. For an always-on server with
saved history, upgrade the service to a paid plan and add a disk.


Any host that runs a Node web service with WebSockets works. Examples:

- **Render**: New → Web Service → connect the repo → Build `npm install`, Start `npm start`.
  Add a persistent disk mounted at `/data` and set `DATA_DIR=/data` so groups survive restarts.
- **Railway** / **Fly.io**: same commands; add a volume and point `DATA_DIR` at it.

Settings (environment variables, all optional):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOME_POSTCODE` | `WN8 8NQ` | Point distances are measured from |
| `DATA_DIR` | `./data` | Where groups, last locations and push keys are stored |
| `VAPID_SECRET` | none | Any random string; keeps push keys stable on hosts with no disk |
| `EPHEMERAL_STORAGE` | none | Set to `1` on hosts that wipe files on restart, so remembered join codes keep working |
| `VAPID_SUBJECT` | `mailto:admin@example.com` | Contact for web-push; set to your email |

## Using it on phones

1. Open the site, enter your name, tap **Create a new group**.
2. Tap the **Code** chip to share the join link.
3. Add it to the Home Screen (Android: ⋯ → *Install app*; iPhone: Share → *Add to Home Screen*).
4. In ⋯ tap **Enable notifications & background pings** so pings and alerts reach you when the app is closed.

## Limits of a web app (be aware)

| Feature | Android (Chrome) | iPhone (Safari / Home Screen app) |
|---|---|---|
| Location every 10s with app open | ✅ | ✅ |
| Location while app is in background / screen off | ❌ paused by the browser | ❌ paused by iOS |
| Battery level | ✅ | ❌ not available, shows "n/a" |
| Vibrate on ping (app open) | ✅ | ❌ no vibration API; shows alert + beep |
| Ping as push notification when app closed | ✅ (vibrates) | ✅ iOS 16.4+ when added to Home Screen (sound, no custom vibration) |

**Sharing while the app is closed:** in ⋯ tap **📡 Keep sharing when the app is closed**. It walks the
tracked person through installing the free **OwnTracks** app (iPhone and Android) and connects it to
this tracker with one tap. OwnTracks then sends location (and battery, even on iPhone) in the background,
about every 30 seconds while moving. The server endpoint is `POST /ot/<code>/<memberId>/<token>`.

The ☀️ *Keep screen awake while sharing* option in ⋯ helps keep updates flowing on a phone left open.
True always-on background tracking (like Google location sharing) needs a native app; this code's
server and protocol could be reused by one.

## Privacy notes

- Anyone with the join code can see everyone's location in that group, so only share it with people you trust.
- Stopping sharing deletes your last location from the server immediately; leaving the group deletes you entirely.
- Addresses come from OpenStreetMap Nominatim and postcodes from postcodes.io (free, rate-limited services).
  For heavy use, swap in a paid geocoder in `server.js`.

## Files

- `server.js` — HTTP + WebSocket server, join codes, location relay, address lookup, push.
- `public/` — the app (`index.html`, `app.js`, `styles.css`), service worker (`sw.js`), manifest and icons.
- `public/vendor/` — Leaflet map library (bundled so no CDN is needed).
