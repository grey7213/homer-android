// Isolated multi-store transaction double, not browser IndexedDB conformance.
// The companion browser suite exercises actual Chromium IndexedDB separately.
const copy = value => value === undefined ? undefined : structuredClone(value);
const keyOf = value => JSON.stringify(value);
const defer = callback => setImmediate(callback);

export function cardTransportIDB() {
    const databases = new Map();
    const factory = { trace: [], openError: false, blockNextOpen: false, strictUnsupported: false,
        failNextPut: false, closeCount: 0, openCount: 0 };
    let nextGate;
    factory.holdNextCommit = mode => {
        let reached, release;
        const control = { reached: new Promise(resolve => { reached = resolve; }), release: () => release?.() };
        nextGate = { mode, reached, wait: new Promise(resolve => { release = resolve; }) };
        return control;
    };
    factory.dump = (name, store) => [...(databases.get(name)?.stores.get(store)?.rows.values() || [])].map(copy);
    factory.seed = (name, store, key, row) => databases.get(name).stores.get(store).rows.set(keyOf(key), copy(row));
    factory.database = name => databases.get(name);

    class Transaction {
        constructor(db, names, mode, gate) {
            this.db = db; this.names = names; this.mode = mode; this.gate = gate;
            this.requests = []; this.finished = false; this.active = false;
            db.queue.push(this); db.schedule();
        }
        activate() {
            this.active = true;
            this.stores = new Map(this.names.map(name => [name,
                new Map([...this.db.stores.get(name).rows].map(([key, row]) => [key, copy(row)]))]));
            this.advance();
        }
        enqueue(fn, existing) {
            if (this.finished) throw new Error('TransactionInactiveError');
            const request = existing || {}; this.requests.push({ request, fn }); return request;
        }
        advance() {
            defer(() => {
                if (this.finished) return;
                const task = this.requests.shift();
                if (!task) { this.complete(); return; }
                try {
                    task.request.result = task.fn(); factory.trace.push({ event: 'request-success', mode: this.mode });
                    task.request.onsuccess?.({ target: task.request });
                } catch (error) {
                    task.request.error = this.error = error;
                    task.request.onerror?.({ target: task.request }); this.onerror?.({ target: task.request });
                    this.abort(); return;
                }
                this.advance();
            });
        }
        complete() {
            const finish = () => {
                if (this.finished) return;
                if (this.requests.length) { this.advance(); return; }
                this.finished = true;
                if (this.mode === 'readwrite') for (const [name, rows] of this.stores) this.db.stores.get(name).rows = rows;
                factory.trace.push({ event: 'transaction-complete', mode: this.mode });
                this.oncomplete?.({ target: this }); this.db.queue.shift(); this.db.schedule();
            };
            if (this.gate) { const gate = this.gate; this.gate = null; gate.reached(this); gate.wait.then(() => defer(finish)); }
            else finish();
        }
        abort() {
            if (this.finished) throw new Error('TransactionInactiveError'); this.finished = true;
            defer(() => {
                factory.trace.push({ event: 'transaction-abort', mode: this.mode });
                this.onabort?.({ target: this }); this.db.queue.shift(); this.db.schedule();
            });
        }
        objectStore(name) {
            if (!this.names.includes(name)) throw new Error('NotFoundError');
            const tx = this, record = operation => factory.trace.push({ store: name, operation, mode: tx.mode });
            function cursor(indexName, wanted, keysOnly = false) {
                record(keysOnly ? 'key-cursor' : 'cursor');
                let values, position = 0;
                const request = {};
                const next = () => tx.enqueue(() => {
                    if (!values) values = [...tx.stores.get(name).entries()]
                        .filter(([, row]) => indexName === undefined || keyOf(row[indexName]) === keyOf(wanted));
                    const item = values[position++];
                    return item ? { primaryKey: JSON.parse(item[0]), ...(keysOnly ? {} : { value: copy(item[1]) }), continue: next } : null;
                }, request);
                next(); return request;
            }
            return {
                get(key) { record('get'); return tx.enqueue(() => copy(tx.stores.get(name).get(keyOf(key)))); },
                put(row) {
                    record('put'); return tx.enqueue(() => {
                        if (factory.failNextPut) { factory.failNextPut = false; const error = new Error('Isolated quota failure'); error.name = 'QuotaExceededError'; throw error; }
                        tx.stores.get(name).set(keyOf(row.key), copy(row)); return copy(row.key);
                    });
                },
                delete(key) { record('delete'); return tx.enqueue(() => tx.stores.get(name).delete(keyOf(key))); },
                openCursor() { return cursor(); },
                index(indexName) { return { openCursor: wanted => cursor(indexName, wanted), openKeyCursor: wanted => cursor(indexName, wanted, true) }; },
            };
        }
    }

    factory.open = name => {
        factory.openCount++;
        const request = {};
        defer(() => {
            if (factory.openError) { request.error = new Error('Isolated open failure'); request.onerror?.({ target: request }); return; }
            let db = databases.get(name), fresh = !db;
            if (!db) {
                db = { stores: new Map(), queue: [],
                    objectStoreNames: { contains: store => db.stores.has(store) },
                    createObjectStore(store) { db.stores.set(store, { rows: new Map() }); return { createIndex() {} }; },
                    transaction(names, mode, options) {
                        if (factory.strictUnsupported && options) throw new TypeError('Old WebView durability option');
                        factory.trace.push({ event: 'transaction', stores: names, mode, durability: options?.durability || null });
                        const gate = nextGate?.mode === mode || nextGate?.mode === undefined ? nextGate : null;
                        if (gate) nextGate = null;
                        return new Transaction(db, Array.isArray(names) ? names : [names], mode, gate);
                    },
                    close() { factory.closeCount++; },
                    schedule() { const tx = db.queue[0]; if (tx && !tx.active && !tx.finished) defer(() => { if (!tx.active && !tx.finished) tx.activate(); }); },
                };
                databases.set(name, db);
            }
            request.result = db;
            if (factory.blockNextOpen) { factory.blockNextOpen = false; request.onblocked?.({ target: request }); }
            if (fresh) request.onupgradeneeded?.({ target: request });
            request.onsuccess?.({ target: request });
        });
        return request;
    };
    return factory;
}
