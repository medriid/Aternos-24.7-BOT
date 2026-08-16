# Aternos 24/7 Bot

A Minecraft bot that connects to your Aternos server and stays active so the
server is not auto-shut-down for inactivity. The bot performs lightweight
anti-AFK movements (moves, looks around, jumps, swings arm), exposes a tiny
web page so a free uptime service (such as UptimeRobot) can keep the host
awake, and automatically reconnects if it gets kicked or disconnects.

> Update:
> - Switched to `mineflayer` for proper protocol handling and built-in
>   keep-alive responses.
> - Added real anti-AFK behavior (random movement, jumps, look, swing arm)
>   so Aternos no longer marks the bot as idle.
> - Fixed the `setInterval` leak and variable-shadowing bug from the previous
>   version.
> - Rebuilt the web UI (monochrome, live status, activity feed).
> - Added `package.json`, environment-variable configuration, and a
>   `/health` endpoint for uptime pings.
> - Added Minecraft **26.2** support via `mcdata-shim.js` (see below).
> - The bot now recovers from pre-login errors and from a stopped/crashed
>   server instead of hanging forever.
> - Added auto-login for servers running a login plugin (EasyAuth, AuthMe).

## Minecraft 26.2 support

`mineflayer` 4.37.1 stops at Minecraft **1.21.11**, and `minecraft-data`
3.113.2 lists 26.2 but ships no packet data for it. Out of the box the bot
dies with `No data available for version 26.2`.

[`mcdata-shim.js`](./mcdata-shim.js) works around both: it registers 26.2
using 26.1's packet definitions while still announcing protocol **776** on
the wire, and raises mineflayer's version ceiling. It must be required
*before* `mineflayer`.

This is a stopgap — delete it once upstream ships real 26.2 data. Two known
rough edges:

- mineflayer's `time` plugin crashes on 26.x (the `update_time` packet
  replaced its `time` field with a `clockUpdates` array), so the bot starts
  with `plugins: { time: false }`.
- The login `success` and play `login` packets carry a few extra trailing
  bytes in 26.2, which produces harmless `Chunk size is N but only M was
  read` warnings on startup.

## Hosting

The bot needs a **persistent process** and a long-lived TCP connection.
Serverless platforms (Vercel, Netlify, Cloudflare Workers) cannot run it —
their functions are frozen between requests, so the bot never stays
connected.

On Heroku use a single **web dyno** (`Procfile` is included). A worker dyno
gets no public URL and so cannot serve the UI. Avoid Eco dynos: they sleep
after 30 minutes idle, which kills the bot. Basic or higher stays awake.

[Watch the original Video Tutorial!](https://youtu.be/mRgLIu1sLMQ)

## Requirements

- An Aternos server (cracked / offline mode by default).
- A free hosting service that runs Node.js (Replit, Render, Railway, a VPS,
  or even your own machine).
- Optional: a free [UptimeRobot](https://uptimerobot.com/) account to ping
  the web URL every 5 minutes so the host stays awake.

## Setup

1. **Create and start your Aternos server.** Note the IP and port (for
   example `DOOMS_DAY_REBORN.aternos.me:59173`).

2. **Clone this repository** into your hosting service or local machine:

   ```bash
   git clone https://github.com/sayanpramanik2012/Aternos-24.7-BOT.git
   cd Aternos-24.7-BOT
   npm install
   ```

3. **Configure the bot.** Either edit the defaults at the top of
   `index.js` or set environment variables:

   | Variable                | Default                           | Description                                 |
   | ----------------------- | --------------------------------- | ------------------------------------------- |
   | `SERVER_HOST`           | `DOOMS_DAY_REBORN.aternos.me`     | Aternos server hostname.                    |
   | `SERVER_PORT`           | `59173`                           | Aternos server port.                        |
   | `BOT_USERNAME`          | `247_Monitor`                     | In-game username for the bot.               |
   | `MC_VERSION`            | auto-detect                       | Minecraft version, e.g. `1.20.1`.           |
   | `RECONNECT_INTERVAL_MS` | `40000`                           | Wait time before reconnecting after kicks.  |
   | `ANTI_AFK_INTERVAL_MS`  | `20000`                           | Frequency of anti-AFK movements.            |
   | `CONNECT_TIMEOUT_MS`    | `60000`                           | Give up if the bot never spawns.            |
   | `AUTH_MODE`             | `offline`                         | `offline` (cracked) or `microsoft`.         |
   | `AUTH_PASSWORD`         | _(unset)_                         | Login-plugin password. Unset = disabled.    |
   | `REGISTER_COMMAND`      | `/register %p %p`                 | `%p` is replaced with the password.         |
   | `LOGIN_COMMAND`         | `/login %p`                       | `%p` is replaced with the password.         |
   | `PORT`                  | `3000`                            | HTTP port for the web UI.                   |

   A `.env` file in the project root is loaded automatically. Keep
   `AUTH_PASSWORD` there — `.env` is gitignored.

   > **Login plugins:** EasyAuth and AuthMe freeze unauthenticated players
   > and withhold the health packet that mineflayer waits on, so the bot
   > authenticates right after `login` rather than after `spawn`. Without
   > `AUTH_PASSWORD` set on such a server, the bot connects but cannot move.

4. **Run the bot:**

   ```bash
   npm start
   ```

   The bot will connect to the server and the web UI will be available at
   `http://localhost:3000` (or your hosted URL).

5. **(Optional) Keep the host awake** by adding the public URL of your bot
   as an HTTP monitor on UptimeRobot. Use either `/` or `/health` as the
   target — UptimeRobot will ping it every 5 minutes.

## Web UI

Open the served URL in a browser. You will see live bot status and three
buttons:

- **Start Bot** — starts the bot if it is not running.
- **Stop Bot** — disconnects the bot and stops auto-reconnect.
- **Reconnect Bot** — gracefully disconnects and immediately re-establishes
  the connection.

## How the anti-AFK works

Aternos shuts a server down if no players are active. While the bot is
spawned in-world it periodically:

- Picks a random direction (forward / back / left / right) and walks
  briefly.
- Occasionally jumps.
- Looks around with random yaw / pitch.
- Swings its arm.

That activity is enough to keep Aternos from marking the bot as idle.

## Troubleshooting

- **Bot keeps getting kicked with "Failed to verify username":** the server
  is in online mode. Either switch your Aternos server to cracked / offline
  mode, or supply Microsoft credentials (see `mineflayer` docs).
- **`ECONNREFUSED` / connect errors:** the Aternos server is offline. Start
  it from the Aternos panel; the bot will reconnect on its own.
- **Wrong protocol version:** set `MC_VERSION` to match the version your
  server runs (for example `1.20.1`).

## License

MIT — see [LICENSE](./LICENSE).

🔗 GitHub Link: [GitHub Repo](https://github.com/sayanpramanik2012/Aternos-24.7-BOT)
