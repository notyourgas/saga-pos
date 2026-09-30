import { teamError } from './team-access-catalog.mjs';
// Fixed adapters invoke legacy domain capabilities only after current permission
// authorization. The session/actor is never promoted to Owner or platform admin.
const inventoryActions = {
  'ingredient.upsert': 'inventory.write', 'ingredient.archive': 'inventory.archive',
  'ingredient.conversion.upsert': 'inventory.write', 'category.create': 'inventory.write',
  'category.update': 'inventory.write', 'category.archive': 'inventory.archive',
  'warehouse.receipt.post': 'purchasing.write', 'warehouse.movement.record': 'inventory.write',
  'warehouse.movement.reverse': 'inventory.approve', 'warehouse.count.complete': 'inventory.approve',
  'hpp.draft-line.upsert': 'hpp.write', 'hpp.draft-lines.upsert': 'hpp.write',
  'hpp.draft-line.remove': 'hpp.write', 'hpp.draft-line.reorder': 'hpp.write', 'hpp.draft.publish': 'hpp.approve',
};
const adminActions = {
  'catalog.product.create': 'catalog.write', 'catalog.product.update': 'catalog.write',
  'catalog.category.create': 'catalog.write', 'catalog.category.update': 'catalog.write',
  'catalog.product.publish': 'catalog.approve',
  'catalog.product.archive': 'catalog.archive', 'catalog.product.restore': 'catalog.archive',
  'hpp.supplier.upsert': 'purchasing.write', 'hpp.purchase_order.create': 'purchasing.write',
  'payment.settlement.review': 'finance.approve',
};
const hrActions = {
  'schedule.create': ['hr.write', 'assignSchedule'], 'attendance.review': ['hr.approve', 'reviewAttendance'],
  'request.review': ['hr.approve', 'reviewRequest'], 'rate.save': ['payroll.write', 'setPayRate'],
};
const sensitiveCosts = /cost|price|value|hpp|margin|profit|valuation|rupiah/i;
const sensitiveFinanceCosts = /hpp|margin|profit|theoreticalIngredient|recipeCost|costStatus/i;
function prune(value, pattern) {
  if (Array.isArray(value)) return value.map(v => prune(v, pattern));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !pattern.test(key)).map(([k,v]) => [k,prune(v,pattern)]));
  return value;
}
export function assertTeamInputScope(value, context) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(actorId|actorRole|role|authUserId|userAccountId|tenantId|organizationSlug|permissions|testMode|privateCanaryContext)$/i.test(key)) throw teamError('actor_input_forbidden', 403);
    if ((key === 'organizationId' && child !== context.organizationId) || (key === 'outletId' && child !== context.outletId)) throw teamError('team_scope_denied', 403);
    assertTeamInputScope(child, context);
  }
}
export function createTeamOperations({ teamAccess, runtime, nativeStaff, paymentOff = false }) {
  const execute = async (subject, permissions, input, work) => {
    if (subject.outletId !== runtime.ids?.outletId || subject.organizationId !== runtime.ids?.organizationId) throw teamError('team_scope_denied',403);
    assertTeamInputScope(input, subject);
    return teamAccess.executeAuthorized(subject, permissions, current => work(current));
  };
  return {
    async state(subject, feature) {
      return execute(subject, [`${feature}.view`], {}, async current => {
        if (feature === 'kds') return prune(await runtime.operatorState('bar'), sensitiveCosts);
        if (['orders','cash','qris'].includes(feature)) {
          const data = await runtime.cashierState({ ...current, role: 'cashier' });
          if (!current.permissions.includes('cash.view')) { data.shift = null; data.cashControl = null; data.expenses = []; data.pendingCashAssists = []; }
          if (!current.permissions.includes('qris.view')) data.pendingManualQris = [];
          data.pendingStaticQrisDemos = [];
          return { ...data, actor: { ...current, role: 'cashier',mode:'CASHIER' }, permissions: current.permissions };
        }
        if (feature === 'catalog') { const state=await runtime.operatorState('owner'); return { revision:state.catalogVersion,catalog:state.catalog }; }
        if (['inventory','hpp','purchasing'].includes(feature)) {
          const state = await runtime.inventoryWorkspaceState('owner');
          const selected = feature === 'inventory' ? { revision: state.revision, ingredients: state.ingredients, warehouse: state.warehouse }
            : feature === 'hpp' ? { revision: state.revision, hpp: state.hpp, ingredients:state.ingredients }
            : { revision:state.revision, purchasing:null };
          if (feature === 'purchasing') {
            const hpp=(await runtime.adminState('owner')).hpp;
            selected.purchasing={suppliers:hpp.suppliers,purchaseOrders:hpp.purchaseOrders,receipts:state.warehouse.recentReceipts};
            selected.ingredients={items:state.ingredients.items.map(i=>({id:i.id,name:i.name,baseUom:i.baseUom,baseUnit:i.baseUnit})),uoms:state.ingredients.uoms,conversions:state.ingredients.conversions,purchaseOptions:state.ingredients.purchaseOptions};
          }
          if(feature==='inventory' && !current.permissions.includes('hpp.view')) selected.ingredients={items:state.ingredients.items,categories:state.ingredients.categories,uoms:state.ingredients.uoms,conversions:state.ingredients.conversions};
          return current.permissions.includes('hpp.view') || feature === 'purchasing' ? selected : prune(selected, sensitiveCosts);
        }
        if (feature === 'finance') {
          const dashboard=(await runtime.operatorState('owner')).dashboard;
          return {dashboard:current.permissions.includes('hpp.view')?dashboard:prune(dashboard,sensitiveFinanceCosts),accountsPayable:await runtime.apState('finance')};
        }
        if (['hr','payroll'].includes(feature)) {
          if (!nativeStaff) throw teamError('feature_unavailable', 503);
          if (feature === 'payroll') { const report=await nativeStaff.report({}); return {...report,staff:(await nativeStaff.listOwner()).staff}; }
          const data = await nativeStaff.listOwner();
          const pick=(row,fields)=>Object.fromEntries(fields.filter(f=>row[f]!==undefined).map(f=>[f,row[f]]));
          return {
            staff:data.staff.map(r=>pick(r,['id','name','employeeCode','role','status','accountState',...(current.permissions.includes('payroll.view')?['payRateType','payRateRupiah','payRateUpdatedAt']:[])])),
            schedules:data.schedules.map(r=>pick(r,['id','staff_id','shift_name','business_date','scheduled_start_at','scheduled_end_at','status'])),
            attendance:data.attendance.map(r=>pick(r,['id','staffId','scheduleId','checkInAt','checkOutAt','status','worked_minutes','late_minutes','reviewStatus'])),
            requests:data.requests.map(r=>pick(r,['id','staff_id','category','reason','state','starts_at','ends_at'])),
          };
        }
        throw teamError('permission_route_unmapped', 403);
      });
    },
    async action(subject, feature, input) {
      let permission, work;
      if (Object.hasOwn(inventoryActions,input.action)) {
        permission = inventoryActions[input.action];
        work = async current => {
          let command=input;
          if (input.action==='ingredient.upsert' && input.payload?.ingredientId && !current.permissions.includes('hpp.write')) {
            const existing=(await runtime.adminState('owner')).hpp.ingredients.find(i=>i.id===input.payload.ingredientId);
            if(!existing)throw teamError('ingredient_not_found',404);
            command={...input,payload:{...input.payload,costPerUnitRupiah:existing.costPerUnitRupiah}};
          }
          await runtime.inventoryWorkspaceAction('owner', current.employeeId, command);
          return { saved: true }; // Never leak the full Owner workspace returned by the domain.
        };
      } else if (Object.hasOwn(adminActions,input.action)) {
        permission = adminActions[input.action];
        work = current => runtime.adminAction('owner', current.employeeId, input.action, input.payload);
      } else if (input.action === 'invoice.approve') {
        permission = 'finance.approve'; work = current => runtime.apAction('finance', current.employeeId, 'hpp.purchase_invoice.approval.decide', input.payload);
      } else if (input.action === 'invoice.credit') {
        permission = 'finance.write'; work = current => runtime.apAction('finance', current.employeeId, 'hpp.purchase_invoice.credit.record', input.payload);
      } else if (Object.hasOwn(hrActions,input.action)) {
        const [p, method] = hrActions[input.action]; permission = p;
        work = current => {
          if (!nativeStaff) throw teamError('feature_unavailable', 503);
          return method === 'reviewRequest' ? nativeStaff[method](input.payload.requestId,input.payload.decision,input.payload.note)
            : nativeStaff[method]({ ...input.payload, actorReference: current.employeeId });
        };
      } else throw teamError('permission_route_unmapped', 403);
      if (feature !== permission.split('.')[0]) throw teamError('permission_denied', 403);
      const required = [permission];
      if (input.action === 'warehouse.movement.record' && input.payload?.movementType === 'CYCLE_COUNT') required.push('inventory.approve');
      // Inventory master edits containing cost fields require the separate HPP grant.
      if (feature === 'inventory' && JSON.stringify(input.payload ?? {}).match(/"[^"\n]*(?:cost|price|value)[^"\n]*"\s*:/i)) required.push('hpp.write');
      return execute(subject, required, input, work);
    },
    cashierRecovery(subject, key) {
      return execute(subject, ['orders.view', 'cash.view'], {}, current => runtime.cashierRecovery({ ...current, role: 'cashier' }, key));
    },
    async cashier(subject, route, input) {
      const mapping = {
        '/api/cashier/shifts/open': ['cash.write', 'openCashShift'],
        '/api/cashier/shifts/close': ['cash.write', 'closeCashShift'],
        '/api/cashier/expenses': ['cash.write', 'recordCashierExpense'],
        '/api/cashier/expenses/void': ['finance.approve', 'voidCashierExpense'],
        '/api/cashier/quote': ['orders.view', 'cashierQuote'],
        '/api/cashier/checkouts': ['orders.write', 'cashierCheckout'],
        '/api/cashier/assisted-cash/confirm': ['cash.write', 'confirmKioskAssistedCash'],
        '/api/cashier/manual-qris/confirm': ['qris.approve', 'confirmKioskManualQris'],
      };
      const pair = Object.hasOwn(mapping,route)?mapping[route]:null; if (!pair) throw teamError('permission_route_unmapped', 403);
      if (paymentOff && !route.includes('/shifts/') && !route.includes('/expenses') && !route.endsWith('/quote')) throw teamError('production_payment_off', 409);
      const permissions = [pair[0]];
      if (route.endsWith('/expenses/void')) permissions.push('cash.view','cash.write');
      if (route.endsWith('/checkouts') || route.endsWith('/quote')) {
        if (input.paymentMethod && !['CASH','QRIS_STATIC_MANUAL'].includes(input.paymentMethod)) throw teamError('payment_method_permission_denied', 403);
        if (input.paymentMethod === 'QRIS_STATIC_MANUAL') permissions.push('qris.view');
        permissions.push('cash.view');
        if (route.endsWith('/checkouts')) permissions.push('cash.write');
      }
      return execute(subject, permissions, input, current => runtime[pair[1]]({ ...current, role: 'cashier' }, input));
    },
    fulfillment(subject, input) {
      return execute(subject, ['kds.write'], input, () => runtime.advanceFulfillment('bar', input));
    },
    async export(subject, feature) {
      if (feature === 'payroll') return execute(subject,['payroll.export'],{},async()=>{
        if (!nativeStaff) throw teamError('feature_unavailable',503);
        const report = await nativeStaff.report({});
        const rows = report.payroll?.rows ?? report.rows ?? [];
        const fields = ['staffId','name','workedMinutes','estimatedPayRupiah'];
        const cell = v => `"${String(v ?? '').replaceAll('"','""').replace(/^[=+@-]/,"'$&")}"`;
        return [fields.map(cell).join(','),...rows.map(r=>fields.map(f=>cell(r[f])).join(','))].join('\n');
      });
      const fn = { finance: 'exportPaymentSettlementCsv', hpp: 'exportHppQualityCsv' }[feature];
      if (!fn) throw teamError('permission_route_unmapped', 403);
      return execute(subject, [`${feature}.export`], {}, () => runtime[fn]('owner'));
    },
  };
}
