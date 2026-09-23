import { domainErrorText } from './api-errors';
export type Role = 'employee' | 'manager' | 'hr' | 'admin';
export type User = { id: string; login: string; displayName: string; role: Role; employeeId: string | null; demo: boolean };
export type Session = { user: User; csrfToken: string };
export type Employee = { id: string; name: string; role: string; grade: string; department: string; language: 'ru' | 'kk' | 'en' };
export type Profile = Employee & { managerId: string | null; hireDate: string; tenureMonths: number; workFormat: 'office' | 'hybrid' | 'remote'; lastReviewDate: string; targetRole: string | null; targetGrade: string | null };
export type Workspace = { counts: { employees: number; skills: number; events: number; participations: number }; dataset: { version: string; asOfDate: string; importedAt: string } | null; scope: 'self' | 'team' | 'organization' };
export type ImportCounts = { skills: number; roleProfiles: number; employees: number; events: number; history: number };
export type ImportBundle = { skills?: Record<string, unknown>; employees?: Record<string, unknown>; events?: Record<string, unknown>; historyCsv?: string };
export type ImportResult = { hash: string; counts: ImportCounts; duplicate: boolean; committed: boolean; batchId?: string };
export type ImportBatch = { id: string; version: string; asOfDate: string; counts: ImportCounts; importedAt: string };
export type ApiIssue = { file?: string; field?: string; message: string };
export type PageMeta = { total: number; page: number; limit: number };
export type ApiResponse<T, M = PageMeta> = { data: T; meta?: M };

const errors = {
  ru: { NETWORK_ERROR: 'Не удаётся связаться с сервером. Проверьте подключение и повторите попытку.', REQUEST_TIMEOUT: 'Сервер отвечает дольше обычного. Повторите попытку.', INVALID_RESPONSE: 'Сервер вернул неожиданный ответ. Повторите попытку.', INVALID_CREDENTIALS: 'Неверный логин или пароль.', UNAUTHENTICATED: 'Сессия завершилась. Войдите ещё раз.', FORBIDDEN: 'У вашей роли нет доступа к этому действию.', NOT_FOUND: 'Данные не найдены или недоступны.', BODY_TOO_LARGE: 'Размер набора превышает 10 МБ.', RATE_LIMITED: 'Слишком много попыток входа. Попробуйте позже.', CSRF_REJECTED: 'Сессия обновилась. Перезагрузите страницу и повторите действие.', ORIGIN_REJECTED: 'Адрес приложения не разрешён сервером. Обратитесь к администратору.', INVALID_DATASET: 'В наборе обнаружены ошибки. Проверьте подробности ниже.', VALIDATION_ERROR: 'Проверьте введённые данные.', NOT_READY: 'Сервис ещё не готов. Повторите попытку чуть позже.', INTERNAL_ERROR: 'Не удалось выполнить запрос. Повторите попытку.' },
  en: { NETWORK_ERROR: 'Cannot connect to the server. Check your connection and try again.', REQUEST_TIMEOUT: 'The server is taking longer than usual. Try again.', INVALID_RESPONSE: 'The server returned an unexpected response. Try again.', INVALID_CREDENTIALS: 'Incorrect login or password.', UNAUTHENTICATED: 'Your session has expired. Sign in again.', FORBIDDEN: 'Your role does not allow this action.', NOT_FOUND: 'The data was not found or is unavailable.', BODY_TOO_LARGE: 'The dataset exceeds 10 MB.', RATE_LIMITED: 'Too many sign-in attempts. Try again later.', CSRF_REJECTED: 'Your session has changed. Reload the page and try again.', ORIGIN_REJECTED: 'The application address is not allowed by the server. Contact your administrator.', INVALID_DATASET: 'The dataset contains errors. Check the details below.', VALIDATION_ERROR: 'Check the information you entered.', NOT_READY: 'The service is not ready yet. Try again shortly.', INTERNAL_ERROR: 'The request could not be completed. Try again.' },
  kk: { NETWORK_ERROR: 'Сервермен байланыс орнатылмады. Қосылымды тексеріп, қайталаңыз.', REQUEST_TIMEOUT: 'Сервердің жауабы кешігіп жатыр. Қайталап көріңіз.', INVALID_RESPONSE: 'Сервер күтпеген жауап қайтарды. Қайталап көріңіз.', INVALID_CREDENTIALS: 'Логин немесе құпиясөз қате.', UNAUTHENTICATED: 'Сессия аяқталды. Қайта кіріңіз.', FORBIDDEN: 'Рөліңіз бұл әрекетке рұқсат бермейді.', NOT_FOUND: 'Деректер табылмады немесе қолжетімсіз.', BODY_TOO_LARGE: 'Жинақ көлемі 10 МБ-тан асады.', RATE_LIMITED: 'Кіру әрекеттері тым көп. Кейінірек қайталаңыз.', CSRF_REJECTED: 'Сессия жаңарды. Бетті жаңартып, қайталаңыз.', ORIGIN_REJECTED: 'Сервер қолданба мекенжайына рұқсат бермейді. Әкімшіге хабарласыңыз.', INVALID_DATASET: 'Жинақта қателер бар. Төмендегі мәліметтерді тексеріңіз.', VALIDATION_ERROR: 'Енгізілген деректерді тексеріңіз.', NOT_READY: 'Қызмет әлі дайын емес. Сәл кейін қайталаңыз.', INTERNAL_ERROR: 'Сұрау орындалмады. Қайталап көріңіз.' },
};
function errorText(code: string) {
  const language = document.documentElement.lang;
  const copy = errors[language === 'kk' || language === 'en' ? language : 'ru'];
  return copy[code as keyof typeof copy] ?? domainErrorText(code, language) ?? copy.INTERNAL_ERROR;
}
export class ApiError extends Error {
  constructor(message: string, public status: number, public details?: ApiIssue[], public code = 'INTERNAL_ERROR') { super(message); this.name = 'ApiError'; }
}
export async function api<T, M = PageMeta>(path: string, options: { method?: string; body?: unknown; csrf?: string; idempotencyKey?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ApiResponse<T, M>> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 25_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method: options.method ?? 'GET', credentials: 'same-origin', signal,
      headers: { Accept: 'application/json', ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(options.csrf ? { 'X-CSRF-Token': options.csrf } : {}), ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}) },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const code = timeout.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR';
    throw new ApiError(errorText(code), 0, undefined, code);
  }
  const payload = await response.json().catch(error => {
    if (options.signal?.aborted) throw error;
    if (timeout.aborted) throw new ApiError(errorText('REQUEST_TIMEOUT'), 0, undefined, 'REQUEST_TIMEOUT');
    return null;
  });
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login' && path !== '/auth/demo-accounts') window.dispatchEvent(new Event('session-expired'));
    const code = typeof payload?.error?.code === 'string' ? payload.error.code : 'INTERNAL_ERROR';
    const details = Array.isArray(payload?.error?.details) ? payload.error.details : undefined;
    throw new ApiError(errorText(code), response.status, details, code);
  }
  if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'data')) throw new ApiError(errorText('INVALID_RESPONSE'), response.status, undefined, 'INVALID_RESPONSE');
  return payload as ApiResponse<T, M>;
}
