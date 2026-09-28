import 'core-js-bundle/minified.js';
import dialogPolyfill from 'dialog-polyfill';

// Keep native fetch/AbortSignal identity; only fill missing DOM APIs.
if (typeof AbortSignal !== 'undefined') {
    const reasons = new WeakMap();
    if (!('reason' in AbortSignal.prototype)) {
        const originalAbort = AbortController.prototype.abort;
        AbortController.prototype.abort = function(reason) {
            if (!this.signal.aborted) reasons.set(this.signal,
                reason === undefined ? new DOMException('Aborted', 'AbortError') : reason);
            return originalAbort.call(this);
        };
        Object.defineProperty(AbortSignal.prototype, 'reason', {
            configurable: true,
            get() { return this.aborted ? (reasons.has(this) ? reasons.get(this) : new DOMException('Aborted', 'AbortError')) : undefined; },
        });
    }
    if (!AbortSignal.prototype.throwIfAborted) {
        AbortSignal.prototype.throwIfAborted = function() { if (this.aborted) throw this.reason; };
    }
    if (!AbortSignal.timeout) AbortSignal.timeout = ms => {
        if (!Number.isFinite(ms) || ms < 0) throw new RangeError('Invalid timeout');
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
        return controller.signal;
    };
    if (!AbortSignal.any) AbortSignal.any = signals => {
        const controller = new AbortController(), listeners = [];
        const cleanup = () => listeners.forEach(([signal, listener]) => signal.removeEventListener('abort', listener));
        for (const signal of signals) {
            if (signal.aborted) { controller.abort(signal.reason); cleanup(); break; }
            const listener = () => { controller.abort(signal.reason); cleanup(); };
            signal.addEventListener('abort', listener, {once: true});
            listeners.push([signal, listener]);
        }
        return controller.signal;
    };
}
if (globalThis.crypto && !crypto.randomUUID) crypto.randomUUID = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
};

if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
    // Lazy registration also covers innerHTML + showModal in the same task.
    for (const method of ['show', 'showModal', 'close']) {
        HTMLDialogElement.prototype[method] = function(...args) {
            if (method === 'close' && !this.open) return;
            dialogPolyfill.forceRegisterDialog(this);
            const close = this.close;
            this.close = function(...values) { if (this.open) return close.apply(this, values); };
            return this[method](...args);
        };
    }
    const css = document.createElement('style');
    css.textContent = 'dialog:not([open]){display:none}dialog{position:absolute;left:0;right:0;margin:auto}dialog+.backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45)}._dialog_overlay{position:fixed;inset:0}dialog.fixed{position:fixed;top:50%;transform:translateY(-50%)}';
    document.head.appendChild(css);
}
globalThis.HomerWebViewCompatibility = {version: 1, minimumChromium: 89};
