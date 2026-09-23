import { useCallback, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertCircle, Check, CheckCircle2, FileJson2, FileSpreadsheet, History, LoaderCircle, LockKeyhole, RefreshCw, ShieldCheck, Upload, X } from 'lucide-react';
import { api, ApiError, type ImportBatch, type ImportBundle, type ImportResult, type Session } from '../api';
import { Button, EmptyState, ErrorState, Heading, Loading } from '../components/ui';
import { useI18n } from '../i18n';
import { importsCopy, localizeImportIssue, type ImportsCopy } from './imports.copy';
import './imports.css';

type FileKey = 'skills' | 'employees' | 'events' | 'history';
type FileProblem = 'fileEmpty' | 'fileJson' | 'fileRead' | 'fileShape' | 'fileType' | 'csvType' | 'fileTooLarge';
type FileSlot = { file: File; reading: boolean; value?: Record<string, unknown> | string; problem?: FileProblem };
type Slots = Partial<Record<FileKey, FileSlot>>;
type ImportProblem = { key: keyof ImportsCopy; details?: { file?: string; field?: string; message: string }[] };
type CheckedPackage = { result: ImportResult; payload: ImportBundle; revision: number; fileCount: number };

const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const fileKeys: FileKey[] = ['skills', 'employees', 'events', 'history'];
const expectedArrays = { skills: ['skills', 'role_profiles'], employees: ['employees'], events: ['events'] };
const fileNames = { skills: 'skills.json', employees: 'employees.json', events: 'events.json', history: 'activity_history.csv' };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fileSize(bytes: number, locale: string) {
  const amount = bytes < 1024 ? bytes : bytes < 1024 * 1024 ? bytes / 1024 : bytes / (1024 * 1024);
  const unit = bytes < 1024 ? 'B' : bytes < 1024 * 1024 ? 'KiB' : 'MiB';
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(amount)} ${unit}`;
}

function requestProblem(error: unknown, fallback: keyof ImportsCopy): ImportProblem {
  if (!(error instanceof ApiError)) return { key: fallback };
  const codeKeys: Partial<Record<string, keyof ImportsCopy>> = {
    CSRF_REJECTED: 'csrfRejected', ORIGIN_REJECTED: 'originRejected',
    INVALID_RESPONSE: fallback === 'commitFailed' ? 'commitFailed' : 'invalidResponse',
  };
  const keys: Partial<Record<number, keyof ImportsCopy>> = {
    401: 'unauthorized', 403: 'forbidden', 413: 'tooLarge', 422: 'validationFailed', 503: 'databaseUnavailable',
  };
  return { key: codeKeys[error.code] ?? keys[error.status] ?? fallback, details: error.details };
}

function prettyDate(value: string, locale: string, withTime = false) {
  // Date-only fields describe the dataset, so they must not shift across time zones.
  const date = new Date(withTime ? value : `${value.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }).format(date);
}

function PackageCounts({ counts, copy, locale, compact = false }: { counts: ImportResult['counts']; copy: ImportsCopy; locale: string; compact?: boolean }) {
  const items = [['skills', copy.skills], ['roleProfiles', copy.roleProfiles], ['employees', copy.employees], ['events', copy.events], ['history', copy.historyRecords]] as const;
  return <dl className={compact ? 'import-counts import-counts-compact' : 'import-counts'}>
    {items.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{new Intl.NumberFormat(locale).format(counts[key])}</dd></div>)}
  </dl>;
}

export function ImportsPage({ session, onDataChanged }: { session: Session; onDataChanged: () => void }) {
  const { locale } = useI18n();
  const copy = importsCopy[locale];
  const [slots, setSlots] = useState<Slots>({});
  const slotsRef = useRef<Slots>({});
  const revision = useRef(0);
  const readTokens = useRef<Record<FileKey, number>>({ skills: 0, employees: 0, events: 0, history: 0 });
  const previewRequest = useRef<AbortController | null>(null);
  const historyRequest = useRef<AbortController | null>(null);
  const inputs = useRef<Partial<Record<FileKey, HTMLInputElement | null>>>({});
  const mounted = useRef(true);
  const mutationInFlight = useRef(false);
  const [checked, setChecked] = useState<CheckedPackage | null>(null);
  const [problem, setProblem] = useState<ImportProblem | null>(null);
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [history, setHistory] = useState<ImportBatch[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<ImportProblem | null>(null);

  const loadHistory = useCallback(async () => {
    if (session.user.role !== 'admin') return;
    historyRequest.current?.abort();
    const controller = new AbortController();
    historyRequest.current = controller;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const response = await api<ImportBatch[]>('/imports', { signal: controller.signal });
      if (!controller.signal.aborted && mounted.current) setHistory(response.data);
    } catch (error) {
      if (!controller.signal.aborted && mounted.current) setHistoryError(requestProblem(error, 'historyFailed'));
    } finally {
      if (!controller.signal.aborted && mounted.current) setHistoryLoading(false);
    }
  }, [session.user.role]);

  useEffect(() => {
    mounted.current = true;
    void loadHistory();
    return () => {
      mounted.current = false;
      previewRequest.current?.abort();
      historyRequest.current?.abort();
      // Any file read still in progress belongs to the previous page instance.
      for (const key of fileKeys) readTokens.current[key] += 1;
    };
  }, [loadHistory]);

  function invalidate() {
    revision.current += 1;
    previewRequest.current?.abort();
    previewRequest.current = null;
    setChecked(null);
    setProblem(null);
    setConfirmOpen(false);
    setBusy(null);
  }

  function storeSlot(key: FileKey, slot?: FileSlot) {
    const next = { ...slotsRef.current };
    if (slot) next[key] = slot;
    else delete next[key];
    slotsRef.current = next;
    setSlots(next);
  }

  async function chooseFile(key: FileKey, file: File | undefined) {
    if (mutationInFlight.current || !file) return;
    invalidate();
    const token = ++readTokens.current[key];
    storeSlot(key, { file, reading: true });
    const finish = (slot: FileSlot) => {
      if (mounted.current && readTokens.current[key] === token) storeSlot(key, slot);
    };
    // Bound memory before reading large local files; the combined encoded payload
    // is checked separately because CSV escaping may increase its request size.
    if (file.size > MAX_REQUEST_BYTES) {
      finish({ file, reading: false, problem: 'fileTooLarge' });
      return;
    }
    const extension = key === 'history' ? '.csv' : '.json';
    if (!file.name.toLowerCase().endsWith(extension)) {
      finish({ file, reading: false, problem: key === 'history' ? 'csvType' : 'fileType' });
      return;
    }
    try {
      const text = await file.text();
      if (!text.trim()) {
        finish({ file, reading: false, problem: 'fileEmpty' });
        return;
      }
      if (key === 'history') {
        // Keep CSV untouched: the API owns parsing, quoted values and normalization.
        finish({ file, reading: false, value: text });
        return;
      }
      let parsed: unknown;
      try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')); }
      catch { finish({ file, reading: false, problem: 'fileJson' }); return; }
      if (!isObject(parsed) || !isObject(parsed.meta) || !expectedArrays[key].every(field => Array.isArray(parsed[field]))) {
        finish({ file, reading: false, problem: 'fileShape' });
        return;
      }
      finish({ file, reading: false, value: parsed });
    } catch { finish({ file, reading: false, problem: 'fileRead' }); }
  }

  function removeFile(key: FileKey) {
    if (mutationInFlight.current) return;
    invalidate();
    readTokens.current[key] += 1;
    storeSlot(key);
    if (inputs.current[key]) inputs.current[key]!.value = '';
    inputs.current[key]?.focus();
  }

  async function preview() {
    if (busy || mutationInFlight.current) return;
    setProblem(null);
    setChecked(null);
    const selected = fileKeys.filter(key => slotsRef.current[key]);
    if (!selected.length) { setProblem({ key: 'noFiles' }); return; }
    if (selected.some(key => slotsRef.current[key]?.reading || slotsRef.current[key]?.problem || slotsRef.current[key]?.value === undefined)) {
      setProblem({ key: 'fileNotReady' }); return;
    }
    const bundle: ImportBundle = {};
    for (const key of selected) {
      const value = slotsRef.current[key]!.value!;
      if (key === 'history') bundle.historyCsv = value as string;
      else bundle[key] = value as Record<string, unknown>;
    }
    const serialized = JSON.stringify(bundle);
    // Check the exact UTF-8 request size, including JSON escaping of the CSV string.
    if (new TextEncoder().encode(serialized).byteLength > MAX_REQUEST_BYTES) { setProblem({ key: 'tooLarge' }); return; }
    // This snapshot is separate from the selected files and reused unchanged by commit.
    const payload: ImportBundle = JSON.parse(serialized) as ImportBundle;
    const requestedRevision = revision.current;
    previewRequest.current?.abort();
    const controller = new AbortController();
    previewRequest.current = controller;
    setBusy('preview');
    try {
      const response = await api<ImportResult>('/imports/preview', { method: 'POST', body: payload, csrf: session.csrfToken, signal: controller.signal });
      if (mounted.current && !controller.signal.aborted && revision.current === requestedRevision) {
        setChecked({ payload, result: response.data, revision: requestedRevision, fileCount: selected.length });
      }
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && revision.current === requestedRevision) setProblem(requestProblem(error, 'requestFailed'));
    } finally {
      if (mounted.current && !controller.signal.aborted && revision.current === requestedRevision) setBusy(null);
    }
  }

  async function commit() {
    if (!checked || checked.revision !== revision.current || checked.result.duplicate || checked.result.committed || busy || mutationInFlight.current) return;
    const snapshot = checked;
    mutationInFlight.current = true;
    setConfirmOpen(false);
    setBusy('commit');
    setProblem(null);
    try {
      const response = await api<ImportResult>('/imports/commit', { method: 'POST', body: snapshot.payload, csrf: session.csrfToken });
      if (!response.data.committed && !response.data.duplicate) throw new ApiError('', 200, undefined, 'INVALID_RESPONSE');
      // The parent still needs to refresh if the user changed pages during commit.
      onDataChanged();
      if (!mounted.current) return;
      setChecked({ ...snapshot, result: response.data });
      void loadHistory();
    } catch (error) {
      if (mounted.current) {
        setProblem(requestProblem(error, 'commitFailed'));
        // A rejected commit is no longer a valid preview. A network failure remains
        // retryable with the identical snapshot because the server may have saved it.
        if (error instanceof ApiError && (error.status === 400 || error.status === 422)) setChecked(null);
      }
    } finally {
      mutationInFlight.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  if (session.user.role !== 'admin') return <div className="imports-page"><Heading title={copy.title} subtitle={copy.subtitle}/><EmptyState title={copy.noAccess} description={copy.noAccessDescription}/></div>;

  const reading = Object.values(slots).some(slot => slot?.reading);
  const hasFileProblems = Object.values(slots).some(slot => slot?.problem);
  const selectedCount = Object.keys(slots).length;
  const applied = Boolean(checked?.result.committed && !checked.result.duplicate);
  const duplicate = Boolean(checked?.result.duplicate);
  const canApply = checked && checked.revision === revision.current && !checked.result.committed && !duplicate && !busy && !reading;
  const previewStatus = applied ? copy.appliedTitle : duplicate ? copy.duplicateTitle : copy.previewTitle;

  return <div className="imports-page">
    <Heading title={copy.title} subtitle={copy.subtitle} action={<span className="import-access-tag"><LockKeyhole size={14}/>{copy.admin}</span>}/>

    <ol className="import-steps" aria-label={copy.title}>
      {[copy.stepChoose, copy.stepCheck, copy.stepApply].map((label, index) => <li key={label} className={(index === 0 && selectedCount > 0) || (index === 1 && checked) || (index === 2 && (applied || duplicate)) ? 'is-complete' : ''}>
        <span aria-hidden="true">{index + 1}</span>{label}
      </li>)}
    </ol>

    <section className="import-panel" aria-labelledby="import-upload-title">
      <div className="import-section-heading"><div><h2 id="import-upload-title">{copy.uploadTitle}</h2><p>{copy.uploadDescription}</p></div><span className="import-limit">{copy.limit}</span></div>
      <div className="import-file-grid">
        {fileKeys.map(key => {
          const slot = slots[key];
          const descriptionKey = `${key}Description` as 'skillsDescription' | 'employeesDescription' | 'eventsDescription' | 'historyDescription';
          const Icon = key === 'history' ? FileSpreadsheet : FileJson2;
          const fieldId = `import-${key}`;
          return <div key={key} className={`import-file-card${slot ? ' has-file' : ''}${slot?.problem ? ' has-error' : ''}`}>
            <div className="import-file-top"><span className="import-file-icon"><Icon size={22} aria-hidden="true"/></span><span className="import-optional">{key === 'history' ? 'CSV' : 'JSON'} · {copy.optional}</span></div>
            <h3><label htmlFor={fieldId}>{copy[key]}</label></h3><p id={`${fieldId}-description`}>{copy[descriptionKey]}</p>
            <div className="import-file-selection">
              {slot ? <div className="import-file-name"><strong title={slot.file.name}>{slot.file.name}</strong><span>{fileSize(slot.file.size, locale)}</span></div> : <span className="import-file-placeholder">{fileNames[key]}</span>}
              {slot && <button type="button" className="import-remove" aria-label={`${copy.remove}: ${slot.file.name}`} onClick={() => removeFile(key)} disabled={busy === 'commit'}><X size={16}/></button>}
            </div>
            <label className={`import-file-button${busy === 'commit' ? ' is-disabled' : ''}`}>
              <input id={fieldId} data-testid={`import-file-${key}`} type="file" accept={key === 'history' ? '.csv,text/csv' : '.json,application/json'} disabled={busy === 'commit'} ref={element => { inputs.current[key] = element; }} aria-describedby={`${fieldId}-description${slot?.problem ? ` ${fieldId}-error` : ''}`} aria-invalid={Boolean(slot?.problem)} onChange={event => { const file = event.currentTarget.files?.[0]; void chooseFile(key, file); event.currentTarget.value = ''; }}/>
              <Upload size={15} aria-hidden="true"/>{slot ? copy.replace : copy.choose}
            </label>
            {slot?.reading && <span className="import-file-status" role="status"><LoaderCircle className="import-spinning" size={14}/>{copy.reading}</span>}
            {slot?.problem && <p className="import-file-error" id={`${fieldId}-error`} role="alert"><AlertCircle size={14}/>{copy[slot.problem]}</p>}
            {slot && !slot.reading && !slot.problem && <span className="import-file-status is-ready"><Check size={14}/>{copy.selected}</span>}
          </div>;
        })}
      </div>
      <div className="import-validation-actions"><p><ShieldCheck size={17}/>{copy.previewNote}</p><Button data-testid="import-preview" onClick={() => void preview()} disabled={Boolean(busy) || reading || hasFileProblems || selectedCount === 0}>{busy === 'preview' ? <LoaderCircle className="import-spinning" size={17}/> : <ShieldCheck size={17}/>} {busy === 'preview' ? copy.checking : copy.preview}</Button></div>
    </section>

    {problem && <section className="import-problems" role="alert" data-testid="import-errors">
      <div className="import-problem-heading"><AlertCircle size={21}/><div><h2>{copy[problem.key]}</h2>{problem.details?.length ? <p>{copy.problemsDescription}</p> : null}</div></div>
      {problem.details && problem.details.length > 0 && <><div className="import-error-table-wrap"><table><thead><tr><th>{copy.detailFile}</th><th>{copy.detailField}</th><th>{copy.detailMessage}</th></tr></thead><tbody>{problem.details.map((detail, index) => <tr key={index}><td>{detail.file || '—'}</td><td><code>{detail.field || '—'}</code></td><td>{localizeImportIssue(detail.message, locale)}</td></tr>)}</tbody></table></div>{problem.details.length >= 100 && <p className="import-error-limit">{copy.detailsLimit}</p>}</>}
    </section>}

    {checked ? <section className={`import-panel import-preview-panel${applied || duplicate ? ' is-applied' : ''}`} data-testid="import-result" aria-labelledby="import-preview-title" aria-live="polite">
      <div className="import-result-heading"><span className="import-result-icon"><CheckCircle2 size={25}/></span><div><h2 id="import-preview-title" tabIndex={-1}>{previewStatus}</h2><p>{applied ? copy.appliedDescription : duplicate ? copy.duplicateDescription : copy.previewDescription}</p></div>{canApply && <Button data-testid="import-commit" onClick={() => setConfirmOpen(true)}><Check size={17}/>{copy.apply}</Button>}</div>
      <PackageCounts counts={checked.result.counts} copy={copy} locale={locale}/>
      <p className="import-counts-note">{copy.countsNote}</p>
      <details className="import-hash"><summary>{copy.hash}</summary><code>{checked.result.hash}</code></details>
      {busy === 'commit' && <p className="import-applying" role="status"><LoaderCircle className="import-spinning" size={17}/>{copy.applying}</p>}
    </section> : <section className="import-awaiting" aria-live="polite"><ShieldCheck size={24}/><div><h2>{copy.waitingTitle}</h2><p>{copy.waitingDescription}</p></div></section>}

    <section className="import-panel import-history" data-testid="import-history" aria-labelledby="import-history-title">
      <div className="import-section-heading"><div className="import-history-heading"><History size={21}/><div><h2 id="import-history-title">{copy.recent}</h2><p>{copy.recentDescription}</p></div></div><Button variant="ghost" size="small" disabled={historyLoading} onClick={() => void loadHistory()} aria-label={copy.refresh}><RefreshCw size={16}/>{copy.refresh}</Button></div>
      {historyLoading ? <Loading label={copy.loadingHistory}/> : historyError ? <ErrorState message={copy[historyError.key]} retry={() => void loadHistory()}/> : history.length === 0 ? <EmptyState title={copy.historyEmptyTitle} description={copy.historyEmptyDescription}/> : <div className="import-history-table-wrap"><table className="import-history-table"><thead><tr><th>{copy.importedAt}</th><th>{copy.dataset}</th><th>{copy.package}</th></tr></thead><tbody>{history.map(batch => <tr key={batch.id}><td data-label={copy.importedAt}><time dateTime={batch.importedAt}>{prettyDate(batch.importedAt, locale, true)}</time></td><td data-label={copy.dataset}><strong>{batch.version || copy.unavailable}</strong><span className="import-snapshot">{copy.snapshot}: {batch.asOfDate ? prettyDate(batch.asOfDate, locale) : copy.unavailable}</span></td><td data-label={copy.package}><PackageCounts counts={batch.counts} copy={copy} locale={locale} compact/></td></tr>)}</tbody></table><p className="import-history-note">{copy.countsNote}</p></div>}
    </section>

    <Dialog.Root open={confirmOpen} onOpenChange={setConfirmOpen}>
      <Dialog.Portal><Dialog.Overlay className="import-dialog-overlay"/><Dialog.Content className="import-dialog-content" onCloseAutoFocus={event => { event.preventDefault(); const focusTarget = document.querySelector<HTMLButtonElement>('[data-testid="import-commit"]') ?? document.getElementById('import-preview-title'); focusTarget?.focus(); }}>
        <span className="import-dialog-icon"><Upload size={25}/></span>
        <Dialog.Title>{copy.confirmTitle}</Dialog.Title><Dialog.Description>{copy.confirmDescription}</Dialog.Description>
        <p className="import-confirm-files">{copy.confirmationFileCount}: <strong>{checked?.fileCount ?? 0}</strong></p>
        <div className="import-dialog-actions"><Dialog.Close asChild><Button variant="secondary">{copy.cancel}</Button></Dialog.Close><Button data-testid="import-confirm" onClick={() => void commit()} disabled={!canApply}><Check size={17}/>{copy.apply}</Button></div>
        <Dialog.Close asChild><button type="button" className="import-dialog-close" aria-label={copy.close}><X size={19}/></button></Dialog.Close>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </div>;
}
