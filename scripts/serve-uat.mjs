import { randomBytes } from "node:crypto";

import { createOperatorUatServer } from "../src/uat/operator-server.mjs";
import { credentialLog } from "../src/uat/credential-log.mjs";

const port = Number(process.env.SAGAOPS_UAT_PORT ?? 4790);
const sharedPassword = process.env.SAGAOPS_UAT_SHARED_PASSWORD ?? randomBytes(9).toString("base64url");
const ownerPin = process.env.SAGAOPS_UAT_OWNER_PIN ?? String(1000 + (randomBytes(2).readUInt16BE(0) % 9000));
const runtimeScope = process.env.SAGAOPS_RUNTIME_SCOPE ?? "LOCAL_INTERNAL_ALPHA";
const { server } = createOperatorUatServer({ sharedPassword, ownerPin, scope: runtimeScope });

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`SagaOPS operator UAT: http://127.0.0.1:${port}\n`);
  process.stdout.write(`Scope: ${runtimeScope} | production=false | public=false | NFC=NOT_RUN | printer=NOT_RUN\n`);
  process.stdout.write("Organization slug: kopi-saga\n");
  process.stdout.write("Employee IDs: OWNER-DEMO, STAFF-01, STAFF-02\n");
  for (const line of credentialLog({ sharedPassword, ownerPin, passwordFromEnvironment: Boolean(process.env.SAGAOPS_UAT_SHARED_PASSWORD), pinFromEnvironment: Boolean(process.env.SAGAOPS_UAT_OWNER_PIN) })) process.stdout.write(`${line}\n`);
});

const stop = () => server.close(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
