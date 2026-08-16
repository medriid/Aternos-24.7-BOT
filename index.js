// Load .env without pulling in a dependency (Node >= 20.12).
try {
  process.loadEnvFile();
} catch (err) {
  // No .env file, or an older Node. Fall back to real environment variables.
}

const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

// Must run before mineflayer is required: adds Minecraft 26.2 support that
// mineflayer and minecraft-data have not shipped yet. See mcdata-shim.js.
const shimResult = require('./mcdata-shim')();
console.log('26.2 shim:', JSON.stringify(shimResult));

const mineflayer = require('mineflayer');

const serverHost = process.env.SERVER_HOST || 'larpsofvellore.aternos.me';
const serverPort = parseInt(process.env.SERVER_PORT || '30677', 10);
const botUsername = process.env.BOT_USERNAME || 'LarpUptime';
const minecraftVersion = process.env.MC_VERSION || false;
// 'offline' for cracked servers, 'microsoft' for online-mode servers.
const authMode = process.env.AUTH_MODE || 'offline';
const reconnectInterval = parseInt(process.env.RECONNECT_INTERVAL_MS || '40000', 10);
const antiAfkInterval = parseInt(process.env.ANTI_AFK_INTERVAL_MS || '20000', 10);
const httpPort = parseInt(process.env.PORT || '3000', 10);

// Login-plugin support (EasyAuth, AuthMe, ...). Leave AUTH_PASSWORD unset to
// disable. %p is replaced with the password.
const authPassword = process.env.AUTH_PASSWORD || '';
const registerCommand = process.env.REGISTER_COMMAND || '/register %p %p';
const loginCommand = process.env.LOGIN_COMMAND || '/login %p';
const loginDelay = parseInt(process.env.LOGIN_DELAY_MS || '2000', 10);
// Give up on a connection that never reaches 'spawn'. Aternos accepts the TCP
// connection even when the server behind it is stopped or crashed, and in that
// case mineflayer emits nothing at all, so only a timeout can recover.
const connectTimeout = parseInt(process.env.CONNECT_TIMEOUT_MS || '60000', 10);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'main.html'));
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    botRunning: bot !== null,
    botUsername: bot && bot.player ? bot.username : null,
    target: `${serverHost}:${serverPort}`,
  });
});

let bot = null;
let antiAfkTimer = null;
let reconnectTimer = null;
let connectTimer = null;
let manualStop = false;

// UI state. `phase` is one of: offline, connecting, authenticating, online.
let phase = 'offline';
let phaseMessage = 'Bot is offline.';
let onlineSince = null;
const logLines = [];

function pushLog(line) {
  logLines.push({ at: Date.now(), line });
  if (logLines.length > 60) logLines.shift();
  io.emit('bot_log', logLines[logLines.length - 1]);
}

function setPhase(next, message) {
  phase = next;
  phaseMessage = message;
  if (next === 'online' && !onlineSince) onlineSince = Date.now();
  if (next !== 'online') onlineSince = null;
  io.emit('bot_status', message);
  broadcastState();
}

function currentState() {
  return {
    phase,
    message: phaseMessage,
    username: botUsername,
    host: serverHost,
    port: serverPort,
    health: bot && typeof bot.health === 'number' ? Math.round(bot.health * 10) / 10 : null,
    food: bot && typeof bot.food === 'number' ? Math.round(bot.food) : null,
    position:
      bot && bot.entity && bot.entity.position
        ? {
            x: Math.round(bot.entity.position.x * 10) / 10,
            y: Math.round(bot.entity.position.y * 10) / 10,
            z: Math.round(bot.entity.position.z * 10) / 10,
          }
        : null,
    playersOnline: bot && bot.players ? Object.keys(bot.players).length : null,
    uptimeMs: onlineSince ? Date.now() - onlineSince : 0,
    antiAfkSeconds: Math.round(antiAfkInterval / 1000),
  };
}

function broadcastState() {
  io.emit('bot_state', currentState());
}

setInterval(broadcastState, 1000);

io.on('connection', (socket) => {
  console.log('Web client connected.');

  socket.emit('bot_status', phaseMessage);
  socket.emit('bot_state', currentState());
  socket.emit('bot_log_history', logLines);

  socket.on('control_bot', (command) => {
    switch (command) {
      case 'start':
        manualStop = false;
        if (!bot) {
          createBot();
        } else {
          io.emit('bot_status', 'Bot is already running.');
        }
        break;
      case 'stop':
        manualStop = true;
        stopBot('Stopped by user.');
        break;
      case 'reconnect':
        manualStop = false;
        reconnectBot();
        break;
      default:
        console.log(`Unknown command: ${command}`);
        break;
    }
  });
});

server.listen(httpPort, () => {
  console.log(`HTTP server listening on port ${httpPort}.`);
  createBot();
});

function createBot() {
  clearReconnectTimer();

  if (bot) {
    console.log('Bot instance already exists; skipping create.');
    return;
  }

  console.log(`Connecting bot "${botUsername}" to ${serverHost}:${serverPort} ...`);
  setPhase('connecting', `Connecting to ${serverHost}:${serverPort}...`);
  pushLog(`Connecting to ${serverHost}:${serverPort}`);

  let newBot;
  try {
    newBot = mineflayer.createBot({
      host: serverHost,
      port: serverPort,
      username: botUsername,
      version: minecraftVersion,
      auth: authMode,
      hideErrors: false,
      plugins: {
        // Minecraft 26.x replaced update_time's `time` field with a
        // clockUpdates array. mineflayer's time plugin still reads
        // packet.time and crashes on undefined. The bot does not need
        // time tracking, so disable it.
        time: false,
      },
    });
  } catch (err) {
    console.error('Failed to create bot:', err.message);
    setPhase('offline', `Failed to create bot: ${err.message}`);
    pushLog(`Failed to create bot: ${err.message}`);
    scheduleReconnect();
    return;
  }

  bot = newBot;
  startConnectWatchdog(newBot);

  bot.once('login', () => {
    console.log(`Bot "${bot.username}" logged in to ${serverHost}.`);
    setPhase('authenticating', `Logged in as ${bot.username}. Authenticating...`);
    pushLog(`Logged in as ${bot.username}`);
    // Login plugins freeze unauthenticated players and withhold update_health,
    // which is what mineflayer waits on to emit 'spawn'. So authenticate here
    // rather than on 'spawn', or the two would deadlock.
    sendLoginCommands();
  });

  bot.once('spawn', () => {
    clearConnectTimer();
    console.log(`Bot "${bot.username}" spawned in the world.`);
    setPhase('online', `${bot.username} is online. Anti-AFK active.`);
    pushLog('Spawned in world; anti-AFK active');
    startAntiAfk();
  });

  // Server chat, including login-plugin replies ("You are now authenticated").
  bot.on('messagestr', (message) => {
    console.log(`[chat] ${message}`);
    pushLog(message);
  });

  bot.on('health', () => {
    if (bot && bot.health <= 0) {
      console.log('Bot has died, will respawn automatically.');
    }
  });

  bot.on('death', () => {
    console.log('Bot died. Respawning.');
    pushLog('Bot died; respawning');
    io.emit('bot_status', 'Bot died, respawning.');
  });

  bot.on('kicked', (reason) => {
    let message = reason;
    try {
      const parsed = typeof reason === 'string' ? JSON.parse(reason) : reason;
      message = (parsed && (parsed.text || parsed.translate)) || JSON.stringify(parsed);
    } catch (_) {
      // Reason was not JSON; use as-is.
    }
    console.log(`Bot kicked: ${message}`);
    pushLog(`Kicked: ${message}`);
    io.emit('bot_status', `Kicked: ${message}`);
  });

  bot.on('error', (err) => {
    const message = err && err.message ? err.message : String(err);
    console.error('Bot error:', message);
    io.emit('bot_status', `Error: ${message}`);

    // Errors thrown before the connection is established (bad version, DNS
    // failure, refused socket) never produce an 'end' event, so without this
    // the bot would sit dead forever and never retry. Give 'end' a moment to
    // arrive on its own; handleDisconnect is idempotent either way.
    const erroredBot = bot;
    setTimeout(() => {
      if (bot === erroredBot) handleDisconnect(`error: ${message}`);
    }, 1000);
  });

  bot.on('end', (reason) => {
    handleDisconnect(reason);
  });
}

// Tears down the current bot and schedules a reconnect. Safe to call more than
// once for the same connection; only the first call has any effect.
function handleDisconnect(reason) {
  if (!bot) return;

  console.log(`Bot disconnected. Reason: ${reason || 'unknown'}.`);
  cleanupBot();
  pushLog(`Disconnected: ${reason || 'unknown'}`);

  if (manualStop) {
    setPhase('offline', 'Bot stopped.');
    return;
  }

  setPhase(
    'connecting',
    `Disconnected (${reason || 'unknown'}). Reconnecting in ${reconnectInterval / 1000}s.`
  );
  scheduleReconnect();
}

function startConnectWatchdog(pendingBot) {
  clearConnectTimer();
  connectTimer = setTimeout(() => {
    connectTimer = null;
    if (bot !== pendingBot) return;
    console.log(`No spawn within ${connectTimeout / 1000}s; server is probably stopped or crashed.`);
    try {
      bot.end('connect timeout');
    } catch (_) {
      // Socket may already be gone.
    }
    handleDisconnect('connect timeout (server stopped or crashed?)');
  }, connectTimeout);
}

function clearConnectTimer() {
  if (connectTimer) {
    clearTimeout(connectTimer);
    connectTimer = null;
  }
}

function sendLoginCommands() {
  if (!authPassword) return;

  const send = (template, delay) => {
    setTimeout(() => {
      if (!bot) return;
      try {
        bot.chat(template.replace(/%p/g, authPassword));
      } catch (err) {
        console.error('Login command failed:', err.message);
      }
    }, delay);
  };

  // Register first so a fresh bot account works; login plugins simply reply
  // "already registered" when the account exists. Never log the password.
  console.log('Sending login-plugin credentials.');
  send(registerCommand, loginDelay);
  send(loginCommand, loginDelay + 1500);
}

function startAntiAfk() {
  stopAntiAfk();

  antiAfkTimer = setInterval(() => {
    if (!bot || !bot.entity) return;

    try {
      const moves = ['forward', 'back', 'left', 'right'];
      const move = moves[Math.floor(Math.random() * moves.length)];

      bot.setControlState(move, true);
      setTimeout(() => {
        if (bot) bot.setControlState(move, false);
      }, 600);

      if (Math.random() < 0.4) {
        bot.setControlState('jump', true);
        setTimeout(() => {
          if (bot) bot.setControlState('jump', false);
        }, 250);
      }

      const yaw = (Math.random() - 0.5) * Math.PI * 2;
      const pitch = (Math.random() - 0.5) * (Math.PI / 3);
      bot.look(yaw, pitch, true).catch(() => {});

      bot.swingArm('right');
    } catch (err) {
      console.error('Anti-AFK error:', err.message);
    }
  }, antiAfkInterval);
}

function stopAntiAfk() {
  if (antiAfkTimer) {
    clearInterval(antiAfkTimer);
    antiAfkTimer = null;
  }
}

function cleanupBot() {
  stopAntiAfk();
  clearConnectTimer();
  if (bot) {
    bot.removeAllListeners();
  }
  bot = null;
}

function stopBot(message) {
  clearReconnectTimer();
  if (bot) {
    try {
      bot.quit(message || 'Bye');
    } catch (err) {
      console.error('Error quitting bot:', err.message);
    }
    cleanupBot();
    console.log(message || 'Bot stopped.');
    setPhase('offline', message || 'Bot stopped.');
    pushLog(message || 'Bot stopped');
  } else {
    setPhase('offline', 'Bot is not running.');
  }
}

function reconnectBot() {
  console.log('Manual reconnect requested.');
  io.emit('bot_status', 'Reconnecting bot...');
  if (bot) {
    try {
      bot.quit('Reconnecting');
    } catch (err) {
      console.error('Error during manual reconnect:', err.message);
    }
    cleanupBot();
  }
  clearReconnectTimer();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    createBot();
  }, 1000);
}

function scheduleReconnect() {
  clearReconnectTimer();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!bot && !manualStop) createBot();
  }, reconnectInterval);
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down.');
  manualStop = true;
  stopBot('Server shutting down.');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
