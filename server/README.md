# destam-web-core/server

## Modules

The server is composed from small feature modules and extension modules.

- **Discovery**: modules are discovered by recursively scanning one or more directories for `.js` files.
  - Each file becomes a module name based on its path, e.g. `modules/posts/Create.js` -> `posts/Create`.
- **Implementations**: a module implementation `export default (injection) => ({ ...handlers })`.
  - Implementation modules declare handlers like `onMessage`, `onConnection`, `validate`, `schedule`, etc.
  - Dependencies are injected by *short name* (last path segment). Example: dep `moderation/strings` injects `strings`.
- **Extensions**: extension modules export `config` and/or `extensions` without any primary handlers.
  - The module system allows only one extension module per module name.
  - Extensions are injected into the implementation as `extensions`.

### What An Implementation Module Can Do

Modules are intentionally flexible; they can provide any subset of:

- `onMessage(props, ctx)`: handle websocket messages where `msg.name === '<moduleName>'`
- `onConnection(ctx)`: run when a client connects (optionally gated by auth)
- `validate`: register database validators
- `schedule`: register scheduled jobs
- `authenticated: false`: mark the module as callable without authentication

## Configuration (Extension Modules)

Modules now use extension modules to supply configuration and hook into custom behavior.

```js
// modules-config/posts/Create.js
export const config = {
  description: { maxLength: 5000 },
  tags: false,
};
```

- **Defaults**: a module may export `export const defaults = { ... }`.
- **Merging**: effective config is `deepMerge(defaults, extension.config)`.
  - Objects merge recursively; non-objects replace.
- **Extensions**: extension modules can export `extensions` (a dictionary of functions).
  - Implementations decide how to use those functions.
- **Disable entirely**: set `moduleConfig[name] = false` to prevent the module from loading at all.
  - `moduleConfig` no longer supports config overrides.
