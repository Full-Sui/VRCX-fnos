const $ = (id) => document.getElementById(id);
const BASE = location.pathname.endsWith('/') ? location.pathname : `${location.pathname}/`;

const api = (path, options = {}) =>
    fetch(`${BASE}api/manager/${path}`.replace(/\/+/g, '/'), {
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        ...options
    }).then(async (response) => {
        const text = await response.text();
        let data = {};
        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            data = { raw: text };
        }
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        return data;
    });

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

const navItems = document.querySelectorAll('.nav-item[data-panel]');
for (const item of navItems) {
    item.addEventListener('click', () => {
        const panel = item.dataset.panel;
        for (const other of navItems) other.classList.toggle('active', other === item);
        for (const section of document.querySelectorAll('.panel')) {
            section.classList.toggle('active', section.id === `panel-${panel}`);
        }
        $('page-title').textContent = item.dataset.title || '';
        if (panel === 'logs') loadLogs();
    });
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function formatUptime(seconds) {
    if (!seconds) return '—';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h) return `${h}小时${m}分${s}秒`;
    if (m) return `${m}分${s}秒`;
    return `${s}秒`;
}

function setState(running) {
    $('state-text').textContent = running ? '运行中' : '已停止';
    $('state-dot').className = `dot ${running ? 'dot-on' : 'dot-off'}`;
}

let busy = false;

async function refreshStatus() {
    try {
        const data = await api('status');
        setState(data.running);
        $('uptime').textContent = data.running ? formatUptime(data.uptime) : '—';
        $('pid').textContent = data.running && data.pid ? String(data.pid) : '—';
        $('cpu').textContent = data.running ? `${Number(data.cpu || 0).toFixed(1)}%` : '—';
        $('memory').textContent = data.running ? `${data.memory || 0} MB` : '—';
        $('deploy-time').textContent = data.deployTime || '—';
        $('hero-version').textContent = data.version || '1.0.2';
        $('about-version').textContent = data.version || '1.0.2';
        if (document.activeElement !== $('proxy')) {
            $('proxy').value = data.proxy || '';
        }
        if (document.activeElement !== $('update-repo')) {
            $('update-repo').value = data.updateRepo || '';
        }
    } catch (err) {
        setState(false);
        $('state-text').textContent = '无法连接';
        $('pid').textContent = '—';
        $('cpu').textContent = '—';
        $('memory').textContent = '—';
    }
}

async function withBusy(button, fn) {
    if (busy) return;
    busy = true;
    const original = button.innerHTML;
    button.disabled = true;
    button.textContent = '处理中…';
    try {
        await fn();
    } catch (err) {
        alert(err.message || String(err));
    } finally {
        busy = false;
        button.disabled = false;
        button.innerHTML = original;
        refreshStatus();
    }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

$('btn-enter').addEventListener('click', () => {
    window.open(`${BASE}webui/`, '_blank', 'noopener');
});

$('btn-stop').addEventListener('click', (event) =>
    withBusy(event.currentTarget, () => api('stop', { method: 'POST' }))
);

$('btn-restart').addEventListener('click', (event) =>
    withBusy(event.currentTarget, () => api('restart', { method: 'POST' }))
);

$('btn-goto-update').addEventListener('click', () => {
    document.querySelector('.nav-item[data-panel="update"]').click();
    setTimeout(() => $('btn-check-update').click(), 120);
});

$('btn-redeploy').addEventListener('click', (event) => {
    if (!confirm('重新部署会重启 VRCX 服务，当前页面会短暂断开。继续吗？')) return;
    withBusy(event.currentTarget, () => api('restart', { method: 'POST' }));
});

$('btn-save-proxy').addEventListener('click', (event) =>
    withBusy(event.currentTarget, async () => {
        const proxy = $('proxy').value.trim();
        await api('config', { method: 'POST', body: JSON.stringify({ proxy }) });
        $('proxy-msg').textContent = proxy ? '已保存，正在重启服务…' : '已切换为直连，正在重启服务…';
        $('proxy-msg').className = 'msg';
        await api('restart', { method: 'POST' });
        $('proxy-msg').textContent = '已保存并重启';
    })
);

$('btn-clear-proxy').addEventListener('click', () => {
    $('proxy').value = '';
    $('btn-save-proxy').click();
});

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
}

function renderUpdate(data) {
    const box = $('update-result');
    if (!data.updateAvailable) {
        box.innerHTML = `已是最新版本 <strong>${escapeHtml(data.current)}</strong>`;
        return;
    }
    box.innerHTML =
        `发现新版本 <strong>${escapeHtml(data.latest)}</strong>（当前 ${escapeHtml(data.current)}）` +
        `<br/><a href="${escapeHtml(data.url)}" target="_blank" rel="noopener">查看 Release</a>`;
    const button = document.createElement('button');
    button.className = 'btn btn-blue';
    button.style.marginTop = '12px';
    button.textContent = '一键更新';
    button.addEventListener('click', async () => {
        if (!confirm(`确认安装 VRCX ${data.latest}？安装时服务会短暂中断。`)) return;
        button.disabled = true;
        button.textContent = '正在下载并安装…';
        try {
            const result = await api('update-apply', { method: 'POST' });
            box.textContent = result.ok ? result.message : (result.error || '更新失败');
        } catch (err) {
            box.textContent = `更新失败：${err.message}`;
        }
    });
    box.appendChild(button);
}

$('btn-save-repo').addEventListener('click', (event) =>
    withBusy(event.currentTarget, async () => {
        const updateRepo = $('update-repo').value.trim();
        await api('config', { method: 'POST', body: JSON.stringify({ updateRepo }) });
        $('update-result').textContent = updateRepo ? `已保存更新仓库：${updateRepo}` : '已清除更新仓库';
    })
);

$('btn-check-update').addEventListener('click', (event) =>
    withBusy(event.currentTarget, async () => {
        const box = $('update-result');
        box.textContent = '正在检查…';
        const data = await api('update-check');
        if (!data.ok) {
            box.textContent = data.error || '检查失败';
            return;
        }
        renderUpdate(data);
    })
);

async function loadLogs() {
    try {
        const response = await fetch(`${BASE}api/manager/logs?lines=200`.replace(/\/+/g, '/'));
        $('logs').textContent = (await response.text()) || '暂无日志';
        $('logs').scrollTop = $('logs').scrollHeight;
    } catch (err) {
        $('logs').textContent = `读取日志失败：${err.message}`;
    }
}

$('btn-refresh-logs').addEventListener('click', loadLogs);

refreshStatus();
setInterval(refreshStatus, 5000);
