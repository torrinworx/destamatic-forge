// drivers/memory.js

import { MAX_IN_MEMORY_SCAN, matchFilter, compareBySort } from '../dsl.js';

const clone = (v) => {
	// state_tree + index should be JSON-safe already
	return v == null ? v : JSON.parse(JSON.stringify(v));
};

const isPlainObject = v =>
	v && typeof v === 'object' && (v.constructor === Object || Object.getPrototypeOf(v) === null);

const deepMatch = (obj, query) => {
	// query is a "partial" deep match:
	// - primitives: strict equality
	// - arrays: strict length + deep equality (simple)
	// - objects: each key in query must match in obj
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

const applyQuery = (col, query, { stopAfterFirst = false } = {}) => {
	if (!query?.filter) throw new Error('memoryDriver.query: missing query.filter');

	const matches = [];
	const limit = query.limit ?? Infinity;
	const skip = query.skip ?? 0;
	const hasSort = Array.isArray(query.sort) && query.sort.length > 0;

	let scanned = 0;
	for (const key of col.order) {
		scanned += 1;
		if (scanned > MAX_IN_MEMORY_SCAN) {
			throw new Error(`ODB query exceeded in-memory scan limit (${MAX_IN_MEMORY_SCAN})`);
		}

		const rec = col.docs.get(key);
		if (!rec) continue;
		if (matchFilter(rec.index, query.filter)) {
			matches.push(clone(rec));
			if (!hasSort && (stopAfterFirst || matches.length >= skip + limit)) break;
		}
	}

	if (hasSort) {
		matches.sort((a, b) => compareBySort(a.index, b.index, query.sort));
	}

	if (skip || limit !== Infinity) return matches.slice(skip, skip + limit);
	return matches;
};

const getCollection = (collections, name) => {
	let col = collections.get(name);
	if (!col) {
		col = {
			docs: new Map(),  // key -> record
			order: [],        // insertion order of keys
		};
		collections.set(name, col);
	}
	return col;
};

const getWatchSet = (watchers, collection, key) => {
	let c = watchers.get(collection);
	if (!c) watchers.set(collection, c = new Map());

	let set = c.get(key);
	if (!set) c.set(key, set = new Set());

	return set;
};

const emit = (watchers, collection, key, recordOrNull) => {
	const c = watchers.get(collection);
	const set = c?.get(key);
	if (!set || set.size === 0) return;

	const payload = recordOrNull ? clone(recordOrNull) : null;
	for (const cb of [...set]) {
		try { cb(payload); } catch (e) { /* swallow watcher errors */ }
	}
};

export default async function memoryDriver(/* props */) {
	const collections = new Map();
	const watchers = new Map();

	const api = {
		async create({ collection, record }) {
			if (!collection) throw new Error('memoryDriver.create: missing collection');
			if (!record || !record.key) throw new Error('memoryDriver.create: record.key required');

			const col = getCollection(collections, collection);
			if (col.docs.has(record.key)) {
				throw new Error(`memoryDriver.create: duplicate key "${record.key}" in collection "${collection}"`);
			}

			const stored = clone({ ...record, rev: typeof record.rev === 'number' ? record.rev : 0 });
			col.docs.set(record.key, stored);
			col.order.push(record.key);

			emit(watchers, collection, record.key, stored);
			return clone(stored);
		},

		async get({ collection, key }) {
			const col = getCollection(collections, collection);
			const rec = col.docs.get(key);
			return rec ? clone(rec) : false;
		},

		async update({ collection, key, record, expectedRev }) {
			const col = getCollection(collections, collection);
			const existing = col.docs.get(key);
			if (!existing) return false;

			if (typeof expectedRev === 'number') {
				const hasRev = typeof existing.rev === 'number';
				if (hasRev) {
					if (existing.rev !== expectedRev) return false;
				} else if (expectedRev !== 0) {
					return false;
				}
			}

			const stored = clone({ ...record, key, rev: record.rev });
			col.docs.set(key, stored);

			emit(watchers, collection, key, stored);
			return true;
		},

		async remove({ collection, key }) {
			const col = getCollection(collections, collection);
			const existed = col.docs.delete(key);
			if (!existed) return false;

			// keep order list simple: remove key (O(n), fine for tests)
			const i = col.order.indexOf(key);
			if (i >= 0) col.order.splice(i, 1);

			emit(watchers, collection, key, null);
			return true;
		},

		async queryOne({ collection, query }) {
			const col = getCollection(collections, collection);
			const out = applyQuery(col, query, { stopAfterFirst: true });
			return out[0] || false;
		},

		async queryMany({ collection, query }) {
			const col = getCollection(collections, collection);
			return applyQuery(col, query);
		},

		async watch({ collection, key, onRecord }) {
			if (typeof onRecord !== 'function') {
				throw new Error('memoryDriver.watch: onRecord must be a function');
			}

			const set = getWatchSet(watchers, collection, key);
			set.add(onRecord);

			// Optional: immediately send current record (handy in tests)
			// const col = getCollection(collections, collection);
			// const current = col.docs.get(key);
			// if (current) onRecord(clone(current));

			return () => {
				set.delete(onRecord);
				if (set.size === 0) {
					const c = watchers.get(collection);
					c?.delete(key);
					if (c && c.size === 0) watchers.delete(collection);
				}
			};
		},

		// "raw" helpers (return records)
		async rawFindOne({ collection, filter }) {
			const col = getCollection(collections, collection);

			const pred = typeof filter === 'function'
				? filter
				: (rec) => deepMatch(rec.index, filter || {});

			for (const key of col.order) {
				const rec = col.docs.get(key);
				if (rec && pred(clone(rec))) return clone(rec);
			}

			return false;
		},

		async rawFindMany({ collection, filter, options }) {
			const col = getCollection(collections, collection);

			const pred = typeof filter === 'function'
				? filter
				: (rec) => deepMatch(rec.index, filter || {});

			const out = [];
			const limit = options?.limit ?? Infinity;

			for (const key of col.order) {
				const rec = col.docs.get(key);
				if (rec && pred(clone(rec))) {
					out.push(clone(rec));
					if (out.length >= limit) break;
				}
			}

			return out;
		},

		async close() {
			collections.clear();
			watchers.clear();
		},
	};

	return api;
}
