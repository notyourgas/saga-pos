import { createHash } from 'node:crypto';
import { allocateLargestRemainder } from './esb-catalog/money.mjs';

const fail = code => Object.assign(new Error(code), { code, status: 409 });
const fields = ['subtotalRupiah','discountRupiah','taxRupiah','serviceRupiah','roundingRupiah','totalRupiah'];

// Original immutable facts only. Cumulative division gives the last unit any
// remaining Rupiah, so several refunds equal one full refund exactly.
export function planCashierRefund({ order, orderItems, refunds = [], items, reason, idempotencyKey }) {
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 160) throw fail('refund_reason_required');
  if (idempotencyKey != null && (typeof idempotencyKey !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(idempotencyKey))) throw fail('refund_key_invalid');
  if (items !== undefined && (!idempotencyKey || !Array.isArray(items) || !items.length || items.length > 100)) throw fail('refund_items_invalid');
  const requestItems = items?.map(item => {
    if (!item || Object.keys(item).some(key => !['orderItemId','qty'].includes(key)) || typeof item.orderItemId !== 'string' || !Number.isSafeInteger(item.qty) || item.qty <= 0) throw fail('refund_items_invalid');
    return { orderItemId:item.orderItemId, qty:item.qty };
  }).sort((a,b)=>a.orderItemId.localeCompare(b.orderItemId));
  if (requestItems && new Set(requestItems.map(item=>item.orderItemId)).size !== requestItems.length) throw fail('refund_items_invalid');
  const operationKey = idempotencyKey ?? `full:${order.id}`;
  const fingerprint = createHash('sha256').update(JSON.stringify({orderId:order.id,reason:reason.trim(),items:requestItems ?? null})).digest('hex');
  const history = refunds.filter(refund=>refund.orderId === order.id);
  const replay = history.find(refund=>refund.operationKey === operationKey);
  if (replay) {
    if (replay.fingerprint !== fingerprint) throw fail('refund_retry_conflict');
    return {...structuredClone(replay),idempotentReplay:true};
  }
  if (!['PAID','COMPLETED'].includes(order.status)) throw fail('order_not_refundable');
  if (history.some(refund=>refund.status === 'PENDING_MANUAL_FINANCE_RECONCILIATION')) throw fail('refund_reconciliation_required');
  if (history.some(refund=>!Array.isArray(refund.items))) throw fail('refund_history_incomplete');
  if (!orderItems.length && items === undefined && Number.isSafeInteger(order.totalRupiah) && order.totalRupiah >= 0) {
    // A legacy full refund can return its persisted total; it cannot invent
    // per-item amounts or claim allocation/COGS completeness.
    return {operationKey,fingerprint,reason:reason.trim(),amountRupiah:order.totalRupiah,full:true,basis:'LEGACY_TOTAL_ONLY',idempotentReplay:false};
  }
  if (!orderItems.length || fields.some(field=>!Number.isSafeInteger(order[field]) || (field !== 'roundingRupiah' && order[field] < 0))) throw fail('refund_original_allocation_invalid');
  if (order.subtotalRupiah-order.discountRupiah+order.taxRupiah+order.serviceRupiah+order.roundingRupiah !== order.totalRupiah) throw fail('refund_original_allocation_invalid');
  const lines = orderItems.map(item=>{
    if (item.orderId !== order.id || !item.id || !Number.isSafeInteger(item.qty) || item.qty <= 0 || !Number.isSafeInteger(item.lineTotalRupiah) || item.lineTotalRupiah < 0) throw fail('refund_original_allocation_invalid');
    return {id:item.id,qty:item.qty,subtotalRupiah:item.lineTotalRupiah};
  });
  if (new Set(lines.map(line=>line.id)).size !== lines.length || lines.reduce((sum,line)=>sum+line.subtotalRupiah,0) !== order.subtotalRupiah) throw fail('refund_original_allocation_invalid');
  let discount;
  if (order.benefitSnapshot?.allocations) {
    const allocations=order.benefitSnapshot.allocations;
    if (allocations.length !== lines.length || new Set(allocations.map(row=>row.orderItemId)).size !== lines.length || allocations.reduce((sum,row)=>sum+row.amountRupiah,0) !== order.discountRupiah) throw fail('refund_original_allocation_invalid');
    discount=new Map(allocations.map(row=>[row.orderItemId,row.amountRupiah]));
  } else {
    if (items !== undefined && order.discountRupiah !== 0) throw fail('refund_original_allocation_required');
    discount=new Map(allocateLargestRemainder(order.discountRupiah,lines.map(line=>({id:line.id,weight:line.subtotalRupiah}))).map(row=>[row.id,row.amountRupiah]));
  }
  for (const line of lines) {
    line.discountRupiah=discount.get(line.id);
    if (!Number.isSafeInteger(line.discountRupiah) || line.discountRupiah < 0 || line.discountRupiah > line.subtotalRupiah) throw fail('refund_original_allocation_invalid');
  }
  const weights=lines.map(line=>({id:line.id,weight:line.subtotalRupiah-line.discountRupiah}));
  for (const field of ['taxRupiah','serviceRupiah','roundingRupiah']) {
    const allocation=new Map(allocateLargestRemainder(Math.abs(order[field]),weights).map(row=>[row.id,row.amountRupiah*Math.sign(order[field])]));
    for (const line of lines) line[field]=allocation.get(line.id);
  }
  for (const line of lines) line.totalRupiah=line.subtotalRupiah-line.discountRupiah+line.taxRupiah+line.serviceRupiah+line.roundingRupiah;
  const used=new Map();
  for (const refund of history) for (const item of refund.items) {
    if (!Number.isSafeInteger(item.qty) || item.qty <= 0 || !lines.some(line=>line.id === item.orderItemId)) throw fail('refund_history_incomplete');
    used.set(item.orderItemId,(used.get(item.orderItemId)??0)+item.qty);
  }
  for (const line of lines) if ((used.get(line.id)??0) > line.qty) throw fail('refund_history_incomplete');
  const requested=requestItems ?? lines.filter(line=>line.qty > (used.get(line.id)??0)).map(line=>({orderItemId:line.id,qty:line.qty-(used.get(line.id)??0)}));
  if (!requested.length) throw fail('order_not_refundable');
  const planned=requested.map(item=>{
    const line=lines.find(line=>line.id === item.orderItemId),before=used.get(item.orderItemId)??0;
    if (!line || before+item.qty > line.qty) throw fail('refund_quantity_exceeds_remaining');
    const portion=field=>Number(BigInt(line[field])*BigInt(before+item.qty)/BigInt(line.qty)-BigInt(line[field])*BigInt(before)/BigInt(line.qty));
    const amounts=Object.fromEntries(fields.filter(field=>field !== 'totalRupiah').map(field=>[field,portion(field)]));
    return {...item,...amounts,totalRupiah:amounts.subtotalRupiah-amounts.discountRupiah+amounts.taxRupiah+amounts.serviceRupiah+amounts.roundingRupiah};
  });
  const totals=Object.fromEntries(fields.map(field=>[field,planned.reduce((sum,line)=>sum+line[field],0)]));
  if (fields.some(field=>!Number.isSafeInteger(totals[field])) || totals.totalRupiah < 0) throw fail('refund_amount_invalid');
  return {operationKey,fingerprint,reason:reason.trim(),items:planned,...totals,amountRupiah:totals.totalRupiah,full:lines.every(line=>(used.get(line.id)??0)+(requested.find(item=>item.orderItemId===line.id)?.qty??0)===line.qty),basis:'ORIGINAL_CHECKOUT_ALLOCATION',idempotentReplay:false};
}
