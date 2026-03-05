import test from 'node:test';
import { expect } from 'chai';
import createODB from '../../odb/index.js';
import { OObject, OArray } from 'destam';

const waitUntil = async (fn, { timeoutMs = 1500, stepMs = 10, label = 'condition' } = {}) => {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const ok = await fn();
		if (ok) return true;
		await new Promise(r => setTimeout(r, stepMs));
	}
	throw new Error(`Timed out waiting for: ${label}`);
};

const createRng = (seed = 12345) => {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0x100000000;
	};
};

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

const fullTest = (name, fn) => test(name, fn);

const eq = (field, value) => ({ field, op: 'eq', value });
const q = (filter, extra = {}) => ({ filter, ...extra });

export const runODBDriverTests = ({
	name,
	driver, // raw import (factory or instance)
	driverProps = {},
	throttleMs = 10,
	crossInstanceLive = true,
} = {}) => {
	if (!name) throw new Error('runODBDriverTests: missing name');
	if (!driver) throw new Error('runODBDriverTests: missing driver');

	const collection = `odb_test_${name}`;
	const makeDriverProps = () => {
		if (name !== 'indexeddb') return driverProps;
		const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
		return { ...driverProps, dbName: `odb_test_${name}_${suffix}`, broadcast: false };
	};

	const createDb = async (props = null) =>
		createODB({ driver, throttleMs, driverProps: props || makeDriverProps() });

	test(`[${name}] open() creates doc (default empty OObject)`, async () => {
		const db = await createDb();
		try {
			const doc = await db.open({
				collection,
				query: q({ and: [eq('type', 'empty-default'), eq('v', 1)] }),
			});

			expect(doc).to.be.instanceOf(OObject);
			expect(doc.type).to.equal('empty-default');
			expect(doc.v).to.equal(1);
		} finally {
			await db.close();
		}
	});

	test(`[${name}] open() reuses existing doc (query + cache)`, async () => {
		const db = await createDb();
		try {
			const initial = OObject({ kind: 'reuse', count: 0, items: OArray([]) });

			const a = await db.open({
				collection,
				query: q(eq('kind', 'reuse')),
				value: initial,
			});

			const b = await db.open({
				collection,
				query: q(eq('kind', 'reuse')),
			});

			expect(a).to.equal(b);
		} finally {
			await db.close();
		}
	});

	test(`[${name}] local mutation persists (findOne sees it)`, async () => {
		const db = await createDb();
		try {
			const doc = await db.open({
				collection,
				query: q(eq('kind', 'persist')),
				value: OObject({ kind: 'persist', count: 0 }),
			});

			doc.count = 123;
			await doc.$odb.flush();

			const loaded = await db.findOne({ collection, query: q(eq('kind', 'persist')) });
			expect(loaded).to.be.instanceOf(OObject);
			expect(loaded.count).to.equal(123);
		} finally {
			await db.close();
		}
	});

	test(`[${name}] findMany returns multiple docs`, async () => {
		const db = await createDb();
		try {
			for (let i = 0; i < 3; i++) {
				const doc = await db.open({
					collection,
					query: q({ and: [eq('kind', 'many'), eq('n', i)] }),
					value: OObject({ kind: 'many', n: i, val: i * 10 }),
				});
				doc.val = i * 100;
				await doc.$odb.flush();
			}

			const found = await db.findMany({ collection, query: q(eq('kind', 'many')) });
			expect(found).to.be.an('array');
			expect(found.length).to.be.at.least(3);

			const ns = found.map(d => d.n).sort((a, b) => a - b);
			expect(ns[0]).to.equal(0);
		} finally {
			await db.close();
		}
	});

	test(`[${name}] DSL operators (eq/neq/in/nin/exists/range)`, async () => {
		const db = await createDb();
		try {
			const docs = [
				OObject({ kind: 'dsl-ops', score: 5, status: 'open', tag: 'a' }),
				OObject({ kind: 'dsl-ops', score: 12, status: 'archived', tag: 'b', extra: true }),
				OObject({ kind: 'dsl-ops', score: 25, status: 'closed', tag: 'c' }),
			];

			for (const doc of docs) {
				const opened = await db.open({
					collection,
					query: q({ and: [eq('kind', 'dsl-ops'), eq('score', doc.score)] }),
					value: doc,
				});
				await opened.$odb.flush();
			}

			const gt = await db.findMany({
				collection,
				query: q({
					and: [eq('kind', 'dsl-ops'), { field: 'score', op: 'gt', value: 10 }],
				}),
			});
			expect(gt.map(d => d.score).sort((a, b) => a - b)).to.eql([12, 25]);

			const lte = await db.findMany({
				collection,
				query: q({
					and: [eq('kind', 'dsl-ops'), { field: 'score', op: 'lte', value: 12 }],
				}),
			});
			expect(lte.map(d => d.score).sort((a, b) => a - b)).to.eql([5, 12]);

			const exists = await db.findMany({
				collection,
				query: q({
					and: [eq('kind', 'dsl-ops'), { field: 'extra', op: 'exists', value: true }],
				}),
			});
			expect(exists.length).to.equal(1);

			const inList = await db.findMany({
				collection,
				query: q({
					and: [
						eq('kind', 'dsl-ops'),
						{ field: 'status', op: 'in', value: ['open', 'archived'] },
					],
				}),
			});
			expect(inList.map(d => d.status).sort()).to.eql(['archived', 'open']);

			const ninList = await db.findMany({
				collection,
				query: q({
					and: [
						eq('kind', 'dsl-ops'),
						{ field: 'status', op: 'nin', value: ['archived'] },
					],
				}),
			});
			expect(ninList.map(d => d.status).sort()).to.eql(['closed', 'open']);

			const neq = await db.findMany({
				collection,
				query: q({
					and: [eq('kind', 'dsl-ops'), { field: 'tag', op: 'neq', value: 'b' }],
				}),
			});
			expect(neq.map(d => d.tag).sort()).to.eql(['a', 'c']);
		} finally {
			await db.close();
		}
	});

	test(`[${name}] DSL nested and/or/not`, async () => {
		const db = await createDb();
		try {
			const docs = [
				OObject({ kind: 'dsl-nested', status: 'draft', flag: true }),
				OObject({ kind: 'dsl-nested', status: 'archived', flag: false }),
				OObject({ kind: 'dsl-nested', status: 'published', flag: true }),
			];

			for (const doc of docs) {
				const opened = await db.open({
					collection,
					query: q({ and: [eq('kind', 'dsl-nested'), eq('status', doc.status)] }),
					value: doc,
				});
				await opened.$odb.flush();
			}

			const result = await db.findMany({
				collection,
				query: q({
					and: [
						eq('kind', 'dsl-nested'),
						{
							or: [
								eq('status', 'draft'),
								eq('status', 'archived'),
							],
						},
						{ not: eq('flag', true) },
					],
				}),
			});

			expect(result.length).to.equal(1);
			expect(result[0].status).to.equal('archived');
		} finally {
			await db.close();
		}
	});

	test(`[${name}] DSL dot-path fields`, async () => {
		const db = await createDb();
		try {
			const doc = await db.open({
				collection,
				query: q(eq('kind', 'dsl-dot')),
				value: OObject({ kind: 'dsl-dot', meta: OObject({ status: 'ok' }) }),
			});
			await doc.$odb.flush();

			const found = await db.findOne({
				collection,
				query: q({ and: [eq('kind', 'dsl-dot'), eq('meta.status', 'ok')] }),
			});
			expect(found).to.be.instanceOf(OObject);
			expect(found.meta.status).to.equal('ok');
		} finally {
			await db.close();
		}
	});

	test(`[${name}] DSL sort + pagination`, async () => {
		const db = await createDb();
		try {
			for (let i = 0; i < 5; i++) {
				const doc = await db.open({
					collection,
					query: q({ and: [eq('kind', 'dsl-sort'), eq('n', i)] }),
					value: OObject({ kind: 'dsl-sort', n: i }),
				});
				await doc.$odb.flush();
			}

			const page = await db.findMany({
				collection,
				query: q(eq('kind', 'dsl-sort'), {
					sort: [{ field: 'n', dir: 'asc' }],
					skip: 1,
					limit: 2,
				}),
			});

			expect(page.map(d => d.n)).to.eql([1, 2]);
		} finally {
			await db.close();
		}
	});

	test(`[${name}] DSL pagination without sort throws`, async () => {
		const db = await createDb();
		try {
			let threw = false;
			try {
				await db.findMany({
					collection,
					query: q(eq('kind', 'dsl-sort'), { limit: 1 }),
				});
			} catch (e) {
				threw = true;
				expect(e.message.toLowerCase()).to.include('sort');
			}
			expect(threw).to.equal(true);
		} finally {
			await db.close();
		}
	});

	test(`[${name}] invalid filter is rejected`, async () => {
		const db = await createDb();
		try {
			let threw = false;
			try {
				await db.findOne({
					collection,
					query: { filter: { field: 'kind', op: 'eq' } },
				});
			} catch (e) {
				threw = true;
				expect(e.message.toLowerCase()).to.include('value');
			}
			expect(threw).to.equal(true);
		} finally {
			await db.close();
		}
	});

	test(`[${name}] in-memory scan limit enforced`, async () => {
		if (name === 'mongodb') return;
		const db = await createDb();
		try {
			for (let i = 0; i < 5100; i++) {
				const doc = await db.open({
					collection,
					value: OObject({ kind: 'dsl-scan', n: i }),
				});
				await doc.$odb.flush();
			}

			let threw = false;
			try {
				await db.findMany({
					collection,
					query: q(eq('kind', 'dsl-scan'), {
						sort: [{ field: 'n', dir: 'asc' }],
					}),
				});
			} catch (e) {
				threw = true;
				expect(e.message.toLowerCase()).to.include('scan limit');
			}
			expect(threw).to.equal(true);
		} finally {
			await db.close();
		}
	});

	test(`[${name}] remove() deletes doc and throws if not found`, async () => {
		const db = await createDb();
		try {
			await db.open({
				collection,
				query: q(eq('kind', 'remove-me')),
				value: OObject({ kind: 'remove-me', ok: true }),
			});

			const removed = await db.remove({ collection, query: q(eq('kind', 'remove-me')) });
			expect(removed).to.equal(true);

			let threw = false;
			try {
				await db.remove({ collection, query: q(eq('kind', 'remove-me')) });
			} catch (e) {
				threw = true;
				expect(e.message.toLowerCase()).to.include('not found');
			}
			expect(threw).to.equal(true);
		} finally {
			await db.close();
		}
	});

	test(`[${name}] rejects plain arrays in state tree (strict mode)`, async () => {
		const db = await createDb();
		try {
			let threw = false;
			try {
				await db.open({
					collection,
					query: q(eq('kind', 'invalid-array')),
					value: OObject({ kind: 'invalid-array', items: [] }),
				});
			} catch (e) {
				threw = true;
				expect(e.message.toLowerCase()).to.include('invalid state tree');
			}
			expect(threw).to.equal(true);
		} finally {
			await db.close();
		}
	});

	test(`[${name}] resolves revision conflict on concurrent save`, async () => {
		let db1;
		let db2;

		const props = makeDriverProps();
		const sharedDriver =
			typeof driver === 'function'
				? await driver(props)
				: driver;

		try {
			db1 = await createODB({ driver: sharedDriver, throttleMs });
			db2 = await createODB({ driver: sharedDriver, throttleMs });

			const doc1 = await db1.open({
				collection,
				query: q(eq('kind', 'rev-conflict')),
				value: OObject({ kind: 'rev-conflict', count: 0 }),
			});

			const doc2 = await db2.open({
				collection,
				query: q(eq('kind', 'rev-conflict')),
			});

			doc1.count = 1;
			await doc1.$odb.flush();

			doc2.count = 2;
			if (doc2.$odb && typeof doc2.$odb.rev === 'number') {
				doc2.$odb.rev = 0;
			}
			await doc2.$odb.flush();
			const reloaded = await db2.findOne({ collection, query: q(eq('kind', 'rev-conflict')) });
			expect(reloaded).to.be.instanceOf(OObject);
			expect(reloaded.count).to.equal(1);
		} finally {
			await Promise.allSettled([db1?.close?.(), db2?.close?.()]);
		}
	});

	test(`[${name}] live propagation across two ODB instances`, async () => {
		if (!crossInstanceLive) return;

		let db1;
		let db2;

		const props = makeDriverProps();
		const sharedDriver =
			typeof driver === 'function'
				? await driver(props)
				: driver;

		try {
			db1 = await createODB({ driver: sharedDriver, throttleMs });
			db2 = await createODB({ driver: sharedDriver, throttleMs });

			const doc1 = await db1.open({
				collection,
				query: q(eq('kind', 'live')),
				value: OObject({ kind: 'live', text: 'a', messages: OArray([]) }),
			});

			const doc2 = await db2.open({
				collection,
				query: q(eq('kind', 'live')),
			});

			doc1.text = 'hello';
			doc1.messages.push(OObject({ id: 'm1', t: 'yo' }));
			await doc1.$odb.flush();

			await waitUntil(
				() =>
					doc2.text === 'hello' &&
					doc2.messages?.length === 1 &&
					doc2.messages[0].id === 'm1',
				{ label: 'db2 receives remote update' }
			);
		} finally {
			await Promise.allSettled([db1?.close?.(), db2?.close?.()]);
		}
	});

	test(`[${name}] reload preserves OArray element identity (observer.id)`, async () => {
		const db = await createDb();
		try {
			const doc = await db.open({
				collection,
				query: q(eq('kind', 'array-identity')),
				value: OObject({
					kind: 'array-identity',
					items: OArray([
						OObject({ label: 'a' }),
						OObject({ label: 'b' }),
					]),
				}),
			});

			const first = doc.items[0];
			const second = doc.items[1];
			first.label = 'aa';
			await doc.$odb.flush();

			const ok = await doc.$odb.reload();
			expect(ok).to.equal(true);
			expect(doc.items[0]).to.equal(first);
			expect(doc.items[1]).to.equal(second);
			expect(doc.items[0].label).to.equal('aa');
		} finally {
			await db.close();
		}
	});

	test(`[${name}] live reorder preserves OArray element identity`, async () => {
		if (!crossInstanceLive) return;

		let db1;
		let db2;

		const props = makeDriverProps();
		const sharedDriver =
			typeof driver === 'function'
				? await driver(props)
				: driver;

		try {
			db1 = await createODB({ driver: sharedDriver, throttleMs });
			db2 = await createODB({ driver: sharedDriver, throttleMs });

			const doc1 = await db1.open({
				collection,
				query: q(eq('kind', 'array-reorder')),
				value: OObject({
					kind: 'array-reorder',
					messages: OArray([
						OObject({ text: 'a' }),
						OObject({ text: 'b' }),
					]),
				}),
			});

			const doc2 = await db2.open({
				collection,
				query: q(eq('kind', 'array-reorder')),
			});

			await doc1.$odb.flush();
			await waitUntil(
				() => doc2.messages?.length === 2,
				{ label: 'doc2 initial messages' }
			);

			const first = doc2.messages[0];
			const second = doc2.messages[1];

			const swapped = [doc1.messages[1], doc1.messages[0]];
			doc1.messages.splice(0, 2, ...swapped);
			await doc1.$odb.flush();

			await waitUntil(
				() =>
					doc2.messages?.length === 2 &&
					doc2.messages[0].text === 'b' &&
					doc2.messages[1].text === 'a',
				{ label: 'doc2 reordered messages' }
			);

			expect(doc2.messages[0]).to.equal(second);
			expect(doc2.messages[1]).to.equal(first);
		} finally {
			await Promise.allSettled([db1?.close?.(), db2?.close?.()]);
		}
	});

	test(`[${name}] fuzz OArray mutations preserve identity`, async () => {
		const db = await createDb();
		try {
			const seed = 424242;
			const rng = createRng(seed);

			const doc = await db.open({
				collection,
				query: q(eq('kind', 'fuzz-array')),
				value: OObject({
					kind: 'fuzz-array',
					items: OArray([
						OObject({ id: 'a', label: 'a' }),
						OObject({ label: 'b' }),
						OObject({ id: 'c', label: 'c' }),
						OObject({ label: 'd' }),
					]),
				}),
			});

			const identityMap = new Map();
			const snapshotIdentity = () => {
				identityMap.clear();
				for (const item of doc.items) {
					if (!item?.observer?.id) continue;
					identityMap.set(item.observer.id.toHex(), item);
				}
			};

			snapshotIdentity();

			const ops = 200;
			for (let i = 0; i < ops; i++) {
				const op = pick(rng, ['push', 'pop', 'shift', 'unshift', 'splice', 'swap', 'replace']);
				const len = doc.items.length;

				switch (op) {
					case 'push':
						doc.items.push(OObject({ label: `p${i}` }));
						break;
					case 'pop':
						if (len) doc.items.pop();
						break;
					case 'shift':
						if (len) doc.items.shift();
						break;
					case 'unshift':
						doc.items.unshift(OObject({ label: `u${i}` }));
						break;
					case 'splice': {
						const start = len ? Math.floor(rng() * len) : 0;
						const del = len ? Math.floor(rng() * Math.min(3, len - start)) : 0;
						const adds = Math.floor(rng() * 3);
						const vals = [];
						for (let j = 0; j < adds; j++) vals.push(OObject({ label: `s${i}-${j}` }));
						doc.items.splice(start, del, ...vals);
						break;
					}
					case 'swap': {
						if (len < 2) break;
						const a = Math.floor(rng() * len);
						let b = Math.floor(rng() * len);
						if (b === a) b = (b + 1) % len;
						const va = doc.items[a];
						const vb = doc.items[b];
						doc.items.splice(a, 1, vb);
						doc.items.splice(b, 1, va);
						break;
					}
					case 'replace': {
						if (!len) break;
						const at = Math.floor(rng() * len);
						doc.items[at] = OObject({ label: `r${i}` });
						break;
					}
				}

				if (i % 25 === 0) {
					await doc.$odb.flush();
					await doc.$odb.reload();
					for (const item of doc.items) {
						expect(item).to.be.instanceOf(OObject);
					}
				}
			}

			await doc.$odb.flush();
			await doc.$odb.reload();

			for (const item of doc.items) {
				expect(item).to.be.instanceOf(OObject);
			}

			for (const [id, obj] of identityMap.entries()) {
				const current = doc.items.find(it => it?.observer?.id?.toHex?.() === id);
				if (current) expect(current).to.equal(obj);
			}
		} finally {
			await db.close();
		}
	});

	test(`[${name}] nested OArray stays observable after reload`, async () => {
		const db = await createDb();
		try {
			const doc = await db.open({
				collection,
				query: q(eq('kind', 'nested-array')),
				value: OObject({
					kind: 'nested-array',
					nested: OArray([
						OObject({
							list: OArray([
								OObject({ label: 'x' }),
								OObject({ label: 'y' }),
							]),
						}),
					]),
				}),
			});

			await doc.$odb.flush();
			await doc.$odb.reload();

			const firstList = doc.nested[0].list;
			expect(firstList).to.be.instanceOf(OArray);
			firstList.push(OObject({ label: 'z' }));
			await doc.$odb.flush();

			const reloaded = await db.findOne({ collection, query: q(eq('kind', 'nested-array')) });
			expect(reloaded.nested[0].list).to.be.instanceOf(OArray);
			expect(reloaded.nested[0].list.length).to.equal(3);
		} finally {
			await db.close();
		}
	});

	test(`[${name}] index updates on deep mutation`, async () => {
		const db = await createDb();
		try {
			const doc = await db.open({
				collection,
				query: q(eq('kind', 'deep-index')),
				value: OObject({
					kind: 'deep-index',
					meta: OObject({
						status: 'new',
						tags: OArray([OObject({ name: 'a' })]),
					}),
				}),
			});

			doc.meta.status = 'updated';
			doc.meta.tags.push(OObject({ name: 'b' }));
			await doc.$odb.flush();

			const found = await db.findOne({
				collection,
				query: q({
					and: [eq('kind', 'deep-index'), eq('meta.status', 'updated')],
				}),
			});
			expect(found).to.be.instanceOf(OObject);
			expect(found.meta.status).to.equal('updated');
		} finally {
			await db.close();
		}
	});

	test(`[${name}] concurrent flushes on same doc are serialized`, async () => {
		const db = await createDb();
		try {
			const doc = await db.open({
				collection,
				query: q(eq('kind', 'flush-serialize')),
				value: OObject({ kind: 'flush-serialize', count: 0 }),
			});

			doc.count = 1;
			const a = doc.$odb.flush();
			doc.count = 2;
			const b = doc.$odb.flush();
			doc.count = 3;
			const c = doc.$odb.flush();

			await Promise.all([a, b, c]);
			await doc.$odb.reload();
			expect(doc.count).to.equal(3);
		} finally {
			await db.close();
		}
	});

	fullTest(`[${name}] full fuzz OArray mutations (10k ops)`, async () => {
		const db = await createDb();
		try {
			const seed = 1337;
			const rng = createRng(seed);

			const doc = await db.open({
				collection,
				query: q(eq('kind', 'fuzz-array-full')),
				value: OObject({
					kind: 'fuzz-array-full',
					items: OArray([
						OObject({ id: 'a', label: 'a' }),
						OObject({ label: 'b' }),
						OObject({ id: 'c', label: 'c' }),
						OObject({ label: 'd' }),
					]),
				}),
			});

			const identityMap = new Map();
			for (const item of doc.items) {
				if (!item?.observer?.id) continue;
				identityMap.set(item.observer.id.toHex(), item);
			}

			const ops = 10000;
			for (let i = 0; i < ops; i++) {
				const op = pick(rng, ['push', 'pop', 'shift', 'unshift', 'splice', 'swap', 'replace']);
				const len = doc.items.length;

				switch (op) {
					case 'push':
						doc.items.push(OObject({ label: `p${i}` }));
						break;
					case 'pop':
						if (len) doc.items.pop();
						break;
					case 'shift':
						if (len) doc.items.shift();
						break;
					case 'unshift':
						doc.items.unshift(OObject({ label: `u${i}` }));
						break;
					case 'splice': {
						const start = len ? Math.floor(rng() * len) : 0;
						const del = len ? Math.floor(rng() * Math.min(3, len - start)) : 0;
						const adds = Math.floor(rng() * 3);
						const vals = [];
						for (let j = 0; j < adds; j++) vals.push(OObject({ label: `s${i}-${j}` }));
						doc.items.splice(start, del, ...vals);
						break;
					}
					case 'swap': {
						if (len < 2) break;
						const a = Math.floor(rng() * len);
						let b = Math.floor(rng() * len);
						if (b === a) b = (b + 1) % len;
						const va = doc.items[a];
						const vb = doc.items[b];
						doc.items.splice(a, 1, vb);
						doc.items.splice(b, 1, va);
						break;
					}
					case 'replace': {
						if (!len) break;
						const at = Math.floor(rng() * len);
						doc.items[at] = OObject({ label: `r${i}` });
						break;
					}
				}

				if (i % 250 === 0) {
					await doc.$odb.flush();
					await doc.$odb.reload();
					for (const item of doc.items) {
						expect(item).to.be.instanceOf(OObject);
					}
				}
			}

			await doc.$odb.flush();
			await doc.$odb.reload();

			for (const item of doc.items) {
				expect(item).to.be.instanceOf(OObject);
			}

			for (const [id, obj] of identityMap.entries()) {
				const current = doc.items.find(it => it?.observer?.id?.toHex?.() === id);
				if (current) expect(current).to.equal(obj);
			}
		} finally {
			await db.close();
		}
	});

	fullTest(`[${name}] concurrent writer stress (3 instances)`, async () => {
		let dbs;
		const props = makeDriverProps();
		const sharedDriver =
			typeof driver === 'function'
				? await driver(props)
				: driver;

		try {
			dbs = await Promise.all([
				createODB({ driver: sharedDriver, throttleMs }),
				createODB({ driver: sharedDriver, throttleMs }),
				createODB({ driver: sharedDriver, throttleMs }),
			]);

			const docs = [];
			for (const db of dbs) {
				const doc = await db.open({
					collection,
					query: q(eq('kind', 'concurrent-writers')),
					value: OObject({ kind: 'concurrent-writers', count: 0 }),
				});
				docs.push(doc);
			}

			const rng = createRng(9090);
			let lastValue = 0;
			const steps = 120;

			for (let i = 1; i <= steps; i++) {
				const idx = Math.floor(rng() * docs.length);
				const doc = docs[idx];
				doc.count = i;
				try {
					await doc.$odb.flush();
					lastValue = i;
				} catch (err) {
					await doc.$odb.reload();
					doc.count = i;
					await doc.$odb.flush();
					lastValue = i;
				}
			}

			for (const doc of docs) {
				await doc.$odb.reload();
				expect(doc.count).to.equal(lastValue);
			}
		} finally {
			if (dbs) await Promise.allSettled(dbs.map(db => db?.close?.()));
		}
	});

	fullTest(`[${name}] dispose prevents ghost updates`, async () => {
		if (!crossInstanceLive) return;

		let db1;
		let db2;

		const props = makeDriverProps();
		const sharedDriver =
			typeof driver === 'function'
				? await driver(props)
				: driver;

		try {
			db1 = await createODB({ driver: sharedDriver, throttleMs });
			db2 = await createODB({ driver: sharedDriver, throttleMs });

			const doc1 = await db1.open({
				collection,
				query: q(eq('kind', 'dispose-ghost')),
				value: OObject({ kind: 'dispose-ghost', text: 'a' }),
			});

			const doc2 = await db2.open({
				collection,
				query: q(eq('kind', 'dispose-ghost')),
			});

			await doc2.$odb.dispose();

			doc1.text = 'b';
			await doc1.$odb.flush();

			await new Promise(r => setTimeout(r, 150));
			expect(doc2.text).to.equal('a');
		} finally {
			await Promise.allSettled([db1?.close?.(), db2?.close?.()]);
		}
	});
};
