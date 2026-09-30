# SagaPOS

Development snapshot for local and cloud testing, not a production-approved release. This sanitized package includes SagaPOS application code, SQL migrations, and a local simulation launcher. It excludes production configuration, credentials, history, operational evidence, private media, and customer or employee records.

## Run locally

Use Node.js 22 or newer and npm. From this directory:

```sh
npm ci
npm run test:all
npm start
```

Open `http://127.0.0.1:4810/kiosk`, `/cashier`, `/dashboard`, or `/admin`. The launcher prints a newly generated temporary password. Demo organization: `kopi-saga`; owner ID: `OWNER-DEMO`; other demo IDs: `ADMIN-01`, `MANAGER-01`, `BAR-01`, `CASHIER-01`, `FINANCE-01`.

The default launcher binds to loopback and stores simulation state in memory. Payment, membership, printer, and NFC behavior here does not establish production integration readiness. Native staff and reporting services that require external persistence are not configured by this launcher.

For a local durable simulation, run `npm run pos:durable:start` and open port 4811. This uses PGlite and stores data under `.local/`; do not commit that runtime directory. The durable launcher in this public package does not load production gateway credentials.

For cloud validation, use the environment's port forwarding for the local server. Do not expose a simulation launcher as a production service. Production setup and deployment are deliberately outside this snapshot.

## Validation and assets

`npm run check` checks module syntax, TypeScript, OpenAPI contracts and migration markers. `npm test` exercises HTTP surfaces, canonical menu customization labels/minimums, generated assets, offline-shell assets, authentication, native request key enforcement and lookup routing, request recovery/privacy state, database-backed idempotency and roster integrity with synthetic fixtures. Test accounts and passwords are generated locally; no real employee/customer records are included. This package suite does not establish that the full private acceptance suite or production integrations pass.

Staff request POSTs require an idempotency key. The browser preserves operation metadata in local storage and keeps the sensitive draft only in session storage. After an uncertain result, recovery checks the server before replaying the same key and frozen payload. If the session payload is missing and the server reports `NOT_FOUND`, manual resolution is required; the client does not blindly resend or start a replacement attempt. Deployment ingress is excluded; a separately configured ingress must allow `/ui/staff-request-attempt.js` alongside the Staff UI.

Product and brand media have been replaced by original SVG illustrations marked **SYNTHETIC DEMO**. System fonts replace omitted binary fonts; upstream font notices remain for attribution. External business endpoints are examples under `example.invalid`; configure legitimate integrations separately.

No project open-source license has been added. Public visibility does not itself grant a reuse license. Dependency licenses remain with their respective packages installed by npm; dependencies are not vendored here.
