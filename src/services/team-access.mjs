import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { TEAM_FEATURES, TEAM_TEMPLATES, TEAM_CATALOG_VERSION, validateTeamPermissions, teamNavigation, teamError } from './team-access-catalog.mjs';
const derive = promisify(scrypt);
const clean = (v, max = 80) => { if (typeof v !== 'string' || !v.trim() || v.trim().length > max || /[\x00-\x1f]/.test(v)) throw teamError('input_invalid'); return v.trim(); };
const publicAccount = ({ passwordHash, credentialVersion, ...account }) => account;
async function hash(password) { const salt = randomBytes(16).toString('hex'); return { salt, key: (await derive(password, salt, 64)).toString('hex') }; }
async function verify(password, encoded) {
  if (typeof password !== 'string' || password.length > 256 || !encoded) return false;
  const key = Buffer.from(encoded.key, 'hex'); const got = await derive(password, encoded.salt, key.length);
  return key.length === got.length && timingSafeEqual(key, got);
}
export function createTeamAccessService({ store, organizationId, outletIds, outletLabels = {}, availableFeatures, clock = () => new Date() }) {
  if (!organizationId || !outletIds?.length || !availableFeatures || availableFeatures.some(id => !TEAM_FEATURES.some(f => f.id === id))) throw teamError('team_context_invalid');
  const available = [...new Set([...availableFeatures, 'team'])];
  let ownerVerifier = null;
  function scope(subject) {
    if (subject?.organizationId !== organizationId || !outletIds.includes(subject.outletId)) throw teamError('team_scope_denied', 403);
  }
  function live(state, subject) {
    scope(subject);
    const account = state.accounts.find(a => a.id === subject.accountId && a.active);
    if (!account || account.credentialVersion !== subject.credentialVersion) throw teamError('team_access_revoked', 401);
    if(account.passwordChangeRequired && account.credentialExpiresAt && Date.parse(account.credentialExpiresAt)<=clock().getTime())throw teamError('team_access_revoked',401);
    const role = state.roles.find(r => r.id === account.roleId);
    if (!role) throw teamError('team_access_revoked', 401);
    if (!role.systemOwner && account.outletId !== subject.outletId) throw teamError('team_scope_denied',403);
    const permissions = role.systemOwner ? TEAM_FEATURES.flatMap(f => f.actions.map(a => `${f.id}.${a}`)) : role.permissions;
    return { account, role, permissions: permissions.filter(p => available.includes(p.split('.')[0])) };
  }
  function owner(state, subject) { const value = live(state, subject); if (!value.role.systemOwner) throw teamError('owner_required', 403); return value; }
  const makeSubject = account => ({ authProvider: account.roleId === 'system-owner' ? 'production_owner' : 'team', teamManaged: true, mode:account.roleId==='system-owner'?'DASHBOARD':'TEAM_ACCESS',role: account.roleId === 'system-owner' ? 'owner' : 'team_member', accountId: account.id, employeeId: account.externalId ?? account.id, displayName: account.name, organizationId, outletId: account.outletId, credentialVersion: account.credentialVersion, passwordChangeRequired: account.passwordChangeRequired });
  async function mutate(subject, input, operation, work) {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw teamError('team_revision_required');
    const reason = clean(input.reason, 160);
    return store.mutate(input.expectedRevision, async state => {
      const actor = owner(state, subject);
      if (typeof input.password !== 'string' || !(ownerVerifier && actor.account.externalId
        ? await ownerVerifier(actor.account.externalId, input.password)
        : await verify(input.password, actor.account.passwordHash))) throw teamError('owner_reauthentication_required', 403);
      const before = { roles: structuredClone(state.roles), accounts: state.accounts.map(publicAccount) };
      const result = await work(state);
      if (!state.accounts.some(a => a.active && state.roles.some(r => r.id === a.roleId && r.systemOwner))) throw teamError('last_owner_protected', 409);
      const after = { roles: structuredClone(state.roles), accounts: state.accounts.map(publicAccount) };
      return { result, event: { actorId: actor.account.id, operation, reason, before, after, at: clock().toISOString() } };
    });
  }
  return {
    organizationId, outletIds: [...outletIds], availableFeatures: available,persistence:store.kind,
    setOwnerVerifier(verifier) { ownerVerifier = verifier; },
    async initializeOwner({ id, name, login, passwordHash, outletId, externalId }) {
      if (!id || !outletIds.includes(outletId) || !passwordHash) throw teamError('owner_bootstrap_invalid');
      return store.initialize({ revision: 1, catalogVersion: TEAM_CATALOG_VERSION,
        roles: [{ id: 'system-owner', name: 'Owner', systemOwner: true, permissions: [] }],
        accounts: [{ id, externalId, name: clean(name), login: clean(login).toLowerCase(), outletId, roleId: 'system-owner', active: true, credentialVersion: 1, passwordChangeRequired: false, passwordHash }] });
    },
    async bootstrapLegacyOwner(actor, password, outletId) {
      if (actor.role !== 'owner' || !outletIds.includes(outletId)) throw teamError('owner_required', 403);
      let state;
      try { state = await store.read(); }
      catch (error) {
        if (error.code !== 'team_not_initialized') throw error;
        state = await store.initialize({ revision: 1, catalogVersion: TEAM_CATALOG_VERSION,
          roles: [{ id: 'system-owner', name: 'Owner', systemOwner: true, permissions: [] }],
          accounts: [{ id: randomUUID(), externalId: actor.employeeId, name: actor.displayName, login: actor.employeeId.toLowerCase(), outletId, roleId: 'system-owner', active: true, credentialVersion: 1, passwordChangeRequired: false, passwordHash: await hash(password) }] });
      }
      const account = state.accounts.find(a => a.externalId === actor.employeeId && a.active && a.roleId === 'system-owner');
      if (!account) throw teamError('owner_bootstrap_required', 503);
      return makeSubject({...account,outletId});
    },
    async login(input) {
      if (input.organizationId !== organizationId || !outletIds.includes(input.outletId)) throw teamError('identity_invalid', 401);
      const state = await store.read();
      const account = state.accounts.find(a => a.login === String(input.login ?? '').trim().toLowerCase() && a.active && a.outletId === input.outletId);
      // Perform scrypt even when login does not exist to avoid a fast account oracle.
      const valid = await verify(input.password, account?.passwordHash ?? { salt: 'team-invalid-account', key: '0'.repeat(128) });
      if (!account || !valid || account.passwordChangeRequired && account.credentialExpiresAt && Date.parse(account.credentialExpiresAt)<=clock().getTime()) throw teamError('identity_invalid', 401);
      return makeSubject(account);
    },
    async resolve(subject) {
      const state = await store.read(); const value = live(state, subject);
      return { ...makeSubject({...value.account,outletId:subject.outletId}), permissions: value.permissions, systemOwner: value.role.systemOwner === true, roleName: value.role.name,
        revision: state.revision, navigation: teamNavigation(value.permissions, available) };
    },
    async authorize(subject, permission) {
      const current = await this.resolve(subject);
      if (current.passwordChangeRequired) throw teamError('password_change_required', 403);
      if (!current.permissions.includes(permission) || !current.permissions.includes(`${permission.split('.')[0]}.view`)) throw teamError('permission_denied', 403);
      return current;
    },
    executeAuthorized(subject, permissions, work) {
      return store.guard(state => {
        const current = live(state, subject);
        if (current.account.passwordChangeRequired) throw teamError('password_change_required', 403);
        if (permissions.some(p => !current.permissions.includes(p) || !current.permissions.includes(`${p.split('.')[0]}.view`))) throw teamError('permission_denied', 403);
        return work({ ...makeSubject({...current.account,outletId:subject.outletId}), permissions: current.permissions });
      });
    },
    async list(subject) {
      const state = await store.read(); owner(state, subject);
      return { revision: state.revision, catalogVersion: TEAM_CATALOG_VERSION, features: TEAM_FEATURES.map(f => ({ ...f, available: available.includes(f.id) && f.id !== 'team', explanation: f.id === 'team' ? 'Hanya Owner sistem' : !available.includes(f.id) ? 'Belum tersedia pada outlet ini' : null })),
        templates: Object.fromEntries(Object.entries(TEAM_TEMPLATES).map(([k, v]) => [k, v.filter(p => available.includes(p.split('.')[0]))])),
        roles: state.roles.map(r => ({ ...r, members: state.accounts.filter(a => a.roleId === r.id).map(publicAccount) })), accounts: state.accounts.map(publicAccount), outletIds: [...outletIds],outletLabels };
    },
    saveRole(subject, input) {
      const permissions = validateTeamPermissions(input.permissions); const name = clean(input.name);
      if (permissions.some(p => !available.includes(p.split('.')[0]))) throw teamError('feature_unavailable', 409);
      return mutate(subject, input, 'role.saved', state => {
        let role = state.roles.find(r => r.id === input.roleId);
        if (input.roleId && !role) throw teamError('role_not_found', 404);
        if (role?.systemOwner) throw teamError('owner_role_protected', 403);
        role ??= { id: randomUUID(), systemOwner: false };
        if (state.roles.some(r => r.id !== role.id && r.name.toLowerCase() === name.toLowerCase())) throw teamError('role_name_duplicate', 409);
        Object.assign(role, { name, permissions }); if (!state.roles.includes(role)) state.roles.push(role);
        return { role: structuredClone(role) };
      });
    },
    createAccount(subject, input) {
      const name = clean(input.name), login = clean(input.login).toLowerCase();
      if (!/^[a-z0-9][a-z0-9@._+-]{2,79}$/.test(login) || !outletIds.includes(input.outletId)) throw teamError('account_input_invalid');
      return mutate(subject, input, 'account.created', async state => {
        if (!state.roles.some(r => r.id === input.roleId && !r.systemOwner)) throw teamError('role_assignment_denied', 403);
        if (state.accounts.some(a => a.login === login)) throw teamError('login_duplicate', 409);
        const temporaryPassword = randomBytes(18).toString('base64url');
        const account = { id: randomUUID(), name, login, outletId: input.outletId, roleId: input.roleId, active: true, credentialVersion: 1, passwordChangeRequired: true, credentialExpiresAt:new Date(clock().getTime()+7*86400000).toISOString(),passwordHash: await hash(temporaryPassword) };
        state.accounts.push(account); return { account: publicAccount(account), temporaryPassword };
      });
    },
    updateAccount(subject, input) {
      return mutate(subject, input, 'account.updated', state => {
        const a = state.accounts.find(a => a.id === input.accountId); if (!a) throw teamError('account_not_found', 404);
        const previousActive = a.active, previousOutletId = a.outletId;
        if (input.roleId !== undefined) {
          if (!state.roles.some(r => r.id === input.roleId) || state.roles.some(r => r.id === input.roleId && r.systemOwner) && a.roleId !== input.roleId) throw teamError('role_assignment_denied', 403);
          a.roleId = input.roleId;
        }
        if (input.outletId !== undefined) { if (!outletIds.includes(input.outletId)) throw teamError('team_scope_denied', 403); a.outletId = input.outletId; }
        if (input.active !== undefined) { if (typeof input.active !== 'boolean') throw teamError('account_input_invalid'); a.active = input.active; }
        if (a.active !== previousActive || a.outletId !== previousOutletId) a.credentialVersion++;
        return { account: publicAccount(a) };
      });
    },
    resetAccount(subject, input) {
      return mutate(subject, input, 'account.reset', async state => {
        const a = state.accounts.find(a => a.id === input.accountId); if (!a || a.roleId === 'system-owner') throw teamError('owner_role_protected', 403);
        const temporaryPassword = randomBytes(18).toString('base64url'); a.passwordHash = await hash(temporaryPassword); a.credentialVersion++; a.passwordChangeRequired = true;a.credentialExpiresAt=new Date(clock().getTime()+7*86400000).toISOString();
        return { account: publicAccount(a), temporaryPassword };
      });
    },
    async changePassword(subject, input) {
      if (typeof input.nextPassword !== 'string' || input.nextPassword.length < 12 || input.nextPassword.length > 256) throw teamError('password_invalid');
      if (!Number.isSafeInteger(input.expectedRevision)) throw teamError('team_revision_required');
      return store.mutate(input.expectedRevision, async state => {
        const { account } = live(state, subject);
        if (account.roleId === 'system-owner') throw teamError('owner_password_managed_externally', 403);
        if (!await verify(input.currentPassword, account.passwordHash)) throw teamError('identity_invalid', 401);
        account.passwordHash = await hash(input.nextPassword); account.credentialVersion++; account.passwordChangeRequired = false;account.credentialExpiresAt=null;
        return { result: { loginAgain: true }, event: { actorId: account.id, operation: 'password.changed', at: clock().toISOString() } };
      });
    },
    async preview(subject, roleId) {
      const state = await store.read(); owner(state, subject); const role = state.roles.find(r => r.id === roleId);
      if (!role) throw teamError('role_not_found', 404);
      return { navigation: teamNavigation(role.permissions, available), members: state.accounts.filter(a => a.roleId === role.id).map(publicAccount), readOnly: true };
    },
    async audit(subject) { owner(await store.read(), subject); return store.audit(); },
  };
}
