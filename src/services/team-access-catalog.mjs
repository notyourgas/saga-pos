export const TEAM_CATALOG_VERSION = 1;
const feature = (id, label, actions, sensitive = false) => ({ id, label, actions: ['view', ...actions], sensitive });
export const TEAM_FEATURES = Object.freeze([
  feature('orders', 'Kasir & pesanan', ['write']),
  feature('cash', 'Tunai & opening/closing', ['write']),
  feature('qris', 'Konfirmasi QRIS manual', ['approve'], true),
  feature('refund', 'Pembatalan & refund', ['approve'], true),
  feature('kds', 'Antrean bar / KDS', ['write']),
  feature('catalog', 'Menu & harga', ['write', 'approve', 'archive'], true),
  feature('inventory', 'Bahan & stok', ['write', 'approve', 'archive']),
  feature('hpp', 'Resep & HPP', ['write', 'approve', 'export'], true),
  feature('purchasing', 'Supplier & penerimaan', ['write', 'approve']),
  feature('finance', 'Laporan & rekonsiliasi', ['write', 'approve', 'export'], true),
  feature('hr', 'Staf, jadwal & absensi', ['write', 'approve']),
  feature('payroll', 'Tarif & rekap gaji', ['write', 'export'], true),
  feature('personal', 'Portal pribadi staf', ['write']),
  feature('settings', 'Pengaturan outlet', ['write'], true),
  feature('team', 'Tim & Akses', ['write'], true),
]);
export const TEAM_PERMISSION_IDS = new Set(TEAM_FEATURES.flatMap(f => f.actions.map(a => `${f.id}.${a}`)));
export const TEAM_TEMPLATES = Object.freeze({
  Kasir: ['orders.view', 'orders.write', 'cash.view', 'cash.write', 'qris.view', 'qris.approve'],
  Barista: ['kds.view', 'kds.write'],
  Inventory: ['inventory.view', 'inventory.write', 'purchasing.view', 'purchasing.write'],
  Finance: ['finance.view', 'finance.write', 'finance.approve', 'finance.export'],
  HR: ['hr.view', 'hr.write', 'hr.approve'],
  Manager: ['orders.view', 'cash.view', 'kds.view', 'kds.write', 'inventory.view', 'purchasing.view', 'hr.view'],
});
export function teamError(code, statusCode = 422) {
  return Object.assign(new Error(code), { code, statusCode });
}
export function validateTeamPermissions(input) {
  if (!Array.isArray(input) || input.length > TEAM_PERMISSION_IDS.size || new Set(input).size !== input.length) throw teamError('permissions_invalid');
  for (const p of input) {
    if (!TEAM_PERMISSION_IDS.has(p)) throw teamError('permission_unknown');
    if (!input.includes(`${p.split('.')[0]}.view`)) throw teamError('permission_view_required');
    if (/^(cash|qris)\./.test(p) && !input.includes('orders.view')) throw teamError('permission_orders_view_required');
    // Account/role administration remains a protected system Owner capability.
    if (p.startsWith('team.')) throw teamError('owner_permission_protected', 403);
  }
  return [...input].sort();
}
export function teamNavigation(permissions, available) {
  return TEAM_FEATURES.filter(f => available.includes(f.id) && permissions.includes(`${f.id}.view`)).map(f => ({ id: f.id, label: f.label, href: f.id === 'orders' || f.id === 'cash' || f.id === 'qris' ? '/cashier' : f.id === 'kds' ? '/kds' : `/team-access#${f.id}` }));
}
