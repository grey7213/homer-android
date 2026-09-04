import express from 'express';

import { getConfigValue } from '../util.js';

const BACKEND_BASE_URL = String(process.env.HOMER_BACKEND_BASE_URL || getConfigValue('homerBridge.backendBaseUrl', 'http://127.0.0.1:8000') || '').replace(/\/+$/, '');
const AUTH_COOKIE_NAME = String(process.env.HOMER_AUTH_COOKIE_NAME || getConfigValue('homerBridge.authCookieName', 'ai_xingyue_token') || 'ai_xingyue_token');
const REQUEST_TIMEOUT_MS = Math.max(500, Number(getConfigValue('homerBridge.requestTimeoutMs', 3000, 'number')) || 3000);

export const router = express.Router();

function readCookie(cookieHeader, name) {
    for (const item of String(cookieHeader || '').split(';')) {
        const [rawName, ...valueParts] = item.trim().split('=');
        if (rawName === name) {
            return valueParts.join('=').trim();
        }
    }
    return '';
}

async function forwardToHomer(request, response, pathname, { decorateSession = false } = {}) {
    const cookieValue = readCookie(request.headers.cookie, AUTH_COOKIE_NAME);
    if (!cookieValue) {
        return response.status(401).json({ error: '请先登录 Homer' });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const url = new URL(`${BACKEND_BASE_URL}${pathname}`);
        for (const [key, value] of Object.entries(request.query || {})) {
            if (Array.isArray(value)) {
                value.forEach(item => url.searchParams.append(key, String(item)));
            } else if (value !== undefined) {
                url.searchParams.set(key, String(value));
            }
        }
        const upstream = await fetch(url, {
            method: request.method,
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                Cookie: `${AUTH_COOKIE_NAME}=${cookieValue}`,
                'X-Homer-Module': 'dialogue-module',
            },
            body: request.method === 'GET' || request.method === 'HEAD'
                ? undefined
                : JSON.stringify(request.body ?? {}),
            signal: controller.signal,
        });
        const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
        let payload = Buffer.from(await upstream.arrayBuffer());
        if (decorateSession && contentType.includes('application/json')) {
            try {
                const decoded = JSON.parse(payload.toString('utf8'));
                const data = decoded?.data && typeof decoded.data === 'object' ? decoded.data : decoded;
                if (data?.runtime && typeof data.runtime === 'object') {
                    data.runtime.bridge_base_url = BACKEND_BASE_URL;
                    data.runtime.dialogue_api_base_url = `${BACKEND_BASE_URL}/console/api/web/dialogue/v1`;
                    payload = Buffer.from(JSON.stringify(decoded), 'utf8');
                }
            } catch {
                // Preserve the upstream payload if it was not valid JSON.
            }
        }
        response.status(upstream.status);
        response.setHeader('Content-Type', contentType);
        response.setHeader('Cache-Control', 'no-store');
        return response.send(payload);
    } catch (error) {
        console.warn('Homer API bridge request failed:', error?.message || error);
        return response.status(502).json({ error: 'Homer 后端暂时不可用' });
    } finally {
        clearTimeout(timeout);
    }
}

router.get('/session', (request, response) => {
    return forwardToHomer(request, response, '/console/api/web/dialogue/session', { decorateSession: true });
});

router.post('/sync', (request, response) => {
    return forwardToHomer(request, response, '/console/api/web/dialogue/sync');
});

router.post('/events', (request, response) => {
    return forwardToHomer(request, response, '/console/api/web/dialogue/events');
});

router.get('/runtime-state', (request, response) => {
    return forwardToHomer(request, response, '/console/api/web/dialogue/runtime-state');
});

router.post('/runtime-state', (request, response) => {
    return forwardToHomer(request, response, '/console/api/web/dialogue/runtime-state');
});

router.get('/conversations', (request, response) => {
    return forwardToHomer(request, response, '/console/api/web/conversations');
});

router.post('/conversations/start', (request, response) => {
    return forwardToHomer(request, response, '/console/api/web/conversations/start');
});

router.post('/conversations/import', (request, response) => {
    return forwardToHomer(request, response, '/console/api/web/conversations/import');
});

for (const action of ['rename', 'pin', 'copy', 'delete', 'export']) {
    router.post(`/conversations/:conversationId/${action}`, (request, response) => {
        const conversationId = encodeURIComponent(String(request.params.conversationId || '').trim());
        return forwardToHomer(
            request,
            response,
            `/console/api/web/conversations/${conversationId}/${action}`,
        );
    });
}

router.get('/conversations/:conversationId/runtime-config', (request, response) => {
    const conversationId = encodeURIComponent(String(request.params.conversationId || '').trim());
    return forwardToHomer(
        request,
        response,
        `/console/api/web/conversations/${conversationId}/runtime-config`,
    );
});

router.post('/conversations/:conversationId/preset-overrides', (request, response) => {
    const conversationId = encodeURIComponent(String(request.params.conversationId || '').trim());
    return forwardToHomer(
        request,
        response,
        `/console/api/web/conversations/${conversationId}/preset-overrides`,
    );
});

router.get('/models', (request, response) => {
    return forwardToHomer(request, response, '/console/api/web/model-presets');
});

router.get('/extensions', (request, response) => {
    return forwardToHomer(request, response, '/console/api/web/dialogue/extensions');
});

router.get('/extensions/:extensionId/assets/*', (request, response) => {
    const extensionId = encodeURIComponent(String(request.params.extensionId || '').trim());
    const assetPath = String(request.params[0] || '')
        .split('/')
        .filter(Boolean)
        .map(segment => encodeURIComponent(segment))
        .join('/');
    if (!extensionId || !assetPath) {
        return response.status(400).json({ error: 'invalid extension asset path' });
    }
    return forwardToHomer(
        request,
        response,
        `/console/api/web/dialogue/extensions/${extensionId}/assets/${assetPath}`,
    );
});

router.post('/favorites/:appId/toggle', (request, response) => {
    const appId = encodeURIComponent(String(request.params.appId || '').trim());
    return forwardToHomer(request, response, `/console/api/web/favorites/${appId}/toggle`);
});

router.get('/mods/library', (request, response) => {
    return forwardToHomer(request, response, '/console/api/web/chat-mods/library');
});

router.get('/mods/conversation/:conversationId', (request, response) => {
    const conversationId = encodeURIComponent(String(request.params.conversationId || '').trim());
    return forwardToHomer(request, response, `/console/api/web/chat-mods/conversation/${conversationId}`);
});

router.post('/mods/conversation/:conversationId', (request, response) => {
    const conversationId = encodeURIComponent(String(request.params.conversationId || '').trim());
    return forwardToHomer(request, response, `/console/api/web/chat-mods/conversation/${conversationId}`);
});
