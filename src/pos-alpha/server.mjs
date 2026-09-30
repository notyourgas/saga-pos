import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { PosVerticalSliceRuntime, SAGA_POS_ALPHA_CONTEXT } from "./vertical-slice-runtime.mjs";
import { createTeamOperations } from "../services/team-access-operations.mjs";
import { SlidingWindowRateLimiter } from "./rate-limiter.mjs";
import { ownRequestOperations, ownRequestInput, ownRequestData } from "../services/hrpos-staff-requests.mjs";
import { createEsbOwnerReportRuntimeApi } from "../services/esb-reporting/runtime-api.mjs";
import { createRuntimeRetiredRouteTelemetry, RETIRED_ROUTE_KEYS } from "../services/retired-route-telemetry.mjs";
import { resolveGoogleMapsLocation } from "../services/google-maps-location.mjs";
import { buildBusinessMasterReadiness } from "../services/business-master-readiness.mjs";
import { buildPhase4WorkforceReadiness } from "../services/phase4-workforce-readiness.mjs";
import { createPhase5MemberLifecycle } from "../services/phase5-member-lifecycle.mjs";
import { createPhase6FinanceClosing } from "../services/phase6-finance-closing.mjs";
import { createPhase7ResiliencePilot } from "../services/phase7-resilience-pilot.mjs";
import { buildPhase8AOperationalDataReadiness } from "../services/phase8a-operational-data-readiness.mjs";
import { buildPhase8BPaymentGatewayReadiness } from "../services/phase8b-payment-gateway-readiness.mjs";
import { buildCashTenderOptions } from "../services/pos-core.mjs";
import { DUMMY_CATALOG_CONTENT_BY_PRODUCT, DUMMY_CATALOG_CONTENT_DISCLAIMER, DUMMY_CATALOG_CONTENT_VERSION } from "./catalog-dummy-content.mjs";

const publicRoot = fileURLToPath(new URL("../../public/pos-alpha/", import.meta.url));
const legacyStaffFixtureRoot = fileURLToPath(new URL('../../tests/fixtures/hrpos-staff/',import.meta.url));
const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".woff2", "font/woff2"],
]);
const routeFiles = new Map([
  ["/kiosk", "kiosk.html"],
  ["/order", "table-order.html"],
  ["/menu", "menu-preview.html"],
  ["/menu/qr", "table-order.html"],
  ["/menu/kiosk", "menu-kiosk-demo.html"],
  ["/menu/promo", "menu-preview.html"],
  ["/menu/member", "menu-preview.html"],
  ["/team-access", "team-access.html"],
  ["/kds", "operator.html"],
  ["/dashboard", "operator.html"],
  ["/cashier", "cashier.html"],
  ["/admin", "admin.html"],
  ["/admin/menu", "admin.html"],
  ["/admin/menu/availability", "admin.html"],
  ["/inventory-reports", "inventory-reports.html"],
  ["/ap", "ap.html"],
  ["/hr", "hr.html"],
  ["/staff", "staff.html"],
  ["/staff/login", "staff.html"],
  ["/login/staff", "staff.html"],
]);
const scryptAsync = promisify(scrypt);
const personas = Object.freeze({
  "OWNER-DEMO": { employeeId: "OWNER-DEMO", displayName: "Demo Owner", role: "owner", mode: "DASHBOARD" },
  "ADMIN-01": { employeeId: "ADMIN-01", displayName: "Admin 01", role: "admin", mode: "APPROVAL" },
  "MANAGER-01": { employeeId: "MANAGER-01", displayName: "Manager 01", role: "manager", mode: "APPROVAL" },
  "BAR-01": { employeeId: "BAR-01", displayName: "Bar 01", role: "bar", mode: "KDS" },
  "CASHIER-01": { employeeId: "CASHIER-01", displayName: "Cashier 01", role: "cashier", mode: "CASHIER" },
  "FINANCE-01": { employeeId: "FINANCE-01", displayName: "Finance Reviewer 01", role: "finance", mode: "AP_REVIEW" },
});

export function createPosAlphaServer({ sharedPassword = randomBytes(9).toString("base64url"), clock = () => new Date(), runtime: suppliedRuntime, publicDemo = false, privateStaging = false, operatorPreview = false, productionRuntime = false, productionPaymentMode = "gateway", productionMemberMode = "off", productionOwnerAuth = null, releaseEvidence = null, featureFlags = {}, hrpos = null, nativeStaff = null, teamAccess = null, staffInventoryReceiving = null, tableOrderAccess = null, tableOrderHost = "order.example.invalid", tableOrderHealth = null, kioskStaticDemoHealth = null, paymentGatewayReadiness = null, legacyStaffUiForTests = false, esbOwnerReportApi: suppliedEsbOwnerReportApi = null, retiredRouteTelemetry: suppliedRetiredRouteTelemetry = null, inventoryReportingApi = null, inventoryReportingHealth = null, phase5MemberLifecycle: suppliedPhase5MemberLifecycle = null, phase6FinanceClosing: suppliedPhase6FinanceClosing = null, phase7ResiliencePilot: suppliedPhase7ResiliencePilot = null } = {}) {
  if (teamAccess && (publicDemo || operatorPreview)) throw Error('team_access_scope_conflict');
  if (productionRuntime && teamAccess && teamAccess.persistence !== 'POSTGRES') throw Error('team_access_postgres_required');
  if (legacyStaffUiForTests && productionRuntime) throw Error('legacy_staff_ui_production_denied');
  if (privateStaging && (publicDemo || operatorPreview || !suppliedRuntime)) throw new Error("private_staging_runtime_required");
  if (operatorPreview && publicDemo) throw new Error("operator_preview_scope_conflict");
  if (!["gateway", "off"].includes(productionPaymentMode)) throw new Error("production_payment_mode_invalid");
  if (!["provider", "off"].includes(productionMemberMode)) throw new Error("production_member_mode_invalid");
  if (tableOrderAccess && ["verify", "assertSession", "listTables"].some((method) => typeof tableOrderAccess[method] !== "function")) throw new Error("table_order_access_invalid");
  if (productionRuntime && tableOrderAccess && !/^[a-z0-9.-]+$/.test(tableOrderHost)) throw new Error("table_order_host_invalid");
  const runtime = suppliedRuntime ?? new PosVerticalSliceRuntime({ clock });
  const phase5MemberLifecycle = suppliedPhase5MemberLifecycle ?? createPhase5MemberLifecycle({ providerConfigured: productionMemberMode === "provider", clock });
  if (["readiness", "simulate", "scenarios"].some((method) => typeof phase5MemberLifecycle?.[method] !== "function")) throw new Error("phase5_member_lifecycle_invalid");
  const phase6FinanceClosing = suppliedPhase6FinanceClosing ?? createPhase6FinanceClosing({ clock });
  if (["readiness", "simulate", "scenarios"].some((method) => typeof phase6FinanceClosing?.[method] !== "function")) throw new Error("phase6_finance_closing_invalid");
  const phase7ResiliencePilot = suppliedPhase7ResiliencePilot ?? createPhase7ResiliencePilot({ clock });
  if (["readiness", "simulate", "scenarios"].some((method) => typeof phase7ResiliencePilot?.[method] !== "function")) throw new Error("phase7_resilience_pilot_invalid");
  const durableSessions = !publicDemo && runtime.repository?.loadHttpSession ? runtime.repository : null;
  const ownerAuth = normalizeProductionOwnerAuth(productionOwnerAuth, runtime.ids, clock);
  if (teamAccess && ownerAuth) teamAccess.setOwnerVerifier(async (employeeId,password) => {
    try { await authenticateProductionOwner({organizationSlug:ownerAuth.organizationSlug,employeeId,password},ownerAuth); return true; }
    catch { return false; }
  });
  const productionHrpos = hrpos?.enabled === true && hrpos.syntheticLoopback !== true;
  if (productionRuntime && (publicDemo || privateStaging || operatorPreview || !suppliedRuntime || !durableSessions || (productionPaymentMode === "gateway" && !runtime.gatewayClient) || (!productionHrpos && !ownerAuth?.enabled))) throw new Error("production_identity_runtime_required");
  if (productionRuntime && productionPaymentMode === "gateway" && (runtime.gatewayActivation?.mode !== "CONTROLLED_CANARY" || runtime.gatewayActivation?.deliveryMode !== "signed_status_polling")) throw new Error("production_gateway_activation_required");
  if (productionRuntime && tableOrderAccess && runtime.tableDemoPersistenceReady !== true) throw new Error("table_order_persistence_required");
  const safeReleaseEvidence = normalizeReleaseEvidence(releaseEvidence);
  const teamOperations = teamAccess ? createTeamOperations({ teamAccess, runtime, nativeStaff, paymentOff: productionRuntime && productionPaymentMode === "off" }) : null;
  const paymentOff = productionRuntime && productionPaymentMode === "off";
  const safeFeatureFlags = normalizeMenuPromoFeatureFlags(featureFlags);
  if (runtime.catalogPricing) runtime.catalogPricing.authoredPromotionEngineEnabled = safeFeatureFlags.promoEngineV1;
  const productionAuthMode = productionRuntime ? (productionHrpos && ownerAuth ? "OWNER_HASH_HRPOS_SSO" : productionHrpos ? "HRPOS" : "OWNER_HASH") : undefined;
  runtime.productionMemberGuard=productionRuntime;
  if(runtime.catalogPricing)runtime.catalogPricing.allowFixturePromotions=!productionRuntime;
  const deliveryContext = operatorPreview
    ? { ...SAGA_POS_ALPHA_CONTEXT, scope: "VERCEL_AUTH_OPERATOR_PREVIEW", publicExposure: true, persistence: "EPHEMERAL_SERVERLESS_PREVIEW", production: false }
    : publicDemo
    ? { ...SAGA_POS_ALPHA_CONTEXT, scope: "PUBLIC_DEMO_SIMULATOR", publicExposure: true, persistence: "EPHEMERAL_SERVERLESS_DEMO" }
    : productionRuntime
    ? { ...SAGA_POS_ALPHA_CONTEXT, scope: "PRODUCTION_RUNTIME", publicExposure: true, persistence: "NATIVE_POSTGRES_SINGLE_WRITER", production: true, gateway: paymentOff ? "PAYMENT_OFF" : "SAGADEV_GATEWAY_PRODUCTION", paymentMode: productionPaymentMode.toUpperCase(), memberMode: productionMemberMode.toUpperCase(), authMode: productionAuthMode }
    : { ...SAGA_POS_ALPHA_CONTEXT, publicExposure: false, ...(privateStaging ? { scope: "PRIVATE_STAGING_SIMULATOR", persistence: "NATIVE_POSTGRES_SINGLE_WRITER", production: false } : {}) };
  if (safeReleaseEvidence) deliveryContext.release = safeReleaseEvidence;
  const loginLimiter = new SlidingWindowRateLimiter({ clock, limit: 10, windowMs: 60_000 });
  const checkoutLimiter = new SlidingWindowRateLimiter({ clock, limit: 60, windowMs: 60_000 });
  const memberLimiter = new SlidingWindowRateLimiter({ clock, limit: 10, windowMs: 60_000 });
  const receiptUploadLimiter = new SlidingWindowRateLimiter({ clock, limit: 40, windowMs: 60_000 });
  const attendanceMutationLimiter = new SlidingWindowRateLimiter({ clock, limit: 20, windowMs: 60_000 });
  const attendanceCorrectionLimiter = new SlidingWindowRateLimiter({ clock, limit: 5, windowMs: 10 * 60_000 });
  const attendanceEvidenceReadLimiter = new SlidingWindowRateLimiter({ clock, limit: 60, windowMs: 60_000 });
  const attendanceLocationResolveLimiter = new SlidingWindowRateLimiter({ clock, limit: 10, windowMs: 60_000 });
  const attendanceDiagnosticLimiter = new SlidingWindowRateLimiter({ clock, limit: 20, windowMs: 60_000 });
  const tableOrderLimiter = new SlidingWindowRateLimiter({ clock, limit: 30, windowMs: 60_000 });
  const menuCatalogLimiter = new SlidingWindowRateLimiter({ clock, limit: 120, windowMs: 60_000 });
  const kioskSessions = new Map();
  const tableSessions = new Map();
  const menuKioskDemoSessions = new Map();
  const operatorSessions = new Map();
  const ownerHrSessions = new Map();
  const staffSessions = new Map();
  const catalogSubscribers = new Set();
  const broadcastCatalogRevision = (event) => {
    const payload = `event: catalog-revision\ndata: ${JSON.stringify(event)}\n\n`;
    for (const subscriber of catalogSubscribers) {
      try { subscriber.write(payload); } catch { catalogSubscribers.delete(subscriber); }
    }
  };
  const esbOwnerReportApi = suppliedEsbOwnerReportApi ?? createEsbOwnerReportRuntimeApi({ runtime, clock });
  const retiredRouteTelemetry = suppliedRetiredRouteTelemetry ?? createRuntimeRetiredRouteTelemetry({ runtime, clock });
  if (!retiredRouteTelemetry?.observe || !retiredRouteTelemetry?.readEvidence || !retiredRouteTelemetry?.healthSignal) throw new Error("retired_route_telemetry_invalid");
  if (inventoryReportingApi && ["readSummary", "readFamily", "exportFamily", "resolveSource"].some((method) => typeof inventoryReportingApi[method] !== "function")) throw new Error("inventory_reporting_api_invalid");
  if (staffInventoryReceiving && (!staffInventoryReceiving.service || typeof staffInventoryReceiving.catalog !== "function" || typeof staffInventoryReceiving.health !== "function")) throw new Error("staff_inventory_receiving_invalid");
  const readInventoryReportingHealth = normalizeInventoryReportingHealth(inventoryReportingHealth, Boolean(inventoryReportingApi));
  if (hrpos && (publicDemo || !durableSessions || hrpos.scope.posOrganizationId !== runtime.ids.organizationId)) throw new Error("hrpos_private_runtime_required");
  async function persistSession(kind, session) {
    if (durableSessions) await durableSessions.saveHttpSession({ ...runtime.ids, kind, session });
  }
  async function revokeSession(kind, tokenHash) {
    if (durableSessions) await durableSessions.revokeHttpSession({ ...runtime.ids, kind, tokenHash });
  }
  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
    setSecurityHeaders(res, req);
    res.setHeader("x-request-id", requestId);
    try {
      const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
      const nativeStaffPath = url.pathname.startsWith('/api/staff/native/') || ['/staff', '/staff/login', '/login/staff'].includes(url.pathname);
      const tableOrderPath = url.pathname === "/order" || url.pathname.startsWith("/api/table/");
      const menuCatalogApi = url.pathname === "/api/menu/catalog";
      if (productionRuntime && tableOrderPath && requestHostname(req) !== tableOrderHost) throw apiError("not_found", 404);
      if (productionRuntime && nativeStaff && req.method === 'GET' && (url.pathname === '/hr' || url.pathname === '/hr/')) {
        res.writeHead(308, { location: '/dashboard#workforce' });
        return res.end();
      }
      if (productionRuntime && nativeStaff && (
        url.pathname.startsWith('/hr/') ||
        url.pathname.startsWith('/api/hrpos/') || url.pathname.startsWith('/api/hr/') ||
        (url.pathname.startsWith('/api/staff/') && !url.pathname.startsWith('/api/staff/native/'))
      )) throw apiError('legacy_workforce_retired',410);
      if (productionRuntime && nativeStaffPath && String(req.headers.host ?? '').split(':')[0] !== 'staff.example.invalid' && url.pathname !== '/staff') throw apiError('not_found',404);
      if (productionRuntime && url.pathname === "/") {
        const surface = String(req.headers.host).split(".")[0];
        res.writeHead(303, { location: surface === 'staff' ? '/login/staff' : ["admin", "cashier", "kds", "kiosk", "menu"].includes(surface) ? `/${surface}` : "/dashboard" });
        return res.end();
      }
      if (operatorPreview && url.pathname.startsWith("/api/kiosk/")) throw apiError("not_found", 404);
      if (req.method === "GET" && url.pathname === "/api/hrpos/config") return json(res, 200, { enabled: Boolean(hrpos) });
      if (req.method === "POST" && url.pathname === "/api/hrpos/start") {
        if (!hrpos) throw apiError("hrpos_disabled", 503);
        assertSameOrigin(req);
        loginLimiter.consume(`hrpos-start:${clientKey(req)}`);
        const body = await readJson(req);
        const flow = await hrpos.begin(body.role ?? "hr");
        res.setHeader("set-cookie", `${hrpos.cookieName}=${flow.flowSecret}; HttpOnly; SameSite=Lax; Path=/; Max-Age=300${hrpos.syntheticLoopback ? "" : "; Secure"}`);
        return json(res, 200, { redirectUrl: flow.redirectUrl });
      }
      if (req.method === "GET" && url.pathname === "/hr/callback") {
        if (!hrpos) throw apiError("hrpos_disabled", 503);
        const clearFlow = `${hrpos.cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${hrpos.syntheticLoopback ? "" : "; Secure"}`;
        res.setHeader("set-cookie", clearFlow);
        try {
          if (`${requestProtocol(req)}://${req.headers.host}/hr/callback` !== hrpos.scope.redirectUri) throw apiError("hrpos_flow_invalid", 401);
          const session = await hrpos.complete({ flowSecret: parseCookies(req.headers.cookie)[hrpos.cookieName], state: url.searchParams.get("state"), code: url.searchParams.get("code"), makeSession: (subject) => createSession({ subject, clock }) });
          operatorSessions.set(session.tokenHash, session);
          setCookie(req, res, "saga_pos_operator", session.token, Math.max(1, Math.floor((Date.parse(session.expiresAt) - clock().getTime()) / 1000)), productionRuntime);
          res.setHeader("set-cookie", [res.getHeader("set-cookie"), clearFlow]);
          res.writeHead(303, { location: hrLanding(session.subject.role), "cache-control": "no-store", "referrer-policy": "no-referrer" });
        } catch { res.writeHead(303, { location: "/hr?login=failed", "cache-control": "no-store", "referrer-policy": "no-referrer" }); }
        return res.end();
      }
      if (durableSessions && (url.pathname.startsWith("/api/") || (teamAccess && req.method === "GET") || (productionRuntime && url.pathname === "/kiosk")) && url.pathname !== "/api/health") {
        const cookies = parseCookies(req.headers.cookie);
        for (const [kind, sessions] of [["kiosk", kioskSessions], ["operator", operatorSessions]]) {
          const token = cookies[`saga_pos_${kind}`];
          if (!token) continue;
          const tokenHash = digest(token);
          const saved = await durableSessions.loadHttpSession({ ...runtime.ids, kind, tokenHash });
          if (saved) sessions.set(tokenHash, saved);
          else sessions.delete(tokenHash);
        }
        const tableToken = cookies.saga_pos_table;
        if (tableToken) {
          const tokenHash = digest(tableToken);
          const saved = await durableSessions.loadHttpSession({ ...runtime.ids, kind: "kiosk", tokenHash });
          if (saved) tableSessions.set(tokenHash, saved);
          else tableSessions.delete(tokenHash);
        }
        const menuKioskDemoToken = cookies.saga_pos_menu_kiosk_demo;
        if (menuKioskDemoToken) {
          const tokenHash = digest(menuKioskDemoToken);
          const saved = await durableSessions.loadHttpSession({ ...runtime.ids, kind: "kiosk", tokenHash });
          if (saved) menuKioskDemoSessions.set(tokenHash, saved);
          else menuKioskDemoSessions.delete(tokenHash);
        }
        if (nativeStaffPath && nativeStaff) {
          const token = cookies.saga_pos_staff;
          if (token) {
            const tokenHash = digest(token);
            const saved = await durableSessions.loadHttpSession({ ...runtime.ids, kind: 'staff', tokenHash });
            if (saved) staffSessions.set(tokenHash, saved);
            else staffSessions.delete(tokenHash);
          }
        }
      }
      // Team-managed identity is refreshed before any legacy endpoint, including
      // HTML navigation. Revoked roles/accounts cannot retain cached privileges.
      let teamSession = teamAccess && findSession(req, operatorSessions, clock, "saga_pos_operator");
      if (teamSession?.subject.teamManaged && !['/api/team/login','/api/operator/login','/api/operator/logout'].includes(url.pathname)) {
        try { teamSession.subject = await teamAccess.resolve(teamSession.subject); }
        catch(error) { if(url.pathname!=='/team-access') throw error; clearCookie(res,'saga_pos_operator'); operatorSessions.delete(teamSession.tokenHash); teamSession=null; }
      }
      if (teamAccess && url.pathname === '/api/team/login' && req.method === 'POST') {
        assertSameOrigin(req); loginLimiter.consume(`team-login:${clientKey(req)}`);
        const loginInput=await readJson(req);
        if(loginInput.outletId!==runtime.ids.outletId)throw apiError('identity_invalid',401);
        const actor = await teamAccess.login(loginInput);
        if (actor.role === 'owner') throw apiError('owner_login_via_dashboard_required',401);
        const session = createSession({ subject: actor, clock });
        await persistSession('operator', session); operatorSessions.set(session.tokenHash, session);
        setCookie(req,res,'saga_pos_operator',session.token,4*60*60,productionRuntime);
        return json(res,200,{actor:await teamAccess.resolve(actor),csrfToken:session.csrfToken});
      }
      if (teamAccess && url.pathname === '/api/team/config' && req.method === 'GET') return json(res,200,{organizationId:teamAccess.organizationId,outletIds:[runtime.ids.outletId]});
      if (url.pathname.startsWith('/api/team/')) {
        if (!teamAccess) throw apiError('team_access_disabled',503);
        const session = requireSession(req,operatorSessions,clock,'saga_pos_operator');
        if (!session.subject.teamManaged) throw apiError('team_login_required',401);
        if (req.method === 'GET' && url.pathname === '/api/team/session') return json(res,200,{actor:session.subject,csrfToken:session.csrfToken});
        if (['POST','PUT','PATCH','DELETE'].includes(req.method)) { assertSameOrigin(req); assertCsrf(req,session); loginLimiter.consume(`team-write:${clientKey(req)}`); }
        if (req.method === 'POST' && url.pathname === '/api/team/password') {
          const result=await teamAccess.changePassword(session.subject,await readJson(req));
          await revokeSession('operator',session.tokenHash);operatorSessions.delete(session.tokenHash);clearCookie(res,'saga_pos_operator');
          return json(res,200,result);
        }
        if (session.subject.passwordChangeRequired) throw apiError('password_change_required',403);
        if (req.method === 'GET' && url.pathname === '/api/team/state') return json(res,200,await teamAccess.list(session.subject));
        if (req.method === 'GET' && url.pathname === '/api/team/audit') return json(res,200,{events:await teamAccess.audit(session.subject)});
        if (req.method === 'GET' && url.pathname === '/api/team/preview') return json(res,200,await teamAccess.preview(session.subject,url.searchParams.get('roleId')));
        const operations = { '/api/team/roles': 'saveRole', '/api/team/accounts': 'createAccount', '/api/team/accounts/update': 'updateAccount', '/api/team/accounts/reset': 'resetAccount' };
        if (req.method === 'POST' && operations[url.pathname]) return json(res,200,await teamAccess[operations[url.pathname]](session.subject,await readJson(req)));
        const workspace = /^\/api\/team\/workspace\/([a-z]+)(\.csv)?$/.exec(url.pathname);
        if (workspace && req.method === 'GET') {
          if (workspace[2]) { const csv = await teamOperations.export(session.subject,workspace[1]); res.writeHead(200,{'content-type':'text/csv; charset=utf-8','cache-control':'no-store'}); return res.end(csv); }
          return json(res,200,{data:await teamOperations.state(session.subject,workspace[1])});
        }
        if (workspace && !workspace[2] && req.method === 'POST') return json(res,200,{data:await teamOperations.action(session.subject,workspace[1],await readJson(req))});
        throw apiError('not_found',404);
      }
      if (teamAccess && teamSession && !teamSession.subject.teamManaged && !nativeStaffPath && url.pathname.startsWith('/api/') && !['/api/operator/login','/api/operator/logout','/api/health','/api/menu/catalog'].includes(url.pathname)) throw apiError('team_login_required',401);
      if (teamSession?.subject.teamManaged && !teamSession.subject.systemOwner) {
        const subject = teamSession.subject;
        if (url.pathname === '/api/operator/logout') { /* common secure logout below */ }
        else if (url.pathname === '/api/operator/state' && req.method === 'GET') {
          const feature = url.searchParams.get('surface') === 'cashier' ? 'orders' : 'kds';
          const data = await teamOperations.state(subject,feature);
          return json(res,200,{...data,actor:{...subject,role:feature==='kds'?'bar':'cashier',mode:feature==='kds'?'KDS':'CASHIER'},permissions:subject.permissions,context:deliveryContext,csrfToken:teamSession.csrfToken});
        } else if (url.pathname === '/api/cashier/recovery' && req.method === 'GET') {
          if ([...url.searchParams.keys()].some(key => key !== 'key')) throw apiError('request_invalid',422);
          return json(res,200,await teamOperations.cashierRecovery(subject,url.searchParams.get('key')));
        } else if (url.pathname === '/api/cashier/manual-qris/image' && req.method === 'GET') {
          await teamAccess.authorize(subject,'qris.view'); // Shared authenticated image response below.
        } else if (url.pathname.startsWith('/api/cashier/') && req.method === 'POST') {
          assertSameOrigin(req); assertCsrf(req,teamSession); checkoutLimiter.consume(`team-cash:${clientKey(req)}`);
          const body = await readJson(req); return json(res,200,await teamOperations.cashier(subject,url.pathname,body));
        } else if (url.pathname === '/api/operator/fulfillment' && req.method === 'POST') {
          assertSameOrigin(req); assertCsrf(req,teamSession);
          return json(res,200,await teamOperations.fulfillment(subject,await readJson(req)));
        } else if (url.pathname.startsWith('/api/') && !['/api/health','/api/menu/catalog'].includes(url.pathname)) throw apiError('permission_denied',403);
        if (req.method === 'GET' && ['/cashier','/cashier.html','/kds','/operator.html','/dashboard','/admin','/admin.html','/ap','/hr','/inventory-reports','/inventory-reports.html','/ap.html','/hr.html'].includes(url.pathname)) {
          const permission = ['/cashier','/cashier.html'].includes(url.pathname) ? 'orders.view' : url.pathname === '/kds' ? 'kds.view' : null;
          if (!permission) throw apiError('permission_denied',403);
          await teamAccess.authorize(subject,permission);
        }
      }
      const operatorApi = !nativeStaffPath && (/^\/api\/(operator|admin|ap|cashier|hr|staff)(?:\/|$)/.test(url.pathname) || url.pathname === "/api/hrpos/role");
      const basicProtectedKiosk = productionRuntime && isBasicProtectedKioskRequest(req);
      if (productionRuntime && ownerAuth && url.pathname === "/kiosk" && !basicProtectedKiosk && findSession(req, operatorSessions, clock, "saga_pos_operator")?.subject.authProvider !== "production_owner") {
        res.writeHead(303, { location: "/dashboard?next=%2Fkiosk" });
        return res.end();
      }
      // The kiosk's catalogue event stream shares its kiosk session, not the
      // dashboard Owner session. Rejecting it as an operator API makes the
      // browser discard its Basic Auth cache and repeatedly prompt the guest.
      const basicProtectedKioskApi = basicProtectedKiosk && (
        url.pathname.startsWith("/api/kiosk/")
        || (req.method === "GET" && url.pathname === "/api/catalog/events")
      );
      const tableOrderApi = url.pathname.startsWith("/api/table/");
      const menuKioskDemoApi = url.pathname.startsWith("/api/menu-kiosk/");
      if (productionRuntime && ownerAuth && !nativeStaffPath && !teamSession?.subject.teamManaged && url.pathname.startsWith("/api/") && !["/api/health", "/api/operator/login"].includes(url.pathname) && !basicProtectedKioskApi && !tableOrderApi && !menuKioskDemoApi && !menuCatalogApi) {
        const ownerSession = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        if (ownerSession.subject.authProvider !== "production_owner" || ownerSession.subject.role !== "owner") throw apiError("identity_invalid", 401);
      }
      if (operatorApi && !teamSession?.subject.teamManaged && !["/api/operator/login", "/api/operator/logout"].includes(url.pathname)) {
        const active = findSession(req, operatorSessions, clock, "saga_pos_operator");
        if (active?.subject.authProvider === "hrpos") {
          if (!hrpos) throw apiError("hrpos_disabled", 503);
          active.subject = await hrpos.identity(active.tokenHash, active.subject.role);
          if (url.pathname.startsWith("/api/cashier/") && !active.subject.employeeId) throw apiError("hrpos_staff_binding_required", 403);
        } else if (hrpos && active && active.subject.authProvider !== "production_owner") throw apiError("hrpos_login_required", 401);
        else if (productionRuntime && active?.subject.authProvider !== "production_owner") throw apiError("production_owner_auth_required", 401);
      }
      if (nativeStaffPath && url.pathname.startsWith('/api/staff/native/')) {
        if (!nativeStaff) throw apiError('native_staff_disabled',503);
        if (req.method === 'POST' && url.pathname === '/api/staff/native/login') {
          if (url.search) throw apiError('request_invalid',422);
          assertSameOrigin(req);
          loginLimiter.consume(`native-staff:${clientKey(req)}`);
          const subject = await nativeStaff.login(await readJson(req));
          const session = createSession({ subject, clock });
          await persistSession('staff', session);
          staffSessions.set(session.tokenHash, session);
          setCookie(req,res,'saga_pos_staff',session.token,4*60*60,productionRuntime);
          return json(res,200,{ staff: subject, csrfToken: session.csrfToken });
        }
        const session = requireSession(req,staffSessions,clock,'saga_pos_staff');
        session.subject = await nativeStaff.validateSession(session.subject);
        const receivingContext = staffReceivingContext(runtime, session.subject);
        if (req.method === 'GET' && url.pathname === '/api/staff/native/session') {
          const capabilities = staffInventoryReceiving ? (await staffInventoryReceiving.service.getStaffCapabilities(receivingContext)).capabilities : [];
          return json(res,200,{ staff: { ...session.subject, capabilities }, capabilities, csrfToken: session.csrfToken });
        }
        if (['POST','PUT','PATCH','DELETE'].includes(req.method)) { assertSameOrigin(req); assertCsrf(req,session); }
        if (req.method === 'POST' && url.pathname === '/api/staff/native/logout') {
          if (url.search) throw apiError('request_invalid',422);
          await revokeSession('staff',session.tokenHash); staffSessions.delete(session.tokenHash); clearCookie(res,'saga_pos_staff');
          return json(res,200,{ authenticated:false });
        }
        if (req.method === 'POST' && url.pathname === '/api/staff/native/password') {
          if (url.search) throw apiError('request_invalid',422);
          const body = await readJson(req);
          const result = await nativeStaff.changePassword(session.subject.staffId,body.currentPassword,body.nextPassword);
          await revokeSession('staff',session.tokenHash); staffSessions.delete(session.tokenHash); clearCookie(res,'saga_pos_staff');
          return json(res,200,{ ...result, loginAgain:true });
        }
        if (session.subject.passwordChangeRequired) throw apiError('password_change_required',403);
        if (req.method === 'GET' && url.pathname === '/api/staff/native/home') {
          if (url.search) throw apiError('request_invalid',422);
          const data = await nativeStaff.home(session.subject.staffId);
          const receiving = staffInventoryReceiving ? await staffInventoryReceiving.service.getStaffCapabilities(receivingContext) : { capabilities: [] };
          return json(res,200,{ data: { ...data, receiving },csrfToken:session.csrfToken });
        }
        if (req.method === 'GET' && url.pathname === '/api/staff/native/attendance/eligibility') {
          if (url.search) throw apiError('request_invalid',422);
          return json(res,200,{data:await nativeStaff.attendanceEligibility(session.subject.staffId)});
        }
        const attendanceOperationRoute='/api/staff/native/attendance/operations/';
        const attendanceOperationMatch=url.pathname.startsWith(attendanceOperationRoute)?url.pathname.match(/^\/api\/staff\/native\/attendance\/operations\/([0-9a-f-]{36})$/i):null;
        if(req.method==='GET'&&attendanceOperationMatch){
          if(url.search)throw apiError('request_invalid',422);
          return json(res,200,{data:await nativeStaff.attendanceOperationStatus(session.subject.staffId,attendanceOperationMatch[1])});
        }
        if(req.method==='GET'&&url.pathname==='/api/staff/native/schedules'){
          if([...url.searchParams.keys()].some((key)=>!['from','to'].includes(key)))throw apiError('request_invalid',422);
          return json(res,200,{data:await nativeStaff.listSchedules(session.subject.staffId,{from:url.searchParams.get('from')??undefined,to:url.searchParams.get('to')??undefined})});
        }
        const staffScheduleMatch=url.pathname.match(/^\/api\/staff\/native\/schedules\/([0-9a-f-]{36})$/i);
        if(req.method==='GET'&&staffScheduleMatch){
          if(url.search)throw apiError('request_invalid',422);
          return json(res,200,{data:await nativeStaff.getSchedule(session.subject.staffId,staffScheduleMatch[1])});
        }
        if(req.method==='GET'&&url.pathname==='/api/staff/native/requests'){
          if([...url.searchParams.keys()].some((key)=>!['status','category','limit','before'].includes(key)))throw apiError('request_invalid',422);
          return json(res,200,{data:await nativeStaff.listRequests(session.subject.staffId,{status:url.searchParams.get('status')??undefined,category:url.searchParams.get('category')??undefined,limit:url.searchParams.get('limit')??undefined,before:url.searchParams.get('before')??undefined})});
        }
        const staffRequestMatch=url.pathname.match(/^\/api\/staff\/native\/requests\/([0-9a-f-]{36})$/i);
        if(req.method==='GET'&&staffRequestMatch){
          if(url.search)throw apiError('request_invalid',422);
          return json(res,200,{data:await nativeStaff.getRequest(session.subject.staffId,staffRequestMatch[1])});
        }
        if (req.method === 'POST' && url.pathname === '/api/staff/native/attendance/diagnostic') {
          if (url.search) throw apiError('request_invalid',422);
          attendanceDiagnosticLimiter.consume(`staff-attendance-diagnostic:${session.subject.staffId}:${clientKey(req)}`);
          const input=await readJson(req),safe=(value,max=64)=>String(value??'').replace(/[^a-zA-Z0-9_.:-]/g,'_').slice(0,max),httpStatus=input.httpStatus==null?null:Number(input.httpStatus);
          const diagnostic={event:'attendance.client_diagnostic',stage:safe(input.stage),code:safe(input.code),httpStatus:Number.isInteger(httpStatus)&&httpStatus>=0&&httpStatus<=599?httpStatus:null,appVersion:safe(input.appVersion),appMode:['browser','standalone'].includes(input.appMode)?input.appMode:'unknown',online:input.online===true,visibility:['visible','hidden','prerender'].includes(input.visibility)?input.visibility:'unknown',contentType:['image/jpeg','image/png','image/webp'].includes(input.contentType)?input.contentType:undefined,byteSize:Number.isSafeInteger(Number(input.byteSize))&&Number(input.byteSize)>=0&&Number(input.byteSize)<=10*1024*1024?Number(input.byteSize):undefined};
          console.warn(JSON.stringify(diagnostic));
          return json(res,202,{accepted:true});
        }
        if (req.method === 'POST' && url.pathname === '/api/staff/native/attendance/prepare') {
          if (url.search) throw apiError('request_invalid',422);
          attendanceMutationLimiter.consume(`staff-attendance:${session.subject.staffId}:${clientKey(req)}`);
          return json(res,201,{data:await nativeStaff.prepareAttendance(session.subject.staffId,{...(await readJson(req)),sessionBinding:session.tokenHash})});
        }
        if (req.method === 'POST' && url.pathname === '/api/staff/native/attendance/evidence/init') {
          if (url.search) throw apiError('request_invalid',422);
          attendanceMutationLimiter.consume(`staff-attendance:${session.subject.staffId}:${clientKey(req)}`);
          const created=await nativeStaff.initializeAttendanceEvidence(session.subject.staffId,{...(await readJson(req)),sessionBinding:session.tokenHash});
          return json(res,201,{data:{...created,uploadUrl:`/api/staff/native/attendance/evidence/${created.evidenceId}/upload`,uploadMethod:'PUT',uploadHeaders:{'x-csrf-token':session.csrfToken}}});
        }
        const attendanceEvidenceUpload=url.pathname.match(/^\/api\/staff\/native\/attendance\/evidence\/([0-9a-f-]{36})\/upload$/i);
        if(attendanceEvidenceUpload&&req.method==='PUT'){
          if(url.search)throw apiError('request_invalid',422);
          receiptUploadLimiter.consume(`staff-attendance-upload:${session.subject.staffId}:${clientKey(req)}`);
          const contentLength=Number(req.headers['content-length']),contentType=String(req.headers['content-type']??'').split(';')[0].trim().toLowerCase(),checksum=String(req.headers['x-content-sha256']??'').trim().toLowerCase();
          return json(res,200,{data:await nativeStaff.uploadAttendanceEvidence(session.subject.staffId,attendanceEvidenceUpload[1],{body:req,contentLength,contentType,checksum})});
        }
        if (staffInventoryReceiving && req.method === 'GET' && url.pathname === '/api/staff/native/inventory-receiving/catalog') {
          if (url.search) throw apiError('request_invalid',422);
          return json(res,200,{ data:await staffInventoryReceiving.catalog(receivingContext) });
        }
        if (staffInventoryReceiving && req.method === 'POST' && url.pathname === '/api/staff/native/inventory-receipts/draft') {
          if (url.search) throw apiError('request_invalid',422);
          return json(res,201,{ data:await staffInventoryReceiving.service.createDraft(receivingContext,await readJson(req)) });
        }
        if (staffInventoryReceiving && req.method === 'GET' && url.pathname === '/api/staff/native/inventory-receipts/mine') {
          if ([...url.searchParams.keys()].some((key)=>!['limit','before'].includes(key))) throw apiError('request_invalid',422);
          return json(res,200,{ data:await staffInventoryReceiving.service.listMine(receivingContext,{limit:url.searchParams.get('limit') == null ? 50 : Number(url.searchParams.get('limit')),before:url.searchParams.get('before')}) });
        }
        const staffReceiptMatch = url.pathname.match(/^\/api\/staff\/native\/inventory-receipts\/([0-9a-f-]{36})$/i);
        if (staffInventoryReceiving && staffReceiptMatch && req.method === 'GET') {
          if (url.search) throw apiError('request_invalid',422);
          return json(res,200,{ data:await staffInventoryReceiving.service.getReceipt(receivingContext,staffReceiptMatch[1]) });
        }
        if (staffInventoryReceiving && staffReceiptMatch && req.method === 'PATCH') {
          if (url.search) throw apiError('request_invalid',422);
          return json(res,200,{ data:await staffInventoryReceiving.service.updateDraft(receivingContext,staffReceiptMatch[1],await readJson(req)) });
        }
        const staffPhotoInitMatch = url.pathname.match(/^\/api\/staff\/native\/inventory-receipts\/([0-9a-f-]{36})\/photos\/init$/i);
        if (staffInventoryReceiving && staffPhotoInitMatch && req.method === 'POST') {
          if (url.search) throw apiError('request_invalid',422);
          const created = await staffInventoryReceiving.service.initializeEvidence(receivingContext,staffPhotoInitMatch[1],await readJson(req));
          return json(res,201,{ data:{ ...created,uploadUrl:`/api/staff/native/inventory-receipts/${staffPhotoInitMatch[1]}/photos/${created.evidenceId}/upload`,uploadMethod:'PUT',uploadHeaders:{'x-csrf-token':session.csrfToken} } });
        }
        const staffPhotoUploadMatch = url.pathname.match(/^\/api\/staff\/native\/inventory-receipts\/([0-9a-f-]{36})\/photos\/([0-9a-f-]{36})\/upload$/i);
        if (staffInventoryReceiving && staffPhotoUploadMatch && req.method === 'PUT') {
          if (url.search) throw apiError('request_invalid',422);
          receiptUploadLimiter.consume(`staff-receipt-upload:${session.subject.staffId}:${clientKey(req)}`);
          const contentLength = Number(req.headers['content-length']);
          const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
          const checksum = String(req.headers['x-content-sha256'] ?? '').trim().toLowerCase();
          return json(res,200,{ data:await staffInventoryReceiving.service.uploadEvidence(receivingContext,staffPhotoUploadMatch[1],staffPhotoUploadMatch[2],{body:req,contentLength,contentType,checksum}) });
        }
        const staffPhotoDeleteMatch = url.pathname.match(/^\/api\/staff\/native\/inventory-receipts\/([0-9a-f-]{36})\/photos\/([0-9a-f-]{36})$/i);
        if (staffInventoryReceiving && staffPhotoDeleteMatch && req.method === 'DELETE') {
          if (url.search) throw apiError('request_invalid',422);
          await discardRequestBody(req);
          return json(res,200,{ data:await staffInventoryReceiving.service.deleteEvidence(receivingContext,staffPhotoDeleteMatch[1],staffPhotoDeleteMatch[2]) });
        }
        const staffSubmitMatch = url.pathname.match(/^\/api\/staff\/native\/inventory-receipts\/([0-9a-f-]{36})\/submit$/i);
        if (staffInventoryReceiving && staffSubmitMatch && req.method === 'POST') {
          if (url.search) throw apiError('request_invalid',422);
          return json(res,200,{ data:await staffInventoryReceiving.service.submit(receivingContext,staffSubmitMatch[1],await readJson(req)) });
        }
        const staffEvidenceMatch = url.pathname.match(/^\/api\/staff\/native\/inventory-receipts\/([0-9a-f-]{36})\/(?:evidence\/([0-9a-f-]{36})|photos\/([0-9a-f-]{36})\/content)$/i);
        if (staffInventoryReceiving && staffEvidenceMatch && req.method === 'GET') {
          if (url.search) throw apiError('request_invalid',422);
          return streamReceiptEvidence(res,await staffInventoryReceiving.service.openEvidence(receivingContext,staffEvidenceMatch[1],staffEvidenceMatch[2] ?? staffEvidenceMatch[3]));
        }
        if (url.search) throw apiError('request_invalid',422);
        if (req.method === 'POST' && url.pathname === '/api/staff/native/clock-in') { attendanceMutationLimiter.consume(`staff-attendance:${session.subject.staffId}:${clientKey(req)}`); return json(res,200,{ data:await nativeStaff.clockIn(session.subject.staffId,{...(await readJson(req)),sessionBinding:session.tokenHash}) }); }
        if (req.method === 'POST' && url.pathname === '/api/staff/native/clock-out') { attendanceMutationLimiter.consume(`staff-attendance:${session.subject.staffId}:${clientKey(req)}`); return json(res,200,{ data:await nativeStaff.clockOut(session.subject.staffId,{...(await readJson(req)),sessionBinding:session.tokenHash}) }); }
        if (req.method === 'POST' && ['/api/staff/native/attendance/correction','/api/staff/native/attendance/correction-request'].includes(url.pathname)) { attendanceCorrectionLimiter.consume(`staff-attendance-correction:${session.subject.staffId}:${clientKey(req)}`); return json(res,201,{data:await nativeStaff.submitAttendanceCorrection(session.subject.staffId,await readJson(req))}); }
        if (req.method === 'POST' && url.pathname === '/api/staff/native/request') return json(res,201,{ data:await nativeStaff.submitRequest(session.subject.staffId,await readJson(req)) });
        if (req.method === 'POST' && url.pathname === '/api/staff/native/peer-decision') {
          const body = await readJson(req);
          return json(res,200,{ data:await nativeStaff.peerDecision(session.subject.staffId,body.requestId,body.accept===true) });
        }
        throw apiError('not_found',404);
      }
      if (url.pathname.startsWith('/api/operator/inventory-receipts')) {
        if (!staffInventoryReceiving) throw apiError('staff_receiving_disabled',503);
        const owner = requireOwnerSession(req,operatorSessions,clock);
        if (owner.subject.authProvider !== 'production_owner' && productionRuntime) throw apiError('owner_required',403);
        const receivingContext = ownerReceivingContext(runtime, owner.subject);
        if (req.method === 'GET' && url.pathname === '/api/operator/inventory-receipts/capabilities') {
          if (url.search) throw apiError('request_invalid',422);
          return json(res,200,await staffInventoryReceiving.service.listStaffCapabilitiesForOwner(receivingContext));
        }
        if (req.method === 'POST' && url.pathname === '/api/operator/inventory-receipts/capabilities') {
          if (url.search) throw apiError('request_invalid',422);
          assertSameOrigin(req); assertCsrf(req,owner);
          return json(res,200,{ data:await staffInventoryReceiving.service.setStaffCapabilities(receivingContext,await readJson(req)) });
        }
        if (req.method === 'GET' && url.pathname === '/api/operator/inventory-receipts') {
          if ([...url.searchParams.keys()].some((key)=>!['limit','before','status'].includes(key))) throw apiError('request_invalid',422);
          return json(res,200,await staffInventoryReceiving.service.listForOwner(receivingContext,{limit:url.searchParams.get('limit') == null ? 100 : Number(url.searchParams.get('limit')),before:url.searchParams.get('before'),status:url.searchParams.get('status')}));
        }
        if (req.method === 'GET' && url.pathname === '/api/operator/inventory-receipts/posting-recovery') {
          if ([...url.searchParams.keys()].some((key)=>!['limit','staleBefore'].includes(key))) throw apiError('request_invalid',422);
          return json(res,200,{ data:await staffInventoryReceiving.service.listPostingRecovery(receivingContext,{limit:url.searchParams.get('limit') == null ? 50 : Number(url.searchParams.get('limit')),staleBefore:url.searchParams.get('staleBefore')}) });
        }
        const ownerEvidenceMatch = url.pathname.match(/^\/api\/operator\/inventory-receipts\/([0-9a-f-]{36})\/(?:evidence\/([0-9a-f-]{36})|photos\/([0-9a-f-]{36})\/content)$/i);
        if (ownerEvidenceMatch && req.method === 'GET') {
          if (url.search) throw apiError('request_invalid',422);
          return streamReceiptEvidence(res,await staffInventoryReceiving.service.openEvidence(receivingContext,ownerEvidenceMatch[1],ownerEvidenceMatch[2] ?? ownerEvidenceMatch[3]));
        }
        const ownerReviewMatch = url.pathname.match(/^\/api\/operator\/inventory-receipts\/([0-9a-f-]{36})\/review$/i);
        if (ownerReviewMatch && req.method === 'POST') {
          if (url.search) throw apiError('request_invalid',422);
          assertSameOrigin(req); assertCsrf(req,owner);
          return json(res,200,{ data:await staffInventoryReceiving.service.review(receivingContext,ownerReviewMatch[1],await readJson(req)) });
        }
        const ownerRecoveryClaimMatch = url.pathname.match(/^\/api\/operator\/inventory-receipts\/([0-9a-f-]{36})\/posting-recovery\/claim$/i);
        if (ownerRecoveryClaimMatch && req.method === 'POST') {
          if (url.search) throw apiError('request_invalid',422);
          assertSameOrigin(req); assertCsrf(req,owner);
          return json(res,200,{ data:await staffInventoryReceiving.service.claimPostingRecovery(receivingContext,ownerRecoveryClaimMatch[1],await readJson(req)) });
        }
        const ownerRecoveryRetryMatch = url.pathname.match(/^\/api\/operator\/inventory-receipts\/([0-9a-f-]{36})\/posting-recovery\/retry$/i);
        if (ownerRecoveryRetryMatch && req.method === 'POST') {
          if (url.search) throw apiError('request_invalid',422);
          assertSameOrigin(req); assertCsrf(req,owner);
          return json(res,200,{ data:await staffInventoryReceiving.service.retryClaimedPosting(receivingContext,ownerRecoveryRetryMatch[1],await readJson(req)) });
        }
        const ownerCorrectionMatch = url.pathname.match(/^\/api\/operator\/inventory-receipts\/([0-9a-f-]{36})\/correction$/i);
        if (ownerCorrectionMatch && req.method === 'POST') {
          if (url.search) throw apiError('request_invalid',422);
          assertSameOrigin(req); assertCsrf(req,owner);
          return json(res,409,{ data:await staffInventoryReceiving.service.requestPostedCorrection(receivingContext,ownerCorrectionMatch[1],await readJson(req)) });
        }
        const ownerReceiptMatch = url.pathname.match(/^\/api\/operator\/inventory-receipts\/([0-9a-f-]{36})$/i);
        if (ownerReceiptMatch && req.method === 'GET') {
          if (url.search) throw apiError('request_invalid',422);
          return json(res,200,await staffInventoryReceiving.service.getForOwner(receivingContext,ownerReceiptMatch[1]));
        }
        throw apiError('not_found',404);
      }
      if (url.pathname.startsWith('/api/operator/native-staff/')) {
        if (!nativeStaff) throw apiError('native_staff_disabled',503);
        const owner = requireOwnerSession(req,operatorSessions,clock);
        if (owner.subject.authProvider !== 'production_owner' && productionRuntime) throw apiError('owner_required',403);
        if (req.method === 'GET' && url.pathname === '/api/operator/native-staff/report') {
          if ([...url.searchParams.keys()].some((key)=>!['from','to'].includes(key))) throw apiError('request_invalid',422);
          return json(res,200,{ data:await nativeStaff.report({from:url.searchParams.get('from'),to:url.searchParams.get('to')}) });
        }
        if (url.search) throw apiError('request_invalid',422);
        if (req.method === 'GET' && url.pathname === '/api/operator/native-staff/state') return json(res,200,{ data:await nativeStaff.listOwner() });
        const attendanceEvidenceRead=url.pathname.match(/^\/api\/operator\/native-staff\/attendance-evidence\/([0-9a-f-]{36})\/content$/i);
        if(attendanceEvidenceRead&&req.method==='GET'){attendanceEvidenceReadLimiter.consume(`owner-attendance-evidence:${owner.subject.employeeId??'owner'}:${clientKey(req)}`);return streamReceiptEvidence(res,await nativeStaff.openAttendanceEvidence(attendanceEvidenceRead[1],{actorReference:owner.subject.employeeId??'OWNER'}));}
        if (req.method !== 'POST') throw apiError('not_found',404);
        assertSameOrigin(req); assertCsrf(req,owner);
        const input = await readJson(req);
        const actions = {
          '/api/operator/native-staff/create': () => nativeStaff.createAccount(input),
          '/api/operator/native-staff/reset': () => nativeStaff.resetPassword(input.staffId),
          '/api/operator/native-staff/account-state': () => nativeStaff.setAccountState(input.staffId,input.state),
          '/api/operator/native-staff/profile-update': () => nativeStaff.updateProfile(input),
          '/api/operator/native-staff/pay-rate': () => nativeStaff.setPayRate(input),
          '/api/operator/native-staff/template-create': () => nativeStaff.createShiftTemplate(input),
          '/api/operator/native-staff/template-update': () => nativeStaff.updateShiftTemplate(input),
          '/api/operator/native-staff/template-state': () => nativeStaff.setShiftTemplateState(input.templateId,input.state),
          '/api/operator/native-staff/roster-load': () => nativeStaff.loadRoster(input),
          '/api/operator/native-staff/roster-assignment': () => nativeStaff.saveRosterAssignment(input),
          '/api/operator/native-staff/roster-bulk-assign': () => nativeStaff.bulkAssignRoster(input),
          '/api/operator/native-staff/roster-copy-pattern': () => nativeStaff.copyRosterPattern(input),
          '/api/operator/native-staff/roster-rules-save': () => nativeStaff.saveRosterRules(input),
          '/api/operator/native-staff/roster-generate': () => nativeStaff.generateRoster(input),
          '/api/operator/native-staff/roster-publish': () => nativeStaff.publishRoster(input),
          '/api/operator/native-staff/roster-draft-status': () => nativeStaff.setRosterStatus(input),
          '/api/operator/native-staff/availability-save': () => nativeStaff.saveAvailability(input),
          '/api/operator/native-staff/review': () => nativeStaff.reviewRequest(input.requestId,input.decision,input.note),
          '/api/operator/native-staff/attendance-location-resolve': () => {
            attendanceLocationResolveLimiter.consume(`owner-attendance-location:${owner.subject.employeeId??'owner'}:${clientKey(req)}`);
            return resolveGoogleMapsLocation(input.mapsLink);
          },
          '/api/operator/native-staff/attendance-policy': () => nativeStaff.saveAttendancePolicy({...input,actorReference:owner.subject.employeeId??'OWNER'}),
          '/api/operator/native-staff/attendance-review': () => nativeStaff.reviewAttendance({...input,actorReference:owner.subject.employeeId??'OWNER'}),
        };
        if (!actions[url.pathname]) throw apiError('not_found',404);
        return json(res,200,{ data:await actions[url.pathname]() });
      }
      if (req.method === "GET" && url.pathname === "/api/staff/session") {
        if (!hrpos) throw apiError("hrpos_disabled", 503);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        if (session.subject.authProvider !== "hrpos" || session.subject.role !== "staff") throw apiError("hrpos_role_denied", 403);
        if (url.search) throw apiError("hrpos_operation_invalid", 422);
        return json(res, 200, { csrfToken: session.csrfToken, capabilities: { scheduleRead: session.subject.staffCapabilities?.scheduleRead === true, requestRead: session.subject.staffCapabilities?.requestRead === true, swapCancel: session.subject.staffCapabilities?.swapCancel === true, swapDecline: session.subject.staffCapabilities?.swapDecline === true } });
      }
      if (req.method === "POST" && ["/api/staff/requests/list", "/api/staff/requests/detail"].includes(url.pathname)) {
        if (!hrpos) throw apiError("hrpos_disabled", 503);
        assertSameOrigin(req);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        assertCsrf(req, session);
        if (session.subject.authProvider !== "hrpos" || session.subject.role !== "staff" || session.subject.staffCapabilities?.requestRead !== true) throw apiError("hrpos_role_denied", 403);
        if (url.search) throw apiError("hrpos_operation_invalid", 422);
        const operation = url.pathname.endsWith("/list") ? "staff.requests.list" : "staff.requests.get";
        const input = ownRequestInput(operation, await readJson(req));
        return json(res, 200, { data: ownRequestData(operation, await hrpos.command(session.tokenHash, operation, input), input) });
      }
      if (req.method === "POST" && url.pathname === "/api/staff/swaps/cancel") {
        if (!hrpos) throw apiError("hrpos_disabled", 503);
        assertSameOrigin(req);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        assertCsrf(req, session);
        if (session.subject.authProvider !== "hrpos" || session.subject.role !== "staff" || session.subject.staffCapabilities?.swapCancel !== true) throw apiError("hrpos_role_denied", 403);
        if (url.search) throw apiError("hrpos_operation_invalid", 422);
        const operation = "swaps.cancel";
        const input = ownRequestInput(operation, await readJson(req));
        return json(res, 200, { data: ownRequestData(operation, await hrpos.command(session.tokenHash, operation, input), input), csrfToken: session.csrfToken });
      }
      if (req.method === "POST" && url.pathname === "/api/staff/swaps/decline") {
        if (!hrpos) throw apiError("hrpos_disabled", 503);
        assertSameOrigin(req);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        assertCsrf(req, session);
        if (session.subject.authProvider !== "hrpos" || session.subject.role !== "staff" || session.subject.staffCapabilities?.swapDecline !== true) throw apiError("hrpos_role_denied", 403);
        if (url.search) throw apiError("hrpos_operation_invalid", 422);
        const operation = "swaps.decline";
        const input = ownRequestInput(operation, await readJson(req));
        return json(res, 200, { data: ownRequestData(operation, await hrpos.command(session.tokenHash, operation, input), input), csrfToken: session.csrfToken });
      }
      if (req.method === "GET" && url.pathname === "/api/staff/home") {
        if (!hrpos) throw apiError("hrpos_disabled", 503);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        if (session.subject.authProvider !== "hrpos" || session.subject.role !== "staff") throw apiError("hrpos_role_denied", 403);
        if (url.search) throw apiError("hrpos_operation_invalid", 422);
        return json(res, 200, { data: await hrpos.command(session.tokenHash, "staff.home", {}), csrfToken: session.csrfToken });
      }
      if (req.method === "GET" && url.pathname === "/api/hr/state") {
        if (!hrpos) throw apiError("hrpos_disabled", 503);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        if (session.subject.authProvider === "production_owner" && session.subject.role === "owner") {
          await ensureOwnerHrSession(session);
          return json(res, 200, { actor: { ...session.subject, roles: ["owner", "hr"] }, csrfToken: session.csrfToken, integrated: true, singleOwnerSession: true });
        }
        if (session.subject.authProvider !== "hrpos" || !session.subject.roles.includes("hr")) throw apiError("hrpos_role_denied", 403);
        return json(res, 200, { actor: session.subject, csrfToken: session.csrfToken, integrated: true, singleOwnerSession: false });
      }
      if (req.method === "POST" && url.pathname === "/api/hr/command") {
        if (!hrpos) throw apiError("hrpos_disabled", 503);
        assertSameOrigin(req);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        assertCsrf(req, session);
        const ownerDelegated = session.subject.authProvider === "production_owner" && session.subject.role === "owner";
        if (!ownerDelegated && session.subject.authProvider !== "hrpos") throw apiError("hrpos_login_required", 401);
        if (!ownerDelegated && session.subject.role !== "hr") throw apiError("hrpos_role_denied", 403);
        const body = await readJson(req);
        if (ownRequestOperations.has(body.operation)) throw apiError("hrpos_role_denied", 403);
        const bridgeHash = ownerDelegated ? (await ensureOwnerHrSession(session)).tokenHash : session.tokenHash;
        return json(res, 200, { data: await hrpos.command(bridgeHash, body.operation, body.input ?? {}) });
      }
      if (req.method === "POST" && url.pathname === "/api/hrpos/role") {
        if (!hrpos) throw apiError("hrpos_disabled", 503);
        assertSameOrigin(req);
        const previous = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        assertCsrf(req, previous);
        if (previous.subject.authProvider !== "hrpos") throw apiError("hrpos_login_required", 401);
        const body = await readJson(req);
        const session = await hrpos.switchRole(previous.tokenHash, body.role, (subject) => createSession({ subject, clock }));
        operatorSessions.delete(previous.tokenHash); operatorSessions.set(session.tokenHash, session);
        setCookie(req, res, "saga_pos_operator", session.token, Math.max(1, Math.floor((Date.parse(session.expiresAt) - clock().getTime()) / 1000)), productionRuntime);
        return json(res, 200, { redirectUrl: hrLanding(session.subject.role) });
      }
      if (req.method === "GET" && url.pathname === "/api/health") {
        const reporting = readInventoryReportingHealth();
        const receiving = staffInventoryReceiving ? staffInventoryReceiving.health() : { ready: false, provider: "OFF", objectStorageMigrationReady: false };
        const attendance = nativeStaff?.health ? await nativeStaff.health() : { ready:false,provider:"OFF" };
        const tableOrder = tableOrderHealth ? await tableOrderHealth() : { ready: false, mode: "OFF", payment: "OFF", businessFactsAffected: false };
        const kioskStaticDemo = kioskStaticDemoHealth ? await kioskStaticDemoHealth() : { ready: false, mode: "OFF", businessFactsAffected: false };
        return json(res, 200, { alive: true, ready: (reporting.required ? reporting.ready : true) && (!staffInventoryReceiving || receiving.ready === true) && (!productionRuntime || !nativeStaff || attendance.ready === true) && (!tableOrderHealth || tableOrder.ready === true) && (!kioskStaticDemoHealth || kioskStaticDemo.ready === true), inventoryReporting: reporting, staffInventoryReceiving: receiving, nativeStaffAttendance: attendance, tableOrder, kioskStaticDemo, retiredRouteEvidence: retiredRouteTelemetry.healthSignal(), ...deliveryContext });
      }
      if (req.method === "GET" && url.pathname === "/api/menu/catalog") {
        if (url.search) throw apiError("request_invalid", 422);
        menuCatalogLimiter.consume(`menu-catalog:${clientKey(req)}`);
        return json(res, 200, menuCatalogState(runtime, deliveryContext, clock));
      }
      if (req.method === "POST" && url.pathname === "/api/table/bootstrap") {
        if (!tableOrderAccess) throw apiError("table_order_unavailable", 503);
        tableOrderLimiter.consume(`table-bootstrap:${clientKey(req)}`);
        assertSameOrigin(req);
        const body = await readJson(req);
        const verified = tableOrderAccess.verify(body.token);
        let session = findSession(req, tableSessions, clock, "saga_pos_table");
        if (session) {
          let current = null;
          try { current = tableOrderAccess.assertSession(session.subject); }
          catch (error) {
            if (!["table_order_token_expired", "table_order_token_revoked", "table_order_session_scope_denied", "table_order_table_unavailable"].includes(error?.code)) throw error;
          }
          if (!current || current.id !== verified.tableId || body.forceFresh === true) {
            await revokeSession("kiosk", session.tokenHash);
            tableSessions.delete(session.tokenHash);
            session = null;
          }
        }
        if (!session) {
          const kiosk = await runtime.startKioskSession();
          session = createSession({ subject: {
            role: "table",
            kioskSessionId: kiosk.id,
            organizationId: verified.organizationId,
            outletId: verified.outletId,
            tableId: verified.tableId,
            tableLabel: verified.tableLabel,
            tableTokenVersion: verified.tokenVersion,
            tableTokenExpiresAt: verified.expiresAt,
          }, clock });
          await persistSession("kiosk", session);
          tableSessions.set(session.tokenHash, session);
          setCookie(req, res, "saga_pos_table", session.token, 4 * 60 * 60, productionRuntime);
        }
        const table = tableOrderAccess.assertSession(session.subject);
        const snapshot = await runtime.kioskState(session.subject.kioskSessionId);
        return json(res, 200, tableOrderState(snapshot, table, deliveryContext, session.csrfToken));
      }
      if (req.method === "GET" && url.pathname === "/api/table/state") {
        if (!tableOrderAccess) throw apiError("table_order_unavailable", 503);
        const session = requireSession(req, tableSessions, clock, "saga_pos_table");
        const table = tableOrderAccess.assertSession(session.subject);
        const snapshot = await runtime.kioskState(session.subject.kioskSessionId);
        return json(res, 200, tableOrderState(snapshot, table, deliveryContext, session.csrfToken));
      }
      if (req.method === "GET" && url.pathname === "/api/table/events") {
        if (!tableOrderAccess || typeof runtime.subscribeTableOrder !== "function") throw apiError("table_order_stream_unavailable", 503);
        tableOrderLimiter.consume(`table-stream:${clientKey(req)}`);
        const session = requireSession(req, tableSessions, clock, "saga_pos_table");
        const table = tableOrderAccess.assertSession(session.subject);
        const initial = tableOrderState(await runtime.kioskState(session.subject.kioskSessionId), table, deliveryContext, session.csrfToken);
        let closed = false;
        let heartbeat;
        let unsubscribe = () => {};
        const cleanup = () => {
          if (closed) return;
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          unsubscribe();
        };
        unsubscribe = await runtime.subscribeTableOrder(session.subject.kioskSessionId, (snapshot, reason) => {
          if (closed) return;
          try {
            const currentTable = tableOrderAccess.assertSession(session.subject);
            writeSse(res, "snapshot", { ...tableOrderState(snapshot, currentTable, deliveryContext, session.csrfToken), freshness: { source: "server_stream", reason, at: clock().toISOString() } });
          } catch (error) {
            writeSse(res, "session-expired", { code: error?.code ?? "table_order_session_invalid" });
            cleanup();
            res.end();
          }
        });
        if (typeof unsubscribe !== "function") throw apiError("table_order_stream_unavailable", 503);
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        res.write("retry: 5000\n\n");
        writeSse(res, "snapshot", { ...initial, freshness: { source: "server_stream", reason: "connected", at: clock().toISOString() } });
        heartbeat = setInterval(() => { if (!closed) res.write(`: keepalive ${clock().toISOString()}\n\n`); }, 15_000);
        heartbeat.unref?.();
        req.once("close", cleanup);
        res.once("close", cleanup);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/table/quote") {
        if (!tableOrderAccess) throw apiError("table_order_unavailable", 503);
        tableOrderLimiter.consume(`table-quote:${clientKey(req)}`);
        assertSameOrigin(req);
        const session = requireSession(req, tableSessions, clock, "saga_pos_table");
        assertCsrf(req, session);
        tableOrderAccess.assertSession(session.subject);
        const body = await readJson(req);
        return json(res, 200, await runtime.quote(session.subject.kioskSessionId, body.cart, { ...body, orderType: "DINE_IN", memberCode: undefined, verifiedMemberId: undefined }));
      }
      if (req.method === "POST" && url.pathname === "/api/table/checkouts") {
        if (!tableOrderAccess || typeof runtime.beginTableDemoCheckout !== "function") throw apiError("table_order_unavailable", 503);
        tableOrderLimiter.consume(`table-checkout:${clientKey(req)}`);
        assertSameOrigin(req);
        const session = requireSession(req, tableSessions, clock, "saga_pos_table");
        assertCsrf(req, session);
        const table = tableOrderAccess.assertSession(session.subject);
        const body = await readJson(req);
        if (!body.expectedQuote) throw apiError("checkout_quote_required", 422);
        const result = await runtime.beginTableDemoCheckout(session.subject.kioskSessionId, body, table);
        if (!result.idempotentReplay) runtime.publishTableOrderState?.(session.subject.kioskSessionId, "checkout_created");
        return json(res, 201, result);
      }
      if (req.method === "POST" && url.pathname === "/api/table/payments/simulate") {
        if (!tableOrderAccess || typeof runtime.transitionTableDemoPayment !== "function") throw apiError("table_order_unavailable", 503);
        tableOrderLimiter.consume(`table-payment:${clientKey(req)}`);
        assertSameOrigin(req);
        const session = requireSession(req, tableSessions, clock, "saga_pos_table");
        assertCsrf(req, session);
        tableOrderAccess.assertSession(session.subject);
        const result = await runtime.transitionTableDemoPayment(session.subject.kioskSessionId, await readJson(req));
        if (!result.idempotentReplay) runtime.publishTableOrderState?.(session.subject.kioskSessionId, "payment_updated");
        return json(res, 200, result);
      }
      if (req.method === "POST" && url.pathname === "/api/table/payments/retry") {
        if (!tableOrderAccess || typeof runtime.retryTableDemoPayment !== "function") throw apiError("table_order_unavailable", 503);
        tableOrderLimiter.consume(`table-payment:${clientKey(req)}`);
        assertSameOrigin(req);
        const session = requireSession(req, tableSessions, clock, "saga_pos_table");
        assertCsrf(req, session);
        tableOrderAccess.assertSession(session.subject);
        const result = await runtime.retryTableDemoPayment(session.subject.kioskSessionId, await readJson(req));
        if (!result.idempotentReplay) runtime.publishTableOrderState?.(session.subject.kioskSessionId, "payment_retried");
        return json(res, 200, result);
      }
      if (req.method === "POST" && url.pathname === "/api/menu-kiosk/bootstrap") {
        if (typeof runtime.beginTableDemoCheckout !== "function") throw apiError("menu_kiosk_demo_unavailable", 503);
        tableOrderLimiter.consume(`menu-kiosk-bootstrap:${clientKey(req)}`);
        assertSameOrigin(req);
        const body = await readJson(req);
        let session = findSession(req, menuKioskDemoSessions, clock, "saga_pos_menu_kiosk_demo");
        if (body.forceFresh === true && session) {
          await revokeSession("kiosk", session.tokenHash);
          menuKioskDemoSessions.delete(session.tokenHash);
          session = null;
        }
        if (!session) {
          const kiosk = await runtime.startKioskSession();
          session = createSession({ subject: { role: "menu_kiosk_demo", kioskSessionId: kiosk.id, demoSource: "KIOSK_DEMO" }, clock });
          await persistSession("kiosk", session);
          menuKioskDemoSessions.set(session.tokenHash, session);
          setCookie(req, res, "saga_pos_menu_kiosk_demo", session.token, 4 * 60 * 60, productionRuntime);
        }
        const snapshot = await runtime.kioskState(session.subject.kioskSessionId);
        return json(res, 200, menuKioskDemoState(snapshot, deliveryContext, session.csrfToken));
      }
      if (req.method === "GET" && url.pathname === "/api/menu-kiosk/state") {
        const session = requireSession(req, menuKioskDemoSessions, clock, "saga_pos_menu_kiosk_demo");
        const snapshot = await runtime.kioskState(session.subject.kioskSessionId);
        return json(res, 200, menuKioskDemoState(snapshot, deliveryContext, session.csrfToken));
      }
      if (req.method === "GET" && url.pathname === "/api/menu-kiosk/events") {
        if (typeof runtime.subscribeTableOrder !== "function") throw apiError("menu_kiosk_stream_unavailable", 503);
        tableOrderLimiter.consume(`menu-kiosk-stream:${clientKey(req)}`);
        const session = requireSession(req, menuKioskDemoSessions, clock, "saga_pos_menu_kiosk_demo");
        let closed = false;
        let streaming = false;
        let pending = null;
        let heartbeat;
        let unsubscribe = () => {};
        const cleanup = () => {
          if (closed) return;
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          unsubscribe();
        };
        res.once("close", cleanup);
        unsubscribe = await runtime.subscribeTableOrder(session.subject.kioskSessionId, (snapshot, reason) => {
          if (closed) return;
          try {
            requireSession(req, menuKioskDemoSessions, clock, "saga_pos_menu_kiosk_demo");
            if (!streaming) pending = { snapshot, reason };
            else writeSse(res, "snapshot", { ...menuKioskDemoState(snapshot, deliveryContext, session.csrfToken), freshness: { source: "server_stream", reason, at: clock().toISOString() } });
          } catch {
            if (streaming) writeSse(res, "session-expired", { code: "menu_kiosk_session_invalid" });
            else res.statusCode = 401;
            cleanup();
            res.end();
          }
        });
        if (typeof unsubscribe !== "function") throw apiError("menu_kiosk_stream_unavailable", 503);
        if (closed) { unsubscribe(); return; }
        let initial;
        try { initial = menuKioskDemoState(await runtime.kioskState(session.subject.kioskSessionId), deliveryContext, session.csrfToken); }
        catch (error) { cleanup(); throw error; }
        if (closed) return;
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          "x-content-type-options": "nosniff",
        });
        res.write("retry: 5000\n\n");
        const first = pending;
        streaming = true;
        writeSse(res, "snapshot", { ...(first ? menuKioskDemoState(first.snapshot, deliveryContext, session.csrfToken) : initial), freshness: { source: "server_stream", reason: first?.reason ?? "connected", at: clock().toISOString() } });
        heartbeat = setInterval(() => {
          if (closed) return;
          try { requireSession(req, menuKioskDemoSessions, clock, "saga_pos_menu_kiosk_demo"); }
          catch {
            writeSse(res, "session-expired", { code: "menu_kiosk_session_invalid" });
            cleanup();
            res.end();
            return;
          }
          res.write(`: keepalive ${clock().toISOString()}\n\n`);
        }, 15_000);
        heartbeat.unref?.();
        req.once("close", cleanup);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/menu-kiosk/quote") {
        tableOrderLimiter.consume(`menu-kiosk-quote:${clientKey(req)}`);
        assertSameOrigin(req);
        const session = requireSession(req, menuKioskDemoSessions, clock, "saga_pos_menu_kiosk_demo");
        assertCsrf(req, session);
        const body = await readJson(req);
        const quote = await runtime.quote(session.subject.kioskSessionId, body.cart, { ...body, memberCode: undefined, verifiedMemberId: undefined });
        return json(res, 200, { ...quote, assistedCash: { available: true, staffConfirmationRequired: true, simulator: true, tenderOptions: buildCashTenderOptions(quote.totalRupiah) } });
      }
      if (req.method === "POST" && url.pathname === "/api/menu-kiosk/member/resolve") {
        tableOrderLimiter.consume(`menu-kiosk-member:${clientKey(req)}`);
        assertSameOrigin(req);
        const session = requireSession(req, menuKioskDemoSessions, clock, "saga_pos_menu_kiosk_demo");
        assertCsrf(req, session);
        const body = await readJson(req);
        return json(res, 200, await runtime.simulateKioskDemoMember(session.subject.kioskSessionId, { memberCode: body.memberCode, orderType: body.orderType, method: "PHONE" }));
      }
      if (req.method === "POST" && url.pathname === "/api/menu-kiosk/member/simulate-nfc") {
        tableOrderLimiter.consume(`menu-kiosk-member:${clientKey(req)}`);
        assertSameOrigin(req);
        const session = requireSession(req, menuKioskDemoSessions, clock, "saga_pos_menu_kiosk_demo");
        assertCsrf(req, session);
        const body = await readJson(req);
        return json(res, 200, await runtime.simulateKioskDemoMember(session.subject.kioskSessionId, { orderType: body.orderType, method: "NFC" }));
      }
      if (req.method === "POST" && url.pathname === "/api/menu-kiosk/member/clear") {
        assertSameOrigin(req);
        const session = requireSession(req, menuKioskDemoSessions, clock, "saga_pos_menu_kiosk_demo");
        assertCsrf(req, session);
        return json(res, 200, await runtime.clearKioskMember(session.subject.kioskSessionId));
      }
      if (req.method === "POST" && url.pathname === "/api/menu-kiosk/checkouts") {
        tableOrderLimiter.consume(`menu-kiosk-checkout:${clientKey(req)}`);
        assertSameOrigin(req);
        const session = requireSession(req, menuKioskDemoSessions, clock, "saga_pos_menu_kiosk_demo");
        assertCsrf(req, session);
        const body = await readJson(req);
        if (!body.expectedQuote) throw apiError("checkout_quote_required", 422);
        const result = await runtime.beginTableDemoCheckout(session.subject.kioskSessionId, body, { id: "KIOSK-DEMO", label: "Kiosk Demo", demoSource: "KIOSK_DEMO" });
        if (!result.idempotentReplay) runtime.publishTableOrderState?.(session.subject.kioskSessionId, "checkout_created");
        return json(res, 201, result);
      }
      if (req.method === "POST" && url.pathname === "/api/menu-kiosk/payments/simulate") {
        tableOrderLimiter.consume(`menu-kiosk-payment:${clientKey(req)}`);
        assertSameOrigin(req);
        const session = requireSession(req, menuKioskDemoSessions, clock, "saga_pos_menu_kiosk_demo");
        assertCsrf(req, session);
        const result = await runtime.transitionTableDemoPayment(session.subject.kioskSessionId, await readJson(req));
        if (!result.idempotentReplay) runtime.publishTableOrderState?.(session.subject.kioskSessionId, "payment_updated");
        return json(res, 200, result);
      }
      if (req.method === "POST" && url.pathname === "/api/menu-kiosk/payments/simulate-paid") {
        tableOrderLimiter.consume(`menu-kiosk-payment:${clientKey(req)}`);
        assertSameOrigin(req);
        const session = requireSession(req, menuKioskDemoSessions, clock, "saga_pos_menu_kiosk_demo");
        assertCsrf(req, session);
        const body = await readJson(req);
        const result = await runtime.transitionTableDemoPayment(session.subject.kioskSessionId, { paymentId: body.paymentId, target: "SUCCESS", callbackId: body.callbackId });
        if (!result.idempotentReplay) runtime.publishTableOrderState?.(session.subject.kioskSessionId, "payment_updated");
        return json(res, 200, result);
      }
      if (req.method === "POST" && url.pathname === "/api/menu-kiosk/payments/status") {
        assertSameOrigin(req);
        const session = requireSession(req, menuKioskDemoSessions, clock, "saga_pos_menu_kiosk_demo");
        assertCsrf(req, session);
        const snapshot = await runtime.kioskState(session.subject.kioskSessionId);
        return json(res, 200, { order: snapshot.activeOrder, payment: snapshot.payment, fulfillment: snapshot.fulfillment, idempotentReplay: false });
      }
      if (req.method === "POST" && url.pathname === "/api/menu-kiosk/payments/retry") {
        tableOrderLimiter.consume(`menu-kiosk-payment:${clientKey(req)}`);
        assertSameOrigin(req);
        const session = requireSession(req, menuKioskDemoSessions, clock, "saga_pos_menu_kiosk_demo");
        assertCsrf(req, session);
        const result = await runtime.retryTableDemoPayment(session.subject.kioskSessionId, await readJson(req));
        if (!result.idempotentReplay) runtime.publishTableOrderState?.(session.subject.kioskSessionId, "payment_retried");
        return json(res, 200, result);
      }
      if (req.method === "POST" && url.pathname === "/api/kiosk/bootstrap") {
        assertSameOrigin(req);
        const body = await readJson(req);
        let session = findSession(req, kioskSessions, clock, "saga_pos_kiosk");
        if (body.forceFresh === true && session) {
          if (typeof runtime.clearKioskMember === "function") {
            await runtime.clearKioskMember(session.subject.kioskSessionId);
          }
          await revokeSession("kiosk", session.tokenHash);
          kioskSessions.delete(session.tokenHash);
          session = null;
        }
        let sessionStarted = false;
        if (!session) {
          const kiosk = await runtime.startKioskSession();
          session = createSession({ subject: { role: "kiosk", kioskSessionId: kiosk.id }, clock });
          await persistSession("kiosk", session);
          kioskSessions.set(session.tokenHash, session);
          setCookie(req, res, "saga_pos_kiosk", session.token, 4 * 60 * 60, productionRuntime);
          sessionStarted = true;
        }
        const kioskState = await runtime.kioskState(session.subject.kioskSessionId);
        return json(res, 200, {
          ...kioskState,
          capabilities: { ...kioskState.capabilities, nfcSimulatorAvailable: publicDemo },
          context: deliveryContext,
          csrfToken: session.csrfToken,
          sessionStarted,
        });
      }
      if (req.method === "POST" && url.pathname === "/api/kiosk/sessions") {
        assertSameOrigin(req);
        const kiosk = await runtime.startKioskSession();
        const session = createSession({ subject: { role: "kiosk", kioskSessionId: kiosk.id }, clock });
        await persistSession("kiosk", session);
        kioskSessions.set(session.tokenHash, session);
        setCookie(req, res, "saga_pos_kiosk", session.token, 4 * 60 * 60, productionRuntime);
        return json(res, 201, { started: true, scope: deliveryContext.scope });
      }
      if (req.method === "GET" && url.pathname === "/api/kiosk/state") {
        const session = requireSession(req, kioskSessions, clock, "saga_pos_kiosk");
        const kioskState = await runtime.kioskState(session.subject.kioskSessionId);
        return json(res, 200, { ...kioskState, capabilities: { ...kioskState.capabilities, nfcSimulatorAvailable: publicDemo }, context: deliveryContext, csrfToken: session.csrfToken });
      }
      if (req.method === "POST" && url.pathname === "/api/kiosk/quote") {
        assertSameOrigin(req);
        const session = requireSession(req, kioskSessions, clock, "saga_pos_kiosk");
        assertCsrf(req, session);
        const body = await readJson(req);
        return json(res, 200, await runtime.quote(session.subject.kioskSessionId, body.cart, body));
      }
      if (req.method === "POST" && url.pathname === "/api/kiosk/member/resolve") {
        memberLimiter.consume(`kiosk-member:${clientKey(req)}`);
        assertSameOrigin(req);
        if (productionRuntime && productionMemberMode === "off") throw apiError("production_member_service_required", 503);
        const session = requireSession(req, kioskSessions, clock, "saga_pos_kiosk");
        assertCsrf(req, session);
        return json(res, 200, await runtime.resolveKioskMember(session.subject.kioskSessionId, await readJson(req)));
      }
      if (req.method === "POST" && url.pathname === "/api/kiosk/member/simulate-nfc") {
        if (!publicDemo || typeof runtime.simulateKioskNfc !== "function") throw apiError("nfc_simulator_unavailable", 404);
        memberLimiter.consume(`kiosk-member:${clientKey(req)}`);
        assertSameOrigin(req);
        const session = requireSession(req, kioskSessions, clock, "saga_pos_kiosk");
        assertCsrf(req, session);
        const body = await readJson(req);
        return json(res, 200, await runtime.simulateKioskNfc(session.subject.kioskSessionId, { orderType: body.orderType }));
      }
      if (req.method === "POST" && url.pathname === "/api/kiosk/member/clear") {
        assertSameOrigin(req);
        const session = requireSession(req, kioskSessions, clock, "saga_pos_kiosk");
        assertCsrf(req, session);
        return json(res, 200, await runtime.clearKioskMember(session.subject.kioskSessionId));
      }
      if (req.method === "POST" && url.pathname === "/api/kiosk/checkouts") {
        checkoutLimiter.consume(`kiosk:${clientKey(req)}`);
        assertSameOrigin(req);
        const body = await readJson(req);
        if (paymentOff && body.testMode !== true) throw apiError("production_payment_off", 409);
        if (productionRuntime && body.paymentMethod === "QRIS_STATIC_DEMO" && !runtime.kioskStaticQrisDemoEnabled) throw apiError("static_qris_demo_unavailable", 409);
        const session = requireSession(req, kioskSessions, clock, "saga_pos_kiosk");
        assertCsrf(req, session);
        if (!body.expectedQuote) throw apiError("checkout_quote_required", 422);
        return json(res, 201, await runtime.beginKioskCheckout(session.subject.kioskSessionId, body));
      }
      if (req.method === "POST" && url.pathname === "/api/kiosk/payments/simulate-paid") {
        assertSameOrigin(req);
        if (paymentOff) throw apiError("production_payment_off", 409);
        if (productionRuntime) throw apiError("payment_simulator_disabled_in_production", 409);
        const session = requireSession(req, kioskSessions, clock, "saga_pos_kiosk");
        assertCsrf(req, session);
        const body = await readJson(req);
        return json(res, 200, await runtime.simulateQrisPaid(session.subject.kioskSessionId, body));
      }
      if (req.method === "POST" && url.pathname === "/api/kiosk/payments/status") {
        assertSameOrigin(req);
        if (paymentOff) throw apiError("production_payment_off", 409);
        const session = requireSession(req, kioskSessions, clock, "saga_pos_kiosk");
        assertCsrf(req, session);
        const body = await readJson(req);
        if (typeof runtime.refreshKioskPayment !== "function") throw apiError("gateway_status_not_available", 409);
        return json(res, 200, await runtime.refreshKioskPayment(session.subject.kioskSessionId, body));
      }
      if (req.method === "POST" && url.pathname === "/api/operator/login") {
        if (hrpos && !ownerAuth) throw apiError("hrpos_login_required", 401);
        loginLimiter.consume(`login:${clientKey(req)}`);
        assertSameOrigin(req);
        const body = await readJson(req);
        const passwordOnlyOwnerDashboard = productionRuntime
          && body.surface === "dashboard"
          && requestHostname(req) === "dashboard.pos.example.invalid"
          && !String(body.employeeId ?? "").trim();
        let actor = productionRuntime ? await authenticateProductionOwner(body, ownerAuth, { passwordOnlyOwnerDashboard }) : authenticateOperator(body, sharedPassword);
        if (teamAccess) {
          if (actor.role !== "owner") throw apiError("team_login_required",401);
          actor = await teamAccess.bootstrapLegacyOwner(actor,body.password,runtime.ids.outletId);
        }
        const session = createSession({ subject: actor, clock });
        await persistSession("operator", session);
        if (productionRuntime && runtime.repository?.recordProductionAuth) await runtime.repository.recordProductionAuth(runtime.ids, "owner.login");
        operatorSessions.set(session.tokenHash, session);
        setCookie(req, res, "saga_pos_operator", session.token, 4 * 60 * 60, productionRuntime);
        return json(res, 200, { authenticated: true, actor, scope: deliveryContext.scope, csrfToken: session.csrfToken });
      }
      if (req.method === "POST" && url.pathname === "/api/operator/preview-login") {
        if (!operatorPreview) throw apiError("not_found", 404);
        loginLimiter.consume(`preview-login:${clientKey(req)}`);
        assertSameOrigin(req);
        const surface = String((await readJson(req)).surface ?? "");
        const actor = surface === "dashboard" ? personas["OWNER-DEMO"] : surface === "kds" ? personas["BAR-01"] : null;
        if (!actor) throw apiError("operator_preview_surface_invalid", 422);
        const session = createSession({ subject: actor, clock });
        operatorSessions.set(session.tokenHash, session);
        setCookie(req, res, "saga_pos_operator", session.token, 4 * 60 * 60, productionRuntime);
        return json(res, 200, { authenticated: true, actor, scope: deliveryContext.scope });
      }
      if (req.method === "GET" && url.pathname === "/api/operator/state") {
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
          const cashierSurface = session.subject.role === "cashier" || (session.subject.role === "owner" && url.searchParams.get("surface") === "cashier");
          const state = cashierSurface ? await runtime.cashierState(session.subject) : await runtime.operatorState(session.subject.role, {
            reportDate: url.searchParams.get("reportDate") || undefined,
            openingCountId: url.searchParams.get("openingCountId") || undefined,
            closingCountId: url.searchParams.get("closingCountId") || undefined,
          });
        return json(res, 200, { actor: session.subject, ...state, ...(session.subject.role === "owner" && !cashierSurface ? { inventoryReportingStatus: readInventoryReportingHealth() } : {}), context: deliveryContext, csrfToken: session.csrfToken });
      }
      if (req.method === "GET" && ['/api/operator/orders', '/api/operator/orders.csv'].includes(url.pathname)) {
        const session = requireSession(req, operatorSessions, clock, 'saga_pos_operator');
        if ([...url.searchParams.keys()].some(key => !['mode', 'date', 'q', 'channel', 'status', 'page'].includes(key))) throw apiError('order_filter_invalid', 422);
        const filters = Object.fromEntries(url.searchParams);
        if (url.pathname.endsWith('.csv')) {
          const csv = await runtime.exportOwnerOrdersCsv(session.subject.role, filters);
          res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="saga-pos-orders.csv"', 'cache-control': 'no-store' });
          return res.end(csv);
        }
        return json(res, 200, await runtime.ownerOrders(session.subject.role, filters));
      }
      const ownerOrderDetailRoute = /^\/api\/operator\/orders\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && ownerOrderDetailRoute) {
        const session = requireSession(req, operatorSessions, clock, 'saga_pos_operator');
        if (url.search) throw apiError('order_filter_invalid', 422);
        return json(res, 200, await runtime.ownerOrderDetail(session.subject.role, decodeURIComponent(ownerOrderDetailRoute[1])));
      }
      if (req.method === "GET" && url.pathname === "/api/operator/inventory-workspace") {
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        if (typeof runtime.inventoryWorkspaceState !== "function") throw apiError("inventory_workspace_unavailable", 503);
        const workspace = await runtime.inventoryWorkspaceState(session.subject.role);
        return json(res, 200, { actor: session.subject, ...workspace, context: deliveryContext, csrfToken: session.csrfToken });
      }
      if (req.method === "GET" && url.pathname === "/api/operator/inventory/ingredient-price-impact") {
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        if (typeof runtime.ingredientPriceImpact !== "function") throw apiError("ingredient_price_impact_unavailable", 503);
        const data = await runtime.ingredientPriceImpact(session.subject.role, {
          ingredientId: url.searchParams.get("ingredientId"), month: url.searchParams.get("month"),
          supplier: url.searchParams.get("supplier"), source: url.searchParams.get("source"),
          cursor: url.searchParams.get("cursor"), limit: url.searchParams.get("limit"),
        });
        return json(res, 200, { data, csrfToken: session.csrfToken });
      }
      if (req.method === "POST" && url.pathname === "/api/operator/inventory-actions") {
        assertSameOrigin(req);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        assertCsrf(req, session);
        if (typeof runtime.inventoryWorkspaceAction !== "function") throw apiError("inventory_workspace_unavailable", 503);
        const result = await runtime.inventoryWorkspaceAction(session.subject.role, session.subject.employeeId ?? session.subject.userAccountId, await readJson(req));
        return json(res, 200, { actor: session.subject, ...result, context: deliveryContext, csrfToken: session.csrfToken });
      }
      if (req.method === "POST" && url.pathname === "/api/operator/fulfillment") {
        assertSameOrigin(req);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        assertCsrf(req, session);
        const body = await readJson(req);
        const result = await runtime.advanceFulfillment(session.subject.role, body);
        if (!result.idempotentReplay) runtime.publishTableOrderByOrder?.(body.orderId, "fulfillment_updated");
        return json(res, 200, result);
      }
      if (req.method === "POST" && url.pathname === "/api/operator/esb/exceptions") {
        assertSameOrigin(req);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        assertCsrf(req, session);
        if (typeof runtime.executeEsbException !== "function") throw apiError("esb_runtime_operations_unavailable", 503);
        return json(res, 200, await runtime.executeEsbException(session.subject, await readJson(req)));
      }
      if (req.method === "POST" && url.pathname === "/api/operator/esb/shifts/close-preview") {
        assertSameOrigin(req);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        assertCsrf(req, session);
        if (typeof runtime.previewEsbShiftClose !== "function") throw apiError("esb_reliability_runtime_unavailable", 503);
        return json(res, 200, await runtime.previewEsbShiftClose(session.subject, await readJson(req)));
      }
      if (req.method === "POST" && url.pathname === "/api/operator/esb/shifts/close-requests") {
        assertSameOrigin(req);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        assertCsrf(req, session);
        if (typeof runtime.requestEsbShiftClose !== "function") throw apiError("esb_reliability_runtime_unavailable", 503);
        return json(res, 201, await runtime.requestEsbShiftClose(session.subject, await readJson(req)));
      }
      if (req.method === "POST" && url.pathname === "/api/operator/esb/shifts/close-approvals") {
        assertSameOrigin(req);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        assertCsrf(req, session);
        if (typeof runtime.approveEsbReliabilityRequest !== "function") throw apiError("esb_reliability_runtime_unavailable", 503);
        return json(res, 201, await runtime.approveEsbReliabilityRequest(session.subject, await readJson(req)));
      }
      if (req.method === "POST" && url.pathname === "/api/operator/esb/inventory/requests") {
        assertSameOrigin(req);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        assertCsrf(req, session);
        assertInventoryAuthorityManager(session.subject);
        const evidence = await retiredRouteTelemetry.observe(RETIRED_ROUTE_KEYS.ESB_INVENTORY_REQUESTS, { headers: req.headers });
        res.setHeader("x-sagapos-retired-correlation", evidence.correlationId);
        throw apiError("esb_inventory_authority_retired", 410);
      }
      if (req.method === "POST" && url.pathname === "/api/operator/esb/inventory/approvals") {
        assertSameOrigin(req);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        assertCsrf(req, session);
        assertInventoryAuthorityManager(session.subject);
        const evidence = await retiredRouteTelemetry.observe(RETIRED_ROUTE_KEYS.ESB_INVENTORY_APPROVALS, { headers: req.headers });
        res.setHeader("x-sagapos-retired-correlation", evidence.correlationId);
        throw apiError("esb_inventory_authority_retired", 410);
      }
      if (req.method === "POST" && url.pathname === "/api/operator/esb/inventory/movements") {
        assertSameOrigin(req);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        assertCsrf(req, session);
        assertInventoryAuthorityManager(session.subject);
        const evidence = await retiredRouteTelemetry.observe(RETIRED_ROUTE_KEYS.ESB_INVENTORY_MOVEMENTS, { headers: req.headers });
        res.setHeader("x-sagapos-retired-correlation", evidence.correlationId);
        throw apiError("esb_inventory_authority_retired", 410);
      }
      const esbInventoryLedger = req.method === "GET" && url.pathname.match(/^\/api\/operator\/esb\/inventory\/([0-9a-f-]{36})$/i);
      if (esbInventoryLedger) {
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        assertInventoryAuthorityManager(session.subject);
        const evidence = await retiredRouteTelemetry.observe(RETIRED_ROUTE_KEYS.ESB_INVENTORY_LEDGER, { headers: req.headers });
        res.setHeader("x-sagapos-retired-correlation", evidence.correlationId);
        throw apiError("esb_inventory_authority_retired", 410);
      }
      if (req.method === "GET" && url.pathname === "/api/admin/retired-route-evidence") {
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        if (session.subject.role !== "owner") throw apiError("retired_route_evidence_owner_required", 403);
        try {
          return json(res, 200, await retiredRouteTelemetry.readEvidence(Object.fromEntries(url.searchParams)));
        } catch (error) {
          if (error.message === "retired_route_scope_override_denied") throw apiError(error.message, 403);
          if (["retired_route_query_invalid", "retired_route_cursor_invalid"].includes(error.message)) throw apiError(error.message, 422);
          throw error;
        }
      }
      if (req.method === "GET" && url.pathname === "/api/admin/reports/inventory") {
        const session = requireOwnerSession(req, operatorSessions, clock);
        const api = requireInventoryReportingApi(inventoryReportingApi);
        return json(res, 200, await api.readSummary({ actor: session.subject, authority: inventoryReportingAuthority(runtime.ids ?? SAGA_POS_ALPHA_CONTEXT), query: queryPlain(url.searchParams) }));
      }
      const inventoryFamilyCsv = req.method === "GET" && url.pathname.match(/^\/api\/admin\/reports\/inventory\/families\/([A-Za-z0-9]+)\.csv$/);
      if (inventoryFamilyCsv) {
        const session = requireOwnerSession(req, operatorSessions, clock);
        const api = requireInventoryReportingApi(inventoryReportingApi);
        const payload = await api.exportFamily({ actor: session.subject, authority: inventoryReportingAuthority(runtime.ids ?? SAGA_POS_ALPHA_CONTEXT), family: inventoryFamilyCsv[1], query: queryPlain(url.searchParams) });
        res.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${payload.filename}"`,
          "content-length": Buffer.byteLength(payload.csv),
          "cache-control": "no-store",
          "x-sagapos-report-fingerprint": payload.reportFingerprint,
        });
        return res.end(payload.csv);
      }
      const inventoryFamily = req.method === "GET" && url.pathname.match(/^\/api\/admin\/reports\/inventory\/families\/([A-Za-z0-9]+)$/);
      if (inventoryFamily) {
        const session = requireOwnerSession(req, operatorSessions, clock);
        const api = requireInventoryReportingApi(inventoryReportingApi);
        return json(res, 200, await api.readFamily({ actor: session.subject, authority: inventoryReportingAuthority(runtime.ids ?? SAGA_POS_ALPHA_CONTEXT), family: inventoryFamily[1], query: queryPlain(url.searchParams) }));
      }
      if (req.method === "GET" && url.pathname === "/api/admin/reports/inventory/source") {
        const session = requireOwnerSession(req, operatorSessions, clock);
        const api = requireInventoryReportingApi(inventoryReportingApi);
        return json(res, 200, await api.resolveSource({ actor: session.subject, authority: inventoryReportingAuthority(runtime.ids ?? SAGA_POS_ALPHA_CONTEXT), query: queryPlain(url.searchParams) }));
      }
      if (req.method === "GET" && url.pathname === "/api/operator/inventory/availability") {
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        if (typeof runtime.readInventoryAvailability !== "function") throw apiError("inventory_planning_runtime_unavailable", 503);
        return json(res, 200, await runtime.readInventoryAvailability(session.subject, inventoryPlanningQuery(url.searchParams)));
      }
      if (req.method === "GET" && url.pathname === "/api/operator/inventory/atp") {
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        if (typeof runtime.readInventoryAtp !== "function") throw apiError("inventory_planning_runtime_unavailable", 503);
        return json(res, 200, await runtime.readInventoryAtp(session.subject, inventoryPlanningQuery(url.searchParams)));
      }
      if (req.method === "GET" && url.pathname === "/api/operator/replenishment") {
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        if (typeof runtime.readReplenishment !== "function") throw apiError("inventory_planning_runtime_unavailable", 503);
        return json(res, 200, await runtime.readReplenishment(session.subject, inventoryPlanningQuery(url.searchParams)));
      }
      if (req.method === "GET" && url.pathname === "/api/operator/reports/esb-owner") {
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        return json(res, 200, await esbOwnerReportApi.load({ actor: session.subject, searchParams: url.searchParams, sessionKey: session.tokenHash }));
      }
      if (req.method === "GET" && url.pathname === "/api/operator/reports/esb-owner.csv") {
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        const payload = esbOwnerReportApi.csv({ actor: session.subject, searchParams: url.searchParams, sessionKey: session.tokenHash });
        res.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${payload.filename}"`,
          "content-length": Buffer.byteLength(payload.csv),
          "cache-control": "no-store",
          "x-sagapos-report-fingerprint": payload.reportFingerprint,
        });
        return res.end(payload.csv);
      }
      const esbBillDetail = req.method === "GET" && url.pathname.match(/^\/api\/operator\/reports\/esb-owner\/bills\/([0-9a-f-]{36})$/i);
      if (esbBillDetail) {
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        return json(res, 200, esbOwnerReportApi.bill({ actor: session.subject, searchParams: url.searchParams, sessionKey: session.tokenHash, billId: esbBillDetail[1] }));
      }
      if (req.method === "GET" && url.pathname === "/api/operator/reports/financial.csv") {
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        const csv = await runtime.exportOwnerFinancialCsv(session.subject.role, url.searchParams.get("reportDate") || undefined);
        res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="saga-pos-financial.csv"', "content-length": Buffer.byteLength(csv), "cache-control": "no-store" });
        return res.end(csv);
      }
      if (req.method === "GET" && url.pathname === "/api/operator/reports/sales-period-comparison.csv") {
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        const csv = await runtime.exportSalesPeriodComparisonCsv(session.subject.role, url.searchParams.get("reportDate") || undefined);
        res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="saga-pos-sales-period-comparison.csv"', "content-length": Buffer.byteLength(csv), "cache-control": "no-store" });
        return res.end(csv);
      }
      if (req.method === "GET" && url.pathname === "/api/operator/reports/sales-trend-comparison.csv") {
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        const csv = await runtime.exportSalesTrendComparisonCsv(session.subject.role, url.searchParams.get("reportDate") || undefined);
        res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="saga-pos-sales-trend-comparison.csv"', "content-length": Buffer.byteLength(csv), "cache-control": "no-store" });
        return res.end(csv);
      }
      if (req.method === "GET" && url.pathname === "/api/operator/reports/cash-control.csv") {
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        const csv = await runtime.exportCashControlCsv(session.subject.role, url.searchParams.get("reportDate") || undefined);
        res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="saga-pos-cash-control.csv"', "content-length": Buffer.byteLength(csv), "cache-control": "no-store" });
        return res.end(csv);
      }
      if (req.method === "GET" && url.pathname === "/api/operator/reports/payment-settlement.csv") {
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        const csv = await runtime.exportPaymentSettlementCsv(session.subject.role, url.searchParams.get("reportDate") || undefined);
        res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="saga-pos-payment-settlement.csv"', "content-length": Buffer.byteLength(csv), "cache-control": "no-store" });
        return res.end(csv);
      }
      if (req.method === "GET" && url.pathname === "/api/operator/reports/theoretical-usage.csv") {
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        const csv = await runtime.exportTheoreticalIngredientUsageCsv(session.subject.role, url.searchParams.get("reportDate") || undefined);
        res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="saga-pos-theoretical-usage.csv"', "content-length": Buffer.byteLength(csv), "cache-control": "no-store" });
        return res.end(csv);
      }
      if (req.method === "GET" && url.pathname === "/api/operator/reports/inventory-variance.csv") {
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        const csv = await runtime.exportInventoryVarianceCsv(session.subject.role, {
          openingCountId: url.searchParams.get("openingCountId") || undefined,
          closingCountId: url.searchParams.get("closingCountId") || undefined,
        });
        res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="saga-pos-inventory-variance.csv"', "content-length": Buffer.byteLength(csv), "cache-control": "no-store" });
        return res.end(csv);
      }
      if (req.method === "GET" && url.pathname === "/api/operator/reports/hpp-quality.csv") {
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        const csv = await runtime.exportHppQualityCsv(session.subject.role);
        res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="saga-pos-hpp-quality.csv"', "content-length": Buffer.byteLength(csv), "cache-control": "no-store" });
        return res.end(csv);
      }
      if (req.method === "GET" && url.pathname === "/api/operator/reports/supplier-payments.csv") {
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        const csv = await runtime.exportSupplierPaymentsCsv(session.subject.role, url.searchParams.get("reportDate") || undefined);
        res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="saga-pos-supplier-payments.csv"', "content-length": Buffer.byteLength(csv), "cache-control": "no-store" });
        return res.end(csv);
      }
      if (req.method === "GET" && url.pathname === "/api/operator/reports/accounts-payable-aging.csv") {
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        const csv = await runtime.exportAccountsPayableAgingCsv(session.subject.role, url.searchParams.get("reportDate") || undefined);
        res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="saga-pos-accounts-payable-aging.csv"', "content-length": Buffer.byteLength(csv), "cache-control": "no-store" });
        return res.end(csv);
      }
      if (req.method === 'GET' && url.pathname === '/api/cashier/recovery') {
        const session = requireSession(req, operatorSessions, clock, 'saga_pos_operator');
        if ([...url.searchParams.keys()].some(key => key !== 'key')) throw apiError('request_invalid',422);
        return json(res,200,await runtime.cashierRecovery(session.subject,url.searchParams.get('key')));
      }
      if (req.method === "POST" && url.pathname === "/api/cashier/shifts/open") {
        assertSameOrigin(req);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        assertCsrf(req, session);
        return json(res, 200, await runtime.openCashShift(session.subject, await readJson(req)));
      }
      if (req.method === "POST" && url.pathname === "/api/cashier/shifts/close") {
        assertSameOrigin(req);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        assertCsrf(req, session);
        return json(res, 200, await runtime.closeCashShift(session.subject, await readJson(req)));
      }
      if (req.method === "POST" && url.pathname === "/api/cashier/quote") {
        checkoutLimiter.consume(`cashier-quote:${clientKey(req)}`);
        assertSameOrigin(req);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        assertCsrf(req, session);
        const input=await readJson(req);
        if(productionRuntime && input.memberCode && productionMemberMode==="off")throw apiError("production_member_service_required",503);
        return json(res, 200, await runtime.cashierQuote(session.subject, await runtime.prepareCashierInput(session.subject,input)));
      }
      if (url.pathname === '/api/cashier/discount-approvals' && ['GET','POST'].includes(req.method)) {
        const session = requireSession(req,operatorSessions,clock,'saga_pos_operator');
        if (req.method === 'GET') return json(res,200,await runtime.discountApprovalState(session.subject));
        assertSameOrigin(req); assertCsrf(req,session);
        checkoutLimiter.consume(`discount-approval:${clientKey(req)}`);
        return json(res,201,await runtime.requestDiscountApproval(session.subject,await readJson(req)));
      }
      if (req.method === 'POST' && url.pathname === '/api/cashier/discount-approvals/approve') {
        assertSameOrigin(req);
        const session = requireOwnerSession(req,operatorSessions,clock); assertCsrf(req,session);
        return json(res,200,await runtime.approveDiscount(session.subject,await readJson(req)));
      }
      if (req.method === 'POST' && ['/api/cashier/expenses','/api/cashier/expenses/void'].includes(url.pathname)) {
        assertSameOrigin(req);
        const session = requireSession(req,operatorSessions,clock,'saga_pos_operator');
        assertCsrf(req,session);
        const method=url.pathname.endsWith('/void') ? 'voidCashierExpense' : 'recordCashierExpense';
        return json(res,201,await runtime[method](session.subject,await readJson(req)));
      }
      if (req.method === "POST" && url.pathname === "/api/cashier/checkouts") {
        checkoutLimiter.consume(`cashier:${clientKey(req)}`);
        assertSameOrigin(req);
        if (paymentOff) throw apiError("production_payment_off", 409);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        assertCsrf(req, session);
        const input=await readJson(req);
        if(productionRuntime && input.memberCode && productionMemberMode==="off")throw apiError("production_member_service_required",503);
        const replay=input.memberCode && input.idempotencyKey && await runtime.cashierRecovery(session.subject,input.idempotencyKey);
        const prepared=input.memberCode && !replay?.found?await runtime.prepareCashierInput(session.subject,input):input;
        return json(res, 201, await runtime.cashierCheckout(session.subject, prepared));
      }
      if (req.method === "POST" && url.pathname === "/api/cashier/payments/simulate-paid") {
        assertSameOrigin(req);
        if (paymentOff) throw apiError("production_payment_off", 409);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        assertCsrf(req, session);
        return json(res, 200, await runtime.settleOperatorQris(session.subject, await readJson(req)));
      }
      if (req.method === "POST" && url.pathname === "/api/cashier/payments/status") {
        assertSameOrigin(req);
        if (paymentOff) throw apiError("production_payment_off", 409);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        assertCsrf(req, session);
        if (typeof runtime.refreshOperatorPayment !== "function") throw apiError("gateway_status_not_available", 409);
        return json(res, 200, await runtime.refreshOperatorPayment(session.subject, await readJson(req)));
      }
      if (req.method === "POST" && url.pathname === "/api/cashier/assisted-cash/confirm") {
        checkoutLimiter.consume(`cashier-assisted-cash:${clientKey(req)}`);
        assertSameOrigin(req);
        if (paymentOff) throw apiError("production_payment_off", 409);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        assertCsrf(req, session);
        if (typeof runtime.confirmKioskAssistedCash !== "function") throw apiError("kiosk_assisted_cash_unavailable", 409);
        return json(res, 200, await runtime.confirmKioskAssistedCash(session.subject, await readJson(req)));
      }
      if (req.method === "POST" && url.pathname === "/api/cashier/static-qris-demo/confirm") {
        if (!runtime.kioskStaticQrisDemoEnabled || typeof runtime.confirmKioskStaticQrisDemo !== "function") throw apiError("static_qris_demo_unavailable", 404);
        checkoutLimiter.consume(`cashier-static-qris-demo:${clientKey(req)}`);
        assertSameOrigin(req);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        assertCsrf(req, session);
        return json(res, 200, await runtime.confirmKioskStaticQrisDemo(session.subject, await readJson(req)));
      }
      if (req.method === "POST" && url.pathname === "/api/cashier/manual-qris/confirm") {
        if (!runtime.kioskManualQrisEnabled || typeof runtime.confirmKioskManualQris !== "function") throw apiError("manual_qris_unavailable", 404);
        checkoutLimiter.consume(`cashier-manual-qris:${clientKey(req)}`);
        assertSameOrigin(req);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        assertCsrf(req, session);
        return json(res, 200, await runtime.confirmKioskManualQris(session.subject, await readJson(req)));
      }
      if (url.pathname === "/api/kiosk/manual-qris/image" && req.method === "GET") {
        if (!runtime.kioskManualQrisEnabled || typeof runtime.manualQrisAsset !== "function") throw apiError("manual_qris_unavailable", 404);
        const kiosk = findSession(req, kioskSessions, clock, "saga_pos_kiosk");
        const owner = findSession(req, operatorSessions, clock, "saga_pos_operator");
        if (!kiosk && owner?.subject.role !== "owner") throw apiError("identity_required", 401);
        const asset = await runtime.manualQrisAsset();
        if (!asset) throw apiError("manual_qris_asset_not_configured", 404);
        res.writeHead(200, { "content-type": "image/png", "content-length": asset.bytes.length,
          "cache-control": "no-store", "x-content-type-options": "nosniff" });
        return res.end(asset.bytes);
      }
      if (url.pathname === '/api/cashier/manual-qris/image' && req.method === 'GET') {
        const session=requireSession(req,operatorSessions,clock,'saga_pos_operator');
        if (!['owner','cashier'].includes(session.subject.role)) throw apiError('cashier_role_denied',403);
        if (!runtime.kioskManualQrisEnabled || typeof runtime.manualQrisAsset !== 'function') throw apiError('manual_qris_unavailable',404);
        const asset=await runtime.manualQrisAsset();
        if (!asset) throw apiError('manual_qris_asset_not_configured',404);
        res.writeHead(200,{'content-type':'image/png','content-length':asset.bytes.length,'cache-control':'no-store','x-content-type-options':'nosniff'});
        return res.end(asset.bytes);
      }
      if (url.pathname === "/api/kiosk/static-qris-demo/image" && req.method === "GET") {
        if (!runtime.kioskStaticQrisDemoEnabled || typeof runtime.kioskStaticDemoAsset !== "function") throw apiError("static_qris_demo_unavailable", 404);
        const kiosk = findSession(req, kioskSessions, clock, "saga_pos_kiosk");
        const owner = findSession(req, operatorSessions, clock, "saga_pos_operator");
        if (!kiosk && owner?.subject.role !== "owner") throw apiError("identity_required", 401);
        const asset = await runtime.kioskStaticDemoAsset();
        if (!asset) {
          res.writeHead(302, { location: "/assets/qris-static-demo.svg", "cache-control": "no-store" });
          return res.end();
        }
        res.writeHead(200, { "content-type": "image/png", "content-length": asset.bytes.length, "cache-control": "no-store", "x-content-type-options": "nosniff" });
        return res.end(asset.bytes);
      }
      if (url.pathname === "/api/admin/static-qris-demo/asset" && req.method === "GET") {
        if (!runtime.kioskStaticQrisDemoEnabled || typeof runtime.kioskStaticDemoAsset !== "function") throw apiError("static_qris_demo_unavailable", 404);
        requireOwnerSession(req, operatorSessions, clock);
        const asset = await runtime.kioskStaticDemoAsset();
        return json(res, 200, { configured: Boolean(asset), revision: asset?.revision ?? 0, sha256: asset?.sha256 ?? null, updatedAt: asset?.updatedAt ?? null, demoOnly: true });
      }
      if (url.pathname === "/api/admin/static-qris-demo/asset" && req.method === "POST") {
        if (!runtime.kioskStaticQrisDemoEnabled || typeof runtime.replaceKioskStaticDemoAsset !== "function") throw apiError("static_qris_demo_unavailable", 404);
        checkoutLimiter.consume(`admin-static-qris-demo:${clientKey(req)}`);
        assertSameOrigin(req);
        const session = requireOwnerSession(req, operatorSessions, clock);
        assertCsrf(req, session);
        return json(res, 200, await runtime.replaceKioskStaticDemoAsset(session.subject, await readJson(req, 360_000)));
      }
      if (url.pathname === "/api/admin/manual-qris/asset" && req.method === "GET") {
        if (typeof runtime.manualQrisAsset !== "function") throw apiError("manual_qris_asset_unavailable", 404);
        requireOwnerSession(req, operatorSessions, clock);
        const asset = await runtime.manualQrisAsset();
        return json(res, 200, { configured: Boolean(asset), revision: asset?.revision ?? 0,
          sha256: asset?.sha256 ?? null, updatedAt: asset?.updatedAt ?? null,
          checkoutEnabled: runtime.kioskManualQrisEnabled === true });
      }
      if (url.pathname === "/api/admin/manual-qris/asset" && req.method === "POST") {
        if (typeof runtime.replaceManualQrisAsset !== "function") throw apiError("manual_qris_asset_unavailable", 404);
        checkoutLimiter.consume(`admin-manual-qris:${clientKey(req)}`);
        assertSameOrigin(req);
        const session = requireOwnerSession(req, operatorSessions, clock);
        assertCsrf(req, session);
        return json(res, 200, await runtime.replaceManualQrisAsset(session.subject, await readJson(req, 360_000)));
      }
      if (url.pathname === "/api/admin/manual-qris/image" && req.method === "GET") {
        if (typeof runtime.manualQrisAsset !== "function") throw apiError("manual_qris_asset_unavailable", 404);
        requireOwnerSession(req, operatorSessions, clock);
        const asset = await runtime.manualQrisAsset();
        if (!asset) throw apiError("manual_qris_asset_not_configured", 404);
        res.writeHead(200, { "content-type": "image/png", "content-length": asset.bytes.length,
          "cache-control": "no-store", "x-content-type-options": "nosniff" });
        return res.end(asset.bytes);
      }
      const outletProductsRoute = /^\/api\/outlets\/([^/]+)\/products$/.exec(url.pathname);
      const outletDraftsRoute = /^\/api\/outlets\/([^/]+)\/menu-drafts$/.exec(url.pathname);
      const outletPublicationsRoute = /^\/api\/outlets\/([^/]+)\/menu-publications$/.exec(url.pathname);
      const productRoute = /^\/api\/products\/([^/]+)$/.exec(url.pathname);
      const productAvailabilityRoute = /^\/api\/products\/([^/]+)\/availability$/.exec(url.pathname);
      const productArchiveRoute = /^\/api\/products\/([^/]+)\/(archive|restore)$/.exec(url.pathname);
      if (outletProductsRoute || outletDraftsRoute || outletPublicationsRoute || productRoute || productAvailabilityRoute || productArchiveRoute) {
        if (!safeFeatureFlags.catalogWorkspaceV2) throw apiError("catalog_workspace_disabled", 409);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        await runtime.adminState(session.subject.role);
        const requestedOutletId = decodeURIComponent((outletProductsRoute || outletDraftsRoute || outletPublicationsRoute)?.[1] ?? String(runtime.ids?.outletId ?? deliveryContext.outletId));
        const authorizedOutletId = String(runtime.ids?.outletId ?? deliveryContext.outletId);
        if (requestedOutletId !== authorizedOutletId) throw apiError("outlet_scope_denied", 403);
        if (outletProductsRoute && req.method === "GET") return json(res, 200, { outletId: authorizedOutletId, catalogVersion: runtime.catalogPricing.version, categories: runtime.catalogPricing.catalog("ADMIN") });
        if (outletDraftsRoute && req.method === "GET") return json(res, 200, { outletId: authorizedOutletId, workspace: runtime.catalogPricing.workspaceState() });
        assertSameOrigin(req);
        assertCsrf(req, session);
        const input = await readJson(req, 2_200_000);
        const actorId = session.subject.employeeId ?? session.subject.userAccountId;
        if (outletProductsRoute && req.method === "POST") return json(res, 201, await runtime.adminAction(session.subject.role, actorId, "catalog.workspace.product.create", input));
        if (productRoute && req.method === "PATCH") return json(res, 200, await runtime.adminAction(session.subject.role, actorId, "catalog.workspace.product.update", { ...input, productId: decodeURIComponent(productRoute[1]) }));
        if (productAvailabilityRoute && req.method === "PATCH") return json(res, 200, await runtime.adminAction(session.subject.role, actorId, "catalog.availability.draft", { ...input, productId: decodeURIComponent(productAvailabilityRoute[1]) }));
        if (productArchiveRoute && req.method === "POST") return json(res, 200, await runtime.adminAction(session.subject.role, actorId, productArchiveRoute[2] === "archive" ? "catalog.product.archive" : "catalog.product.restore", { ...input, productId: decodeURIComponent(productArchiveRoute[1]) }));
        if (outletPublicationsRoute && req.method === "POST") { const result = await runtime.adminAction(session.subject.role, actorId, "catalog.workspace.publish", input); broadcastCatalogRevision({ action: "catalog.workspace.publish", catalogVersion: result.version, publicationRevision: result.publication?.revision ?? null, occurredAt: clock().toISOString() }); return json(res, 201, result); }
        throw apiError("method_not_allowed", 405);
      }
      if (req.method === "GET" && url.pathname === "/api/admin/state") {
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        const adminState = await runtime.adminState(session.subject.role);
        const esbCatalog = session.subject.role === "owner" && typeof runtime.esbCatalogAdminState === "function"
          ? await runtime.esbCatalogAdminState(session.subject.role)
          : { mode: "UNAVAILABLE", runtimeGuard: "DEFAULT_OFF", versions: [] };
        const discountApprovals = session.subject.role === 'owner' ? await runtime.discountApprovalState(session.subject) : null;
        return json(res, 200, { actor: session.subject, ...adminState, discountApprovals, esbCatalog, featureFlags: safeFeatureFlags, context: deliveryContext, csrfToken: session.csrfToken });
      }
      if (req.method === "GET" && url.pathname === "/api/admin/promotion-report") {
        const session = requireOwnerSession(req,operatorSessions,clock);
        return json(res,200,await runtime.promotionReport(session.subject.role,{from:url.searchParams.get('from')??'',to:url.searchParams.get('to')??''}));
      }
      if (req.method === "POST" && url.pathname === "/api/admin/promotion-preview") {
        assertSameOrigin(req);const session=requireOwnerSession(req,operatorSessions,clock);assertCsrf(req,session);
        if(!safeFeatureFlags.promoEngineV1)throw apiError("promotion_engine_disabled",409);
        return json(res,200,await runtime.previewPromotion(session.subject,await readJson(req)));
      }
      if (req.method === "GET" && url.pathname === "/api/operator/business-master-readiness") {
        const session = requireOwnerSession(req, operatorSessions, clock);
        const adminState = await runtime.adminState(session.subject.role);
        const operatorState = await runtime.operatorState(session.subject.role);
        const staffState = nativeStaff?.listOwner ? await nativeStaff.listOwner() : null;
        const attendanceHealth = nativeStaff?.health ? await nativeStaff.health() : null;
        const tableOrder = tableOrderHealth ? await tableOrderHealth() : { ready: false, mode: "OFF", payment: "OFF", businessFactsAffected: false };
        const inventoryWorkspace = typeof runtime.inventoryWorkspaceState === "function"
          ? await runtime.inventoryWorkspaceState(session.subject.role)
          : {};
        const transactionCatalog = typeof runtime.catalogPricing?.catalog === "function"
          ? runtime.catalogPricing.catalog("KIOSK")
          : [];
        let gatewayReadiness = null;
        if (typeof paymentGatewayReadiness === "function") {
          try { gatewayReadiness = await paymentGatewayReadiness(); }
          catch (error) { gatewayReadiness = { ready: false, errorCode: String(error?.message ?? "gateway_readiness_unavailable").split(":", 1)[0].replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) }; }
        }
        return json(res, 200, {
          data: buildBusinessMasterReadiness({ adminState, staffState, context: deliveryContext, generatedAt: clock().toISOString() }),
          phase3: typeof runtime.phase3ReadinessState === "function"
            ? await runtime.phase3ReadinessState(session.subject.role, { tableOrder, paymentMode: deliveryContext.paymentMode ?? productionPaymentMode })
            : null,
          phase4: buildPhase4WorkforceReadiness({
            staffState,
            attendanceHealth,
            portal: { canonicalPath: "/login/staff", pwa: true, requestCategories: ["schedule_change", "shift_swap", "leave", "permission", "sick", "overtime"] },
            generatedAt: clock().toISOString(),
          }),
          phase5: phase5MemberLifecycle.readiness({ generatedAt: clock().toISOString() }),
          phase6: phase6FinanceClosing.readiness({ dashboard: operatorState.dashboard, generatedAt: clock().toISOString() }),
          phase7: phase7ResiliencePilot.readiness({ generatedAt: clock().toISOString() }),
          phase8a: buildPhase8AOperationalDataReadiness({
            inventoryWorkspace,
            catalog: adminState.catalog,
            transactionCatalog,
            catalogWorkspace: adminState.menuWorkspace,
            inventoryReporting: readInventoryReportingHealth(),
            generatedAt: clock().toISOString(),
          }),
          phase8b: buildPhase8BPaymentGatewayReadiness({
            paymentMode: deliveryContext.paymentMode ?? productionPaymentMode,
            gatewayMode: deliveryContext.gateway,
            gatewayReadiness,
            activation: runtime.gatewayActivation,
            generatedAt: clock().toISOString(),
          }),
        });
      }
      if (req.method === "GET" && url.pathname === "/api/operator/member-lifecycle") {
        requireOwnerSession(req, operatorSessions, clock);
        return json(res, 200, {
          readiness: phase5MemberLifecycle.readiness({ generatedAt: clock().toISOString() }),
          scenarios: phase5MemberLifecycle.scenarios(),
        });
      }
      if (req.method === "POST" && url.pathname === "/api/operator/member-lifecycle/simulate") {
        assertSameOrigin(req);
        const session = requireOwnerSession(req, operatorSessions, clock);
        assertCsrf(req, session);
        return json(res, 200, phase5MemberLifecycle.simulate(await readJson(req)));
      }
      if (req.method === "GET" && url.pathname === "/api/operator/finance-closing") {
        const session = requireOwnerSession(req, operatorSessions, clock);
        const operatorState = await runtime.operatorState(session.subject.role);
        return json(res, 200, {
          readiness: phase6FinanceClosing.readiness({ dashboard: operatorState.dashboard, generatedAt: clock().toISOString() }),
          scenarios: phase6FinanceClosing.scenarios(),
        });
      }
      if (req.method === "POST" && url.pathname === "/api/operator/finance-closing/simulate") {
        assertSameOrigin(req);
        const session = requireOwnerSession(req, operatorSessions, clock);
        assertCsrf(req, session);
        return json(res, 200, phase6FinanceClosing.simulate(await readJson(req)));
      }
      if (req.method === "GET" && url.pathname === "/api/operator/resilience-pilot") {
        requireOwnerSession(req, operatorSessions, clock);
        return json(res, 200, {
          readiness: phase7ResiliencePilot.readiness({ generatedAt: clock().toISOString() }),
          scenarios: phase7ResiliencePilot.scenarios(),
        });
      }
      if (req.method === "POST" && url.pathname === "/api/operator/resilience-pilot/simulate") {
        assertSameOrigin(req);
        const session = requireOwnerSession(req, operatorSessions, clock);
        assertCsrf(req, session);
        return json(res, 200, phase7ResiliencePilot.simulate(await readJson(req)));
      }
      if (req.method === "GET" && url.pathname === "/api/catalog/events") {
        let session;
        try { session = requireSession(req, operatorSessions, clock, "saga_pos_operator"); }
        catch { session = requireSession(req, kioskSessions, clock, "saga_pos_kiosk"); }
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-content-type-options": "nosniff", "x-accel-buffering": "no" });
        res.write(`event: ready\ndata: ${JSON.stringify({ role: session.subject.role, catalogVersion: runtime.catalogPricing?.version ?? null })}\n\n`);
        catalogSubscribers.add(res);
        req.on("close", () => catalogSubscribers.delete(res));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/ap/state") {
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        return json(res, 200, { actor: session.subject, ...await runtime.apState(session.subject.role), context: deliveryContext, csrfToken: session.csrfToken });
      }
      if (req.method === "POST" && url.pathname === "/api/ap/actions") {
        assertSameOrigin(req);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        assertCsrf(req, session);
        const body = await readJson(req);
        return json(res, 200, await runtime.apAction(session.subject.role, session.subject.employeeId ?? session.subject.userAccountId, body.action, body.payload));
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/refund-preview') {
        assertSameOrigin(req);
        const session=requireSession(req,operatorSessions,clock,'saga_pos_operator');
        assertCsrf(req,session);
        return json(res,200,await runtime.previewOwnerRefund(session.subject.role,await readJson(req)));
      }
      if (req.method === "POST" && url.pathname === "/api/admin/actions") {
        assertSameOrigin(req);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        assertCsrf(req, session);
        const body = await readJson(req, 2_200_000);
        if ((String(body.action ?? "").startsWith("catalog.promotion.") || String(body.action ?? "").startsWith("catalog.workspace.promotion.") || String(body.action ?? '').startsWith('catalog.workspace.voucher.')) && !safeFeatureFlags.promoEngineV1) throw apiError("promotion_engine_disabled", 409);
        if ((String(body.action ?? "").startsWith("catalog.workspace.") || body.action === "catalog.availability.draft") && !safeFeatureFlags.catalogWorkspaceV2) throw apiError("catalog_workspace_disabled", 409);
        const result = await runtime.adminAction(session.subject.role, session.subject.employeeId ?? session.subject.userAccountId, body.action, body.payload);
        if (["catalog.workspace.publish", "catalog.publication.rollback", "catalog.availability"].includes(body.action)) broadcastCatalogRevision({ action: body.action, catalogVersion: result.version ?? runtime.catalogPricing?.version ?? null, publicationRevision: result.publication?.revision ?? null, occurredAt: clock().toISOString() });
        return json(res, 200, result);
      }
      if (req.method === "POST" && url.pathname === "/api/admin/replenishment/recommendations") {
        assertSameOrigin(req);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        assertCsrf(req, session);
        if (typeof runtime.recommendReplenishment !== "function") throw apiError("inventory_planning_runtime_unavailable", 503);
        return json(res, 201, await runtime.recommendReplenishment(session.subject, await readJson(req)));
      }
      if (req.method === "POST" && url.pathname === "/api/admin/replenishment/policies") {
        assertSameOrigin(req);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        assertCsrf(req, session);
        if (typeof runtime.upsertReplenishmentPolicy !== "function") throw apiError("inventory_planning_runtime_unavailable", 503);
        return json(res, 200, await runtime.upsertReplenishmentPolicy(session.subject, await readJson(req)));
      }
      if (req.method === "GET" && url.pathname === "/api/admin/exports/orders.csv") {
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        const payload = await runtime.exportOrdersCsv(session.subject.role);
        res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=orders-local.csv", "content-length": Buffer.byteLength(payload), "cache-control": "no-store" });
        return res.end(payload);
      }
      if (req.method === "POST" && url.pathname === "/api/operator/logout") {
        assertSameOrigin(req);
        const session = requireSession(req, operatorSessions, clock, "saga_pos_operator");
        assertCsrf(req, session);
        let remoteRevoked = null;
        if (session.subject.authProvider === "hrpos" && hrpos) remoteRevoked = (await hrpos.logout(session.tokenHash)).remoteRevoked;
        if (session.subject.authProvider === "production_owner" && hrpos) {
          const delegated = ownerHrSessions.get(session.tokenHash);
          if (delegated) remoteRevoked = (await hrpos.logout(delegated.tokenHash)).remoteRevoked;
          ownerHrSessions.delete(session.tokenHash);
        }
        await revokeSession("operator", session.tokenHash);
        operatorSessions.delete(session.tokenHash);
        clearCookie(res, "saga_pos_operator");
        return json(res, 200, { authenticated: false, ...(remoteRevoked === null ? {} : { remoteRevoked }) });
      }
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(302, { location: "/kiosk", "cache-control": "no-store" });
        return res.end();
      }
      if (req.method === "GET" || req.method === "HEAD") return serveStatic(url.pathname, req, res, productionRuntime, legacyStaffUiForTests);
      return json(res, 404, { error: { code: "not_found", message: safeMessage("not_found") } });
    } catch (error) {
      const rawCode = error.code ?? error.message ?? "internal_error";
      const code = typeof rawCode === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(rawCode) ? rawCode : "internal_error";
      const payload = { code, message: safeMessage(code) };
      if (["roster_publish_conflicts", "swap_schedule_conflict"].includes(code) && error.details != null) payload.details = error.details;
      const statusCode = Number(error.statusCode ?? error.status ?? 500);
      return json(res, Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : 500, { error: payload });
    }
  });

  async function ensureOwnerHrSession(ownerSession) {
    if (!hrpos || !ownerAuth || ownerSession.subject.authProvider !== "production_owner" || ownerSession.subject.role !== "owner") throw apiError("hrpos_role_denied", 403);
    const existing = ownerHrSessions.get(ownerSession.tokenHash);
    if (existing && new Date(existing.expiresAt) > clock()) {
      try { await hrpos.identity(existing.tokenHash, "hr"); return existing; }
      catch { ownerHrSessions.delete(ownerSession.tokenHash); }
    }
    const delegated = await hrpos.delegateOwner({ posOwnerAuthUserId: ownerAuth.authUserId, makeSession: (subject) => createSession({ subject, clock }) });
    ownerHrSessions.set(ownerSession.tokenHash, delegated);
    return delegated;
  }

  return { server, runtime, sharedPassword };
}

function authenticateOperator(body, sharedPassword) {
  if (String(body.organizationSlug ?? "").trim().toLowerCase() !== "kopi-saga") throw apiError("identity_invalid", 401);
  const actor = personas[String(body.employeeId ?? "").trim().toUpperCase()];
  if (!actor || body.password !== sharedPassword) throw apiError("identity_invalid", 401);
  return structuredClone(actor);
}

async function authenticateProductionOwner(body, ownerAuth, { passwordOnlyOwnerDashboard = false } = {}) {
  if (!ownerAuth?.enabled) throw apiError("production_owner_auth_required", 503);
  const suppliedOrganization = String(body.organizationSlug ?? "").trim().toLowerCase();
  const suppliedLogin = String(body.employeeId ?? "").trim();
  const identityMatches = (passwordOnlyOwnerDashboard && !suppliedLogin)
    || suppliedLogin.toLowerCase() === ownerAuth.login
    || suppliedLogin.toUpperCase() === ownerAuth.employeeId;
  if (suppliedOrganization !== ownerAuth.organizationSlug || !identityMatches) throw apiError("identity_invalid", 401);
  const password = String(body.password ?? "");
  if (!password || password.length > 256) throw apiError("identity_invalid", 401);
  const derived = await scryptAsync(password, ownerAuth.passwordHash.salt, ownerAuth.passwordHash.key.length, ownerAuth.passwordHash.options);
  if (derived.length !== ownerAuth.passwordHash.key.length || !timingSafeEqual(derived, ownerAuth.passwordHash.key)) throw apiError("identity_invalid", 401);
  return { employeeId: ownerAuth.employeeId, displayName: ownerAuth.displayName, role: "owner", mode: "DASHBOARD", authProvider: "production_owner" };
}

function hrLanding(role) { return { hr: "/hr", owner: "/dashboard", cashier: "/cashier", bar: "/kds", staff: "/staff" }[role] ?? "/hr"; }

async function serveStatic(urlPath, req, res, productionRuntime = false, legacyStaffUiForTests = false) {
  const mapped = routeFiles.get(urlPath);
  const requested = mapped || path.posix.normalize(urlPath).replace(/^\/+/, "");
  const root = legacyStaffUiForTests && (urlPath === '/staff' || urlPath === '/staff.js') ? legacyStaffFixtureRoot : publicRoot;
  const target = path.resolve(root, requested);
  if (!target.startsWith(path.resolve(root) + path.sep)) return json(res, 404, { error: { code: "not_found" } });
  let fileStat;
  try { fileStat = await stat(target); } catch { return json(res, 404, { error: { code: "not_found" } }); }
  if (!fileStat.isFile()) return json(res, 404, { error: { code: "not_found" } });
  const extension = path.extname(target);
  if (productionRuntime && extension === ".html") {
    const html = (await readFile(target, "utf8"))
      .replace('<body', '<body data-production="true"')
      .replace(/(<(?:div|header)\b[^>]*class="[^"]*\benvironment-banner\b[^"]*"[^>]*>)[\s\S]*?(<\/(?:div|header)>)/i, '$1<span id="delivery-scope">SAGAPOS · OWNER</span><span id="delivery-persistence">Data tersimpan · production</span>$2')
      .replace(/Employee ID/g, mapped === 'staff.html' ? 'Employee ID' : 'Email Owner')
      .replace(/Password sementara/g, mapped === 'staff.html' ? 'Password sementara' : 'Password')
      .replace(/value="(?:OWNER-DEMO|CASHIER-01|BAR-01)"/g, 'value=""')
      .replace(/<option value="FREE-AMERICANO">[^<]*<\/option>/g, "")
      .replace(/QRIS simulator/g, "QRIS nonaktif");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html), "cache-control": "no-store" });
    return res.end(req.method === "HEAD" ? undefined : html);
  }
  const versionedAsset = /^\/assets\/(?:menu|portrait-kiosk)\/v\d+\//.test(urlPath);
  res.writeHead(200, {
    "content-type": mime.get(extension) ?? "application/octet-stream",
    "content-length": fileStat.size,
    "cache-control": versionedAsset ? "public, max-age=31536000, immutable" : "no-store",
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(target).pipe(res);
}

function tableOrderState(snapshot, table, context, csrfToken) {
  const demoSource = table.demoSource === "KIOSK_DEMO" ? "KIOSK_DEMO" : "TABLE_QR_DEMO";
  return {
    context: { ...context, tableOrderMode: "DEMO", demoSource, paymentMode: "OFF" },
    table: { id: table.id, label: table.label },
    capabilities: {
      serviceAvailable: snapshot.capabilities?.serviceAvailable !== false,
      paymentMethods: ["QRIS_DEMO"],
      orderTypes: [demoSource === "KIOSK_DEMO" ? "TAKEAWAY" : "DINE_IN"],
      memberInput: false,
      demoOnly: true,
    },
    catalog: snapshot.catalog,
    catalogEtag: snapshot.catalogEtag,
    policy: snapshot.policy,
    activeOrder: snapshot.activeOrder,
    payment: snapshot.payment,
    fulfillment: snapshot.fulfillment,
    csrfToken,
  };
}

function menuKioskDemoState(snapshot, context, csrfToken) {
  return {
    ...snapshot,
    table: { id: "KIOSK-DEMO", label: "Kiosk Demo" },
    context: {
      ...context,
      surface: "MENU_KIOSK_DEMO",
      tableOrderMode: "DEMO",
      demoSource: "KIOSK_DEMO",
      paymentMode: "SIMULATOR_ONLY",
      memberMode: "SIMULATOR_ONLY",
    },
    capabilities: {
      ...snapshot.capabilities,
      serviceAvailable: snapshot.capabilities?.serviceAvailable !== false,
      memberInput: true,
      memberMode: "phone",
      nfcAvailable: false,
      nfcSimulatorAvailable: true,
      orderTypes: ["DINE_IN", "TAKEAWAY"],
      paymentMethods: ["QRIS", "CASH_ASSISTED"],
      assistedCash: {
        enabled: true,
        available: true,
        staffConfirmationRequired: true,
        simulator: true,
      },
      demoOnly: true,
    },
    csrfToken,
  };
}

function menuCatalogState(runtime, context, clock) {
  const presentationConfiguration = runtime.catalogPricing.publicPresentationConfiguration();
  const promotions = presentationConfiguration.promotionRules
    .filter((rule) => rule.activationMode !== "VOUCHER" && rule.status === "ACTIVE" && rule.effectiveState === "EFFECTIVE")
    .map((rule) => ({
      id: rule.id,
      name: rule.name,
      type: rule.type,
      value: rule.value,
      minimumSpendRupiah: rule.minimumSpendRupiah ?? 0,
      capRupiah: rule.capRupiah ?? null,
      stackPolicy: rule.stackPolicy,
      quotaLimit: rule.quotaLimit ?? null,
      perOrderLimit: rule.perOrderLimit ?? null,
      eligibilitySummary: publicPromotionEligibility(rule),
      startsAt: rule.startsAt,
      endsAt: rule.endsAt ?? null,
    }));
  const ordering = presentationConfiguration.orderingSettings;
  const catalog = runtime.catalogPricing.catalog("KIOSK").map((category) => ({
    id: category.id,
    name: category.name,
    products: category.products.map((product) => {
      const dummyRecord = DUMMY_CATALOG_CONTENT_BY_PRODUCT.get(product.id);
      const details = product.catalogDetails ?? dummyRecord?.catalogDetails ?? null;
      const contentStatus = product.catalogDetails ? "PUBLISHED" : dummyRecord ? "DUMMY_PREVIEW_ONLY" : "MISSING";
      return {
      id: product.id,
      name: product.name,
      priceRupiah: product.priceRupiah,
      available: product.available !== false,
      imageUrl: product.imageUrl ?? null,
      imageAlt: product.imageAlt || product.name,
      contentStatus,
      contentDisclaimer: contentStatus === "DUMMY_PREVIEW_ONLY" ? DUMMY_CATALOG_CONTENT_DISCLAIMER : null,
      shortDescription: details?.shortDescription ?? "",
      description: details?.description ?? "",
      profileTags: details?.profileTags ?? [],
      allergens: details?.allergens ?? [],
      badges: details?.badges ?? [],
      alternativeProductIds: details?.alternativeProductIds ?? [],
      nutritionEstimate: details?.nutritionEstimate ?? null,
      customizations: [...(product.variantGroups ?? []), ...(product.modifierGroups ?? [])].map((group) => ({
        name: group.name,
        required: group.required === true || Number(group.minSelections ?? 0) > 0,
        options: (group.options ?? []).map((option) => ({ name: option.name, priceDeltaRupiah: Number(option.priceDeltaRupiah ?? option.priceRupiah ?? 0) })),
      })),
    };
    }),
  }));
  return {
    surfaceMode: "CATALOG_PREVIEW",
    readOnly: true,
    capabilities: { cart: false, quote: false, checkout: false, payment: false, tableIdentity: false, kdsDispatch: false },
    catalog,
    catalogEtag: runtime.catalogPricing.etag("KIOSK"),
    productCount: catalog.reduce((sum, category) => sum + category.products.length, 0),
    promotions,
    store: {
      name: "Kopi Saga Salak",
      timezone: "Asia/Jakarta",
      browsingAvailable: true,
      orderingPaused: ordering.paused === true,
      hoursEnforced: ordering.enforceHours === true,
      opensAt: ordering.opensAt,
      lastOrderAt: ordering.lastOrderAt,
      closesAt: ordering.closesAt,
    },
    member: { mode: "HANDOFF_ONLY", url: "https://member.example.invalid", personalized: false },
    freshness: { source: "SAGAPOS_PUBLISHED_CATALOG", checkedAt: clock().toISOString(), publishedRevision: presentationConfiguration.publishedRevision },
    presentation: {
      priceFormat: "THOUSANDS_K_NO_CURRENCY_SYMBOL",
      nutritionLabel: "Estimasi Resep",
      designSystem: "WARM_WOOD_EDITORIAL_V1",
      dummyContentVersion: DUMMY_CATALOG_CONTENT_VERSION,
    },
    context: { scope: context.scope, paymentMode: "OFF", memberMode: context.memberMode ?? "OFF" },
  };
}

function publicPromotionEligibility(rule) {
  const productCount = rule.eligibleProductIds?.length ?? 0;
  const categoryCount = rule.eligibleCategoryIds?.length ?? 0;
  const exclusions = (rule.excludedProductIds?.length ?? 0) + (rule.excludedCategoryIds?.length ?? 0);
  if (productCount) return `${productCount} produk terpilih${exclusions ? ` dengan ${exclusions} pengecualian` : ""}`;
  if (categoryCount) return `${categoryCount} kategori terpilih${exclusions ? ` dengan ${exclusions} pengecualian` : ""}`;
  return exclusions ? `Semua menu dengan ${exclusions} pengecualian` : "Semua menu yang memenuhi aturan transaksi";
}

function createSession({ subject, clock }) {
  const token = randomBytes(32).toString("base64url");
  return {
    id: randomUUID(),
    token,
    tokenHash: digest(token),
    csrfToken: randomBytes(24).toString("base64url"),
    subject,
    createdAt: clock().toISOString(),
    expiresAt: new Date(clock().getTime() + 4 * 60 * 60_000).toISOString(),
  };
}

function requireSession(req, sessions, clock, cookieName) {
  const token = parseCookies(req.headers.cookie)[cookieName];
  if (!token) throw apiError("authentication_required", 401);
  const tokenHash = digest(token);
  const session = sessions.get(tokenHash);
  if (!session || new Date(session.expiresAt) <= clock()) {
    sessions.delete(tokenHash);
    throw apiError("session_expired", 401);
  }
  return session;
}

function findSession(req, sessions, clock, cookieName) {
  const token = parseCookies(req.headers.cookie)[cookieName];
  if (!token) return null;
  const tokenHash = digest(token);
  const session = sessions.get(tokenHash);
  if (!session || new Date(session.expiresAt) <= clock()) {
    sessions.delete(tokenHash);
    return null;
  }
  return session;
}

function assertCsrf(req, session) {
  const supplied = String(req.headers["x-csrf-token"] ?? "");
  const expected = session.csrfToken;
  if (!supplied || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw apiError("csrf_invalid", 403);
}

function assertSameOrigin(req) {
  const expected = `${requestProtocol(req)}://${req.headers.host}`;
  if (req.headers.origin !== expected) throw apiError("origin_invalid", 403);
}

function inventoryPlanningQuery(searchParams) {
  return {
    itemId: searchParams.get("itemId") || undefined,
    locationId: searchParams.get("locationId") || undefined,
    asOf: searchParams.get("asOf") || undefined,
    organizationId: searchParams.get("organizationId") || undefined,
    outletId: searchParams.get("outletId") || undefined,
    tenantId: searchParams.get("tenantId") || undefined,
  };
}

function inventoryReportingAuthority(ids) {
  if (!ids?.organizationId || !ids?.outletId) throw apiError("inventory_reporting_authority_invalid", 500);
  return Object.freeze({ organizationId: ids.organizationId, outletIds: Object.freeze([ids.outletId]), scopeLevel: "OUTLET" });
}

function requireInventoryReportingApi(api) {
  if (!api) throw apiError("inventory_reporting_provider_unavailable", 503);
  return api;
}

function requireOwnerSession(req, sessions, clock) {
  const session = requireSession(req, sessions, clock, "saga_pos_operator");
  if (session.subject.role !== "owner") throw apiError("owner_required", 403);
  return session;
}

function queryPlain(searchParams) {
  const output = Object.create(null);
  for (const [key, value] of searchParams) {
    if (Object.hasOwn(output, key)) output[key] = Array.isArray(output[key]) ? [...output[key], value] : [output[key], value];
    else output[key] = value;
  }
  return output;
}

function normalizeMenuPromoFeatureFlags(input = {}) {
  return Object.freeze({
    menuUiV2: input.menuUiV2 === true,
    catalogWorkspaceV2: input.catalogWorkspaceV2 === true,
    promoEngineV1: input.promoEngineV1 === true,
  });
}

function staffReceivingContext(runtime, subject) {
  return Object.freeze({
    organizationId: runtime.ids?.organizationId ?? SAGA_POS_ALPHA_CONTEXT.organizationId,
    outletId: runtime.ids?.outletId ?? SAGA_POS_ALPHA_CONTEXT.outletId,
    staffId: subject.staffId,
    actorReference: subject.staffId,
  });
}

function ownerReceivingContext(runtime, subject) {
  return Object.freeze({
    organizationId: runtime.ids?.organizationId ?? SAGA_POS_ALPHA_CONTEXT.organizationId,
    outletId: runtime.ids?.outletId ?? SAGA_POS_ALPHA_CONTEXT.outletId,
    actorReference: subject.employeeId ?? runtime.ids?.ownerProfileId ?? "owner",
  });
}

function streamReceiptEvidence(res, evidence) {
  res.writeHead(200, {
    "content-type": evidence.contentType,
    "content-length": evidence.byteSize,
    "cache-control": "private, no-store",
    "content-disposition": "inline",
    "x-content-type-options": "nosniff",
    etag: `"sha256-${evidence.checksum}"`,
  });
  evidence.stream.once("error", () => res.destroy());
  evidence.stream.pipe(res);
}

async function discardRequestBody(req) {
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 32_768) throw apiError("request_too_large", 413);
  }
}

async function readJson(req, maximumBytes = 32_768) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maximumBytes) throw apiError("request_too_large", 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw apiError("json_invalid", 400); }
}

function parseCookies(header = "") {
  return Object.fromEntries(String(header).split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}

function setCookie(req, res, name, value, maxAge, forceSecure = false) {
  const secure = forceSecure || requestProtocol(req) === "https" ? "; Secure" : "";
  res.setHeader("set-cookie", `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`);
}

function clearCookie(res, name) {
  res.setHeader("set-cookie", `${name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function setSecurityHeaders(res, req) {
  res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  const staffHost = String(req?.headers?.host ?? '').split(':')[0] === 'staff.example.invalid';
  res.setHeader("permissions-policy", `camera=${staffHost ? '(self)' : '()'}, microphone=(), geolocation=${staffHost ? '(self)' : '()'}, payment=(), usb=(), serial=(), hid=()`);
  res.setHeader("cache-control", "no-store");
}

function json(res, status, body) {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), "cache-control": "no-store" });
  res.end(payload);
}

function writeSse(res, event, body) {
  if (res.destroyed || res.writableEnded) return false;
  res.write(`event: ${String(event).replace(/[^a-z0-9_-]/gi, "")}\n`);
  res.write(`data: ${JSON.stringify(body)}\n\n`);
  return true;
}

function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function normalizeReleaseEvidence(value) {
  if (value == null) return null;
  if (!/^[0-9a-f]{40}$/.test(value.sourceSha ?? "") || !/^[0-9a-f]{64}$/.test(value.migrationFingerprint ?? "") || !Number.isInteger(value.migrationCount) || value.migrationCount < 1 || value.migrationCount > 100) throw new Error("release_evidence_invalid");
  return Object.freeze({ sourceSha: value.sourceSha, migrationFingerprint: value.migrationFingerprint, migrationCount: value.migrationCount });
}
function normalizeProductionOwnerAuth(value, runtimeIds, clock) {
  if (value == null || value.enabled === false) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("production_owner_auth_invalid");
  if (!Object.keys(value).every((key) => ["enabled", "organizationSlug", "login", "employeeId", "displayName", "authUserId", "ownerProfileId", "organizationId", "expiresAt", "passwordHash"].includes(key))) throw new Error("production_owner_auth_invalid");
  if (value.enabled !== true) throw new Error("production_owner_auth_invalid");
  const organizationSlug = String(value.organizationSlug ?? "").trim().toLowerCase();
  const login = String(value.login ?? "").trim().toLowerCase();
  const employeeId = String(value.employeeId ?? "").trim().toUpperCase();
  const displayName = String(value.displayName ?? "").trim();
  if (!/^[a-z0-9-]{3,80}$/.test(organizationSlug) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login) || !/^[A-Z0-9_-]{3,80}$/.test(employeeId) || !displayName || displayName.length > 80 || /[<>]/.test(displayName)) throw new Error("production_owner_auth_invalid");
  if (value.authUserId !== runtimeIds?.authUserId || value.ownerProfileId !== runtimeIds?.ownerProfileId || value.organizationId !== runtimeIds?.organizationId) throw new Error("production_owner_auth_scope_mismatch");
  return Object.freeze({ enabled: true, organizationSlug, login, employeeId, displayName, authUserId: value.authUserId, passwordHash: parseScryptPasswordHash(value.passwordHash) });
}
function parseScryptPasswordHash(value) {
  const parts = String(value ?? "").split(":");
  if (parts.length !== 4 || parts[0] !== "scrypt" || parts[1] !== "n=16384,r=8,p=1") throw new Error("production_owner_auth_invalid");
  const salt = Buffer.from(parts[2], "base64url");
  const key = Buffer.from(parts[3], "base64url");
  if (salt.length < 16 || salt.length > 32 || key.length !== 32) throw new Error("production_owner_auth_invalid");
  return Object.freeze({ salt, key, options: Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }) });
}
function clientKey(req) { return String(req.socket.remoteAddress ?? "unknown"); }
function requestHostname(req) { return String(req.headers.host ?? "").trim().toLowerCase().replace(/:\d+$/, ""); }
function isBasicProtectedKioskRequest(req) {
  const host = requestHostname(req);
  const forwardedHost = String(req.headers["x-forwarded-host"] ?? "").split(",")[0].trim().toLowerCase().replace(/:\d+$/, "");
  const authenticatedUser = String(req.headers["x-sagapos-basic-user"] ?? "").trim();
  return host === "kiosk.pos.example.invalid"
    && forwardedHost === host
    && requestProtocol(req) === "https"
    && authenticatedUser.length > 0
    && authenticatedUser.length <= 128;
}
function requestProtocol(req) {
  const forwarded = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim().toLowerCase();
  if (forwarded === "https" || forwarded === "http") return forwarded;
  return req.socket.encrypted ? "https" : "http";
}

function assertInventoryAuthorityManager(actor) {
  if (!actor || !["owner", "manager"].includes(actor.role) || !actor.employeeId) throw apiError("reliability_manager_required", 403);
}

function apiError(code, statusCode) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizeInventoryReportingHealth(input, apiEnabled) {
  if (input == null) {
    const fixed = Object.freeze({ mode: apiEnabled ? "INJECTED" : "OFF", required: false, configured: apiEnabled, ready: apiEnabled, projection: apiEnabled ? "INJECTED" : "OFF", worker: "OFF", invalidation: null, freshness: null, queue: null });
    return () => fixed;
  }
  if (typeof input !== "function") throw new Error("inventory_reporting_health_invalid");
  return () => {
    const value = input();
    const keys = ["configured", "freshness", "invalidation", "mode", "projection", "queue", "ready", "required", "worker", ...(value?.dataQuality === undefined ? [] : ["dataQuality"])].sort();
    if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)
      || !new Set(["OFF", "POSTGRES", "INJECTED"]).has(value.mode) || !new Set(["OFF", "DIRECT_REPEATABLE_READ", "INJECTED"]).has(value.projection) || !new Set(["OFF", "READY", "UNAVAILABLE"]).has(value.worker)
      || ["configured", "ready", "required"].some((key) => typeof value[key] !== "boolean")) throw new Error("inventory_reporting_health_invalid");
    const invalidation = inventoryReportingInvalidationHealth(value.invalidation);
    const freshness = inventoryReportingFreshnessHealth(value.freshness);
    const queue = inventoryReportingQueueHealth(value.queue);
    const dataQuality = inventoryReportingDataQualityHealth(value.dataQuality);
    if (value.mode === "OFF" && (value.configured || value.ready || value.required || value.projection !== "OFF" || value.worker !== "OFF" || invalidation || freshness || queue || dataQuality)) throw new Error("inventory_reporting_health_invalid");
    if (value.projection === "DIRECT_REPEATABLE_READ" && (value.worker !== "OFF" || invalidation || queue || freshness?.status !== "DIRECT")) throw new Error("inventory_reporting_health_invalid");
    if (value.ready && value.projection === "INJECTED" && (value.worker !== "READY" || invalidation?.status !== "READY" || freshness?.status !== "FRESH" || !queue || queue.deadLetter !== 0 || queue.expiredLease !== 0)) throw new Error("inventory_reporting_health_invalid");
    return Object.freeze({ mode: value.mode, required: value.required, configured: value.configured, ready: value.ready, projection: value.projection, worker: value.worker, invalidation, freshness, queue, ...(dataQuality ? { dataQuality } : {}) });
  };
}

function inventoryReportingDataQualityHealth(value) {
  if (value === undefined) return null;
  const keys = ["legacyPaidOrderGapBacklog", "truncated"];
  if (!plainObject(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys) || typeof value.truncated !== "boolean") throw new Error("inventory_reporting_health_invalid");
  const legacyPaidOrderGapBacklog = optionalInventoryReportingHealthInteger(value.legacyPaidOrderGapBacklog, 1_000, 0, false);
  return Object.freeze({ legacyPaidOrderGapBacklog, truncated: value.truncated });
}

function inventoryReportingInvalidationHealth(value) {
  if (value == null) return null;
  const keys = ["backlogCount", "lagSeconds", "status"];
  if (!plainObject(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys) || !new Set(["READY", "UNAVAILABLE"]).has(value.status)) throw new Error("inventory_reporting_health_invalid");
  const backlogCount = optionalInventoryReportingHealthInteger(value.backlogCount, 1_000_000);
  const lagSeconds = optionalInventoryReportingHealthInteger(value.lagSeconds, 31 * 24 * 60 * 60);
  if ((backlogCount === null) !== (lagSeconds === null) || (value.status === "READY" && backlogCount === null)) throw new Error("inventory_reporting_health_invalid");
  return Object.freeze({ status: value.status, backlogCount, lagSeconds });
}

function inventoryReportingFreshnessHealth(value) {
  if (value == null) return null;
  const keys = ["ageSeconds", "maxAgeSeconds", "status"];
  if (!plainObject(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys) || !new Set(["DIRECT", "FRESH", "STALE", "UNKNOWN"]).has(value.status)) throw new Error("inventory_reporting_health_invalid");
  const ageSeconds = optionalInventoryReportingHealthInteger(value.ageSeconds, 31 * 24 * 60 * 60);
  const maxAgeSeconds = optionalInventoryReportingHealthInteger(value.maxAgeSeconds, 31 * 24 * 60 * 60, 1);
  if (value.status === "DIRECT" && (ageSeconds !== null || maxAgeSeconds !== null)) throw new Error("inventory_reporting_health_invalid");
  if (value.status === "FRESH" && (ageSeconds === null || maxAgeSeconds === null || ageSeconds > maxAgeSeconds)) throw new Error("inventory_reporting_health_invalid");
  if (value.status === "STALE" && (ageSeconds === null || maxAgeSeconds === null || ageSeconds <= maxAgeSeconds)) throw new Error("inventory_reporting_health_invalid");
  if (value.status === "UNKNOWN" && (ageSeconds !== null || maxAgeSeconds !== null)) throw new Error("inventory_reporting_health_invalid");
  return Object.freeze({ status: value.status, ageSeconds, maxAgeSeconds });
}

function inventoryReportingQueueHealth(value) {
  if (value == null) return null;
  const keys = ["deadLetter", "expiredLease", "pending", "retryWait", "running"];
  if (!plainObject(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)) throw new Error("inventory_reporting_health_invalid");
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, optionalInventoryReportingHealthInteger(value[key], 1_000_000, 0, false)])));
}

function optionalInventoryReportingHealthInteger(value, max, min = 0, nullable = true) {
  if (value === null && nullable) return null;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("inventory_reporting_health_invalid");
  return value;
}

function plainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

function safeMessage(code) {
  const messages = {
    table_order_unavailable: "Order dari meja belum tersedia. Minta bantuan staf.",
    table_order_token_invalid: "QR meja tidak valid. Scan ulang QR yang tersedia di meja.",
    table_order_token_expired: "QR atau sesi meja sudah kedaluwarsa. Scan ulang QR di meja.",
    table_order_token_revoked: "QR meja ini sudah diganti. Scan QR terbaru di meja.",
    table_order_table_unavailable: "Meja ini sedang tidak menerima pesanan. Minta bantuan staf.",
    table_order_session_scope_denied: "Sesi meja tidak sesuai. Scan ulang QR di meja.",
    table_order_ttl_invalid: "Masa aktif QR meja tidak valid.",
    identity_invalid: "Organisasi, Employee ID, atau password tidak valid.",
    native_staff_disabled: "Portal karyawan SagaPOS belum siap.",
    password_change_required: "Ganti password sementara sebelum melanjutkan.",
    new_password_invalid: "Password baru harus berbeda dan minimal 12 karakter.",
    current_password_invalid: "Password saat ini tidak cocok.",
    password_changed_concurrently: "Password sudah berubah. Masuk ulang sebelum mencoba lagi.",
    staff_not_found: "Akun karyawan tidak ditemukan.",
    staff_not_found_or_reset_required: "Akun ini perlu reset password sebelum bisa diaktifkan.",
    schedule_locked_or_missing: "Jadwal sudah memiliki absensi atau tidak ditemukan; tidak bisa diedit.",
    schedule_not_found: "Jadwal tidak ditemukan untuk akun ini.",
    schedule_range_invalid: "Rentang jadwal harus berurutan dan maksimal 93 hari.",
    schedule_time_invalid: "Waktu selesai shift harus setelah mulai, maksimal 24 jam.",
    schedule_overlap_or_staff_not_found: "Jadwal bertabrakan dengan shift aktif atau karyawan tidak ditemukan.",
    shift_template_invalid: "Template shift belum lengkap atau nilainya tidak valid.",
    shift_template_code_exists: "Kode template shift sudah digunakan.",
    shift_template_not_found: "Template shift tidak ditemukan.",
    roster_period_not_found: "Periode jadwal tidak ditemukan.",
    roster_period_locked: "Periode jadwal sudah dikunci dan tidak dapat diubah.",
    roster_version_conflict: "Roster telah berubah di perangkat lain. Muat ulang sebelum menyimpan.",
    roster_assignment_outside_period: "Tanggal jadwal berada di luar periode roster.",
    roster_assignment_locked: "Penempatan yang dikunci dipertahankan. Buka kunci melalui sel jadwal untuk mengubahnya.",
    roster_role_mismatch: "Peran karyawan tidak sesuai dengan kebutuhan template shift.",
    roster_unavailable: "Karyawan sedang cuti atau tidak tersedia pada waktu tersebut.",
    roster_overlap: "Jadwal karyawan bertabrakan dengan jadwal lain.",
    roster_minimum_rest: "Jarak istirahat antarsift belum memenuhi aturan roster.",
    roster_weekly_hours: "Total jam kerja mingguan karyawan melewati batas roster.",
    roster_consecutive_days: "Jadwal membuat karyawan bekerja terlalu banyak hari berturut-turut.",
    roster_review_required: "Ubah roster ke status Review sebelum dipublikasikan.",
    roster_publish_conflicts: "Roster masih memiliki konflik dan belum dapat dipublikasikan.",
    roster_empty: "Tambahkan minimal satu jadwal sebelum mempublikasikan roster.",
    attendance_already_recorded: "Shift ini sudah memiliki absensi. Hubungi Owner untuk koreksi.",
    no_open_attendance: "Belum ada absensi masuk yang bisa dipulangkan.",
    request_range_invalid: "Rentang waktu permohonan tidak valid.",
    request_not_found: "Pengajuan tidak ditemukan untuk akun ini.",
    request_status_invalid: "Status pengajuan tidak valid.",
    request_category_invalid: "Jenis pengajuan tidak valid.",
    request_limit_invalid: "Jumlah pengajuan yang diminta tidak valid.",
    swap_target_invalid: "Pilih shift rekan yang masih aktif.",
    request_not_actionable: "Permohonan ini tidak lagi bisa diproses.",
    swap_schedule_changed: "Jadwal tukar shift sudah berubah. Muat ulang sebelum menyetujui.",
    swap_schedule_locked: "Shift sudah memiliki absensi dan tidak dapat ditukar.",
    swap_schedule_conflict: "Tukar shift menimbulkan bentrok jadwal, cuti, atau waktu istirahat.",
    swap_roster_mismatch: "Data roster dan jadwal tidak lagi sinkron. Muat ulang sebelum menyetujui.",
    swap_role_mismatch: "Peran karyawan tidak sesuai dengan shift yang akan diterima.",
    swap_staff_ineligible: "Salah satu akun karyawan sedang tidak aktif atau ditangguhkan.",
    authentication_required: "Sesi yang sesuai diperlukan.",
    session_expired: "Sesi berakhir. Silakan mulai atau masuk kembali.",
    csrf_invalid: "Permintaan ditolak karena token keamanan tidak valid.",
    origin_invalid: "Permintaan lintas-origin ditolak.",
    production_owner_auth_required: "Login Owner production belum dikonfigurasi.",
    hrpos_disabled: "Fitur HR belum terhubung ke Owner Dashboard.",
    hrpos_login_required: "Sesi Owner atau sesi kerja diperlukan.",
    hrpos_role_denied: "Sesi ini tidak memiliki akses HR.",
    hrpos_owner_delegation_denied: "Delegasi HR untuk Owner tidak tersedia.",
    cart_required: "Tambahkan minimal satu menu sebelum checkout.",
    cart_item_invalid: "Jumlah item tidak valid.",
    active_product_required: "Menu tidak tersedia untuk dipesan.",
    active_order_exists: "Selesaikan pembayaran aktif sebelum membuat pesanan baru.",
    checkout_quote_required: "Konfirmasi total terbaru diperlukan sebelum membuat pembayaran.",
    checkout_quote_invalid: "Konfirmasi total tidak valid. Periksa kembali sebelum membayar.",
    checkout_quote_expired: "Konfirmasi total sudah kedaluwarsa. Periksa kembali sebelum membayar.",
    checkout_quote_changed: "Menu, benefit, atau total berubah. Periksa kembali sebelum membayar.",
    cash_session_open_required: "Buka shift kas sebelum menerima pembayaran.",
    cash_received_under_amount: "Uang diterima kurang dari total pembayaran.",
    cashier_quote_changed: "Harga pesanan berubah. Periksa total terbaru sebelum membayar kembali.",
    promotion_report_date_invalid: "Rentang tanggal laporan tidak valid. Pilih tanggal awal sebelum tanggal akhir.",
    partial_refund_not_available: "Refund sebagian belum tersedia. Permintaan ini tidak mengubah transaksi; gunakan alur refund penuh bila memang seluruh pesanan dibatalkan.",
    partial_refund_payment_not_available: "Refund per item saat ini hanya untuk tunai. QRIS harus melalui rekonsiliasi pengembalian dana; status pembayaran tidak diubah otomatis.",
    refund_items_invalid: "Pilih item dan jumlah yang masih dapat direfund. Nominal dihitung dari transaksi asli.",
    refund_quantity_exceeds_remaining: "Jumlah refund melebihi sisa item. Perbarui detail pesanan sebelum mencoba lagi.",
    refund_original_allocation_required: "Transaksi lama belum menyimpan pembagian diskon per item. Refund sebagian ditolak; gunakan refund penuh bila seluruh pesanan dibatalkan.",
    refund_state_changed: "Ada refund lain yang baru tersimpan. Perbarui detail pesanan dan periksa sisa item sebelum mencoba lagi.",
    partial_refund_esb_ledger_unavailable: "Refund per item belum tersedia pada mode ledger ini. Tidak ada uang atau stok yang diubah.",
    partial_refund_split_payment_unavailable: "Pesanan memiliki pembayaran terbagi. Refund per item belum tersedia untuk pembayaran ini.",
    refund_retry_conflict: "Permintaan refund ini sudah digunakan dengan rincian berbeda. Periksa riwayat refund; jangan ulang dengan nominal baru.",
    refund_reconciliation_required: "Refund sebelumnya masih menunggu rekonsiliasi. Selesaikan pemeriksaannya sebelum membuat refund lain.",
    cashier_role_denied: "Role ini tidak boleh menggunakan Cashier Mode.",
    owner_required: "Aksi ini hanya dapat dilakukan Owner.",
    order_filter_invalid: "Filter pesanan tidak valid. Periksa tanggal, pencarian, status, dan halaman lalu coba lagi.",
    order_not_found: "Pesanan tidak tersedia pada outlet ini. Perbarui daftar pesanan lalu coba lagi.",
    pricing_tax_rate_invalid: "Tarif pajak harus antara 0% dan 100% dengan maksimal dua angka desimal.",
    pricing_service_rate_invalid: "Tarif service harus antara 0% dan 100% dengan maksimal dua angka desimal.",
    pricing_tax_timing_invalid: "Dasar pengenaan pajak tidak valid.",
    pricing_rounding_mode_invalid: "Metode pembulatan tidak valid.",
    pricing_rounding_step_invalid: "Satuan pembulatan tidak valid untuk metode yang dipilih.",
    inventory_action_not_found: "Aksi Stok & HPP tidak tersedia.",
    inventory_action_payload_invalid: "Data perubahan Stok & HPP tidak valid.",
    ingredient_not_found: "Bahan tidak ditemukan. Muat ulang data terbaru.",
    ingredient_name_invalid: "Nama bahan wajib diisi dan maksimal 80 karakter.",
    ingredient_name_conflict: "Nama bahan sudah digunakan.",
    ingredient_code_invalid: "Kode bahan wajib 2–40 karakter: huruf, angka, titik, garis bawah, atau tanda hubung.",
    ingredient_code_conflict: "Kode bahan sudah digunakan.",
    ingredient_category_invalid: "Kategori bahan wajib diisi dan maksimal 60 karakter.",
    ingredient_unit_invalid: "Satuan dasar harus gram, ml, atau pcs.",
    ingredient_unit_locked_after_movement: "Satuan dasar terkunci karena bahan sudah memiliki histori operasional.",
    ingredient_cost_purchase_managed: "Biaya bahan ini dikelola otomatis dari rata-rata pembelian.",
    ingredient_dependency_active: "Bahan tidak dapat diarsipkan karena sudah dipakai oleh stok, transaksi, atau resep.",
    ingredient_production_dependency_active: "Identitas atau sumber bahan olahan terkunci karena sudah dipakai oleh resep atau batch produksi.",
    ingredient_recipe_identity_locked: "Nama, satuan, sumber, dan jenis bahan terkunci karena sudah dipakai oleh resep produksi.",
    ingredient_conversion_factor_invalid: "Nilai konversi harus lebih dari nol dan maksimal enam angka desimal.",
    ingredient_conversion_same_uom: "Satuan asal dan tujuan konversi harus berbeda.",
    ingredient_conversion_path_missing: "Rantai konversi menuju satuan dasar belum lengkap.",
    ingredient_uom_invalid: "Nama satuan tidak valid.",
    ingredient_supplier_name_invalid: "Nama supplier wajib diisi.",
    ingredient_package_label_invalid: "Nama kemasan wajib diisi.",
    ingredient_package_identity_conflict: "Referensi kemasan tidak boleh dipindahkan ke bahan lain.",
    material_category_not_found: "Kategori bahan tidak ditemukan. Muat ulang pilihan kategori.",
    material_category_archived: "Kategori sudah diarsipkan dan tidak dapat dipakai untuk bahan baru.",
    material_category_name_conflict: "Nama kategori sudah digunakan.",
    material_category_prefix_conflict: "Prefix kategori sudah digunakan.",
    material_category_prefix_invalid: "Prefix kategori harus terdiri dari 2–5 huruf atau angka.",
    material_category_base_unit_invalid: "Satuan rekomendasi kategori harus gram, ml, atau pcs.",
    material_category_storage_invalid: "Pilih penyimpanan suhu ruang, dingin, atau beku.",
    material_category_expiry_tracking_invalid: "Pilihan pelacakan kedaluwarsa tidak valid.",
    material_category_in_use: "Kategori masih dipakai oleh bahan aktif dan belum dapat diarsipkan.",
    material_category_required_for_auto_code: "Pilih kategori agar kode bahan dapat dibuat otomatis.",
    ingredient_code_sequence_exhausted: "Nomor kode pada kategori ini sudah penuh.",
    ingredient_purchase_option_not_found: "Pilihan pembelian tidak ditemukan untuk bahan tersebut.",
    ingredient_purchase_option_levels_invalid: "Susunan kemasan harus langsung ke satuan dasar atau maksimal karton → isi → satuan dasar.",
    ingredient_purchase_option_conversion_conflict: "Total konversi kemasan tidak sesuai dengan rincian isi.",
    ingredient_purchase_option_preferred_invalid: "Pilihan utama kemasan tidak valid.",
    ingredient_reference_price_invalid: "Harga acuan harus lebih dari nol, atau dikosongkan bila belum tersedia.",
    purchase_quantity_invalid: "Jumlah penerimaan harus lebih dari nol.",
    purchase_lines_invalid: "Isi minimal satu bahan untuk penerimaan.",
    purchase_unit_label_invalid: "Satuan pembelian wajib diisi.",
    purchase_conversion_invalid: "Satuan pembelian belum memiliki konversi yang valid ke satuan dasar.",
    purchase_cost_invalid: "Total biaya penerimaan tidak valid.",
    inventory_cost_required: "Bahan belum memiliki saldo dan biaya yang dapat dipakai untuk movement.",
    inventory_movement_type_invalid: "Jenis pergerakan stok tidak tersedia.",
    inventory_movement_quantity_invalid: "Jumlah pergerakan stok tidak valid.",
    inventory_movement_balance_invalid: "Stok tidak cukup untuk pergerakan ini.",
    production_recipe_not_found: "Resep produksi bahan olahan tidak ditemukan. Muat ulang data terbaru.",
    production_recipe_cycle_invalid: "Resep membentuk siklus antar-bahan olahan. Periksa kembali susunan komponennya.",
    production_revision_conflict: "Data batch produksi sudah berubah. Muat ulang sebelum melanjutkan.",
    production_order_not_found: "Rencana batch produksi tidak ditemukan.",
    production_order_not_completable: "Batch ini tidak lagi dapat diselesaikan pada status sekarang.",
    production_output_quantity_invalid: "Jumlah hasil produksi tidak valid.",
    production_output_above_plan: "Hasil produksi melebihi batas toleransi resep. Periksa jumlah hasil dan input aktual.",
    production_output_above_tolerance: "Hasil produksi melebihi batas toleransi resep. Periksa jumlah hasil dan input aktual.",
    production_measured_input_variance: "Pemakaian bahan aktual melewati batas toleransi resep.",
    production_measured_input_below_tolerance: "Pemakaian bahan aktual terlalu rendah dibanding hasil produksi.",
    production_stock_shortage: "Stok tersedia setelah reservasi tidak cukup untuk menyelesaikan produksi.",
    production_stock_reserved: "Stok bahan sudah dicadangkan untuk pesanan dan tidak cukup untuk batch ini.",
    production_output_expiry_invalid: "Tanggal kedaluwarsa hasil produksi tidak valid.",
    production_period_closed: "Tanggal produksi berada pada periode persediaan yang sudah ditutup.",
    inventory_period_closed: "Tanggal transaksi berada pada periode persediaan yang sudah ditutup.",
    production_plan_cancelled: "Rencana batch sudah dibatalkan.",
    production_correction_replacement_invalid: "Data koreksi batch tidak valid. Muat ulang riwayat batch dan coba lagi.",
    production_adjustment_atomic_boundary_unavailable: "Void dan koreksi batch dinonaktifkan sampai pembalikan seluruh ledger tersedia.",
    production_output_lot_conflict: "Nomor lot hasil sudah pernah digunakan untuk bahan ini.",
    production_output_shelf_life_too_short: "Tanggal kedaluwarsa hasil belum memenuhi umur simpan minimum bahan.",
    production_output_expiry_exceeds_input: "Tanggal kedaluwarsa hasil tidak boleh melewati bahan input yang paling cepat kedaluwarsa.",
    purchase_ingredient_not_purchasable: "Bahan olahan buatan sendiri tidak dapat dimasukkan melalui penerimaan pembelian.",
    inventory_count_lines_invalid: "Stock count harus berisi minimal satu bahan.",
    inventory_count_incomplete: "Full stock count wajib mencakup semua bahan yang memiliki saldo.",
    inventory_count_ingredient_duplicate: "Satu bahan tidak boleh dihitung dua kali dalam sesi yang sama.",
    staff_receiving_disabled: "Fitur Barang Datang belum siap pada server ini.",
    staff_receiving_capability_denied: "Akun karyawan ini belum memiliki akses Barang Datang yang diperlukan.",
    staff_receiving_receipt_not_found: "Data barang datang tidak ditemukan pada outlet atau akun ini.",
    staff_receiving_revision_conflict: "Data barang datang sudah berubah. Muat ulang sebelum melanjutkan.",
    staff_receiving_evidence_incomplete: "Selesaikan unggahan seluruh foto sebelum mengirim atau menyetujui barang datang.",
    staff_receiving_cost_unresolved: "Harga bahan belum lengkap. Minta karyawan memperbaiki data sebelum approval.",
    staff_receiving_accepted_quantity_required: "Minimal satu jumlah diterima diperlukan untuk memposting stok. Minta perbaikan sebelum approval.",
    staff_receiving_rejected_requires_correction: "Barang yang ditolak memerlukan alur purchase order. Minta perbaikan dan pisahkan barang tertolak sebelum approval.",
    staff_receiving_duplicate_override_required: "Pengiriman ini terdeteksi duplikat. Owner wajib mengisi alasan override sebelum approval.",
    staff_receiving_delivery_identity_change_blocked: "Identitas supplier atau surat jalan tidak dapat diubah karena sudah memiliki penerimaan duplikat terkait.",
    staff_receiving_cost_allocation_unsupported: "Alokasi biaya untuk barang rusak atau belum diperiksa belum didukung canonical ledger. Penerimaan tetap menunggu review.",
    staff_receiving_recovery_state_invalid: "Penerimaan ini tidak lagi berada pada status POSTING.",
    staff_receiving_recovery_already_claimed: "Pemulihan POSTING sedang ditangani proses lain. Muat ulang antrean sebelum mencoba kembali.",
    staff_receiving_recovery_claim_invalid: "Claim pemulihan POSTING tidak valid atau sudah kedaluwarsa.",
    staff_receiving_correction_state_invalid: "Koreksi hanya dapat diminta untuk penerimaan yang sudah POSTED.",
    staff_receiving_canonical_poster_unavailable: "Sinkronisasi stok belum tersedia. Data barang datang tetap tersimpan dan dapat dicoba kembali.",
    staff_receiving_post_result_collision: "Hasil sinkronisasi stok tidak cocok dengan transaksi sebelumnya. Hubungi Owner sebelum mencoba lagi.",
    staff_receiving_post_finalize_state_invalid: "Status barang datang berubah saat sinkronisasi. Muat ulang riwayat.",
    staff_receiving_post_finalize_conflict: "Sinkronisasi stok belum dapat diselesaikan. Muat ulang dan coba lagi.",
    staff_receiving_post_recovery_conflict: "Data barang datang tidak dapat dipulihkan otomatis. Muat ulang dan minta Owner meninjau statusnya.",
    staff_receiving_evidence_content_type_invalid: "Foto harus berformat JPEG, PNG, atau WebP.",
    staff_receiving_evidence_too_large: "Ukuran foto melewati batas unggahan.",
    staff_receiving_evidence_checksum_mismatch: "Isi foto berubah saat diunggah. Ambil atau pilih ulang foto.",
    staff_receiving_evidence_dimension_mismatch: "Dimensi foto berubah saat diunggah. Ambil atau pilih ulang foto.",
    staff_receiving_evidence_size_mismatch: "Ukuran foto berubah saat diunggah. Pilih ulang foto.",
    staff_receiving_evidence_binary_invalid: "File foto tidak dapat dibaca. Ambil atau pilih ulang foto.",
    attendance_not_open: "Absensi belum dibuka. Coba lagi satu jam sebelum shift dimulai.",
    attendance_schedule_required: "Kamu belum memiliki jadwal aktif untuk absensi.",
    attendance_window_closed: "Batas absensi sudah lewat. Ajukan koreksi kehadiran.",
    attendance_checkout_window_closed: "Batas absen pulang sudah lewat. Ajukan lupa absen untuk diperiksa Owner.",
    attendance_already_recorded: "Absensi untuk shift ini sudah tercatat.",
    attendance_selfie_required: "Ambil dan unggah foto wajah sebelum menyelesaikan absensi.",
    attendance_evidence_incomplete: "Foto wajah belum selesai diunggah. Tunggu sampai upload selesai.",
    attendance_evidence_not_found: "Bukti foto absensi tidak ditemukan. Ambil ulang foto.",
    attendance_evidence_storage_unavailable: "Penyimpanan foto absensi belum tersedia. Coba lagi atau hubungi Owner.",
    attendance_challenge_invalid: "Sesi absensi tidak valid. Mulai ulang proses absensi.",
    attendance_challenge_expired: "Sesi absensi sudah kedaluwarsa. Mulai ulang proses absensi.",
    attendance_challenge_consumed: "Sesi absensi ini sudah digunakan. Muat ulang status absensi.",
    attendance_prepare_already_created: "Sesi absensi ini sudah dibuat. Muat ulang lalu lanjutkan sesi terbaru.",
    attendance_idempotency_reused: "Referensi absensi ini sudah digunakan. Muat ulang status absensi.",
    attendance_result_unresolved: "Hasil absensi belum dapat dipastikan. Jangan mengirim ulang; hubungi Owner untuk pemeriksaan.",
    attendance_challenge_action_mismatch: "Jenis absensi berubah. Muat ulang jadwal dan mulai lagi.",
    attendance_challenge_schedule_mismatch: "Jadwal berubah saat proses absensi. Muat ulang dan mulai lagi.",
    attendance_challenge_session_mismatch: "Sesi absensi berasal dari perangkat atau login lain. Muat ulang dan mulai lagi di perangkat ini.",
    attendance_policy_changed_retry: "Aturan absensi baru saja diperbarui Owner. Muat ulang lalu ambil foto dan lokasi lagi.",
    attendance_capture_challenge_mismatch: "Kode pengambilan foto tidak cocok. Ambil foto baru dari halaman absensi.",
    attendance_outside_geofence: "Lokasi berada di luar area outlet yang diizinkan.",
    attendance_gps_accuracy_low: "Akurasi GPS belum cukup baik. Pindah ke area terbuka lalu coba lagi.",
    attendance_outlet_location_not_configured: "Lokasi outlet belum dikonfigurasi. Absensi akan menunggu pemeriksaan Owner.",
    attendance_correction_invalid: "Lengkapi jenis dan alasan koreksi absensi.",
    attendance_correction_time_invalid: "Waktu koreksi berada di luar rentang shift yang diperbolehkan.",
    attendance_evidence_content_invalid: "Foto absensi harus berupa JPEG, PNG, atau WebP dengan ukuran maksimal 10 MB.",
    attendance_evidence_checksum_invalid: "Foto absensi berubah saat dikirim. Ambil ulang foto.",
    attendance_evidence_size_invalid: "Ukuran foto absensi tidak valid.",
    attendance_evidence_dimension_invalid: "Dimensi foto absensi tidak valid.",
    attendance_evidence_capture_stale: "Waktu pengambilan foto terlalu jauh dari waktu absensi. Ambil foto baru.",
    attendance_location_capture_stale: "Data lokasi sudah terlalu lama. Aktifkan GPS lalu ambil lokasi baru.",
    attendance_evidence_expired: "Bukti absensi sudah kedaluwarsa. Mulai ulang proses absensi.",
    attendance_evidence_exif_forbidden: "Foto masih memuat metadata perangkat. Ambil foto langsung dari halaman absensi.",
    attendance_evidence_upload_metadata_mismatch: "Detail foto berubah saat diunggah. Ambil ulang foto dari halaman absensi.",
    attendance_outlet_location_required: "Isi koordinat outlet sebelum memakai mode blokir lokasi.",
    maps_location_input_invalid: "Tempel link Google Maps, pin, atau koordinat yang valid.",
    maps_location_link_invalid: "Link harus berasal dari Google Maps dan menggunakan HTTPS.",
    maps_location_resolve_failed: "Link Google Maps belum dapat dibuka. Coba lagi atau masukkan koordinat manual.",
    maps_location_coordinates_not_found: "Titik koordinat belum ditemukan dari link tersebut. Bagikan pin lokasi, bukan hanya nama tempat.",
    attendance_clock_in_required: "Absensi masuk belum tersedia untuk pengajuan pulang.",
    attendance_review_not_actionable: "Permintaan ini sudah diproses atau tidak lagi dapat diperiksa.",
    attendance_review_decision_invalid: "Pilih setujui atau tolak untuk pemeriksaan absensi.",
    coordinates_invalid: "Lokasi GPS tidak valid atau akurasinya belum tersedia.",
    receipt_evidence_too_large: "Ukuran foto melewati batas unggahan.",
    receipt_evidence_content_length_invalid: "Ukuran foto tidak terbaca oleh server. Ambil ulang foto lalu coba lagi.",
    receipt_evidence_content_type_unsupported: "Foto harus berformat JPEG, PNG, atau WebP.",
    receipt_evidence_content_length_mismatch: "Ukuran foto berubah saat diunggah. Pilih ulang foto.",
    receipt_evidence_mime_mismatch: "Isi foto tidak sesuai dengan format filenya. Pilih ulang foto JPEG, PNG, atau WebP.",
    receipt_evidence_dimension_mismatch: "Dimensi foto berubah saat diunggah. Ambil atau pilih ulang foto.",
    receipt_evidence_checksum_mismatch: "Isi foto berubah saat diunggah. Ambil atau pilih ulang foto.",
    receipt_evidence_object_exists: "Bukti foto dengan referensi ini sudah ada dan isinya berbeda. Pilih ulang foto.",
    receipt_evidence_privacy_metadata_unsupported: "Metadata perangkat pada foto belum berhasil dibersihkan. Muat ulang SagaPOS lalu ambil foto baru dari halaman absensi.",
    receipt_evidence_binary_unsupported: "Hasil foto tidak dapat dibaca server. Muat ulang SagaPOS lalu ambil foto baru.",
    hpp_version_required: "Revisi data wajib disertakan.",
    hpp_version_conflict: "Data sudah berubah di tempat lain. Muat ulang sebelum menyimpan.",
    hpp_reason_required: "Alasan perubahan wajib diisi.",
    finance_role_denied: "Aksi ini hanya dapat dilakukan reviewer Finance.",
    purchase_invoice_self_approval_denied: "Pembuat invoice tidak boleh menyetujui invoice yang sama.",
    purchase_invoice_approval_role_denied: "Persetujuan invoice memerlukan role Finance.",
    purchase_invoice_approval_state_invalid: "Invoice tidak lagi menunggu persetujuan. Muat ulang daftar.",
    purchase_invoice_approval_decision_invalid: "Pilih setujui atau tolak invoice.",
    purchase_invoice_not_found: "Invoice tidak ditemukan. Muat ulang daftar.",
    purchase_invoice_post_state_invalid: "Invoice harus disetujui Finance sebelum diposting.",
    purchase_invoice_post_role_denied: "Posting utang AP hanya dapat dilakukan Owner.",
    purchase_invoice_poster_separation_required: "Pencatat AP harus berbeda dari reviewer Finance.",
    purchase_invoice_action_idempotency_conflict: "Referensi aksi invoice sudah dipakai untuk perubahan berbeda.",
    purchase_invoice_credit_role_denied: "Pencatatan credit memo memerlukan role Finance.",
    purchase_invoice_credit_post_role_denied: "Posting credit memo hanya dapat dilakukan Owner.",
    purchase_invoice_credit_poster_separation_required: "Owner yang memposting harus berbeda dari Finance pembuat credit memo.",
    purchase_invoice_credit_state_invalid: "Invoice tidak memiliki outstanding yang dapat dikoreksi.",
    supplier_return_role_denied: "Hanya Owner yang dapat mencatat retur supplier.",
    supplier_return_receipt_invalid: "Retur harus menunjuk penerimaan dari purchase order.",
    supplier_return_reference_invalid: "Referensi retur supplier tidak valid.",
    supplier_return_reference_conflict: "Referensi retur sudah digunakan untuk supplier ini.",
    supplier_return_disposition_invalid: "Pilih penggantian atau credit supplier sebagai tindak lanjut.",
    supplier_return_lines_invalid: "Pilih minimal satu barang yang akan diretur.",
    supplier_return_line_invalid: "Barang retur tidak ditemukan pada receipt asal.",
    supplier_return_quantity_invalid: "Jumlah retur melebihi quantity receipt yang masih tersedia.",
    supplier_return_stock_insufficient: "Stok atau nilai persediaan tidak cukup untuk dikirim balik. Lakukan count terlebih dahulu.",
    supplier_return_not_found: "Dokumen retur supplier tidak ditemukan.",
    supplier_return_credit_link_required: "Pilih retur supplier yang akan ditautkan ke credit note.",
    supplier_return_credit_state_invalid: "Retur supplier tidak lagi dapat menerima credit note. Muat ulang daftar.",
    supplier_return_credit_already_linked: "Retur supplier ini sudah ditautkan ke credit memo.",
    supplier_return_credit_lineage_mismatch: "Retur, supplier, purchase order, dan invoice harus berasal dari transaksi yang sama.",
    supplier_return_credit_amount_mismatch: "Nominal credit retur harus sama dengan nilai barang yang dikirim kembali.",
    supplier_return_credit_type_required: "Tautan retur hanya dapat digunakan untuk jenis credit retur barang.",
    supplier_replacement_role_denied: "Hanya Owner yang dapat menerima replacement supplier.",
    supplier_replacement_disposition_invalid: "Retur ini tidak meminta replacement supplier.",
    supplier_replacement_state_invalid: "Replacement sudah diterima atau retur tidak lagi menunggu.",
    supplier_replacement_reference_invalid: "Referensi replacement tidak valid.",
    supplier_replacement_reference_conflict: "Referensi replacement sudah digunakan untuk supplier ini.",
    purchase_invoice_credit_post_state_invalid: "Credit memo tidak lagi menunggu posting. Muat ulang daftar.",
    purchase_invoice_credit_not_found: "Credit memo tidak ditemukan. Muat ulang daftar.",
    purchase_invoice_credit_number_invalid: "Nomor credit note wajib diisi dengan format yang aman.",
    purchase_invoice_credit_number_conflict: "Nomor credit note supplier sudah pernah dicatat.",
    purchase_invoice_credit_date_invalid: "Tanggal credit note tidak valid atau lebih awal dari invoice.",
    purchase_invoice_credit_type_invalid: "Pilih jenis credit memo yang tersedia.",
    purchase_invoice_credit_amount_invalid: "Nominal credit harus lebih dari nol dan tidak melebihi outstanding tersedia.",
    purchase_invoice_credit_idempotency_conflict: "Referensi credit memo sudah dipakai untuk perubahan berbeda.",
    purchase_invoice_credit_reversal_request_role_denied: "Permintaan reversal credit memo memerlukan role Finance.",
    purchase_invoice_credit_reversal_decision_role_denied: "Keputusan reversal credit memo hanya dapat dilakukan Owner.",
    purchase_invoice_credit_reversal_state_invalid: "Credit memo tidak dapat direversal pada status saat ini. Muat ulang riwayat.",
    purchase_invoice_credit_reversal_pending: "Credit memo ini sudah menunggu keputusan reversal dari Owner.",
    purchase_invoice_credit_reversal_separation_required: "Owner yang memutuskan reversal harus berbeda dari Finance pemohon.",
    purchase_invoice_credit_reversal_decision_invalid: "Pilih setujui atau tolak untuk keputusan reversal.",
    purchase_invoice_credit_reversal_idempotency_conflict: "Referensi reversal sudah dipakai untuk perubahan berbeda.",
    purchase_invoice_credit_reversal_history_limit: "Batas riwayat koreksi credit memo tercapai. Eskalasi untuk rekonsiliasi manual.",
    inventory_variance_count_pair_required: "Pilih count pembuka dan penutup sebagai satu pasangan.",
    inventory_variance_count_id_invalid: "Referensi full count tidak valid.",
    inventory_variance_count_not_found: "Full count yang dipilih tidak ditemukan.",
    inventory_variance_period_invalid: "Count penutup harus lebih baru daripada count pembuka.",
    catalog_version_required: "Versi katalog diperlukan untuk perubahan ini.",
    product_name_invalid: "Nama menu wajib diisi, maksimal 80 karakter tanpa markup.",
    product_price_invalid: "Harga harus berupa rupiah bulat antara 100 dan 10.000.000.",
    catalog_category_invalid: "Pilih kategori menu yang tersedia.",
    catalog_category_name_invalid: "Nama kategori wajib diisi dan maksimal 60 karakter.",
    catalog_category_duplicate: "Kategori dengan nama tersebut sudah tersedia.",
    catalog_customization_invalid: "Pilih tipe menu minuman atau makanan.",
    catalog_media_invalid: "Foto tidak lolos pemeriksaan. Gunakan JPG, PNG, atau WebP yang valid; sistem akan mengecilkannya otomatis.",
    catalog_media_metadata_not_allowed: "Foto masih membawa metadata perangkat. Pilih ulang foto agar sistem membersihkannya sebelum disimpan.",
    catalog_media_alt_invalid: "Keterangan foto maksimal 120 karakter.",
    catalog_station_invalid: "Pilih tujuan produksi BAR atau FOOD.",
    catalog_status_invalid: "Pilih status aktif atau arsip.",
    catalog_sort_invalid: "Urutan tampil harus angka bulat 0–999.",
    variant_group_label_invalid: "Nama grup varian wajib diisi, maksimal 60 karakter tanpa markup.",
    variant_group_limits_invalid: "Batas pilihan varian tidak valid. Minimum tidak boleh melebihi maksimum 8.",
    variant_group_duplicate: "Nama grup varian sudah digunakan.",
    variant_group_not_found: "Grup varian tidak ditemukan. Muat ulang katalog.",
    variant_option_label_invalid: "Nama pilihan varian wajib diisi, maksimal 60 karakter tanpa markup.",
    variant_option_price_invalid: "Harga tambahan varian harus berupa rupiah bulat minimal Rp0.",
    variant_option_duplicate: "Nama pilihan varian sudah digunakan pada grup ini.",
    variant_option_not_found: "Pilihan varian tidak ditemukan. Muat ulang katalog.",
    variant_product_scope_invalid: "Cakupan menu varian tidak valid. Muat ulang katalog dan pilih menu yang tersedia.",
    variant_required_options_invalid: "Grup varian wajib harus tetap memiliki pilihan aktif sesuai batas minimum.",
    modifier_group_label_invalid: "Nama grup modifier wajib diisi, maksimal 60 karakter tanpa markup.",
    modifier_group_limits_invalid: "Batas pilihan modifier tidak valid. Minimum tidak boleh melebihi maksimum 8.",
    modifier_group_duplicate: "Nama grup modifier sudah digunakan.",
    modifier_group_not_found: "Grup modifier tidak ditemukan. Muat ulang katalog.",
    modifier_option_label_invalid: "Nama pilihan modifier wajib diisi, maksimal 60 karakter tanpa markup.",
    modifier_option_price_invalid: "Harga tambahan modifier harus berupa rupiah bulat minimal Rp0.",
    modifier_option_duplicate: "Nama pilihan modifier sudah digunakan pada grup ini.",
    modifier_option_not_found: "Pilihan modifier tidak ditemukan. Muat ulang katalog.",
    modifier_product_scope_invalid: "Cakupan menu modifier tidak valid. Muat ulang katalog dan pilih menu yang tersedia.",
    modifier_required_options_invalid: "Grup wajib harus tetap memiliki pilihan aktif sesuai batas minimum.",
    modifier_selection_required: "Lengkapi pilihan modifier wajib sebelum melanjutkan.",
    ordering_settings_invalid: "Pilih status jeda dan penerapan jam yang valid.",
    cash_count_required: "Hitung uang fisik dan isi nominal rupiah bulat sebelum menutup shift.",
    cash_to_leave_invalid: "Kas yang ditinggalkan harus antara nol dan uang fisik yang dihitung.",
    ordering_hours_invalid: "Isi jam WIB dalam hari yang sama: buka sebelum pesanan terakhir, lalu tutup.",
    ordering_paused: "Pesanan baru sedang dijeda. Pembayaran dan pesanan yang sudah masuk tetap diproses. Silakan hubungi kasir.",
    ordering_outside_hours: "Pemesanan di luar jam layanan. Silakan hubungi kasir.",
    catalog_reason_required: "Isi alasan perubahan, maksimal 160 karakter.",
    prototype_clear_confirmation_required: "Ketik konfirmasi HAPUS ORDER UJI untuk membersihkan antrean uji.",
    prototype_clear_reason_required: "Isi alasan pembersihan order uji, maksimal 160 karakter.",
    availability_value_invalid: "Status ketersediaan menu tidak valid.",
    catalog_version_conflict: "Katalog sudah berubah di tab atau perangkat lain.",
    catalog_runtime_unavailable: "Runtime price book belum tersedia pada release ini.",
    catalog_assignment_not_available: "Belum ada versi harga published untuk outlet ini.",
    catalog_assignment_not_published: "Versi harga outlet belum published.",
    catalog_entries_incomplete: "Versi harga outlet belum memiliki mapping menu yang lengkap.",
    catalog_draft_already_exists: "Masih ada draft price book yang perlu ditinjau atau dipublish.",
    catalog_version_immutable: "Versi harga ini sudah published dan tidak dapat diubah.",
    catalog_draft_hash_invalid: "Identitas draft harga tidak valid.",
    free_price_authorization_required: "Harga khusus memerlukan otorisasi Owner yang masih aktif.",
    free_price_authorization_scope_mismatch: "Otorisasi harga khusus tidak cocok atau sudah digunakan.",
    availability_reset_mode_invalid: "Pilih jadwal pemulihan availability yang tersedia.",
    member_code_invalid: "Member Code tidak dikenali pada fixture lokal.",
    member_service_unavailable: "Layanan Saga Member belum tersedia. Coba lagi atau lanjut sebagai guest.",
    promotion_stacking_denied: "Promo ini tidak dapat digabung dengan benefit member.",
    benefit_stacking_denied: "Pilih satu benefit: promo/voucher, member, reward, atau diskon manual. Hapus pilihan lain sebelum melanjutkan.",
    promotion_invalid: "Kode promo atau voucher tidak dikenali.",
    promotion_draft: "Promo masih draft dan belum diaktifkan.",
    promotion_paused: "Promo ini sedang dijeda oleh Owner.",
    promotion_expired: "Masa berlaku promo sudah berakhir.",
    promotion_scheduled: "Promo belum memasuki masa berlaku.",
    promotion_outside_schedule: "Promo tidak berlaku pada hari atau jam sekarang.",
    promotion_outside_scope: "Promo tidak berlaku untuk tipe pesanan atau metode pembayaran ini.",
    promotion_not_eligible: "Menu atau minimum belanja belum memenuhi syarat promo.",
    promotion_quota_exhausted: "Kuota promo habis atau voucher sedang dipakai pada transaksi lain. Periksa antrean pembayaran.",
    promotion_verified_member_required: "Voucher ini membutuhkan Member yang terverifikasi. Masukkan kode Member pelanggan terlebih dahulu.",
    promotion_member_limit_reached: "Member ini sudah mencapai batas pemakaian untuk program voucher tersebut.",
    voucher_batch_invalid: "Isi jumlah voucher 1–100 dan awalan kode 1–20 huruf/angka. Periksa kembali aturan promonya.",
    manual_discount_approval_required: "Diskon melebihi batas staf atau persetujuannya tidak lagi cocok. Minta persetujuan Owner untuk pesanan ini.",
    discount_operation_key_required: "Permintaan diskon belum memiliki nomor operasi. Buka ulang pengaturan diskon.",
    discount_request_changed: "Isi permintaan diskon sudah berubah. Buat permintaan baru untuk pesanan terbaru.",
    discount_limit_invalid: "Isi batas diskon staf dengan rupiah bulat dan alasan pengaturan.",
    reliability_authorization_consume_failed: "Persetujuan sudah dipakai, kedaluwarsa, atau tidak cocok dengan pesanan. Minta persetujuan baru.",
    manual_discount_owner_required: "Diskon manual hanya dapat diberikan melalui akun Owner. Jangan gunakan akun bersama untuk melewati batas akses.",
    manual_discount_invalid: "Masukkan potongan rupiah bulat atau persentase antara 0,01% dan 100%.",
    manual_discount_reason_required: "Isi alasan diskon, maksimal 160 karakter.",
    manual_discount_product_invalid: "Menu untuk diskon sudah tidak ada di pesanan. Pilih kembali menunya.",
    manual_discount_exceeds_base: "Potongan tidak boleh melebihi harga menu atau tagihan yang dipilih.",
    private_promotion_authorization_required: "Promo trial hanya tersedia pada perangkat pilot yang diizinkan.",
    private_promotion_authorization_denied: "Promo trial tidak aktif atau batas canary telah tercapai.",
    rate_limit_exceeded: "Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.",
    payment_not_pending: "Pembayaran ini tidak lagi menunggu konfirmasi.",
    payment_simulator_disabled_in_production: "Simulator dinonaktifkan saat SagaDev Gateway production digunakan.",
    production_payment_off: "Pembayaran production belum diaktifkan. Gunakan mode baca atau tunggu aktivasi Owner.",
    production_member_service_required: "Member production belum terhubung. Lanjutkan sebagai guest atau tunggu aktivasi member.",
    production_reward_not_available: "Penukaran reward belum terhubung di kasir ini. Benefit member yang terverifikasi tetap dapat digunakan; jangan pilih reward demo.",
    sagadev_gateway_not_ready: "SagaDev Gateway belum dibuka untuk canary terbatas.",
    gateway_status_not_available: "Pemeriksaan status gateway tidak tersedia pada runtime ini.",
    gateway_payment_expired: "QRIS sudah kedaluwarsa. Buat pesanan trial baru.",
    gateway_payment_failed: "Pembayaran QRIS gagal. Jangan lanjutkan produksi pesanan.",
    gateway_payment_cancelled: "Pembayaran QRIS dibatalkan.",
    fulfillment_role_denied: "Role ini tidak boleh mengubah antrean produksi.",
    report_owner_scope_denied: "Hanya Owner pada outlet sesi aktif yang dapat membuka laporan ini.",
    report_esb_read_not_enabled: "Laporan authoritative belum diaktifkan pada runtime ini.",
    report_authoritative_source_unavailable: "Sumber laporan authoritative belum tersedia. Tidak ada data pengganti yang ditampilkan.",
    report_authoritative_source_incomplete: "Sumber laporan belum lengkap sehingga angka dihentikan dengan aman.",
    report_server_scope_unavailable: "Scope laporan server belum tersedia.",
    report_period_invalid: "Periode laporan tidak valid.",
    report_period_not_available: "Periode laporan belum tersedia.",
    report_period_too_large: "Periode laporan terlalu panjang.",
    report_time_basis_invalid: "Basis waktu laporan tidak tersedia.",
    report_ranking_kind_invalid: "Kelompok ranking laporan tidak tersedia.",
    report_metric_invalid: "Metrik laporan tidak tersedia.",
    report_query_invalid: "Parameter laporan tidak valid.",
    report_snapshot_unavailable: "Snapshot laporan sudah tidak tersedia. Muat ulang laporan.",
    report_bill_not_found: "Bill tidak ditemukan pada snapshot laporan ini.",
    inventory_planning_runtime_unavailable: "Layanan ketersediaan dan replenishment belum tersedia pada runtime ini.",
    inventory_planning_provider_unavailable: "Sumber inventory sementara tidak tersedia. Coba lagi tanpa mengubah transaksi.",
    inventory_planning_provider_output_invalid: "Sumber inventory mengembalikan data yang tidak dapat diverifikasi.",
    inventory_planning_provider_scope_invalid: "Scope sumber inventory tidak cocok dengan outlet sesi.",
    inventory_planning_scope_override_denied: "Scope inventory ditentukan oleh sesi server.",
    inventory_availability_role_denied: "Role sesi ini tidak boleh membaca ketersediaan inventory.",
    replenishment_read_role_denied: "Role sesi ini tidak boleh membaca replenishment.",
    replenishment_recommend_role_denied: "Hanya Owner yang dapat membuat rekomendasi replenishment.",
    replenishment_policy_role_denied: "Hanya Owner yang dapat mengubah kebijakan replenishment.",
    replenishment_policy_revision_invalid: "Revisi kebijakan replenishment tidak valid.",
    replenishment_policy_revision_conflict: "Kebijakan replenishment berubah. Muat ulang lalu coba lagi.",
    replenishment_policy_mode_invalid: "Mode kebijakan replenishment tidak valid.",
    replenishment_reason_required: "Alasan perubahan kebijakan replenishment wajib diisi.",
    inventory_planning_item_not_found: "Item inventory tidak ditemukan pada scope outlet aktif.",
    inventory_planning_location_not_canonical: "Lokasi inventory tidak sesuai lokasi usable outlet aktif.",
    inventory_planning_revision_conflict: "Data replenishment berubah. Muat ulang lalu coba lagi.",
    inventory_planning_operation_collision: "Referensi operasi replenishment sudah digunakan untuk input berbeda.",
    esb_runtime_operations_unavailable: "Operasi ESB belum diaktifkan pada runtime ini.",
    exception_execute_permission_denied: "Role sesi ini tidak boleh menjalankan pengecualian tersebut.",
    esb_exception_order_not_found: "Pesanan tidak ditemukan pada outlet sesi aktif.",
    report_refund_allocation_unavailable: "Alokasi refund belum lengkap sehingga laporan dihentikan dengan aman.",
    reliability_manager_required: "Aksi ini memerlukan role Owner atau Manager.",
    esb_inventory_authority_retired: "Ledger stok ESB lama sudah dihentikan. Gunakan aksi inventory HPP kanonik; pengurangan penjualan hanya terjadi saat PREPARING.",
    retired_route_evidence_owner_required: "Hanya Owner yang dapat membaca bukti pemanggilan rute lama.",
    retired_route_scope_override_denied: "Scope bukti ditentukan oleh sesi Owner aktif.",
    retired_route_query_invalid: "Parameter bukti rute lama tidak valid.",
    retired_route_cursor_invalid: "Cursor bukti tidak valid atau sudah tidak dapat dipakai.",
    not_found: "Halaman atau data tidak ditemukan.",
  };
  return messages[code] ?? "Tindakan belum dapat diselesaikan. Periksa urutan dan coba lagi.";
}
