# Tests

This folder is organized for fast, per-file runs. Developers run individual test files directly with `node --test`.

## Conventions

- `tests/modules/`: unit-ish module tests with minimal fixtures.
- `tests/modules_int/`: integration/workflow tests that exercise multiple modules together.
- `tests/utils/`: shared test helpers (core harness, module graph, websocket client, etc.).

## Running tests

Run any test file by path:

```bash
node --test ./tests/modules/auth/enter.test.js
node --test ./tests/obridge.test.js
node --test ./tests/modules_int/auth/sign-up-flow.test.js
node --test ./tests/modules_int/auth/sign-up-flow.test.js
etc
```

You can also run the full suite via the package script:

```bash
npm test
```
