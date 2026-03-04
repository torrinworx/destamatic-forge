import test from 'node:test';
import assert from 'node:assert/strict';

import { OObject, OArray, Observer } from 'destam';

import paginate from '../common/paginate.js';
import createODB from '../odb/index.js';
import memoryDriver from '../odb/drivers/memory.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, { timeout = 1500, interval = 5 } = {}) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (fn()) return;
		await sleep(interval);
	}
	throw new Error('waitFor: condition not met in time');
}

// decode the serialized destam tree that your ODB stores in state_tree
function decodeStateTree(st) {
	if (!st) return null;

	// plain object already
	if (st && typeof st === 'object' && !st.OBJECT_TYPE) return st;

	// observer_object shape: { OBJECT_TYPE:'observer_object', vals:[{name,val}, ...] }
	if (st.OBJECT_TYPE === 'observer_object' && Array.isArray(st.vals)) {
		const out = {};
		for (const { name, val } of st.vals) out[name] = val;
		return out;
	}

	// if you have other shapes (arrays, nested objects) add them here
	throw new Error('Unknown state_tree encoding: ' + JSON.stringify(st).slice(0, 200));
}

test('paginate + ODB(memory): follow/older/newer/cap', async () => {
	// IMPORTANT: share ONE memory driver instance
	const sharedDriver = await memoryDriver({ test: true });

	const odb = await createODB({
		driver: sharedDriver,
		throttleMs: 0,
	});

	const collection = 'messages';
	let n = 0;

	const makeMsg = () => {
		n++;
		const cursor = n;
		const id = `m_${String(n).padStart(4, '0')}`;
		return { id, key: id, cursor };
	};

	// seed 300
	for (let i = 0; i < 300; i++) {
		const msg = makeMsg();
		const doc = await odb.open({
			collection,
			query: { id: msg.id },
			value: OObject(msg),
		});
		await doc.$odb.flush();
		await doc.$odb.dispose();
	}

	async function queryAllChrono() {
		const recs = await sharedDriver.rawFindMany({ collection, filter: {} });

		const docs = recs
			.map(r => decodeStateTree(r.state_tree))
			.filter(Boolean)
			.map(d => ({ id: d.id, key: d.key ?? d.id, cursor: d.cursor }));

		docs.sort((a, b) => (a.cursor - b.cursor) || a.id.localeCompare(b.id));
		return docs;
	}

	const source = {
		tail: async (limit) => {
			const all = await queryAllChrono();
			return all.slice(Math.max(0, all.length - limit));
		},
		older: async (beforeTuple, limit) => {
			const all = await queryAllChrono();
			const idx = all.findIndex(r => r.id === beforeTuple.id);
			if (idx <= 0) return [];
			return all.slice(Math.max(0, idx - limit), idx);
		},
		newer: async (afterTuple, limit) => {
			const all = await queryAllChrono();
			const idx = all.findIndex(r => r.id === afterTuple.id);
			if (idx < 0) return [];
			return all.slice(idx + 1, idx + 1 + limit);
		},
	};

	const window = OArray([]);
	const page = OObject({
		follow: true,
		want: null,
		pageSize: 50,
		cap: 100,
		anchor: null,
	});

	const changes = Observer.mutable(0);

	const attached = new Set();
	const disposed = new Set();

	const stop = paginate({
		array: window,
		signal: page.observer,
		source,
		changes,
		throttle: 0,
		attach: async (record) => {
			attached.add(record.key);
			disposed.delete(record.key);
			return {
				item: record.key,
				dispose: async () => {
					disposed.add(record.key);
					attached.delete(record.key);
				},
			};
		},
	});

	// initial
	await waitFor(() => window.length === 50);
	assert.equal(window[0], 'm_0251');
	assert.equal(window[49], 'm_0300');

	// add one new
	{
		const msg = makeMsg(); // m_0301
		const doc = await odb.open({
			collection,
			query: { id: msg.id },
			value: OObject(msg),
		});
		await doc.$odb.flush();
		await doc.$odb.dispose();

		changes.set(changes.get() + 1);
	}

	await waitFor(() => window[window.length - 1] === 'm_0301');

	// add many, trim to cap
	page.pageSize = 500;
	for (let i = 0; i < 120; i++) {
		const msg = makeMsg();
		const doc = await odb.open({
			collection,
			query: { id: msg.id },
			value: OObject(msg),
		});
		await doc.$odb.flush();
		await doc.$odb.dispose();
	}
	changes.set(changes.get() + 1);

	await waitFor(() =>
		window.length === 100 &&
		window[0] === 'm_0322' &&
		window[99] === 'm_0421'
	);

	// older
	page.follow = false;
	page.pageSize = 50;
	page.want = { dir: 'older', seq: 1 };

	await waitFor(() =>
		window.length === 100 &&
		window[0] === 'm_0272' &&
		window[99] === 'm_0371'
	);

	// newer
	page.want = { dir: 'newer', seq: 2 };

	await waitFor(() =>
		window.length === 100 &&
		window[0] === 'm_0322' &&
		window[99] === 'm_0421'
	);

	assert.ok(disposed.size > 0);

	stop();
	await sleep(10);

	assert.equal(window.length, 0);
	assert.equal(attached.size, 0);

	await odb.close();
});