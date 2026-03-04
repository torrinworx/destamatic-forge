import { OObject, OArray } from 'destam';
import { parse, stringify } from '../common/clone.js';
import {
	deepNormalize,
	normalizeQuery,
	extractEqConditions,
	getPathValue,
	deepEqual,
} from './dsl.js';

/**
 * Driver contract (single driver):
 *
 * Required:
 * - create({ collection, record }) -> record
 * - get({ collection, key }) -> record | false
 * - update({ collection, key, record, expectedRev? }) -> true
 * - remove({ collection, key }) -> true (throw/false on failure)
 * - queryOne({ collection, query }) -> record | false
 * - queryMany({ collection, query, options? }) -> record[]
 * - watch({ collection, key, onRecord }) -> stop()  (implement polling here if needed)
 *
 * Optional (advanced / "raw"):
 * - rawFindOne({ collection, filter, options? }) -> record | false
 * - rawFindMany({ collection, filter, options? }) -> record[]
 *
 * record shape (stored in DB; never returned to user):
 * {
 *   key: string,              // usually root observer UUID hex (ex: "#A1B2...")
 *   state_tree: object,       // from stringify()/parse()
 *   index: object,            // queryable projection (plain JSON)
 *   rev: number               // monotonically increasing revision
 * }
 */

const makeIndex = (state) => {
	const index = deepNormalize(JSON.parse(JSON.stringify(state)));

	index.id = keyFromState(state);

	// TODO, somehow we need to serialize createdAt and modifiedAt so that 
	// createdAt is stored. Then modifiedAt is stored but also updated every modification.
	// might look into extending clone.js?

	return index;
};

const keyFromState = (state) => {
	const id = state?.observer?.id;
	if (!id) throw new Error('ODB: state is missing observer.id');
	return typeof id.toHex === 'function' ? id.toHex() : String(id);
};

const isValidStateTree = (state) => {
	if (!(state instanceof OObject)) return 'root is not an OObject';

	const seen = new WeakSet();
	const stack = [state];
	while (stack.length) {
		const current = stack.pop();
		if (!current || typeof current !== 'object') continue;
		if (seen.has(current)) continue;
		seen.add(current);

		if (Array.isArray(current) && !(current instanceof OArray)) {
			return 'plain array found in state tree';
		}

		if (current instanceof OArray) {
			for (const item of current) stack.push(item);
			continue;
		}

		for (const k of Object.keys(current)) {
			stack.push(current[k]);
		}
	}

	return null;
};

const throttle = (fn, ms) => {
	let t = null;
	let pending = false;

	const run = async () => {
		t = null;
		pending = false;
		await fn();
		if (pending) schedule();
	};

	const schedule = () => {
		if (t) {
			pending = true;
			return;
		}
		t = setTimeout(run, ms);
	};

	schedule.flush = async () => {
		if (t) clearTimeout(t);
		t = null;
		pending = false;
		await fn();
	};

	schedule.cancel = () => {
		if (t) clearTimeout(t);
		t = null;
		pending = false;
	};

	return schedule;
};

// In-place sync so UI keeps the same object references
const obsKey = (v) => {
	const id = v?.observer?.id;
	return id?.toHex ? id.toHex() : null;
};

const syncInto = (dst, src) => {
	if (dst === src) return;

	// OObject
	if (dst instanceof OObject && src instanceof OObject) {
		for (const k of Object.keys(dst)) {
			if (!(k in src)) delete dst[k];
		}

		for (const k of Object.keys(src)) {
			const dv = dst[k];
			const sv = src[k];

			const dk = obsKey(dv);
			const sk = obsKey(sv);

			if (dk && sk && dk === sk) {
				// same observable identity, sync deeper
				if (dv instanceof OObject && sv instanceof OObject) syncInto(dv, sv);
				else if (dv instanceof OArray && sv instanceof OArray) syncInto(dv, sv);
				else dst[k] = sv;
			} else {
				dst[k] = sv;
			}
		}
		return;
	}

	// OArray
	if (dst instanceof OArray && src instanceof OArray) {
		const hasElementId = (el) => el instanceof OObject && (typeof el.id === 'string' || typeof el.id === 'number');
		const hasObsKey = (el) => !!obsKey(el);
		const anyElementId = dst.some(hasElementId) || src.some(hasElementId);
		const anyObsKey = dst.some(hasObsKey) || src.some(hasObsKey);
		if (anyElementId || anyObsKey) {
			const idMap = new Map();
			const obsMap = new Map();
			for (const el of dst) {
				if (hasElementId(el)) {
					idMap.set(el.id, el);
				}
				const key = obsKey(el);
				if (key) {
					let list = obsMap.get(key);
					if (!list) obsMap.set(key, (list = []));
					list.push(el);
				}
			}

			const takeObs = (key) => {
				const list = obsMap.get(key);
				if (!list || list.length === 0) return null;
				const el = list.shift();
				if (list.length === 0) obsMap.delete(key);
				return el;
			};

			const next = [];
			for (const sEl of src) {
				let existing = null;
				if (hasElementId(sEl)) {
					existing = idMap.get(sEl.id) || null;
				}
				if (!existing) {
					const key = obsKey(sEl);
					if (key) existing = takeObs(key);
				}

				if (existing) {
					syncInto(existing, sEl);
					next.push(existing);
				} else {
					next.push(sEl);
				}
			}

			dst.splice(0, dst.length, ...next);
			return;
		}

		// fallback: positional
		const min = Math.min(dst.length, src.length);
		for (let i = 0; i < min; i++) {
			const dv = dst[i];
			const sv = src[i];

			const dk = obsKey(dv);
			const sk = obsKey(sv);

			if (dk && sk && dk === sk) {
				if (dv instanceof OObject && sv instanceof OObject) syncInto(dv, sv);
				else if (dv instanceof OArray && sv instanceof OArray) syncInto(dv, sv);
				else dst[i] = sv;
			} else {
				dst[i] = sv;
			}
		}

		if (src.length > dst.length) dst.push(...src.slice(dst.length));
		else if (dst.length > src.length) dst.splice(src.length, dst.length - src.length);
	}
};

export const createODB = async ({ driver, throttleMs = 75, driverProps = {}, integrityMode } = {}) => {
	if (!driver) throw new Error('ODB: missing "driver"');

	const mode = integrityMode || (process.env.NODE_ENV === 'production' ? 'lenient' : 'strict');
	const isStrict = mode !== 'lenient';

	const d = typeof driver === 'function' ? await driver(driverProps) : driver;

	const required = ['create', 'get', 'update', 'remove', 'queryOne', 'queryMany', 'watch'];
	for (const name of required) {
		if (typeof d[name] !== 'function') {
			throw new Error(`ODB: driver is missing required method "${name}()"`);
		}
	}

	// cache: collection::key -> handle
	const cache = new Map();

	const cacheKey = (collection, key) => `${collection}::${key}`;

	const recordFromState = (state, { allowSkip = false } = {}) => {
		if (!(state instanceof OObject)) {
			throw new Error('ODB: only OObject documents are supported as roots.');
		}

		const invalid = isValidStateTree(state);
		if (invalid) {
			const err = new Error(`ODB: invalid state tree (${invalid})`);
			if (isStrict || !allowSkip) throw err;
			console.warn(err.message);
			return null;
		}

		const state_tree = JSON.parse(stringify(state));
		const key = keyFromState(state);
		const index = makeIndex(state);
		const rev = 0;

		return { key, state_tree, index, rev };
	};

	const stateFromRecord = (record, { allowSkip = false } = {}) => {
		const state = parse(JSON.stringify(record.state_tree));
		if (!(state instanceof OObject)) {
			const err = new Error('ODB: parsed document root is not an OObject.');
			if (isStrict || !allowSkip) throw err;
			console.warn(err.message);
			return null;
		}

		const invalid = isValidStateTree(state);
		if (invalid) {
			const err = new Error(`ODB: invalid state tree (${invalid})`);
			if (isStrict || !allowSkip) throw err;
			console.warn(err.message);
			return null;
		}
		return state;
	};

	const attachHandle = (state, handle) => {
		Object.defineProperty(state, '$odb', {
			enumerable: false,
			configurable: true,
			value: handle,
		});
	};

	const openFromRecord = async ({ collection, record }) => {
		const key = record.key || record.state_tree?.id;
		if (!key) throw new Error('ODB: record missing "key" (or state_tree.id)');

		const ckey = cacheKey(collection, key);
		const existing = cache.get(ckey);
		if (existing) {
			existing._refs++;
			return existing.state;
		}

		const state = stateFromRecord(record);

		const handle = {
			state,
			collection,
			key,
			rev: typeof record.rev === 'number' ? record.rev : 0,

			_refs: 1,
			_suppress: 0,
			_stopLocal: null,
			_stopRemote: null,
			_throttledSave: null,
			_saveLock: Promise.resolve(),

			flush: async () => handle._throttledSave.flush(),
			reload: async () => {
				const rec = await d.get({ collection, key: handle.key });
				if (!rec) return false;

				const next = stateFromRecord(rec, { allowSkip: !isStrict });
				if (!next) return false;
				if (typeof rec.rev === 'number' && rec.rev <= handle.rev) return true;
				handle._suppress++;
				try { syncInto(handle.state, next); }
				finally { handle._suppress--; }

				if (typeof rec.rev === 'number') handle.rev = rec.rev;

				return true;
			},

			dispose: async () => {
				handle._refs--;
				if (handle._refs > 0) return;

				cache.delete(ckey);

				try { handle._throttledSave?.cancel?.(); } catch { }
				try { handle._stopLocal?.(); } catch { }
				try { await handle._stopRemote?.(); } catch { }
			},

			remove: async () => {
				const ok = await d.remove({ collection, key: handle.key });
				if (!ok) throw new Error('ODB.remove: driver failed to remove document.');
				await handle.dispose();
				return true;
			},
		};

		// local -> db
		const saveNow = async () => {
			if (handle._suppress) return;

			const run = async () => {
				if (handle._suppress) return;

				for (let attempt = 0; attempt < 2; attempt++) {
					if (handle._suppress) return;

					const rec = recordFromState(handle.state, { allowSkip: !isStrict });
					if (!rec) return;
					rec.rev = handle.rev + 1;
					const ok = await d.update({ collection, key: handle.key, record: rec, expectedRev: handle.rev });
					if (ok) {
						handle.rev = rec.rev;
						return;
					}

					const err = new Error(`ODB: driver.update() conflict for key=${handle.key}`);
					if (attempt === 0) {
						try {
							const reloaded = await handle.reload();
							if (!reloaded) return;
							continue;
						} catch {
							// fall through to strict/lenient handling
						}
					}

					if (isStrict) throw err;
					console.warn(err.message);
					return;
				}
			};

			const result = handle._saveLock.then(run, run);
			handle._saveLock = result.catch(() => {});
			return result;
		};

		handle._throttledSave = throttle(saveNow, throttleMs);

		handle._stopLocal = state.observer.watch(() => {
			if (handle._suppress) return;
			handle._throttledSave();
		});

		// db -> local (live propagation)
		handle._stopRemote = await d.watch({
			collection,
			key: handle.key,
			onRecord: (rec) => {
				if (!rec) return; // treat as "deleted" if you want later
				if (typeof rec.rev === 'number' && rec.rev <= handle.rev) return;
				const next = stateFromRecord(rec, { allowSkip: !isStrict });
				if (!next) return;

				handle._suppress++;
				try { syncInto(handle.state, next); }
				finally { handle._suppress--; }

				if (typeof rec.rev === 'number') handle.rev = rec.rev;
			}
		});

		attachHandle(state, handle);
		cache.set(ckey, { state, ...handle });

		return state;
	};

const normalizeForCompare = (v) => deepNormalize(JSON.parse(JSON.stringify(v)));

const setPathValue = (root, path, value) => {
	const parts = path.split('.').filter(Boolean);
	if (!parts.length) throw new Error('ODB.open: query field path is invalid');

	let current = root;
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (Array.isArray(current)) {
			throw new Error('ODB.open: array paths are not supported in query fields');
		}
		if (i === parts.length - 1) {
			current[part] = value;
			return;
		}
		let next = current[part];
		if (next == null) {
			next = OObject({});
			current[part] = next;
		} else if (typeof next !== 'object') {
			throw new Error(`ODB.open: value.${parts.slice(0, i + 1).join('.')} is not an object`);
		}
		current = next;
	}
};

const ensureValueMatchesQuery = (value, query) => {
	if (!query) return value;

	const eqConditions = extractEqConditions(query.filter);
	if (!eqConditions) {
		throw new Error('ODB.open: query filter must be eq-only to create a document');
	}

	for (const { field, value: expected } of eqConditions) {
		const existing = getPathValue(value, field);
		if (existing === undefined) {
			setPathValue(value, field, expected);
			continue;
		}

		const a = normalizeForCompare(existing);
		const b = normalizeForCompare(expected);
		if (!deepEqual(a, b)) {
			throw new Error(`ODB.open: value.${field} does not match query.${field}`);
		}
	}

	return value;
};

	const open = async ({ collection, query = null, value = null } = {}) => {
		if (!collection) throw new Error('ODB.open: "collection" is required.');

		const normalizedQuery = query ? normalizeQuery(query) : null;

		// try find existing if query provided
		if (normalizedQuery) {
			const found = await d.queryOne({ collection, query: normalizedQuery });
			if (found) return openFromRecord({ collection, record: found });
		}

		// create new
		if (!value) value = OObject({});
		if (!(value instanceof OObject)) throw new Error('ODB.open: "value" must be an OObject.');

		value = ensureValueMatchesQuery(value, normalizedQuery);

		const rec = recordFromState(value, { allowSkip: !isStrict });
		if (!rec) throw new Error('ODB.open: invalid value (state tree)');
		const created = await d.create({ collection, record: rec });
		return openFromRecord({ collection, record: created });
	};

	const findOne = async ({ collection, query } = {}) => {
		if (!collection) throw new Error('ODB.findOne: "collection" is required.');
		if (!query) throw new Error('ODB.findOne: "query" is required.');

		const normalizedQuery = normalizeQuery(query);
		const rec = await d.queryOne({ collection, query: normalizedQuery });
		if (!rec) return false;
		return openFromRecord({ collection, record: rec });
	};

	const findMany = async ({ collection, query, options } = {}) => {
		if (!collection) throw new Error('ODB.findMany: "collection" is required.');
		if (!query) throw new Error('ODB.findMany: "query" is required.');
		if (options && Object.keys(options).length) {
			throw new Error('ODB.findMany: "options" is not supported; use query.sort/limit/skip');
		}

		const normalizedQuery = normalizeQuery(query);
		const recs = await d.queryMany({ collection, query: normalizedQuery });
		const out = [];
		for (const record of recs) {
			const doc = await openFromRecord({ collection, record }).catch(err => {
				if (isStrict) throw err;
				console.warn(err.message);
				return null;
			});
			if (doc) out.push(doc);
		}
		return out;
	};

	const remove = async ({ collection, query } = {}) => {
		if (!collection) throw new Error('ODB.remove: "collection" is required.');
		if (!query) throw new Error('ODB.remove: "query" is required.');

		const normalizedQuery = normalizeQuery(query);
		const rec = await d.queryOne({ collection, query: normalizedQuery });
		if (!rec) throw new Error('ODB.remove: document not found.');

		const key = rec.key || rec.state_tree?.id;
		const ok = await d.remove({ collection, key });
		if (!ok) throw new Error('ODB.remove: driver failed to remove document.');

		const ckey = cacheKey(collection, key);
		const existing = cache.get(ckey);
		if (existing?.state?.$odb) await existing.state.$odb.dispose();

		return true;
	};

	const close = async () => {
		// dispose all open docs
		for (const v of [...cache.values()]) {
			try { await v.state.$odb.dispose(); } catch { }
		}
		cache.clear();

		await d.close?.();
	};

	// db.driver.* (advanced), but still returns destam state
	const driverView = new Proxy(d, {
		get(target, prop) {
			if (prop === 'findOne') {
				return async ({ collection, filter, options } = {}) => {
					if (!target.rawFindOne) throw new Error('ODB.driver.findOne: driver.rawFindOne is not implemented');
					const rec = await target.rawFindOne({ collection, filter, options });
					if (!rec) return false;
					return openFromRecord({ collection, record: rec });
				};
			}

			if (prop === 'findMany') {
				return async ({ collection, filter, options } = {}) => {
					if (!target.rawFindMany) throw new Error('ODB.driver.findMany: driver.rawFindMany is not implemented');
					const recs = await target.rawFindMany({ collection, filter, options });
					return Promise.all(recs.map(record => openFromRecord({ collection, record })));
				};
			}

			return target[prop];
		}
	});

	return {
		open,
		findOne,
		findMany,
		remove,
		close,

		driver: driverView,
	};
};

export default createODB;
