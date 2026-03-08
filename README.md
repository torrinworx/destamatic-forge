# destamatic-forge

Ship real-time apps without rebuilding the plumbing. `@destamatic/forge` bundles websocket sync, observer-driven state, modular server execution, and ODB persistence so you can focus on product logic instead of infrastructure glue.

This project began by extracting the modular foundation of OpenGig into a reusable client/server runtime. The goal is to aggregate the web app components I have built across multiple projects into one consistent system: shared modules, repeatable workflows, and a predictable architecture for building apps on top of the destam stack.

Forge connects authenticated or public clients, manages the module lifecycle, injects server and websocket services into module jobs, and keeps observer-backed state synchronized between client and server. It is opinionated about structure, but flexible in how modules are composed and extended.

At a glance: it handles the websocket lifecycle and reconnection on the client, wires HTTP + WS + scheduling on the server, discovers modules by file structure, and persists observable documents through ODB with autosave and live updates. Think of it as a 'web-app framework'.

## Quick start

### 1) Start the server core
```js
import { core } from '@destamatic/forge/server';

await core({
  root: process.cwd(),
  modulesDir: './modules',
  env: process.env.NODE_ENV,
  port: 3002,
});
```

### 2) Connect the client
```js
import { syncState } from '@destamatic/forge/client';

const state = await syncState();

const result = await state.modReq('posts/Create', {
  title: 'Hello world',
  body: 'First build log',
});
```

### 3) Write a module
```js
// modules/posts/Create.js
import { OObject } from 'destam';

export default ({ odb, config, imports }) => ({
  async onMessage(props, { user }) {
    const post = await odb.open({
      collection: 'posts',
      query: { filter: { field: 'id', op: 'eq', value: props.id } },
      value: OObject({
        id: props.id,
        author: user.id,
        title: props.title,
        body: props.body,
      }),
    });

    post.updatedAt = Date.now();
    await post.$odb.flush();
    return { ok: true, id: post.id };
  },
});
```

## Architecture notes

Modules are discovered by scanning directories for `.js` files and naming them by their path (for example `posts/Create`). Dependencies inject by short name under `imports`, and the module graph is topologically sorted. You can override built-in modules with project modules, and extend modules via separate extension files that supply config or hooks; `moduleConfig` is reserved for disabling modules by name.

ODB is an observable persistence layer. Documents are `OObject` roots, autosave is throttled, and live updates sync into existing object references so UI bindings stay intact. Drivers implement create/get/update/remove/queryOne/queryMany/watch, and the server wraps ODB with validators and cleanup hooks so modules can enforce integrity as data is opened.

## Docs
For details on the module system and extension rules, see `destamatic-forge/server/README.md`. For the full ODB API, drivers, and query DSL, see `destamatic-forge/odb/README.md`.

## Scope
`@destamatic/forge` is the runtime layer: websocket sync, module lifecycle, scheduling, and persistence. Pair it with `@destamatic/ui` for the UI toolkit and build the rest of your product on top. Eventually we will support 'act templates' which can be imported in a destamatic-ui project's stage system to allow for simple pre-built destamatic-forge compatible pages.
