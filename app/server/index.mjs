import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocket, WebSocketServer } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

const APP_DIR = process.env.VRCX_APP_DIR || process.cwd();
const DATA_DIR = process.env.VRCX_DATA_DIR || path.join(APP_DIR, 'data');
const SOCKET_PATH = process.env.VRCX_SOCKET || path.join(APP_DIR, 'app.sock');
const BASE_PATH = process.env.VRCX_BASE_PATH || '/app/vrcx';
const INTERNAL_PORT = Number(process.env.VRCX_HOST_PORT || 39211);
const NODE_BIN = process.env.VRCX_NODE_BIN || process.execPath;
const execFileAsync = promisify(execFile);

const WEBUI_DIR = path.join(APP_DIR, 'webui');
const MANAGER_DIR = path.join(APP_DIR, 'manager');
const HOST_BIN = path.join(APP_DIR, 'bin', 'VRCXWebHost');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const HOST_PID_FILE = path.join(DATA_DIR, 'host.pid');

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'home'), { recursive: true });

const APP_VERSION = '1.0.17';
const defaultConfig = {
    proxy: '',
    autoStart: true,
    updateRepo: '',
    updateApiBase: 'https://api.github.com',
    updateSource: 'https://api.github.com/repos/vrcx-team/VRCX/releases/latest'
};

function readConfig() {
    try {
        return { ...defaultConfig, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
    } catch {
        return { ...defaultConfig };
    }
}

function writeVrcxProxy(proxy) {
    const file = path.join(DATA_DIR, 'home', '.config', 'VRCX', 'VRCX.json');
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        let values = {};
        if (fs.existsSync(file)) {
            values = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '') || '{}');
        }
        values.VRCX_ProxyServer = proxy || '';
        fs.writeFileSync(file, JSON.stringify(values, null, 2));
    } catch (err) {
        console.error('[config] failed to write VRCX.json:', err.message);
    }
}

function writeConfig(config) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    applyProxyEnv(config.proxy);
}

function applyProxyEnv(proxy) {
    const value = String(proxy || '').trim();
    if (value) {
        process.env.HTTP_PROXY = value;
        process.env.HTTPS_PROXY = value;
        process.env.http_proxy = value;
        process.env.https_proxy = value;
    } else {
        delete process.env.HTTP_PROXY;
        delete process.env.HTTPS_PROXY;
        delete process.env.http_proxy;
        delete process.env.https_proxy;
    }
}

function proxyAgent(proxy) {
    const value = String(proxy || '').trim();
    if (!value) return undefined;
    if (value.startsWith('socks')) return new SocksProxyAgent(value);
    return new HttpsProxyAgent(value);
}

const config = readConfig();
applyProxyEnv(config.proxy);

// ---------------------------------------------------------------------------
// C# backend lifecycle
// ---------------------------------------------------------------------------

let hostProcess = null;
let hostReady = false;
let hostStartedAt = 0;

async function hostRpc(className, methodName, args = []) {
    const response = await fetch(`http://127.0.0.1:${INTERNAL_PORT}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ className, methodName, args })
    });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || 'rpc failed');
    return payload.result;
}

async function waitForHost(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`http://127.0.0.1:${INTERNAL_PORT}/health`);
            if (response.ok) return true;
        } catch {
            // not ready yet
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return false;
}

async function startHost() {
    if (hostProcess && hostReady) return true;

    // Reuse a healthy backend left over from a previous gateway process.
    try {
        const response = await fetch(`http://127.0.0.1:${INTERNAL_PORT}/health`);
        if (response.ok) {
            hostReady = true;
            hostStartedAt = Date.now();
            console.log('[host] reusing existing backend');
            return true;
        }
    } catch {
        // not running
    }

    // Clean up a stale pid file before spawning.
    try {
        const oldPid = Number(fs.readFileSync(HOST_PID_FILE, 'utf8').trim());
        if (oldPid > 1) process.kill(oldPid, 'SIGKILL');
    } catch {
        // ignore
    }
    try {
        fs.rmSync(HOST_PID_FILE, { force: true });
    } catch {
        // ignore
    }
    if (hostProcess) {
        try {
            hostProcess.kill('SIGKILL');
        } catch {
            // ignore
        }
        hostProcess = null;
        hostReady = false;
    }

    const out = fs.openSync(path.join(LOG_DIR, 'backend.log'), 'a');
    const env = {
        ...process.env,
        HOME: path.join(DATA_DIR, 'home'),
        XDG_CONFIG_HOME: path.join(DATA_DIR, 'home', '.config'),
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        DOTNET_NOLOGO: '1'
    };
    hostProcess = spawn(HOST_BIN, ['--port', String(INTERNAL_PORT), '--version', 'VRCX 2026.09.16'], {
        cwd: APP_DIR,
        env,
        stdio: ['ignore', out, out]
    });
    if (hostProcess.pid) fs.writeFileSync(HOST_PID_FILE, String(hostProcess.pid));
    hostProcess.on('exit', (code) => {
        hostReady = false;
        try {
            fs.rmSync(HOST_PID_FILE, { force: true });
        } catch {
            // ignore
        }
        console.log(`[host] exited with ${code}`);
    });
    hostReady = await waitForHost();
    hostStartedAt = Date.now();
    console.log(`[host] ready=${hostReady}`);
    return hostReady;
}

function stopHost() {
    try {
        const pid = Number(fs.readFileSync(HOST_PID_FILE, 'utf8').trim());
        if (pid > 1) process.kill(pid, 'SIGTERM');
    } catch {
        // ignore
    }
    if (!hostProcess) return;
    try {
        hostProcess.kill('SIGTERM');
    } catch {
        // ignore
    }
    hostProcess = null;
    hostReady = false;
}

async function restartHost() {
    stopHost();
    await new Promise((resolve) => setTimeout(resolve, 500));
    return startHost();
}

// ---------------------------------------------------------------------------
// Tiny HTTP helpers
// ---------------------------------------------------------------------------

function stripBase(pathname) {
    if (pathname === BASE_PATH) return '/';
    if (pathname.startsWith(`${BASE_PATH}/`)) return pathname.slice(BASE_PATH.length);
    return pathname;
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.map': 'application/json; charset=utf-8'
};

function sendJson(res, status, data) {
    const body = Buffer.from(JSON.stringify(data));
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store'
    });
    res.end(body);
}

function sendText(res, status, text) {
    const body = Buffer.from(String(text));
    res.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store'
    });
    res.end(body);
}

function serveFile(res, file, cacheControl = 'no-cache') {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    const ext = path.extname(file).toLowerCase();
    const stat = fs.statSync(file);
    res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': cacheControl,
        'X-Content-Type-Options': 'nosniff'
    });
    fs.createReadStream(file).pipe(res);
    return true;
}

function safeJoin(root, rel) {
    const decoded = (() => {
        try {
            return decodeURIComponent(rel);
        } catch {
            return rel;
        }
    })();
    const file = path.normalize(path.join(root, decoded));
    if (!file.startsWith(root)) return null;
    return file;
}

async function readBody(req, limit = 50 * 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw new Error('body too large');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// WebSocket relay (VRChat pipeline)
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });
const pipelineClients = new Set();
const BACKLOG_FILE = path.join(DATA_DIR, 'ws-backlog.jsonl');
let pipelineSocket = null;
let pipelineToken = '';
let pipelineConnecting = false;
let pipelineReconnectTimer = null;
let pipelineBacklog = [];

function loadBacklog() {
    try {
        if (!fs.existsSync(BACKLOG_FILE)) return;
        const lines = fs.readFileSync(BACKLOG_FILE, 'utf8').split('\n').filter(Boolean);
        pipelineBacklog = lines
            .map((line) => {
                try {
                    return JSON.parse(line);
                } catch {
                    return null;
                }
            })
            .filter((item) => item && item.data);
        if (pipelineBacklog.length > 500) pipelineBacklog = pipelineBacklog.slice(-500);
        console.log(`[ws] loaded ${pipelineBacklog.length} backlog events`);
    } catch (err) {
        console.error('[ws] backlog load failed:', err.message);
    }
}

let backlogSaveTimer = null;
function saveBacklog() {
    if (backlogSaveTimer) clearTimeout(backlogSaveTimer);
    backlogSaveTimer = setTimeout(() => {
        try {
            const body = pipelineBacklog.map((item) => JSON.stringify(item)).join('\n') + (pipelineBacklog.length ? '\n' : '');
            fs.writeFileSync(BACKLOG_FILE, body);
        } catch (err) {
            console.error('[ws] backlog save failed:', err.message);
        }
    }, 300);
}

function pushPipelineMessage(data) {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    if (pipelineClients.size > 0) {
        for (const client of pipelineClients) {
            if (client.readyState === WebSocket.OPEN) client.send(text);
        }
        return;
    }
    pipelineBacklog.push({ t: Date.now(), data: text });
    if (pipelineBacklog.length > 500) pipelineBacklog.shift();
    saveBacklog();
}

async function getPipelineToken() {
    try {
        const raw = await hostRpc('WebApi', 'ExecuteJson', [
            JSON.stringify({ url: 'https://api.vrchat.cloud/api/1/auth', method: 'GET' })
        ]);
        const outer = JSON.parse(raw);
        if (!outer || outer.status !== 200 || !outer.message) return '';
        const inner = JSON.parse(outer.message);
        return inner && inner.ok && inner.token ? String(inner.token) : '';
    } catch {
        return '';
    }
}

function schedulePipelineReconnect() {
    if (pipelineReconnectTimer) return;
    pipelineReconnectTimer = setTimeout(() => {
        pipelineReconnectTimer = null;
        ensurePipeline();
    }, 5000);
}

function connectPipeline(token) {
    if (token) pipelineToken = token;
    if (!pipelineToken) return;
    if (pipelineSocket && (pipelineSocket.readyState === WebSocket.OPEN || pipelineSocket.readyState === WebSocket.CONNECTING)) {
        return;
    }
    if (pipelineConnecting) return;
    pipelineConnecting = true;
    const agent = proxyAgent(readConfig().proxy);
    const upstreamUrl = `wss://pipeline.vrchat.cloud/?auth=${encodeURIComponent(pipelineToken)}`;
    let socket;
    try {
        socket = new WebSocket(upstreamUrl, {
            agent,
            headers: { 'User-Agent': 'VRCX 2026.09.16' }
        });
    } catch (err) {
        pipelineConnecting = false;
        console.error('[ws] connect failed:', err.message);
        schedulePipelineReconnect();
        return;
    }
    pipelineSocket = socket;
    socket.on('open', () => {
        pipelineConnecting = false;
        console.log('[ws] pipeline connected (background)');
    });
    socket.on('message', (data, isBinary) => {
        pushPipelineMessage(data);
    });
    socket.on('close', (code, reason) => {
        pipelineConnecting = false;
        if (pipelineSocket === socket) pipelineSocket = null;
        console.log(`[ws] pipeline closed ${code} ${reason?.toString().slice(0, 80) || ''}`);
        schedulePipelineReconnect();
    });
    socket.on('error', (err) => {
        pipelineConnecting = false;
        console.error('[ws] pipeline error:', err.message);
        try {
            socket.close();
        } catch {
            // ignore
        }
        schedulePipelineReconnect();
    });
}

async function ensurePipeline() {
    if (pipelineSocket && (pipelineSocket.readyState === WebSocket.OPEN || pipelineSocket.readyState === WebSocket.CONNECTING)) {
        return;
    }
    const token = await getPipelineToken();
    if (token) {
        pipelineToken = token;
        connectPipeline(token);
    } else {
        schedulePipelineReconnect();
    }
}

function handleUpgrade(req, socket, head, pathname) {
    if (pathname !== '/ws' && pathname !== '/ws/') {
        socket.destroy();
        return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
        pipelineClients.add(client);
        for (const item of pipelineBacklog) {
            if (client.readyState === WebSocket.OPEN) client.send(item.data);
        }
        if (pipelineBacklog.length) {
            console.log(`[ws] replayed ${pipelineBacklog.length} backlog events`);
            pipelineBacklog = [];
            saveBacklog();
        }
        const url = new URL(req.url, 'http://localhost');
        const browserToken = url.searchParams.get('auth') || '';
        if (browserToken && browserToken !== pipelineToken) {
            pipelineToken = browserToken;
            try {
                pipelineSocket?.close();
            } catch {
                // ignore
            }
            pipelineSocket = null;
            connectPipeline(browserToken);
        } else if (!pipelineSocket || pipelineSocket.readyState === WebSocket.CLOSED) {
            connectPipeline(pipelineToken);
        }
        client.on('message', (data, isBinary) => {
            if (pipelineSocket && pipelineSocket.readyState === WebSocket.OPEN) {
                pipelineSocket.send(data, { binary: isBinary });
            }
        });
        client.on('close', () => {
            pipelineClients.delete(client);
            console.log(`[ws] browser client closed, background=${pipelineClients.size === 0}`);
        });
        client.on('error', () => {
            pipelineClients.delete(client);
        });
    });
}

// ---------------------------------------------------------------------------
// Manager API
// ---------------------------------------------------------------------------

function fetchJson(url, proxy) {
    return new Promise((resolve, reject) => {
        const client = String(url).startsWith('https:') ? https : http;
        const req = client.get(
            url,
            {
                agent: proxyAgent(proxy),
                headers: {
                    'User-Agent': 'VRCX-fnos-manager/1.0',
                    Accept: 'application/vnd.github+json'
                },
                timeout: 20000
            },
            (response) => {
                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    response.resume();
                    fetchJson(response.headers.location, proxy).then(resolve, reject);
                    return;
                }
                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('end', () => {
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                    } catch (err) {
                        reject(err);
                    }
                });
            }
        );
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}


function compareVersions(a, b) {
    const normalize = (value) =>
        String(value || '')
            .replace(/^v/i, '')
            .split('-')[0]
            .split('.')
            .map((part) => Number.parseInt(part, 10) || 0);
    const left = normalize(a);
    const right = normalize(b);
    const length = Math.max(left.length, right.length);
    for (let i = 0; i < length; i += 1) {
        const diff = (left[i] || 0) - (right[i] || 0);
        if (diff !== 0) return diff > 0 ? 1 : -1;
    }
    return 0;
}

function fetchRedirect(url, proxy) {
    return new Promise((resolve, reject) => {
        const client = String(url).startsWith('https:') ? https : http;
        const req = client.get(
            url,
            {
                agent: proxyAgent(proxy),
                headers: { 'User-Agent': 'VRCX-fnos-updater/1.0' },
                timeout: 30000
            },
            (response) => {
                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    response.resume();
                    fetchRedirect(response.headers.location, proxy).then(resolve, reject);
                    return;
                }
                response.resume();
                resolve(String(url));
            }
        );
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

async function fetchLatestRelease(repo, proxy) {
    try {
        const release = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`, proxy);
        if (release && release.tag_name) return release;
    } catch {
        // fall through to HTML redirect
    }
    const finalUrl = await fetchRedirect(`https://github.com/${repo}/releases/latest`, proxy);
    const match = finalUrl.match(/\/releases\/tag\/([^/?#]+)/);
    if (!match) throw new Error('无法解析最新 Release');
    const tag = decodeURIComponent(match[1]);
    const version = tag.replace(/^v/, '');
    const name = `vrcx_${version}_x86.fpk`;
    return {
        tag_name: tag,
        html_url: finalUrl,
        assets: [
            {
                name,
                browser_download_url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${name}`,
                size: 0,
                digest: ''
            }
        ]
    };
}

function downloadFile(url, destination, proxy, expectedDigest) {
    return new Promise((resolve, reject) => {
        const client = String(url).startsWith('https:') ? https : http;
        const request = client.get(
            url,
            {
                agent: proxyAgent(proxy),
                headers: { 'User-Agent': 'VRCX-fnos-updater/1.0', Accept: 'application/octet-stream' },
                timeout: 600000
            },
            (response) => {
                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    response.resume();
                    downloadFile(response.headers.location, destination, proxy, expectedDigest).then(resolve, reject);
                    return;
                }
                if (response.statusCode !== 200) {
                    response.resume();
                    reject(new Error(`下载失败：HTTP ${response.statusCode}`));
                    return;
                }
                fs.mkdirSync(path.dirname(destination), { recursive: true });
                const hash = crypto.createHash('sha256');
                const output = fs.createWriteStream(destination);
                response.on('data', (chunk) => hash.update(chunk));
                response.pipe(output);
                output.on('finish', () => {
                    output.close(() => {
                        const digest = hash.digest('hex');
                        if (expectedDigest && expectedDigest.startsWith('sha256:') && expectedDigest.slice(7) !== digest) {
                            reject(new Error('更新包校验失败（sha256 不匹配）'));
                            return;
                        }
                        resolve({ file: destination, digest });
                    });
                });
                output.on('error', reject);
            }
        );
        request.on('timeout', () => request.destroy(new Error('下载超时')));
        request.on('error', reject);
    });
}

async function managerApi(req, res, pathname, url) {
    if (pathname === '/status') {
        const cfg = readConfig();
        const running = Boolean(hostProcess && hostReady);
        let pid = 0;
        let cpu = 0;
        let memory = 0;
        try {
            pid = Number(fs.readFileSync(HOST_PID_FILE, 'utf8').trim());
            if (pid > 1) {
                const { stdout } = await execFileAsync('ps', ['-o', '%cpu=,rss=', '-p', String(pid)]);
                const [cpuText, rssText] = stdout.trim().split(/\s+/);
                cpu = Number(cpuText) || 0;
                memory = Math.round((Number(rssText) || 0) / 1024);
            }
        } catch {
            pid = 0;
        }
        let deployTime = '';
        try {
            const stat = fs.statSync(APP_DIR);
            const date = new Date(stat.mtime);
            const pad = (value) => String(value).padStart(2, '0');
            deployTime = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
        } catch {
            deployTime = '';
        }
        return sendJson(res, 200, {
            running,
            deployTime,
            version: APP_VERSION,
            vrcxVersion: '2026.09.16',
            uptime: running && hostStartedAt ? Math.floor((Date.now() - hostStartedAt) / 1000) : 0,
            pid,
            cpu,
            memory,
            proxy: cfg.proxy || '',
            updateRepo: cfg.updateRepo || '',
            basePath: BASE_PATH
        });
    }
    if (pathname === '/start' && req.method === 'POST') {
        const ok = await startHost();
        return sendJson(res, 200, { ok });
    }
    if (pathname === '/stop' && req.method === 'POST') {
        stopHost();
        return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/restart' && req.method === 'POST') {
        const ok = await restartHost();
        return sendJson(res, 200, { ok });
    }
    if (pathname === '/config' && req.method === 'GET') {
        return sendJson(res, 200, readConfig());
    }
    if (pathname === '/config' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8'));
        const next = { ...readConfig(), ...body };
        writeConfig(next);
        writeVrcxProxy(next.proxy || '');
        try {
            await hostRpc('VRCXStorage', 'Set', ['VRCX_ProxyServer', next.proxy || '']);
            await hostRpc('VRCXStorage', 'Save', []);
        } catch (err) {
            console.error('[config] failed to sync proxy to backend:', err.message);
        }
        return sendJson(res, 200, { ok: true, config: next });
    }
    if (pathname === '/update-check') {
        try {
            const cfg = readConfig();
            const repo = String(cfg.updateRepo || '').trim();
            if (!repo) {
                return sendJson(res, 200, { ok: false, error: '未配置更新仓库，请在「检查更新」里填写 GitHub owner/repo' });
            }
            const release = await fetchLatestRelease(repo, cfg.proxy);
            const latest = String(release.tag_name || '').replace(/^v/, '');
            const asset = (release.assets || []).find((item) => /\.fpk$/i.test(item.name || ''));
            return sendJson(res, 200, {
                ok: true,
                current: APP_VERSION,
                latest: latest || APP_VERSION,
                updateAvailable: compareVersions(latest, APP_VERSION) > 0,
                url: release.html_url || '',
                assetUrl: asset?.browser_download_url || '',
                assetName: asset?.name || '',
                assetSize: asset?.size || 0,
                digest: asset?.digest || ''
            });
        } catch (err) {
            return sendJson(res, 200, { ok: false, error: `检查更新失败：${err.message}` });
        }
    }
    if (pathname === '/update-apply' && req.method === 'POST') {
        try {
            const cfg = readConfig();
            const repo = String(cfg.updateRepo || '').trim();
            if (!repo) {
                return sendJson(res, 200, { ok: false, error: '未配置更新仓库' });
            }
            const release = await fetchLatestRelease(repo, cfg.proxy);
            const latest = String(release.tag_name || '').replace(/^v/, '');
            if (compareVersions(latest, APP_VERSION) <= 0) {
                return sendJson(res, 200, { ok: false, error: '当前已经是最新版本' });
            }
            const asset = (release.assets || []).find((item) => /\.fpk$/i.test(item.name || ''));
            if (!asset?.browser_download_url) {
                return sendJson(res, 200, { ok: false, error: 'Release 中没有找到 .fpk 安装包' });
            }
            const target = path.join(DATA_DIR, 'updates', asset.name);
            await downloadFile(asset.browser_download_url, target, cfg.proxy, asset.digest);
            const installCommand = `sleep 2; /usr/local/bin/appcenter-cli stop vrcx >/dev/null 2>&1; /usr/local/bin/appcenter-cli uninstall vrcx >/dev/null 2>&1; /usr/local/bin/appcenter-cli install-fpk ${JSON.stringify(target)} -v 1 >> ${JSON.stringify(path.join(LOG_DIR, 'update.log'))} 2>&1`;
            const child = spawn('/bin/sh', ['-c', installCommand], {
                detached: true,
                stdio: 'ignore'
            });
            child.unref();
            return sendJson(res, 200, { ok: true, message: `已下载 ${asset.name}，正在安装，页面可能会短暂断开` });
        } catch (err) {
            return sendJson(res, 200, { ok: false, error: `更新失败：${err.message}` });
        }
    }
    if (pathname === '/logs') {
        const file = path.join(LOG_DIR, 'backend.log');
        const limit = Number(url.searchParams.get('lines') || 200);
        if (!fs.existsSync(file)) return sendText(res, 200, '');
        const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
        return sendText(res, 200, lines.slice(-limit).join('\n'));
    }
    return sendJson(res, 404, { error: 'not found' });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
    let url;
    try {
        url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
        return sendText(res, 400, 'bad request');
    }
    const pathname = stripBase(url.pathname);

    try {
        if (pathname === '/healthz') return sendJson(res, 200, { ok: true, host: hostReady });

        if (pathname.startsWith('/api/manager')) {
            return await managerApi(req, res, pathname.replace('/api/manager', '') || '/', url);
        }

        if (pathname === '/image' || pathname === '/api/image') {
            const target = url.searchParams.get('url') || '';
            if (!/^https:\/\/(api\.vrchat\.cloud|files\.vrchat\.cloud|d348imysud55la\.cloudfront\.net|assets\.vrchat\.com)\//i.test(target)) {
                return sendText(res, 400, 'invalid image url');
            }
            try {
                const fileId = crypto.createHash('md5').update(target).digest('hex');
                const version = fileId.slice(0, 10);
                const file = await hostRpc('AppApiElectron', 'GetImage', [target, fileId, version]);
                if (!file || !fs.existsSync(file)) return sendText(res, 404, 'not found');
                const data = fs.readFileSync(file);
                let type = 'image/png';
                if (data[0] === 0xff && data[1] === 0xd8) type = 'image/jpeg';
                else if (data.slice(0, 4).toString() === 'RIFF' && data.slice(8, 12).toString() === 'WEBP') type = 'image/webp';
                else if (data.slice(0, 3).toString() === 'GIF') type = 'image/gif';
                res.writeHead(200, {
                    'Content-Type': type,
                    'Content-Length': data.length,
                    'Cache-Control': 'public, max-age=86400'
                });
                return res.end(data);
            } catch (err) {
                return sendText(res, 502, `image proxy failed: ${err.message}`);
            }
        }

        if (pathname === '/api/bootstrap') {
            let storage = {};
            let version = 'VRCX 2026.09.16';
            try {
                const json = await hostRpc('VRCXStorage', 'GetAll');
                storage = JSON.parse(json || '{}');
            } catch (err) {
                console.error('[bootstrap] storage failed:', err.message);
            }
            return sendJson(res, 200, { version, storage, basePath: BASE_PATH, startedAt: hostStartedAt || Date.now() });
        }

        if (pathname === '/api/storage' && req.method === 'POST') {
            const body = JSON.parse((await readBody(req)).toString('utf8'));
            await hostRpc('WebHostStorage', 'Apply', [JSON.stringify({ set: body.set || {}, remove: body.remove || [] })]);
            return sendJson(res, 200, { ok: true });
        }

        if (pathname === '/api/rpc' && req.method === 'POST') {
            const body = await readBody(req);
            const response = await fetch(`http://127.0.0.1:${INTERNAL_PORT}/rpc`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body
            });
            const text = await response.text();
            res.writeHead(response.status, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store'
            });
            return res.end(text);
        }

        if (pathname.startsWith('/webui')) {
            let rel = pathname.replace(/^\/webui\/?/, '');
            if (rel === '') rel = 'index.html';
            const file = safeJoin(WEBUI_DIR, rel);
            if (!file) return sendText(res, 403, 'forbidden');
            const isAsset = rel.startsWith('assets/');
            if (serveFile(res, file, isAsset ? 'public, max-age=31536000, immutable' : 'no-cache')) return;
            return sendText(res, 404, 'not found');
        }

        let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        const file = safeJoin(MANAGER_DIR, rel);
        if (file && serveFile(res, file, rel === 'index.html' ? 'no-store' : 'no-cache')) return;
        return sendText(res, 404, 'not found');
    } catch (err) {
        console.error('[http]', req.method, pathname, err);
        if (!res.headersSent) sendJson(res, 500, { error: err.message });
        else res.end();
    }
});

server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
        pathname = stripBase(new URL(req.url, 'http://localhost').pathname);
    } catch {
        socket.destroy();
        return;
    }
    handleUpgrade(req, socket, head, pathname);
});

server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

async function boot() {
    loadBacklog();
    try {
        fs.rmSync(SOCKET_PATH, { force: true });
    } catch {
        // ignore
    }

    if (readConfig().autoStart) {
        await startHost().catch((err) => console.error('[host] start failed:', err));
    }

    setInterval(() => ensurePipeline(), 15000).unref();
    setTimeout(() => ensurePipeline(), 3000).unref();

    server.listen(SOCKET_PATH, () => {
        try {
            fs.chmodSync(SOCKET_PATH, 0o666);
        } catch {
            // ignore
        }
        console.log(`[gateway] listening on ${SOCKET_PATH} base=${BASE_PATH}`);
    });

}

for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
        console.log(`[gateway] ${signal}`);
        stopHost();
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000).unref();
    });
}

boot().catch((err) => {
    console.error('[boot]', err);
    process.exit(1);
});
