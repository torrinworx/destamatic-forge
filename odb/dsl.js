const MAX_IN_MEMORY_SCAN = 5000;

const isPlainObject = (v) =>
	v && typeof v === 'object' && (v.constructor === Object || Object.getPrototypeOf(v) === null);

const isUUIDLike = (v) =>
	v && typeof v === 'object' && typeof v.toHex === 'function' && v.buffer instanceof Int32Array;

const normalizeIndexValue = (v) => {
	if (isUUIDLike(v)) return v.toHex();
	if (v instanceof Date) return +v;
	return v;
};

const deepNormalize = (v) => {
	v = normalizeIndexValue(v);

	if (Array.isArray(v)) return v.map(deepNormalize);
	if (isPlainObject(v)) {
		const out = {};
		for (const k of Object.keys(v)) out[k] = deepNormalize(v[k]);
		return out;
	}
	return v;
};

const FILTER_OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'exists']);

const normalizeSort = (sort) => {
	if (!Array.isArray(sort)) throw new Error('ODB query.sort must be an array');
	if (sort.length === 0) throw new Error('ODB query.sort must not be empty');

	return sort.map((entry) => {
		if (!isPlainObject(entry)) throw new Error('ODB query.sort entries must be objects');
		const field = entry.field;
		if (!field || typeof field !== 'string') throw new Error('ODB query.sort entry.field must be a string');

		let dir = entry.dir ?? entry.direction ?? 'asc';
		if (typeof dir === 'string') {
			const lower = dir.toLowerCase();
			if (lower === 'asc' || lower === 'ascending') dir = 1;
			else if (lower === 'desc' || lower === 'descending') dir = -1;
			else throw new Error('ODB query.sort entry.dir must be "asc" or "desc"');
		} else if (dir === 1 || dir === -1) {
			// ok
		} else {
			throw new Error('ODB query.sort entry.dir must be 1 or -1');
		}

		return { field, dir };
	});
};

const normalizeFilter = (filter) => {
	if (!isPlainObject(filter)) throw new Error('ODB query.filter must be an object');

	if ('and' in filter) {
		const keys = Object.keys(filter);
		if (keys.length !== 1) throw new Error('ODB query.filter.and cannot mix with other keys');
		if (!Array.isArray(filter.and) || filter.and.length === 0) {
			throw new Error('ODB query.filter.and must be a non-empty array');
		}
		return { and: filter.and.map(normalizeFilter) };
	}

	if ('or' in filter) {
		const keys = Object.keys(filter);
		if (keys.length !== 1) throw new Error('ODB query.filter.or cannot mix with other keys');
		if (!Array.isArray(filter.or) || filter.or.length === 0) {
			throw new Error('ODB query.filter.or must be a non-empty array');
		}
		return { or: filter.or.map(normalizeFilter) };
	}

	if ('not' in filter) {
		const keys = Object.keys(filter);
		if (keys.length !== 1) throw new Error('ODB query.filter.not cannot mix with other keys');
		return { not: normalizeFilter(filter.not) };
	}

	const keys = Object.keys(filter);
	if (!('field' in filter) || !('op' in filter)) {
		throw new Error('ODB query.filter requires "field" and "op"');
	}
	if (keys.some((k) => !['field', 'op', 'value'].includes(k))) {
		throw new Error('ODB query.filter contains invalid keys');
	}

	const field = filter.field;
	if (!field || typeof field !== 'string') throw new Error('ODB query.filter.field must be a string');

	const op = filter.op;
	if (!FILTER_OPS.has(op)) throw new Error(`ODB query.filter.op must be one of: ${[...FILTER_OPS].join(', ')}`);

	if (op === 'exists') {
		const value = 'value' in filter ? !!filter.value : true;
		return { field, op, value };
	}

	if (!('value' in filter)) throw new Error(`ODB query.filter.value is required for op="${op}"`);
	const value = op === 'in' || op === 'nin'
		? (Array.isArray(filter.value) ? filter.value.map(deepNormalize) : null)
		: deepNormalize(filter.value);

	if ((op === 'in' || op === 'nin') && !Array.isArray(value)) {
		throw new Error(`ODB query.filter.value must be an array for op="${op}"`);
	}

	return { field, op, value };
};

const normalizeQuery = (query, { allowEmpty = false } = {}) => {
	if (query == null) {
		if (allowEmpty) return null;
		throw new Error('ODB query is required');
	}
	if (!isPlainObject(query)) throw new Error('ODB query must be an object');

	const { filter } = query;
	if (!filter) {
		if (allowEmpty) return null;
		throw new Error('ODB query.filter is required');
	}

	const normalized = { filter: normalizeFilter(filter) };

	if ('sort' in query) normalized.sort = normalizeSort(query.sort);
	if ('limit' in query) {
		const limit = query.limit;
		if (!Number.isFinite(limit) || limit < 0) throw new Error('ODB query.limit must be a non-negative number');
		normalized.limit = Math.floor(limit);
	}
	if ('skip' in query) {
		const skip = query.skip;
		if (!Number.isFinite(skip) || skip < 0) throw new Error('ODB query.skip must be a non-negative number');
		normalized.skip = Math.floor(skip);
	}

	if ((normalized.limit != null || normalized.skip != null) && !normalized.sort) {
		throw new Error('ODB query.limit/skip requires query.sort');
	}

	return normalized;
};

const extractEqConditions = (filter) => {
	if (!filter) return null;
	if (filter.and) {
		const out = [];
		for (const entry of filter.and) {
			const next = extractEqConditions(entry);
			if (!next) return null;
			out.push(...next);
		}
		return out;
	}
	if (filter.or || filter.not) return null;
	if (filter.op !== 'eq') return null;
	return [{ field: filter.field, value: filter.value }];
};

const getPathValue = (obj, path) => {
	const parts = path.split('.');
	let cur = obj;
	for (const part of parts) {
		if (cur == null) return undefined;
		if (Array.isArray(cur) && /^\d+$/.test(part)) {
			cur = cur[Number(part)];
		} else {
			cur = cur[part];
		}
	}
	return cur;
};

const deepEqual = (a, b) => {
	if (a === b) return true;
	if (a == null || b == null) return a === b;

	if (Array.isArray(a)) {
		if (!Array.isArray(b) || a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
		return true;
	}

	if (isPlainObject(a)) {
		if (!isPlainObject(b)) return false;
		const keys = Object.keys(a);
		if (keys.length !== Object.keys(b).length) return false;
		for (const k of keys) if (!deepEqual(a[k], b[k])) return false;
		return true;
	}

	return Object.is(a, b);
};

const matchFilter = (obj, filter) => {
	if (!filter) return true;
	if (filter.and) return filter.and.every((entry) => matchFilter(obj, entry));
	if (filter.or) return filter.or.some((entry) => matchFilter(obj, entry));
	if (filter.not) return !matchFilter(obj, filter.not);

	const value = getPathValue(obj, filter.field);
	const expected = filter.value;

	switch (filter.op) {
		case 'eq':
			return deepEqual(value, expected);
		case 'neq':
			return !deepEqual(value, expected);
		case 'gt':
			return value != null && value > expected;
		case 'gte':
			return value != null && value >= expected;
		case 'lt':
			return value != null && value < expected;
		case 'lte':
			return value != null && value <= expected;
		case 'in':
			return Array.isArray(expected) && expected.some((entry) => deepEqual(value, entry));
		case 'nin':
			return Array.isArray(expected) && expected.every((entry) => !deepEqual(value, entry));
		case 'exists':
			return expected ? value !== undefined : value === undefined;
		default:
			return false;
	}
};

const compareValues = (a, b) => {
	if (a === b) return 0;
	if (a == null) return -1;
	if (b == null) return 1;

	if (typeof a === 'number' && typeof b === 'number') return a - b;
	if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
	if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : (a ? 1 : -1);

	const sa = JSON.stringify(a);
	const sb = JSON.stringify(b);
	if (sa === sb) return 0;
	return sa < sb ? -1 : 1;
};

const compareBySort = (a, b, sort) => {
	for (const entry of sort || []) {
		const av = getPathValue(a, entry.field);
		const bv = getPathValue(b, entry.field);
		const diff = compareValues(av, bv);
		if (diff !== 0) return diff * entry.dir;
	}
	return 0;
};

const buildMongoFilter = (filter, { prefix = 'index' } = {}) => {
	if (!filter) return {};
	if (filter.and) return { $and: filter.and.map((entry) => buildMongoFilter(entry, { prefix })) };
	if (filter.or) return { $or: filter.or.map((entry) => buildMongoFilter(entry, { prefix })) };
	if (filter.not) return { $nor: [buildMongoFilter(filter.not, { prefix })] };

	const path = prefix ? `${prefix}.${filter.field}` : filter.field;
	const value = filter.value;

	switch (filter.op) {
		case 'eq':
			return { [path]: value };
		case 'neq':
			return { [path]: { $ne: value } };
		case 'gt':
			return { [path]: { $gt: value } };
		case 'gte':
			return { [path]: { $gte: value } };
		case 'lt':
			return { [path]: { $lt: value } };
		case 'lte':
			return { [path]: { $lte: value } };
		case 'in':
			return { [path]: { $in: value } };
		case 'nin':
			return { [path]: { $nin: value } };
		case 'exists':
			return { [path]: { $exists: !!value } };
		default:
			return {};
	}
};

const buildMongoSort = (sort, { prefix = 'index' } = {}) => {
	if (!sort) return undefined;
	const out = {};
	for (const entry of sort) {
		const path = prefix ? `${prefix}.${entry.field}` : entry.field;
		out[path] = entry.dir;
	}
	return out;
};

export {
	MAX_IN_MEMORY_SCAN,
	isPlainObject,
	isUUIDLike,
	normalizeIndexValue,
	deepNormalize,
	normalizeFilter,
	normalizeQuery,
	extractEqConditions,
	getPathValue,
	deepEqual,
	matchFilter,
	compareBySort,
	buildMongoFilter,
	buildMongoSort,
};
