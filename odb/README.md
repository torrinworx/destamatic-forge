# ODB (Observable DataBase)

ODB is a small persistence layer for **Destam `OObject` documents**. You “open” a document from a collection, mutate it like normal, and ODB handles:

- **autosave** (throttled)
- **live updates** from the DB (watch/poll/change streams)
- keeping the **same object reference** in memory while syncing changes in

ODB is great for “documents” like: user settings, projects, pages, notes, etc.

---

## Mental model

Think of ODB like:

- `collection` = table / mongo collection (ex: `"projects"`)
- `doc` = one `OObject` state tree
- `query` = how you find the doc (DSL filter against the index)
- `doc.$odb` = control handle (flush/reload/dispose/remove)

---

## Basic usage

### 1) Create an ODB instance

Use a driver (memory for tests, mongodb for real apps):

```js
import createODB from './odb/index.js';
import memoryDriver from './odb/drivers/memory.js';

const odb = await createODB({
  driver: memoryDriver,
  throttleMs: 150,
});
```

Mongo example:

```js
import createODB from './odb/index.js';
import mongodbDriver from './odb/drivers/mongodb.js';

const odb = await createODB({
  driver: mongodbDriver,
  throttleMs: 150,
  driverProps: {
    uri: process.env.DB,
    dbName: process.env.DB_TABLE,
  },
});
```

---

## Opening documents

### `odb.open()` (get-or-create)

Use this when the document should always exist.

```js
import { OObject } from 'destam';

const settings = await odb.open({
  collection: 'settings',
  query: {
    filter: { field: 'userId', op: 'eq', value: 'u_123' },
  },
  value: OObject({
    userId: 'u_123',
    theme: 'dark',
  }),
});
```

- If a matching doc exists, you get it.
- If not, ODB creates it using `value`.

Now just mutate:

```js
settings.theme = 'light';
settings.sidebarOpen = true;
```

That’s it—ODB will autosave shortly after changes.

---

### `odb.findOne()` (only if it exists)

```js
const doc = await odb.findOne({
  collection: 'projects',
  query: {
    filter: { field: 'id', op: 'eq', value: 'p_1' },
  },
});

if (!doc) {
  // not found
}
```

---

### `odb.findMany()` (list results)

```js
const docs = await odb.findMany({
  collection: 'projects',
  query: {
    filter: { field: 'ownerId', op: 'eq', value: 'u_123' },
    sort: [{ field: 'createdAt', dir: 'desc' }],
    limit: 50,
  },
});
```

You get an array of live `OObject` docs.

---

## Autosave and throttle

ODB listens to mutations and writes updates to the DB automatically.

**Throttle** means ODB waits a tiny bit and batches multiple quick changes into one DB write.

- good default: `150–500ms` for form-like editing
- `75ms` is very aggressive (more writes)
- memory driver doesn’t “need” it, but you still avoid CPU spam

If you need to guarantee persistence at a moment in time, call `flush()`.

---

## The `$odb` handle (important)

Every opened doc has a non-enumerable control handle:

```js
doc.$odb
```

### `await doc.$odb.flush()`
Forces an immediate save (bypasses throttle).

Use this:
- right before navigating away
- after a “Save” button click
- before tests assert DB state

```js
await settings.$odb.flush();
```

### `await doc.$odb.reload()`
Re-fetches from DB and merges into your current object (keeps references stable).

```js
await settings.$odb.reload();
```

Returns `false` if the record no longer exists.

### `await doc.$odb.remove()`
Deletes the document from the DB and disposes it locally.

```js
await settings.$odb.remove();
```

### `await doc.$odb.dispose()`
Stops syncing and removes it from ODB’s cache when nobody else is using it.

Use this when a doc is no longer needed (like component unmount).

```js
await settings.$odb.dispose();
```

---

## Live updates (multi-tab / multi-client)

If your driver supports `watch()` (memory does, mongo does), then:

- when some other client writes to the same doc
- your local doc updates automatically

Important detail: ODB syncs **in-place**, so UI bindings keep working because the object identity doesn’t change.

---

## Queries (DSL)

ODB queries run against a stored **index** (a JSON-friendly snapshot of your doc). Practically, this means:

- query should be plain JSON values (strings/numbers/bools/arrays/objects)
- Dates are indexed as numbers (`+new Date()`)
- Destam UUID-like values are indexed as hex strings (`id.toHex()`)

### DSL shape

```js
const query = {
  filter: {
    and: [
      { field: 'projectId', op: 'eq', value: 'p_1' },
      {
        or: [
          { field: 'status', op: 'eq', value: 'open' },
          { field: 'status', op: 'eq', value: 'archived' },
        ],
      },
    ],
  },
  sort: [{ field: 'createdAt', dir: 'desc' }],
  limit: 25,
  skip: 0,
};
```

### Operators

- `eq`, `neq`
- `gt`, `gte`, `lt`, `lte`
- `in`, `nin` (value must be an array)
- `exists` (value coerces to boolean)

### Notes

- Legacy query objects are not supported; all queries must use the DSL.
- Use dot paths for nested fields (ex: `meta.authorId`).

### Examples

```js
await odb.findMany({
  collection: 'tasks',
  query: {
    filter: {
      and: [
        { field: 'projectId', op: 'eq', value: 'p_1' },
        { field: 'status', op: 'eq', value: 'open' },
      ],
    },
  },
});
```

Nested query:

```js
await odb.findMany({
  collection: 'docs',
  query: {
    filter: { field: 'meta.authorId', op: 'eq', value: 'u_123' },
  },
});
```

---

### Pagination and sort

- `limit`/`skip` require a `sort` for deterministic results.
- Without `sort`, pagination throws an error.

### Scan limit

Drivers that must scan in-memory will throw after 5,000 records.

---

## Caching behavior (why you might see the “same object”)

ODB caches open docs by `{collection, key}`.

So if you open the same doc twice, you usually get the same object reference back:

```js
const a = await odb.findOne({
  collection: 'settings',
  query: { filter: { field: 'userId', op: 'eq', value: 'u_123' } },
});
const b = await odb.findOne({
  collection: 'settings',
  query: { filter: { field: 'userId', op: 'eq', value: 'u_123' } },
});

a === b; // true
```

This is intentional—prevents duplicate watchers and conflicting local copies.

---

## Common patterns

### “Open settings on app start”
```js
const settings = await odb.open({
  collection: 'settings',
  query: { filter: { field: 'userId', op: 'eq', value: userId } },
  value: OObject({ userId, theme: 'dark' }),
});
```

### “Flush on explicit save”
```js
const onSave = async () => {
  await doc.$odb.flush();
};
```

### “Dispose on unmount”
```js
const stop = () => doc.$odb.dispose();
// call stop() when you’re done
```

---

## Gotchas

- **Root must be an `OObject`.** Arrays aren’t valid as root documents.
- If you stick non-JSON stuff in state, it may not index/query how you expect.
- For lists: ODB tries to reconcile arrays by `.id` when items are `OObject`s with an `id` field. If your items don’t have ids, it falls back to positional updates.

---

## API summary

```ts
const odb = await createODB({ driver, throttleMs?, driverProps? });

await odb.open({ collection, query?, value? })   // get-or-create
await odb.findOne({ collection, query })         // existing only
await odb.findMany({ collection, query })        // list
await odb.remove({ collection, query })          // delete by query
await odb.close()                                   // shutdown
```

Docs returned are `OObject` with:

```ts
doc.$odb.flush()
doc.$odb.reload()
doc.$odb.dispose()
doc.$odb.remove()
```
