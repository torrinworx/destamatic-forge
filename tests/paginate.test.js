import test from 'node:test';
import assert from 'node:assert/strict';

import { OObject, OArray, Observer } from 'destam';
import paginate from '../common/paginate.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, { timeout = 500, interval = 5 } = {}) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (fn()) return;
		await sleep(interval);
	}
	throw new Error('waitFor: condition not met in time');
}

// In-memory chronological message store (oldest -> newest)
function makeStore(count = 300) {
	let n = 0;
	const rows = [];

	const push = (extra = {}) => {
		n++;
		const createdAt = n; // monotonic cursor
		const id = `m_${String(n).padStart(4, '0')}`;
		const rec = { key: id, id, cursor: createdAt, ...extra };
		rows.push(rec);
		return rec;
	};

	for (let i = 0; i < count; i++) push();

	const findIndexById = (id) => rows.findIndex(r => r.id === id);

	// NOTE: Always return results oldest -> newest
	const source = {
		tail: async (limit) => rows.slice(Math.max(0, rows.length - limit)),
		older: async (beforeTuple, limit) => {
			const idx = findIndexById(beforeTuple.id);
			if (idx <= 0) return [];
			const start = Math.max(0, idx - limit);
			return rows.slice(start, idx);
		},
		newer: async (afterTuple, limit) => {
			const idx = findIndexById(afterTuple.id);
			if (idx < 0) return [];
			return rows.slice(idx + 1, idx + 1 + limit);
		},
	};

	return { rows, push, source };
}

test('paginate: follow appends newest + cap trims oldest; scroll older/newer trims opposite side', async () => {
	const { push, source } = makeStore(300);

	const window = OArray([]);
	const page = OObject({
		follow: true,
		want: null,
		pageSize: 50,
		cap: 100,
		anchor: null,
	});

	const changes = Observer.mutable(0);

	const disposed = new Set();
	const attached = new Set();

	const stop = paginate({
		array: window,
		signal: page.observer,
		source,
		changes,
		throttle: 0,

		attach: async (record) => {
			attached.add(record.key);
			disposed.delete(record.key); // <-- ensure disposed only holds currently-disposed keys
			return {
				item: record.key,
				dispose: async () => {
					disposed.add(record.key);
					attached.delete(record.key);
				},
			};
		},
	});

	// Initial fill: tail(pageSize=50) => m_0251..m_0300
	await waitFor(() => window.length === 50);
	assert.equal(window[0], 'm_0251');
	assert.equal(window[49], 'm_0300');

	// New message while follow=true => appended
	push(); // m_0301
	changes.set(changes.get() + 1);

	await waitFor(() => window[window.length - 1] === 'm_0301');
	assert.equal(window.length, 51);

	// Add many messages; bump pageSize so the fetch grabs them all in one changes tick
	page.pageSize = 500;

	for (let i = 0; i < 120; i++) push(); // m_0302..m_0421
	changes.set(changes.get() + 1);

	// After cap=100 trim (drop oldest), window should be m_0322..m_0421
	await waitFor(() => window.length === 100 && window[0] === 'm_0322' && window[99] === 'm_0421');
	assert.equal(window[0], 'm_0322');
	assert.equal(window[99], 'm_0421');

	// Scroll up: follow=false, load older (prepend), then trim from end (drop newest)
	page.follow = false;
	page.pageSize = 50;

	page.want = { dir: 'older', seq: 1 };

	await waitFor(() => window[0] === 'm_0272' && window[99] === 'm_0371');
	assert.equal(window.length, 100);
	assert.equal(window[0], 'm_0272');
	assert.equal(window[99], 'm_0371');

	// Scroll down: load newer (append), then trim from start (drop oldest)
	page.want = { dir: 'newer', seq: 2 };

	await waitFor(() => window[0] === 'm_0322' && window[99] === 'm_0421');
	assert.equal(window.length, 100);
	assert.equal(window[0], 'm_0322');
	assert.equal(window[99], 'm_0421');

	// We should have disposed stuff due to trimming
	assert.ok(disposed.size > 0);
	// and nothing disposed should still be "attached"
	for (const k of disposed) assert.ok(!attached.has(k));

	// Cleanup should dispose everything and clear array
	stop();
	await sleep(10);

	assert.equal(window.length, 0);
	assert.equal(attached.size, 0);
});