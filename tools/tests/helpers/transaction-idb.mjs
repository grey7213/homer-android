// Deliberately small transaction test double, not a claim of browser conformance.
// Actual Chromium IndexedDB is exercised separately by mobile_r35_outbox_idb.py.
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const keyOf = key => JSON.stringify(key);
const defer = callback => setImmediate(callback);

export function transactionIDB() {
    const databases = new Map();
    const factory = { trace: [], failNextPut: false, strictUnsupported: false, openError: false };
    let nextGate = null;
    factory.holdNextCommit = () => {
        let reached, release;
        const control = { reached: new Promise(resolve => { reached = resolve; }) };
        control.release = () => release?.();
        nextGate = { reached, wait: new Promise(resolve => { release = resolve; }) };
        return control;
    };
    factory.dump = name => [...(databases.get(name)?.rows.values() || [])].map(copy);

    class Transaction {
        constructor(db, mode, gate) {
            this.db = db; this.mode = mode; this.gate = gate;
            this.requests = []; this.finished = false; this.active = false;
            db.queue.push(this); db.schedule();
        }
        activate() {
            this.active = true; this.rows = new Map([...this.db.rows].map(([key, value]) => [key, copy(value)]));
            this.advance();
        }
        enqueue(fn, existing) {
            if (this.finished) throw new Error('TransactionInactiveError');
            const request = existing || {};
            this.requests.push({ request, fn });
            return request;
        }
        advance() {
            defer(() => {
                if (this.finished) return;
                const task = this.requests.shift();
                if (!task) { this.complete(); return; }
                try {
                    task.request.result = task.fn();
                    factory.trace.push('request-success');
                    task.request.onsuccess?.({ target: task.request });
                } catch (error) {
                    task.request.error = error; this.error = error;
                    task.request.onerror?.({ target: task.request });
                    this.onerror?.({ target: task.request });
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
                if (this.mode === 'readwrite') this.db.rows = this.rows;
                factory.trace.push('transaction-complete');
                this.oncomplete?.({ target: this });
                this.db.queue.shift(); this.db.schedule();
            };
            if (this.gate) {
                const gate = this.gate; this.gate = null;
                gate.reached(this);
                gate.wait.then(() => defer(finish));
            } else finish();
        }
        abort() {
            if (this.finished) throw new Error('TransactionInactiveError');
            this.finished = true;
            defer(() => {
                factory.trace.push('transaction-abort');
                this.onabort?.({ target: this });
                this.db.queue.shift(); this.db.schedule();
            });
        }
        objectStore() {
            const tx = this;
            return {
                get(key) { return tx.enqueue(() => copy(tx.rows.get(keyOf(key)))); },
                put(value) {
                    return tx.enqueue(() => {
                        if (factory.failNextPut) {
                            factory.failNextPut = false;
                            const error = new Error('Test quota exceeded'); error.name = 'QuotaExceededError'; throw error;
                        }
                        tx.rows.set(keyOf(value.key), copy(value)); return copy(value.key);
                    });
                },
                delete(key) { return tx.enqueue(() => { tx.rows.delete(keyOf(key)); }); },
                index(indexName) {
                    return { openCursor(wanted) {
                        let values, position = 0;
                        const request = {};
                        const next = () => tx.enqueue(() => {
                            if (!values) values = [...tx.rows.values()].filter(row => keyOf(row[indexName]) === keyOf(wanted)).map(copy);
                            const value = values[position++];
                            return value ? { value, continue: next } : null;
                        }, request);
                        next(); return request;
                    } };
                },
            };
        }
    }

    factory.open = name => {
        const request = {};
        defer(() => {
            if (factory.openError) {
                request.error = new Error('Test IndexedDB open failure');
                request.onerror?.({ target: request }); return;
            }
            let db = databases.get(name), fresh = !db;
            if (!db) {
                db = {
                    rows: new Map(), queue: [], running: false, stores: new Set(),
                    objectStoreNames: { contains: value => db.stores.has(value) },
                    createObjectStore(storeName) { db.stores.add(storeName); return { createIndex() {} }; },
                    transaction(store, mode, options) {
                        if (options && factory.strictUnsupported) throw new TypeError('Old WebView durability option');
                        const gate = nextGate; nextGate = null;
                        return new Transaction(db, mode, gate);
                    },
                    close() {},
                    schedule() {
                        if (!db.queue.length) return;
                        const tx = db.queue[0];
                        if (!tx.active && !tx.finished) defer(() => { if (!tx.active && !tx.finished) tx.activate(); });
                    },
                };
                databases.set(name, db);
            }
            request.result = db;
            if (fresh) request.onupgradeneeded?.({ target: request });
            request.onsuccess?.({ target: request });
        });
        return request;
    };
    return factory;
}
