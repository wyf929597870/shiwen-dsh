# Mobile v1 contract probes

These draft contracts are executable P0 inputs, **not an enabled service API**.
The desktop/plugin build does not import them yet. `npm run test:mobile` runs
the isolated SQLite protocol model and failure fixtures without opening user data.

- `schema.mjs`: strict request shapes and semantic checks. `schema.json` is generated
  with `npm run mobile:contracts`; changing it requires updating the fixtures.
- UTF-8 wire format is `shiwen-json-v1`: recursively sort object keys by UTF-16 code
  units; retain array order; use JSON string escaping without Unicode normalization;
  accept only safe integer numbers, booleans, strings, objects, arrays and null.
  Reject unpaired surrogates, undefined and non-JSON objects. SHA-256 covers these
  exact bytes. Markdown, CRLF, combining characters and emoji remain unchanged.
- Body limits use UTF-16 code units to match existing JS save APIs. JSON Schema's
  `maxLength` alone is not sufficient; Kotlin and JS must both check this rule.
- Request fingerprints cover the decoded operation. Upload IDs and transport
  chunking never enter them. Business fingerprints omit `operationId`,
  `baseRevision` and `localGeneration`, retaining original version/activity identity.
- The 64 MiB canonical-operation bound is a **probe bound**, not a published
  compatibility claim. Long conflict histories need child-manifest streaming before
  production rollout; the test model intentionally does not implement that API.

`tests/support/mobile/coordinator.mjs` is a persistent reference model for receipts,
fenced setup publication and restore authorization. It is not a substitute for the
P1 audit of every existing library writer, P2 production blob storage or authenticated
HTTP integration. No route or capability is exposed until those gates pass.
