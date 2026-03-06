# destam-web-core

## Scope and goals

destam-web-core extracts the modular foundation of [OpenGig.org](https://github.com/torrinworx/OpenGig.org) into a reusable client/server runtime. It manages client rendering, websocket-based sync, observer-driven state propagation, and server-side job execution so that new projects do not need to re-implement this infrastructure. The library is responsible for connecting authenticated/unauthenticated clients, injecting contextual services into module jobs, and driving the observer-backed state that both sides share, which solves the boilerplate of wiring websockets, persistence, background jobs, and synchronized UI state.

My goal with this project is to aggrigate the components of a webapp that I have built out accross multiple different projects into a single reusable system. This will simplify component iteration, organize the backend logic into standalone modules, create multi module overarching systems like users, and allow for standardization of building components accross multiple web platform repositories.

## Features

- **Websockets Communication**: Real-time, two-way interaction between client and server.
- **Observer-based State Syncing**: Uses [destam](https://github.com/equator-studios/destam) and [destam-dom](https://github.com/Nefsen402/destam-dom) to synchronize state seamlessly between client and server.
- **MongoDB Integration**: A simple built-in wrapper for storing server state in MongoDB.
- **Flexible Job System**: Infrastructure for invoking code during websocket connections and HTTP requests.
- **Opinionated Authentication**: Built-in auth secures state syncing and job execution while managing signups and logins.

## Modules system
Server modules are discovered automatically under `modules/*` plus any additional `modulesDir` entries you pass to core. Each module declares jobs, routers, validators, and services while depending on the shared container injected via `webCore` metadata and the module-discovery pipeline documented in [`server/README.md`](server/README.md). The dependency graph can resolve other modules, shared utilities, uploads handlers, and validators so that functionality can be composed incrementally. The `modules/posts`, `modules/files`, `uploads`, `moderation`, and `validators` directories showcase how the ecosystem has grown: new concern-specific modules plug into the same discovery, DI, and extension mechanisms that power the rest of the runtime. Module configs are now supplied via extension modules instead of `moduleConfig` overrides.

### Built-in modules
`server/modules` ships with implementations for predictable needs so new projects reuse battle-tested behavior out of the box. Every built-in module honors the contract in [`server/README.md`](server/README.md): shared injections (database clients, upload helpers, job schedulers, etc.) arrive via module discovery, sensible defaults live in each module’s config, and deployments alter behavior by supplying extension modules instead of editing module code. Common handlers such as `onMessage`, `validate`, `schedule`, and express middleware surface in the same way, which lets the runtime wire websocket messages, HTTP routes, and background jobs with minimal glue.

- **modules/posts**: provides CRUD helpers for publishing entries, covers cleanup via `schedule` jobs, and calls `validate`/`onMessage` hooks to guard state mutations. It depends on shared state modules and exposes `onMessage` for websocket operations so that clients can emit post updates without handling persistence directly.
- **modules/files** + `uploads/images`: orchestrate file uploads by hooking validation to file storage, exposing express middleware for receiving file chunks, and registering `validate` rules so that image metadata stays consistent. The pipeline injects storage helpers and enforces configuration defaults for max sizes, while `moduleConfig` can redirect uploads to alternate buckets or services.
- **uploads**, **moderation**, **static**: these directories contain reusable helpers, from express middleware that serves static assets to moderation wrappers around OpenAI so text passes through configurable safety checks. Moderation modules register `validate` handlers and expose `schedule` or on-demand checks that wrap OpenAI clients, relying on shared injection of API credentials and rate limits.
- **validators**, **users**, **state**: these modules normalize cross-cutting concerns such as user data, shared observable state, and derived validators. They layer `validate` handlers that sanitize payloads, normalize session state, and provide DI for other modules that need canonical user/state helpers.
- **enter** + **check**: auth-focused helpers that manage sessions, expose unauthenticated entry points, and supply express middleware for login/signup flows. They plug in to module discovery so unauthed users go through consistent validation while still allowing projects to extend config via extension modules.

Together these built-in modules cover repetitive web development workflows—sessions, uploads, moderation, state sync, etc.—so projects can compose them rather than re-implement shared patterns. Refer to `server/README.md` for the deeper module contract while leveraging these defaults to jumpstart a project.

## Layout overview
- **Directories**: `/server` hosts the websocket/server entry (`server/core.js`) and module glue; `/client` is the browser bundle; `/common` houses shared helpers; `/odb` powers observable persistence; `/tests` contains automated specs such as `tests/obridge.test.js`.
- **Primary entry points**: `server/core.js` wires `coreServer` into HTTP, websocket, and job handling, while `client/index.js` bootstraps the browser runtime.
- **Client sync pieces**: `client/core.jsx`, `client/sync.js`, and cookie helpers coordinate the websocket lifecycle, auth tokens, and client-side state priming.
- **Shared utilities & persistence**: Common utilities feed both client and server modules, and the ODB layer (`odb/`) maintains the live data that modules and the client rely on.

## Client runtime and sync
The client bundle at `client/index.js` imports `core` from `destam-web-core/client` and invokes `core(App, NotFound)` to render the app tree and 404 fallback. Auth cookies and tokens (managed in `client/cookies.js`) seed the client `webcoreToken` reference so the websocket sync layer knows which session to bind. `client/sync.js` handles websocket reconnection, dispatching updates into `destam` state, and forwarding server push jobs so that UI and server-side observers stay consistent.

## Persistence and ODB
For persistence guidance see [`odb/README.md`](odb/README.md); ODB provides observable persistence with drivers for memory, MongoDB, and IndexedDB so that both server modules and client state can subscribe to live data. Autosave and live-update behaviors keep module namespaces consistent, letting the client reflect backend changes and modules write state without repeating wiring logic. Drivers register automatically and can be extended as new storage needs arise.

## Configuration and environment
`coreServer(configServerOptions)` orchestrates server setup, including HTTP routes, websocket handling, module pipelines, and job scheduling. Use extension modules to adjust module config, and only use `moduleConfig` to disable modules (set the module name to `false`). Environment defaults live in `.example.env`, and deployments typically point the MongoDB URI at a cluster (or use memory drivers locally). The runtime distinguishes authenticated versus unauthenticated flows during connection setup so jobs can run with or without a user context while still benefiting from shared middleware.

## Testing and workflows
Unit tests such as `tests/obridge.test.js` verify the observer bridge, and automation lives in `.github/workflows/publish.yml`. Run `npm test` (or the repo’s configured runner) to execute tests before release, and rely on the GitHub publish workflow for CI validation and npm publishing.

## Full stack example
This minimal full stack app illustrates how to plug into destam-web-core while reusing the features above.

**server.js**
```javascript
import { coreServer } from 'destam-web-core/server';

const connection = async (ws, req) => {
    console.log('User connected!');
    return;
};

coreServer(
    './backend/jobs',
    './frontend',
    connection
);
```

**client.jsx**
```javascript
import { core } from 'destam-web-core/client';

const App = ({ state }) => {
    const counter = state.client.counter.def(0);

    return (
        <div>
            {counter}
            <button onClick={() => counter.set(counter.get() + 1)}>
                Counter
            </button>
        </div>
    );
};

const NotFound = () => <>Not Found 404</>;

core(App, NotFound);
```

**index.html**
```html
<!doctype html>
<html lang="en">
    <head>
        <meta charset="UTF-8" />
        <title>destam-web-core</title>
    </head>
    <body style="margin: 0px;">
        <script type="module" src="./client.jsx"></script>
    </body>
</html>
```

That's all the code needed to create a full stack app with destam-web-core, destam, and destam-dom. Focus on building features while the library handles synchronization, modules, and persistence.
