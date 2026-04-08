const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const fs = require('fs');
const { spawn } = require('child_process');

const app = express();
const PORT = 8081;
const DB_FILE = './nanostreamer.db';
const CONFIG_FILE = './streamer_config.json';

let mpvProcess = null;
let isRunning = false;
let restartTimeout = null;

app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'nanostreamer-super-secret-key',
    resave: false,
    saveUninitialized: false
}));

const db = new sqlite3.Database(DB_FILE);
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT
    )`);
});

const checkSetup = (req, res, next) => {
    db.get("SELECT COUNT(*) AS count FROM users", (err, row) => {
        if (err) return res.status(500).send("Database error");
        if (row.count === 0 && req.path !== '/setup') return res.redirect('/setup');
        if (row.count > 0 && req.path === '/setup') return res.redirect('/login');
        next();
    });
};

const requireAuth = (req, res, next) => {
    if (!req.session.userId) return res.redirect('/login');
    next();
};

app.use(checkSetup);

function startStream() {
    if (restartTimeout) {
        clearTimeout(restartTimeout);
        restartTimeout = null;
    }

    if (mpvProcess) {
        stopStream(false); 
    }

    if (!fs.existsSync(CONFIG_FILE)) return;
    let config;
    try {
        config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
        return;
    }

    if (!config.streamUrl) return;

    isRunning = true;
    const cacheSecs = config.cacheSecs || 5;
    const volume = config.volume || 45;
    
    const args = [
        `--cache-secs=${cacheSecs}`,
        '--no-video',
        `--volume=${volume}`,
        '--network-timeout=5',
        config.streamUrl
    ];

    console.log(`[NanoStreamer] Starting mpv: mpv ${args.join(' ')}`);
    mpvProcess = spawn('mpv', args);

    const currentProcess = mpvProcess;

    currentProcess.on('close', () => {
        if (mpvProcess === currentProcess) {
            mpvProcess = null;
            
            if (isRunning) {
                console.log('[NanoStreamer] Stream dropped! Restarting in 5 seconds...');
                restartTimeout = setTimeout(startStream, 5000);
            }
        }
    });

    currentProcess.on('error', (err) => {
        console.error('[NanoStreamer] Failed to start mpv:', err);
    });
}

function stopStream(intentional = true) {
    if (intentional) {
        isRunning = false;
        if (restartTimeout) clearTimeout(restartTimeout);
        console.log('[NanoStreamer] Stream intentionally stopped.');
    }
    
    if (mpvProcess) {
        mpvProcess.removeAllListeners('close'); 
        mpvProcess.kill();
        mpvProcess = null;
    }
}

process.on('exit', () => stopStream(true));
process.on('SIGINT', () => { stopStream(true); process.exit(); });

app.get('/setup', (req, res) => res.send(renderAuthPage("Setup NanoStreamer", "/setup", "Create Admin Account", "Create Account")));
app.post('/setup', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.send(renderAuthPage("Setup NanoStreamer", "/setup", "Create Admin Account", "Create Account", "Username and password required."));
    const hash = await bcrypt.hash(password, 10);
    db.run("INSERT INTO users (username, password) VALUES (?, ?)", [username, hash], (err) => {
        if (err) return res.send(renderAuthPage("Setup NanoStreamer", "/setup", "Create Admin Account", "Create Account", "Error creating user."));
        res.redirect('/login');
    });
});

app.get('/login', (req, res) => {
    if (req.session.userId) return res.redirect('/');
    res.send(renderAuthPage("Login", "/login", "NanoStreamer WebUI", "Unlock"));
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
        if (user && await bcrypt.compare(password, user.password)) {
            req.session.regenerate(() => {
                req.session.userId = user.id;
                res.redirect('/');
            });
        } else {
            res.send(renderAuthPage("Login", "/login", "NanoStreamer WebUI", "Unlock", "Invalid credentials."));
        }
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

app.get('/', requireAuth, (req, res) => {
    let config = { streamUrl: '', cacheSecs: 5, volume: 45 };
    if (fs.existsSync(CONFIG_FILE)) {
        try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) {}
    }
    res.send(renderDashboard(config, req.query.success, req.query.error, isRunning)); 
});

app.post('/update', requireAuth, (req, res) => {
    const { streamUrl, cacheSecs, volume } = req.body;
    
    if (!streamUrl) {
        return res.redirect('/?error=' + encodeURIComponent('Stream URL is required!'));
    }

    const config = {
        streamUrl: streamUrl.trim(),
        cacheSecs: parseInt(cacheSecs) || 5,
        volume: parseInt(volume) || 45
    };
    
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 4));

    startStream();
    
    res.redirect('/?success=' + encodeURIComponent('Settings saved and stream started!'));
});

app.post('/stop', requireAuth, (req, res) => {
    stopStream(true);
    res.redirect('/?success=' + encodeURIComponent('Stream stopped successfully.'));
});

function renderAuthPage(title, actionUrl, headerText, btnText, errorMsg = "") {
    let errorHtml = errorMsg ? `<div class="error-box">${errorMsg}</div>` : '';
    let finalBtnText = btnText === 'Unlock' ? 'Login' : btnText;

    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link rel="icon" type="image/x-icon" href="/favicon.ico">
        <title>${title} | NanoStreamer WebUI</title>
        <script src="https://unpkg.com/lucide@latest"></script>
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;700&display=swap" rel="stylesheet">
        <link rel="stylesheet" href="/style.css">
    </head>
    <body class="auth-body">
        <div class="glass-card auth-card">
            <h1 class="auth-title">
                 NanoStreamer <span>WebUI</span>
            </h1>
            ${errorHtml}
            <form method="POST" action="${actionUrl}" class="auth-form">
                <input type="text" name="username" required autofocus class="input-field" placeholder="Username">
                <input type="password" name="password" required class="input-field" placeholder="Password">
                <button type="submit" class="btn btn-submit">
                    ${finalBtnText} <i data-lucide="${actionUrl === '/setup' ? 'user-plus' : 'log-in'}" class="w-4 h-4"></i>
                </button>
            </form>
        </div>
        <script>lucide.createIcons();</script>
    </body>
    </html>`;
}

function renderDashboard(config, successMsg = "", errorMsg = "", active = false) {
    const statusHtml = active 
        ? `<div class="af-tag status-running"><i data-lucide="play-circle" class="w-4 h-4 status-icon"></i> Running</div>`
        : `<div class="af-tag status-stopped"><i data-lucide="stop-circle" class="w-4 h-4 status-icon"></i> Stopped</div>`;

    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link rel="icon" type="image/x-icon" href="/favicon.ico">
        <title>NanoStreamer WebUI</title>
        <script src="https://unpkg.com/lucide@latest"></script>
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;700&display=swap" rel="stylesheet">
        <link rel="stylesheet" href="/style.css">
    </head>
    <body class="dash-body">
        <div class="main-container">
            <header class="header">
                <div class="header-title-wrapper">
                    <h1 class="header-title">
                        NanoStreamer <span>WebUI</span>
                    </h1>
                    ${statusHtml}
                </div>

                <div class="header-actions">
                    <div class="header-main">
                        <form id="stop-form" method="POST" action="/stop" class="hidden"></form>
                        
                        <button type="button" onclick="document.getElementById('stop-form').submit();" class="btn btn-reset" ${!active ? 'disabled' : ''}>
                            <i data-lucide="square" class="w-4 h-4"></i> Stop
                        </button>

                        <button type="submit" form="main-config-form" class="btn btn-apply" ${active ? 'disabled' : ''}>
                            <i data-lucide="play" class="w-4 h-4"></i> Save & Play
                        </button>
                    </div>
                        
                    <div class="divider"></div>
                        
                    <div class="header-utils">
                        <a href="/logout" class="btn btn-logout"><i data-lucide="log-out" class="w-4 h-4"></i> Logout</a>
                    </div>
                </div>
            </header>

            ${errorMsg ? `
            <div class="alert-danger">
                <div class="alert-icon"><i data-lucide="alert-triangle"></i></div>
                <div><h3 class="alert-title">Configuration Error</h3><p class="alert-text">${errorMsg}</p></div>
            </div>` : ''}

            <form id="main-config-form" method="POST" action="/update">
                <div class="grid-cards">
                    
                    <div class="glass-card param-card align-start">
                        <div class="card-header">
                            <div class="card-title-box">
                                <span class="card-title">STREAM URL</span>
                                <span class="card-subtitle">Icecast / Shoutcast / Direct Link</span>
                            </div>
                        </div>
                        <div class="form-group">
                            <div class="input-wrapper">
                                <input type="url" name="streamUrl" value="${config.streamUrl || ''}" class="input-field text-sm font-mono" placeholder="https://domain.com/stream.aac" required>
                            </div>
                        </div>
                    </div>

                    <div class="glass-card param-card align-start">
                        <div class="card-header">
                            <div class="card-title-box">
                                <span class="card-title">CACHE</span>
                                <span class="card-subtitle">Buffer size in seconds</span>
                            </div>
                        </div>
                        <div class="form-group">
                            <div class="input-wrapper">
                                <input type="number" name="cacheSecs" value="${config.cacheSecs || 5}" class="input-field text-sm font-mono" placeholder="5" min="0" required>
                            </div>
                        </div>
                    </div>

                    <div class="glass-card param-card align-start">
                        <div class="card-header">
                            <div class="card-title-box">
                                <span class="card-title">VOLUME</span>
                                <span class="card-subtitle">Playback Volume (1-100)</span>
                            </div>
                        </div>
                        <div class="form-group">
                            <div class="input-wrapper">
                                <input type="number" name="volume" value="${config.volume || 45}" class="input-field text-sm font-mono" placeholder="45" min="1" max="100" required>
                            </div>
                        </div>
                    </div>

                </div>
            </form>
        </div>

        ${successMsg ? `<div id="toast" class="toast"><i data-lucide="check-circle" class="w-5 h-5"></i> ${successMsg}</div><script>setTimeout(()=>document.getElementById('toast').remove(),3000);window.history.replaceState({},'',window.location.pathname);</script>` : ''}

        <script>
            lucide.createIcons();
        </script>
    </body>
    </html>`;
}

if (fs.existsSync(CONFIG_FILE)) {
    const startupConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (startupConfig.streamUrl) {
        console.log('[NanoStreamer] Restoring previous session on boot...');
        startStream();
    }
}

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 NanoStreamer running at http://0.0.0.0:${PORT}`));