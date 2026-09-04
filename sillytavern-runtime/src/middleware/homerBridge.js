import { ensureExternalUser, getAccountVersion } from '../users.js';
import { getConfigValue } from '../util.js';

const ENABLED = getConfigValue('homerBridge.enabled', false, 'boolean');
const BACKEND_BASE_URL = String(process.env.HOMER_BACKEND_BASE_URL || getConfigValue('homerBridge.backendBaseUrl', 'http://127.0.0.1:8000') || '').replace(/\/+$/, '');
const AUTH_COOKIE_NAME = String(process.env.HOMER_AUTH_COOKIE_NAME || getConfigValue('homerBridge.authCookieName', 'ai_xingyue_token') || 'ai_xingyue_token');
const LOGIN_URL = String(process.env.HOMER_LOGIN_URL || getConfigValue('homerBridge.loginUrl', 'http://127.0.0.1:8000/app/login.html') || '');
const VERIFY_TTL_MS = Math.max(5, Number(getConfigValue('homerBridge.verificationTtlSeconds', 60, 'number')) || 60) * 1000;
const REQUEST_TIMEOUT_MS = Math.max(500, Number(getConfigValue('homerBridge.requestTimeoutMs', 3000, 'number')) || 3000);

let lastBackendWarningAt = 0;

function isRuntimeDocumentRequest(request) {
    if (!['GET', 'HEAD'].includes(String(request.method || '').toUpperCase())) {
        return false;
    }
    return ['/', '/index.html', '/login'].includes(String(request.path || ''));
}

function isInternalModuleRequest(request) {
    const prefix = String(request.headers['x-forwarded-prefix'] || '').replace(/\/+$/, '');
    return prefix === '/module/dialogue';
}

function websiteUrl(pathname) {
    try {
        return new URL(pathname, BACKEND_BASE_URL + '/').href;
    } catch {
        return pathname;
    }
}

function readCookie(cookieHeader, name) {
    for (const item of String(cookieHeader || '').split(';')) {
        const [rawName, ...valueParts] = item.trim().split('=');
        if (rawName === name) {
            return valueParts.join('=').trim();
        }
    }
    return '';
}

async function fetchHomerIdentity(cookieValue) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(`${BACKEND_BASE_URL}/console/api/web/sillytavern/session`, {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                Cookie: `${AUTH_COOKIE_NAME}=${cookieValue}`,
                'X-Homer-Bridge': 'sillytavern-1.18.0',
            },
            signal: controller.signal,
        });
        if (response.status === 401 || response.status === 403) {
            return null;
        }
        if (!response.ok) {
            throw new Error(`Homer identity endpoint returned ${response.status}`);
        }
        const payload = await response.json();
        const data = payload?.data ?? payload;
        const user = data?.user;
        if (!user?.handle) {
            throw new Error('Homer identity response did not contain a user handle');
        }
        return user;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Uses the existing Homer HttpOnly login cookie to establish an ST session.
 * The cookie value is forwarded only to the configured localhost Homer
 * backend and is never exposed to browser JavaScript or written to ST data.
 */
export default async function homerBridgeMiddleware(request, response, next) {
    if (!ENABLED || !request.session) {
        return next();
    }

    // The compatibility runtime is not a user-facing application. Only the
    // site's internal reverse proxy may serve its document; direct navigation
    // returns to the website-owned conversation surface.
    if (isRuntimeDocumentRequest(request) && !isInternalModuleRequest(request)) {
        return response.redirect(
            request.path === '/login' && LOGIN_URL
                ? LOGIN_URL
                : websiteUrl('/app/chat.html'),
        );
    }

    const now = Date.now();
    if (request.session.handle
        && request.session.homerVerifiedAt
        && now - Number(request.session.homerVerifiedAt) < VERIFY_TTL_MS) {
        return next();
    }

    const cookieValue = readCookie(request.headers.cookie, AUTH_COOKIE_NAME);
    if (!cookieValue) {
        // SillyTavern exposes this endpoint before requireLoginMiddleware and
        // uses its cookie-backed anonymous session to create the CSRF token.
        // Keep that public bootstrap/health endpoint functional; all private
        // routes still pass through the normal Homer login requirement.
        if (request.path === '/csrf-token') {
            return next();
        }
        request.session = null;
        if (request.path === '/api/users/login') {
            return response.status(401).json({ error: '请先登录 Homer' });
        }
        if (LOGIN_URL && (request.path === '/' || request.path === '/login')) {
            return response.redirect(LOGIN_URL);
        }
        return next();
    }

    try {
        const identity = await fetchHomerIdentity(cookieValue);
        if (!identity) {
            request.session = null;
            if (LOGIN_URL && (request.path === '/' || request.path === '/login')) {
                return response.redirect(LOGIN_URL);
            }
            return next();
        }
        const user = await ensureExternalUser(identity.handle, identity.name, identity.is_admin);
        request.session.handle = user.handle;
        request.session.version = getAccountVersion(user);
        request.session.homerHandle = user.handle;
        request.session.homerVerifiedAt = now;
    } catch (error) {
        if (now - lastBackendWarningAt > 30_000) {
            console.warn('Homer identity bridge is temporarily unavailable:', error?.message || error);
            lastBackendWarningAt = now;
        }
    }
    return next();
}
