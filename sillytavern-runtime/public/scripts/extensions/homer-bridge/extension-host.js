// Loads administrator-approved Homer extension packages inside the dialogue
// module. Assets are served through the authenticated same-origin
// /api/homer proxy, so no login token is exposed to extension code.

const loadedExtensions = new Map();
const HOOK_TIMEOUT_MS = 5000;

function withVersion(url, extension) {
    if (!url) {
        return '';
    }
    const version = encodeURIComponent(
        extension.file_sha256 || extension.version || Date.now(),
    );
    return `${url}${url.includes('?') ? '&' : '?'}homer_ext=${version}`;
}

function withTimeout(value, label) {
    let timer = null;
    return Promise.race([
        Promise.resolve(value),
        new Promise((_, reject) => {
            timer = window.setTimeout(
                () => reject(new Error(`${label} 超过 ${HOOK_TIMEOUT_MS}ms`)),
                HOOK_TIMEOUT_MS,
            );
        }),
    ]).finally(() => window.clearTimeout(timer));
}

async function callHook(record, hookName) {
    const exportName = String(record.extension?.hooks?.[hookName] || '').trim();
    if (!exportName) {
        return;
    }
    const hook = record.module?.[exportName];
    if (typeof hook !== 'function') {
        throw new Error(`manifest hooks.${hookName} 指向的导出不存在：${exportName}`);
    }
    await withTimeout(
        hook(),
        `${record.extension.display_name || record.extension.id} ${hookName}`,
    );
}

function addStylesheet(extension) {
    if (!extension.css_url) {
        return Promise.resolve(null);
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = withVersion(extension.css_url, extension);
    link.dataset.homerDialogueExtension = extension.id;
    return new Promise((resolve, reject) => {
        link.onload = () => resolve(link);
        link.onerror = () => reject(new Error(`CSS 加载失败：${extension.css_url}`));
        document.head.appendChild(link);
    });
}

async function deactivate(record) {
    try {
        await callHook(record, 'disable');
    } catch (error) {
        console.warn('[Homer/dialogue-extension] disable hook failed', error);
    }
    record.stylesheet?.remove();
}

export async function loadApprovedExtensions(payload) {
    const list = (Array.isArray(payload) ? payload : payload?.list || [])
        .filter(item => item?.id && item.enabled !== false)
        .sort(
            (left, right) => Number(left.loading_order || 0) - Number(right.loading_order || 0)
                || String(left.id).localeCompare(String(right.id)),
        );
    const requestedIds = new Set(list.map(item => String(item.id)));
    for (const [id, record] of loadedExtensions.entries()) {
        if (!requestedIds.has(id)) {
            await deactivate(record);
            loadedExtensions.delete(id);
        }
    }

    const available = new Set(requestedIds);
    const result = { loaded: [], skipped: [], failed: [] };
    for (const extension of list) {
        const id = String(extension.id);
        const missing = (Array.isArray(extension.requires) ? extension.requires : [])
            .filter(required => !available.has(String(required)));
        if (missing.length) {
            result.skipped.push({ id, reason: `缺少必需扩展：${missing.join(', ')}` });
            continue;
        }
        const fingerprint = String(extension.file_sha256 || extension.version || '');
        const prior = loadedExtensions.get(id);
        if (prior?.fingerprint === fingerprint) {
            result.loaded.push({ id, reused: true });
            continue;
        }
        if (prior) {
            await deactivate(prior);
            loadedExtensions.delete(id);
        }
        const record = { extension, fingerprint, module: {}, stylesheet: null };
        try {
            record.stylesheet = await addStylesheet(extension);
            if (extension.js_url) {
                record.module = await import(withVersion(extension.js_url, extension));
            }
            loadedExtensions.set(id, record);
            await callHook(record, 'enable');
            await callHook(record, 'activate');
            result.loaded.push({ id, reused: false });
        } catch (error) {
            record.stylesheet?.remove();
            loadedExtensions.delete(id);
            const reason = String(error?.message || error || '未知错误');
            result.failed.push({ id, reason });
            console.error('[Homer/dialogue-extension] load failed', id, error);
        }
    }
    window.__homerDialogueExtensions = {
        result,
        list: list.map(item => ({ ...item })),
    };
    window.dispatchEvent(
        new CustomEvent('homer:dialogue-extensions-loaded', { detail: result }),
    );
    return result;
}
