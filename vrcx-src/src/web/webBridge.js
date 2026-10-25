/*
 * Browser bridge for the VRCX web port.
 *
 * The original renderer talks to a C# backend through `window.interopApi.callDotNetMethod`
 * (Electron/node-api-dotnet).  Here the same contract is served by the NAS-side
 * `VRCXWebHost` process through /api/rpc, so the upstream Vue application can run
 * unchanged in a normal browser.
 */

const API_BASE = new URL('../api/', document.baseURI).href;

let version = 'VRCX';
let storageMap = new Map();
let dirtySet = new Map();
let dirtyRemove = new Set();
let saveTimer = null;

function normalizeArg(value) {
    if (value instanceof Map) {
        return Object.fromEntries(Array.from(value.entries(), ([key, item]) => [key, normalizeArg(item)]));
    }
    if (Array.isArray(value)) {
        return value.map(normalizeArg);
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            out[key] = normalizeArg(item);
        }
        return out;
    }
    return value;
}

async function rpc(className, methodName, args = []) {
    const response = await fetch(`${API_BASE}rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ className, methodName, args: args.map(normalizeArg) })
    });
    if (!response.ok) {
        throw new Error(`RPC ${className}.${methodName} failed: HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (!payload.ok) {
        throw new Error(payload.error || `RPC ${className}.${methodName} failed`);
    }
    return payload.result;
}

function makeApi(className, overrides = {}) {
    return new Proxy(overrides, {
        get(target, prop) {
            if (prop in target) {
                return target[prop];
            }
            if (prop === 'then' || typeof prop === 'symbol') {
                return undefined;
            }
            return (...args) => rpc(className, String(prop), args);
        }
    });
}

function flushStorage() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    const payload = {
        set: Object.fromEntries(dirtySet),
        remove: Array.from(dirtyRemove)
    };
    dirtySet = new Map();
    dirtyRemove = new Set();
    if (!Object.keys(payload.set).length && !payload.remove.length) {
        return Promise.resolve();
    }
    return fetch(`${API_BASE}storage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).catch((err) => console.error('storage save failed', err));
}

function scheduleStorageSave() {
    if (saveTimer) {
        clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(flushStorage, 250);
}

const VRCXStorage = {
    Load() {
        return Promise.resolve();
    },
    Get(key) {
        return storageMap.has(String(key)) ? storageMap.get(String(key)) : '';
    },
    Set(key, value) {
        storageMap.set(String(key), value === null || value === undefined ? '' : String(value));
        dirtySet.set(String(key), storageMap.get(String(key)));
        dirtyRemove.delete(String(key));
        scheduleStorageSave();
    },
    Remove(key) {
        storageMap.delete(String(key));
        dirtySet.delete(String(key));
        dirtyRemove.add(String(key));
        scheduleStorageSave();
    },
    GetAll() {
        return JSON.stringify(Object.fromEntries(storageMap));
    },
    Save() {
        return flushStorage();
    },
    Clear() {
        storageMap.clear();
        scheduleStorageSave();
    }
};

const LogWatcher = {
    GetLogLines() {
        return Promise.resolve(null);
    },
    Get() {
        return Promise.resolve([]);
    },
    SetDateTill() {
        return Promise.resolve();
    },
    Reset() {
        return Promise.resolve();
    }
};

const noop = () => Promise.resolve();

const Discord = new Proxy(
    {},
    {
        get() {
            return noop;
        }
    }
);

const AssetBundleManager = new Proxy(
    {},
    {
        get() {
            return noop;
        }
    }
);

const AppApiVrElectron = new Proxy(
    {},
    {
        get(_, prop) {
            if (prop === 'CpuUsage' || prop === 'GetUptime') {
                return () => 0;
            }
            if (prop === 'GetVRDevices') {
                return () => [];
            }
            if (prop === 'CurrentCulture' || prop === 'CustomVrScript') {
                return () => '';
            }
            if (prop === 'GetExecuteVrOverlayFunctionQueue') {
                return () => [];
            }
            return noop;
        }
    }
);

const AppApi = makeApi('AppApiElectron', {
    OpenLink(url) {
        if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
            window.open(url, '_blank', 'noopener,noreferrer');
        }
        return Promise.resolve();
    },
    OpenDiscordProfile(id) {
        if (id) {
            window.open(`https://discord.com/users/${encodeURIComponent(id)}`, '_blank', 'noopener,noreferrer');
        }
        return Promise.resolve();
    },
    GetVersion() {
        return Promise.resolve(version);
    },
    CurrentLanguage() {
        return Promise.resolve(navigator.language || 'en');
    },
    GetZoom() {
        return Promise.resolve(0);
    },
    SetZoom() {
        return Promise.resolve();
    },
    GetClipboard() {
        return navigator.clipboard?.readText?.().catch(() => '') ?? Promise.resolve('');
    },
    SetClipboard(text) {
        return navigator.clipboard?.writeText?.(String(text ?? '')).catch(() => {}) ?? Promise.resolve();
    },
    DesktopNotification(title, body, icon) {
        try {
            if (window.Notification?.permission === 'granted') {
                new Notification(String(title || 'VRCX'), { body: String(body || ''), icon });
            }
        } catch (err) {
            console.error(err);
        }
        return Promise.resolve();
    },
    XSNotification() {
        return Promise.resolve();
    },
    OVRTNotification() {
        return Promise.resolve();
    },
    RestartApplication() {
        location.reload();
        return Promise.resolve();
    },
    OpenFileSelectorDialog() {
        return Promise.resolve('');
    },
    OpenFolderSelectorDialog() {
        return Promise.resolve('');
    },
    OpenFolderAndSelectItem() {
        return Promise.resolve();
    },
    OpenShortcutFolder() {
        return Promise.resolve();
    },
    OpenUGCPhotosFolder() {
        return Promise.resolve();
    },
    OpenCalendarFile() {
        return Promise.resolve();
    },
    CheckGameRunning() {
        return Promise.resolve();
    },
    IsGameRunning() {
        return Promise.resolve(false);
    },
    IsSteamVRRunning() {
        return Promise.resolve(false);
    },
    StartGame() {
        return Promise.resolve(false);
    },
    StartGameFromPath() {
        return Promise.resolve(false);
    },
    TryOpenInstanceInVrc() {
        return Promise.resolve(false);
    },
    GetLaunchCommand() {
        return Promise.resolve('');
    },
    GetVRChatRegistry() {
        return Promise.resolve('{}');
    },
    GetVRChatRegistryJson() {
        return Promise.resolve('{}');
    },
    GetVRChatRegistryKey() {
        return Promise.resolve('');
    },
    GetVRChatRegistryKeyString() {
        return Promise.resolve('');
    },
    HasVRChatRegistryFolder() {
        return Promise.resolve(false);
    },
    SetVRChatRegistry() {
        return Promise.resolve();
    },
    SetVRChatRegistryKey() {
        return Promise.resolve();
    },
    ReadVrcRegJsonFile() {
        return Promise.resolve('{}');
    },
    GetVRChatPhotosLocation() {
        return Promise.resolve('');
    },
    GetScreenshotMetadata() {
        return Promise.resolve(null);
    },
    GetExtraScreenshotData() {
        return Promise.resolve(null);
    },
    GetFileBase64() {
        return Promise.resolve('');
    },
    MD5File() {
        return Promise.resolve('');
    },
    SignFile() {
        return Promise.resolve('');
    },
    ResizeImageToFitLimits(base64) {
        return Promise.resolve(base64);
    },
    CropPrintImage() {
        return Promise.resolve(false);
    },
    SaveStickerToFile() {
        return Promise.resolve('');
    },
    SavePrintToFile() {
        return Promise.resolve('');
    },
    SaveEmojiToFile() {
        return Promise.resolve('');
    },
    SetTrayIconNotification() {
        return Promise.resolve();
    },
    SetStartup() {
        return Promise.resolve();
    },
    SetAppLauncherSettings() {
        return Promise.resolve();
    },
    SetUserAgent() {
        return Promise.resolve();
    },
    SetVR() {
        return Promise.resolve();
    },
    ExecuteVrOverlayFunction() {
        return Promise.resolve();
    },
    SendIpc() {
        return Promise.resolve();
    },
    IPCAnnounceStart() {
        return Promise.resolve();
    },
    FocusWindow() {
        return Promise.resolve();
    },
    FlashWindow() {
        return Promise.resolve();
    },
    ChangeTheme() {
        return Promise.resolve();
    },
    ShowDevTools() {
        return Promise.resolve();
    },
    VrcClosedGracefully() {
        return Promise.resolve();
    },
    WriteConfigFile() {
        return Promise.resolve();
    },
    PopulateImageHosts() {
        return Promise.resolve();
    },
    SetVRChatUserModeration() {
        return Promise.resolve();
    },
    GetVRChatUserModeration() {
        return Promise.resolve('{}');
    },
    DoFunny() {
        return Promise.resolve();
    }
});

function makeElectronShim() {
    const noopUnsubscribe = () => () => {};
    return {
        getArch: () => Promise.resolve('x64'),
        getClipboardText: () => AppApi.GetClipboard(),
        getNoUpdater: () => Promise.resolve(true),
        setTrayIconNotification: noop,
        setThemeSource: noop,
        onSystemThemeChanged(callback) {
            try {
                const media = window.matchMedia('(prefers-color-scheme: dark)');
                const listener = (event) => callback?.(event.matches);
                media.addEventListener?.('change', listener);
                return () => media.removeEventListener?.('change', listener);
            } catch {
                return noopUnsubscribe();
            }
        },
        openFileDialog: () => Promise.resolve(''),
        openDirectoryDialog: () => Promise.resolve(''),
        onWindowPositionChanged: noopUnsubscribe,
        onWindowSizeChanged: noopUnsubscribe,
        onWindowStateChange: noopUnsubscribe,
        onBrowserFocus: noopUnsubscribe,
        onBrowserBlur: noopUnsubscribe,
        desktopNotification: (title, body, icon) => AppApi.DesktopNotification(title, body, icon),
        restartApp: () => {
            location.reload();
            return Promise.resolve();
        },
        getOverlayWindow: () => Promise.resolve(null),
        updateVr: noop,
        ipcRenderer: {
            on: noopUnsubscribe
        }
    };
}


function imageProxyUrl(src) {
    if (!src || typeof src !== 'string' || src.startsWith('data:') || src.startsWith('blob:')) return src;
    if (!/^https:\/\/(api\.vrchat\.cloud|files\.vrchat\.cloud|d348imysud55la\.cloudfront\.net|assets\.vrchat\.com)\//i.test(src)) return src;
    const encoded = btoa(unescape(encodeURIComponent(src))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    return `${API_BASE}image/${encoded}`;
}

function proxifyImageElement(image) {
    const src = image.getAttribute('src');
    if (!src) return;
    const proxied = imageProxyUrl(src);
    if (proxied !== src) image.setAttribute('src', proxied);
}

function startImageProxy() {
    if (window.__VRCX_IMAGE_PROXY__) return;
    window.__VRCX_IMAGE_PROXY__ = true;
    window.__VRCX_IMAGE_PROXY_URL__ = imageProxyUrl;

    // Catch images assigned through element.src = ... (Vue/reka-ui often does this).
    try {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
        if (descriptor?.set && !descriptor.set.__vrcxProxy) {
            const setter = descriptor.set;
            const wrapped = function (value) {
                try {
                    value = imageProxyUrl(String(value));
                } catch {
                    // ignore
                }
                return setter.call(this, value);
            };
            wrapped.__vrcxProxy = true;
            Object.defineProperty(HTMLImageElement.prototype, 'src', { ...descriptor, set: wrapped });
        }
    } catch {
        // ignore
    }
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.type === 'attributes' && mutation.target instanceof HTMLImageElement) {
                proxifyImageElement(mutation.target);
            }
            for (const node of mutation.addedNodes || []) {
                if (node instanceof HTMLImageElement) proxifyImageElement(node);
                if (node instanceof HTMLElement) node.querySelectorAll('img').forEach(proxifyImageElement);
            }
        }
    });
    observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['src']
    });
    document.querySelectorAll('img').forEach(proxifyImageElement);
}

export async function initWebBridge() {
    // Bootstrap: version + persisted VRCXStorage values.
    try {
        const response = await fetch(`${API_BASE}bootstrap`);
        if (response.ok) {
            const data = await response.json();
            version = data.version || version;
            window.__VRCX_APP_START_AT__ = data.startedAt || Date.now();
            storageMap = new Map(Object.entries(data.storage || {}));
        }
    } catch (err) {
        console.error('bootstrap failed', err);
    }

    window.LINUX = true;
    window.WINDOWS = false;
    window.isVrOverlay = false;
    window.__VRCX_WEB__ = true;
    window.__VRCX_API_BASE__ = API_BASE;
    window.electron = makeElectronShim();
    window.interopApi = {
        callDotNetMethod: (className, methodName, args) => rpc(className, methodName, args)
    };

    startImageProxy();

    return {
        AppApi,
        WebApi: makeApi('WebApi'),
        VRCXStorage,
        SQLite: makeApi('SQLite'),
        LogWatcher,
        Discord,
        AssetBundleManager,
        AppApiVrElectron
    };
}
