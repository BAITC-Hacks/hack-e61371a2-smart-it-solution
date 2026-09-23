import type { Page } from '@playwright/test';
import type { ImportBatch, Profile, Role, User } from '../src/api';

// Explicit UI contract fixture. It does not replace the real API integration suite.
const profiles: Profile[] = Array.from({ length: 25 }, (_, index) => ({
  id: `E${String(index + 1).padStart(4, '0')}`,
  name: index === 0 ? 'Aigul Testova' : `Employee ${index + 1}`,
  role: 'Software Engineer', grade: index === 12 ? 'Lead' : 'Middle',
  department: index < 13 ? 'Engineering' : 'Product', language: 'ru',
  managerId: index < 12 ? 'E0013' : null,
  hireDate: '2023-01-16', tenureMonths: 42, workFormat: 'hybrid',
  lastReviewDate: '2026-07-01', targetRole: 'Software Engineer', targetGrade: 'Senior',
}));
const accounts: User[] = (['employee', 'manager', 'hr', 'admin'] as Role[]).map(role => ({
  id: `user-${role}`, login: `demo.${role}`, displayName: `${role} Demo`, role,
  employeeId: role === 'employee' ? 'E0001' : role === 'manager' ? 'E0013' : null,
  demo: true,
}));
const counts = { skills: 2, roleProfiles: 1, employees: 1, events: 2, history: 3 };

export async function contractApi(page: Page, initialRole?: Role) {
  const state = {
    user: accounts.find(user => user.role === initialRole) ?? null,
    previewBodies: [] as unknown[], commitBodies: [] as unknown[],
    errors: false, duplicate: false, unauthorizedWorkspace: false, peopleUnavailable: false,
    history: [] as ImportBatch[],
  };
  const csrf = 'contract-csrf-token';
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice('/api/v1'.length);
    const ok = (data: unknown, meta?: unknown) => route.fulfill({ json: { data, ...(meta ? { meta } : {}) } });
    const fail = (status: number, code: string, details?: unknown) => route.fulfill({ status, json: { error: { code, message: code, details, requestId: 'contract-request' } } });
    if (path === '/auth/demo-accounts') return ok({ enabled: true, accounts });
    if (path === '/auth/login') {
      const body = request.postDataJSON();
      const user = accounts.find(user => user.login === body.login);
      if (!user || !body.demo) return fail(401, 'INVALID_CREDENTIALS');
      state.user = user;
      return ok({ user, csrfToken: csrf });
    }
    if (!state.user) return fail(401, 'UNAUTHENTICATED');
    if (request.method() === 'POST' && request.headers()['x-csrf-token'] !== csrf) return fail(403, 'CSRF_REJECTED');
    if (path === '/auth/me') return ok({ user: state.user, csrfToken: csrf });
    if (path === '/auth/logout') { state.user = null; return ok({ loggedOut: true }); }
    const visible = profiles.filter(profile => state.user?.role === 'employee' ? profile.id === state.user.employeeId : state.user?.role === 'manager' ? profile.id === state.user.employeeId || profile.managerId === state.user.employeeId : true);
    if (path === '/workspace') {
      if (state.unauthorizedWorkspace) return fail(401, 'UNAUTHENTICATED');
      return ok({ counts: { employees: visible.length, skills: 60, events: 40, participations: 12 }, dataset: { version: '1.0', asOfDate: '2026-09-01', importedAt: '2026-09-02T10:00:00Z' }, scope: state.user.role === 'employee' ? 'self' : state.user.role === 'manager' ? 'team' : 'organization' });
    }
    if (path === '/employees') {
      if (state.peopleUnavailable) return fail(503, 'NOT_READY');
      const query = (url.searchParams.get('q') ?? '').toLowerCase();
      const pageNumber = Number(url.searchParams.get('page') ?? 1);
      const limit = Number(url.searchParams.get('limit') ?? 12);
      const filtered = visible.filter(profile => `${profile.name} ${profile.role} ${profile.department}`.toLowerCase().includes(query));
      return ok(filtered.slice((pageNumber - 1) * limit, pageNumber * limit), { total: filtered.length, page: pageNumber, limit });
    }
    if (path.startsWith('/employees/')) {
      const profile = visible.find(profile => profile.id === decodeURIComponent(path.split('/').at(-1)!));
      return profile ? ok(profile) : fail(404, 'NOT_FOUND');
    }
    if (path.startsWith('/imports')) {
      if (state.user.role !== 'admin') return fail(403, 'FORBIDDEN');
      if (path === '/imports') return ok(state.history);
      const body = request.postDataJSON();
      if (path === '/imports/preview') state.previewBodies.push(body);
      if (path === '/imports/commit') state.commitBodies.push(body);
      if (state.errors) return fail(422, 'INVALID_DATASET', [{ file: 'employees', field: 'employees.0.employee_id', message: 'Unknown employee reference' }]);
      const committed = path === '/imports/commit' && !state.duplicate;
      if (committed) state.history.unshift({ id: 'new-batch', version: '1.0', asOfDate: '2026-09-01', counts, importedAt: '2026-09-23T12:00:00Z' });
      return ok({ hash: 'a'.repeat(64), counts, duplicate: state.duplicate, committed, ...(committed ? { batchId: 'new-batch' } : {}) });
    }
    return fail(404, 'NOT_FOUND');
  });
  return state;
}

export const employeesFile = (name = 'employees.json') => ({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ meta: { dataset: 'ui-test', version: '1.0', as_of_date: '2026-09-01' }, employees: [{ employee_id: 'E0001' }] })) });
