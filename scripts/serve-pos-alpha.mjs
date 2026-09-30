import { randomBytes } from "node:crypto";

import { createPosAlphaServer } from "../src/pos-alpha/server.mjs";
import { PosVerticalSliceRuntime } from "../src/pos-alpha/vertical-slice-runtime.mjs";

const port = Number(process.env.SAGA_POS_ALPHA_PORT ?? 4810);
const sharedPassword = process.env.SAGA_POS_ALPHA_PASSWORD ?? randomBytes(9).toString("base64url");
const runtime = new PosVerticalSliceRuntime({ kioskAssistedCashEnabled: true, kioskStaticQrisDemoEnabled: true });
const { server } = createPosAlphaServer({ sharedPassword, runtime });

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Saga POS Local Sprint Lab: http://127.0.0.1:${port}/kiosk\n`);
  process.stdout.write(`KDS: http://127.0.0.1:${port}/kds\n`);
  process.stdout.write(`Dashboard: http://127.0.0.1:${port}/dashboard\n`);
  process.stdout.write(`Cashier fallback: http://127.0.0.1:${port}/cashier\n`);
  process.stdout.write(`Admin: http://127.0.0.1:${port}/admin\n`);
  process.stdout.write("Organization: kopi-saga\n");
  process.stdout.write("Employee IDs: OWNER-DEMO, BAR-01, CASHIER-01\n");
  process.stdout.write(`Temporary local password: ${sharedPassword}\n`);
  process.stdout.write("Scope: LOCAL_SPRINT_EXECUTION_LAB. QRIS/Member/Reward are simulated fixtures; NFC and printer are NOT RUN.\n");
});
