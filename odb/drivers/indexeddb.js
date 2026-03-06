// drivers/indexeddb.js

import { MAX_IN_MEMORY_SCAN, matchFilter, compareBySort } from '../dsl.js';

const isPlainObject = v =>
	v && typeof v === 'object' && (v.constructor === Object || Object.getPrototypeOf(v) === null);

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

const deepMatch = (obj, query) => {
	if (query === obj) return true;
	if (query == null || obj == null) return query === obj;

	if (Array.isArray(query)) {
		if (!Array.isArray(obj)) return false;
		if (obj.length !== query.length) return false;
		for (let i = 0; i < query.length; i++) {
			if (!deepMatch(obj[i], query[i])) return false;
		}
		return true;
	}

	if (isPlainObject(query)) {
		if (!isPlainObject(obj)) return false;
		for (const k of Object.keys(query)) {
			if (!(k in obj)) return false;
			if (!deepMatch(obj[k], query[k])) return false;
		}
		return true;
	}

	return Object.is(obj, query);
};

const reqToPromise = (req) =>
	new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
	});

const txDone = (tx) =>
	new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve(true);
		tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
		tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
	});

export default async function indexeddbDriver({
	dbName = 'webcore',
	test = false,

	// cross-tab live updates
	broadcast = true,
	channelName = `odb:${dbName}`,
} = {}) {
	if (test) {
		try {
			await import(/* @vite-ignore */ 'fake-indexeddb/auto');
		} catch (error) {
			throw new Error('indexeddbDriver: missing fake-indexeddb; install dev dependency or disable test mode.');
		}
	}

	// cache one db connection
	let db = null;
	let opening = null;

	const watchers = new Map(); // `${collection}::${key}` -> Set<cb>

	const bc =
		broadcast && typeof BroadcastChannel !== 'undefined'
			? new BroadcastChannel(channelName)
			: null;

	const emitLocal = (collection, key, recordOrNull) => {
		const set = watchers.get(`${collection}::${key}`);
		if (!set || set.size === 0) return;

		const payload = recordOrNull ? clone(recordOrNull) : null;
		for (const cb of [...set]) {
			try { cb(payload); } catch { /* swallow */ }
		}
	};

	const emit = (collection, key, recordOrNull) => {
		// in-tab
		emitLocal(collection, key, recordOrNull);

		// cross-tab
		if (bc) {
			try {
				bc.postMessage({
					t: 'odb:record',
					collection,
					key,
					record: recordOrNull ? clone(recordOrNull) : null,
				});
			} catch { /* ignore */ }
		}
	};

	if (bc) {
		bc.onmessage = (e) => {
			const msg = e?.data;
			if (!msg || msg.t !== 'odb:record') return;
			emitLocal(msg.collection, msg.key, msg.record || null);
		};
	}

	const openDB = async () => {
		if (db) return db;
		if (opening) return opening;

		opening = new Promise((resolve, reject) => {
			const req = indexedDB.open(dbName);

			req.onupgradeneeded = () => {
				// no-op: we create stores on demand in ensureStore()
			};

			req.onsuccess = () => {
				db = req.result;

				// if another tab upgrades the db, this connection becomes stale
				db.onversionchange = () => {
					try { db.close(); } catch { }
					db = null;
				};

				resolve(db);
			};

			req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
		});

		try {
			return await opening;
		} finally {
			opening = null;
		}
	};

	const ensureStore = async (collection) => {
		const current = await openDB();
		if (current.objectStoreNames.contains(collection)) return current;

		// Need a version bump to add a store.
		// We'll close and reopen with version+1. If we race with another tab,
		// we retry by opening again at latest version.
		const bumpAndCreate = async () =>
			new Promise((resolve, reject) => {
				const nextVersion = current.version + 1;

				try { current.close(); } catch { }
				db = null;

				const req = indexedDB.open(dbName, nextVersion);

				req.onupgradeneeded = () => {
					const up = req.result;
					if (!up.objectStoreNames.contains(collection)) {
						up.createObjectStore(collection, { keyPath: 'key' });
					}
				};

				req.onsuccess = () => {
					db = req.result;
					db.onversionchange = () => {
						try { db.close(); } catch { }
						db = null;
					};
					resolve(db);
				};

				req.onerror = () => {
					// VersionError can happen if another tab upgraded first.
					reject(req.error || new Error('Failed to upgrade IndexedDB'));
				};
			});

		try {
			return await bumpAndCreate();
		} catch (e) {
			// Retry once by reopening at latest version (common multi-tab race)
			const latest = await openDB();
			if (!latest.objectStoreNames.contains(collection)) throw e;
			return latest;
		}
	};

	const withStore = async (collection, mode, fn) => {
		const d = await ensureStore(collection);
		const tx = d.transaction([collection], mode);
		const store = tx.objectStore(collection);
		const result = await fn(store, tx);
		await txDone(tx);
		return result;
	};

	const scanMatches = async (collection, query, { stopAfterFirst = false } = {}) => {
		if (!query?.filter) throw new Error('indexeddbDriver.query: missing query.filter');

		const d = await openDB();
		if (!d.objectStoreNames.contains(collection)) return [];

		const tx = d.transaction([collection], 'readonly');
		const store = tx.objectStore(collection);

		const matches = await new Promise((resolve, reject) => {
			const res = [];
			let scanned = 0;
			const req = store.openCursor();
			req.onerror = () => reject(req.error || new Error('IndexedDB cursor error'));
			req.onsuccess = () => {
				const cursor = req.result;
				if (!cursor) return resolve(res);
				const rec = cursor.value;
				scanned += 1;
				if (scanned > MAX_IN_MEMORY_SCAN) {
					return reject(new Error(`ODB query exceeded in-memory scan limit (${MAX_IN_MEMORY_SCAN})`));
				}
				if (matchFilter(rec?.index, query.filter)) {
					res.push(clone(rec));
					if (stopAfterFirst) return resolve(res);
				}
				cursor.continue();
			};
		});

		await txDone(tx);
		return matches;
	};

	const api = {
		async create({ collection, record }) {
			if (!collection) throw new Error('indexeddbDriver.create: missing collection');
			if (!record?.key) throw new Error('indexeddbDriver.create: record.key required');

			const stored = clone({ ...record, rev: typeof record.rev === 'number' ? record.rev : 0 });

			await withStore(collection, 'readwrite', async (store) => {
				// add will fail if key exists (ConstraintError) -> fine
				await reqToPromise(store.add(stored));
			});

			emit(collection, record.key, stored);
			return clone(stored);
		},

		async get({ collection, key }) {
			if (!collection) throw new Error('indexeddbDriver.get: missing collection');
			if (!key) throw new Error('indexeddbDriver.get: missing key');

			const d = await openDB();
			if (!d.objectStoreNames.contains(collection)) return false;

			const tx = d.transaction([collection], 'readonly');
			const store = tx.objectStore(collection);
			const rec = await reqToPromise(store.get(key));
			await txDone(tx);

			return rec ? clone(rec) : false;
		},

		async update({ collection, key, record, expectedRev }) {
			if (!collection) throw new Error('indexeddbDriver.update: missing collection');
			if (!key) throw new Error('indexeddbDriver.update: missing key');

			const stored = clone({ ...record, key, rev: record.rev });

			const ok = await withStore(collection, 'readwrite', async (store) => {
				const existing = await reqToPromise(store.get(key));
				if (!existing) return false;
				if (typeof expectedRev === 'number') {
					const hasRev = typeof existing.rev === 'number';
					if (hasRev) {
						if (existing.rev !== expectedRev) return false;
					} else if (expectedRev !== 0) {
						return false;
					}
				}
				await reqToPromise(store.put(stored));
				return true;
			});

			if (ok) emit(collection, key, stored);
			return ok;
		},

		async remove({ collection, key }) {
			if (!collection) throw new Error('indexeddbDriver.remove: missing collection');
			if (!key) throw new Error('indexeddbDriver.remove: missing key');

			const d = await openDB();
			if (!d.objectStoreNames.contains(collection)) return false;

			const ok = await withStore(collection, 'readwrite', async (store) => {
				const existing = await reqToPromise(store.get(key));
				if (!existing) return false;
				await reqToPromise(store.delete(key));
				return true;
			});

			if (ok) emit(collection, key, null);
			return ok;
		},

		async queryOne({ collection, query }) {
			if (!collection) throw new Error('indexeddbDriver.queryOne: missing collection');
			if (!query?.filter) throw new Error('indexeddbDriver.queryOne: query.filter required');

			const stopAfterFirst = !(query.sort?.length);
			const matches = await scanMatches(collection, query, { stopAfterFirst });
			if (!matches.length) return false;
			if (query.sort?.length) {
				matches.sort((a, b) => compareBySort(a.index, b.index, query.sort));
			}
			return matches[0] || false;
		},

		async queryMany({ collection, query }) {
			if (!collection) throw new Error('indexeddbDriver.queryMany: missing collection');
			if (!query?.filter) throw new Error('indexeddbDriver.queryMany: query.filter required');

			const matches = await scanMatches(collection, query);
			if (query.sort?.length) {
				matches.sort((a, b) => compareBySort(a.index, b.index, query.sort));
			}

			const limit = query.limit ?? Infinity;
			const skip = query.skip ?? 0;
			if (skip || limit !== Infinity) return matches.slice(skip, skip + limit);
			return matches;
		},

		async watch({ collection, key, onRecord }) {
			if (!collection) throw new Error('indexeddbDriver.watch: missing collection');
			if (!key) throw new Error('indexeddbDriver.watch: missing key');
			if (typeof onRecord !== 'function') {
				throw new Error('indexeddbDriver.watch: onRecord must be a function');
			}

			const wkey = `${collection}::${key}`;
			let set = watchers.get(wkey);
			if (!set) watchers.set(wkey, (set = new Set()));
			set.add(onRecord);

			return () => {
				set.delete(onRecord);
				if (set.size === 0) watchers.delete(wkey);
			};
		},

		// Optional "raw" helpers:
		async rawFindOne({ collection, filter /* function or object */, options }) {
			const pred =
				typeof filter === 'function'
					? filter
					: (rec) => deepMatch(rec?.index, filter || {});

			const d = await openDB();
			if (!d.objectStoreNames.contains(collection)) return false;

			const tx = d.transaction([collection], 'readonly');
			const store = tx.objectStore(collection);

			const out = await new Promise((resolve, reject) => {
				const req = store.openCursor();
				req.onerror = () => reject(req.error || new Error('IndexedDB cursor error'));
				req.onsuccess = () => {
					const cursor = req.result;
					if (!cursor) return resolve(false);
					const v = cursor.value;
					if (pred(clone(v))) return resolve(clone(v));
					cursor.continue();
				};
			});

			await txDone(tx);
			return out;
		},

		async rawFindMany({ collection, filter, options }) {
			const pred =
				typeof filter === 'function'
					? filter
					: (rec) => deepMatch(rec?.index, filter || {});

			const limit = options?.limit ?? Infinity;

			const d = await openDB();
			if (!d.objectStoreNames.contains(collection)) return [];

			const tx = d.transaction([collection], 'readonly');
			const store = tx.objectStore(collection);

			const out = await new Promise((resolve, reject) => {
				const res = [];
				const req = store.openCursor();
				req.onerror = () => reject(req.error || new Error('IndexedDB cursor error'));
				req.onsuccess = () => {
					const cursor = req.result;
					if (!cursor) return resolve(res);
					const v = cursor.value;
					if (pred(clone(v))) {
						res.push(clone(v));
						if (res.length >= limit) return resolve(res);
					}
					cursor.continue();
				};
			});

			await txDone(tx);
			return out;
		},

		async close() {
			watchers.clear();
			try { if (bc) bc.close(); } catch { }
			try { if (db) db.close(); } catch { }
			db = null;
		},
	};

	return api;
}
