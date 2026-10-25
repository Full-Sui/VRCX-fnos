import { extractFileId, extractFileVersion, extractVariantVersion } from './fileUtils';
import { replaceBioSymbols } from './base/string';
import { getFaviconUrl, replaceVrcPackageUrl } from './urlUtils';
import { AppDebug } from '../../services/appConfig.js';
import { getAvailablePlatforms } from './platformUtils';

/**
 * @param {string} url
 * @param {number} resolution
 * @param endpointDomain
 * @returns {string}
 */
function proxyImageUrl(url) {
    if (!url || typeof url !== 'string') return url;
    if (typeof window === 'undefined' || !window.__VRCX_WEB__ || !window.__VRCX_API_BASE__) return url;
    if (!/^https:\/\/(api\.vrchat\.cloud|files\.vrchat\.cloud|d348imysud55la\.cloudfront\.net|assets\.vrchat\.com)\//i.test(url)) {
        return url;
    }
    const encoded = btoa(unescape(encodeURIComponent(url))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    return `${window.__VRCX_API_BASE__}image/${encoded}`;
}

function convertFileUrlToImageUrl(url, resolution = 128, endpointDomain = AppDebug.endpointDomain) {
    if (!url || typeof url !== 'string') {
        return '';
    }
    /**
     * Possible patterns?
     * /file/file_fileId/version
     * /file/file_fileId/version/
     * /file/file_fileId/version/file
     * /file/file_fileId/version/file/
     * /image/file_fileId/version/resolution
     */
    const imagePattern = /image\/file_([a-f0-9-]+)\/(\d+)\/(\d+)\/?$/;
    const pattern = /file\/file_([a-f0-9-]+)\/(\d+)(\/file)?\/?$/;
    const match = url.match(imagePattern) || url.match(pattern);

    if (match) {
        const fileId = match[1];
        const version = match[2];
        return proxyImageUrl(`${endpointDomain}/image/file_${fileId}/${version}/${resolution}`);
    }
    // no match return origin url
    return proxyImageUrl(url);
}

/**
 * @param func
 * @param delay
 */
function debounce(func, delay) {
    let timer = null;
    return function (...args) {
        const context = this;
        clearTimeout(timer);
        timer = setTimeout(() => {
            func.apply(context, args);
        }, delay);
    };
}

// Re-export from appActions and cacheCoordinator for backward compatibility
export {
    downloadAndSaveJson,
    copyToClipboard,
    openExternalLink,
    openDiscordProfile,
    openFolderGeneric
} from './appActions';

export { deleteVRChatCache, checkVRChatCache, getBundleDateSize } from '../../coordinators/cacheCoordinator';

export {
    getAvailablePlatforms,
    getFaviconUrl,
    convertFileUrlToImageUrl,
    proxyImageUrl,
    replaceVrcPackageUrl,
    extractFileId,
    extractFileVersion,
    extractVariantVersion,
    replaceBioSymbols,
    debounce
};
