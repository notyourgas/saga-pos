import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { SagaOpsLocalPostgresRuntime } from "../src/db/local-postgres-runtime.mjs";
import { SagaPosPostgresRepository } from "../src/db/saga-pos-postgres-repository.mjs";
import { DurablePosVerticalSliceRuntime } from "../src/pos-alpha/durable-runtime.mjs";
import { createPosAlphaServer } from "../src/pos-alpha/server.mjs";

const port = Number(process.env.SAGA_POS_DURABLE_PORT ?? 4811);
const dataDir = path.resolve(process.env.SAGA_POS_LOCAL_DATA_DIR ?? ".local/saga-pos-postgres");
const sharedPassword = process.env.SAGA_POS_DURABLE_PASSWORD ?? randomBytes(9).toString("base64url");
await mkdir(path.dirname(dataDir), { recursive: true });
const postgres = new SagaOpsLocalPostgresRuntime({ dataDir });
const migration = await postgres.start();
const repository = new SagaPosPostgresRepository({ db: postgres.db });
const productionGatewayEnabled = false;
const productionGateway = null;
const runtime = new DurablePosVerticalSliceRuntime({
  repository,
  kioskAssistedCashEnabled: process.env.SAGA_POS_KIOSK_ASSISTED_CASH_ENABLED === "true",
  gatewayClient: productionGateway?.client ?? null,
  privatePromotionAuthorizer: productionGateway?.privatePromotionAuthorizer ?? null,
  privateCanaryContext: productionGateway?.privateCanaryContext ?? null,
});
const recovery = await runtime.initialize();
const { server } = createPosAlphaServer({ sharedPassword, runtime });

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Saga POS durable local runtime: http://127.0.0.1:${port}/kiosk\n`);
  process.stdout.write(`Local data directory: ${dataDir}\n`);
  process.stdout.write(`Migrations applied now: ${migration.appliedNow.length}; already applied: ${migration.alreadyApplied.length}\n`);
  process.stdout.write(`Recovered orders: ${recovery.ordersRecovered}; payments: ${recovery.paymentsRecovered}; fulfillments: ${recovery.fulfillmentsRecovered}\n`);
  process.stdout.write(`Temporary local password: ${sharedPassword}\n`);
  process.stdout.write(productionGatewayEnabled
    ? "Gateway mode: PRODUCTION_DIRECT_CONTROLLED_CANARY. Simulator disabled; provider status polling active.\n"
    : "Scope: LOCAL_DURABLE_POSTGRES_RUNTIME. External gateway and production transactions remain NOT RUN.\n");
});

const shutdown = async () => {
  server.close(async () => {
    await postgres.close();
    process.exit(0);
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
