// Copyright (C) 2024–2026 Aiko Hanasaki
// SPDX-License-Identifier: AGPL-3.0-only

import { getRequestHeaders } from '../../../../script.js';

/**
 * Check a loose user file without triggering a browser-visible 404 on first run.
 *
 * @param {string} fileName
 * @returns {Promise<boolean>}
 */
export async function userFileExists(fileName) {
    const name = String(fileName || '').trim();
    if (!name || name.includes('/') || name.includes('\\')) {
        throw new Error('Invalid user file name');
    }

    const relativePath = `user/files/${name}`;
    const response = await fetch('/api/files/verify', {
        method: 'POST',
        credentials: 'include',
        headers: getRequestHeaders(),
        body: JSON.stringify({ urls: [relativePath] }),
    });
    if (!response.ok) {
        throw new Error(`Failed to verify user file: ${response.status} ${response.statusText}`);
    }

    const verified = await response.json();
    return verified?.[relativePath] === true;
}
