'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckSquare, Download, FileSpreadsheet, Plus, RotateCcw, Trash2, Upload } from 'lucide-react';
import { apiDelete, apiGet, apiPost, apiRequest, apiUpload, downloadFile } from '@/shared/api/client';
import type { AthleteDto, SportDto } from '@/shared/api/types';
import { useApi, useList, useErrorText } from '@/shared/hooks/useApi';
import { useSession } from '@/shared/components/session-context';
import { useRouter } from '@/shared/i18n/navigation';
import { useFormatters } from '@/features/common/use-formatters';
import { GENDERS, ATHLETE_STATUSES } from '@/shared/lib/options';
import { PageHeader } from '@/shared/ui-kit/page-header';
import { Button } from '@/shared/ui-kit/button';
import { SearchInput } from '@/shared/ui-kit/search';
import { Select } from '@/shared/ui-kit/select';
import { DataTable, type DataTableColumn } from '@/shared/ui-kit/data-table';
import { Pagination } from '@/shared/ui-kit/pagination';
import { StatusBadge } from '@/shared/ui-kit/status-badge';
import { ConfirmDialog } from '@/shared/ui-kit/confirm-dialog';
import { useToast } from '@/shared/ui-kit/toast';
import { Checkbox } from '@/shared/ui-kit/date-picker';
import { Modal } from '@/shared/ui-kit/modal';
import { FileUpload } from '@/shared/ui-kit/file-upload';
import { cacheAthletes, queueOfflineOperation, readCachedAthletes, removeCachedAthletes } from '@/shared/offline/athlete-sync';

export function AthletesScreen() {
  const t = useTranslations('athlete');
  const tc = useTranslations('common');
  const ts = useTranslations('status');
  const tt = useTranslations();
  const errorText = useErrorText();
  const toast = useToast();
  const router = useRouter();
  const fmt = useFormatters();
  const { can } = useSession();
  const [filters, setFilters] = useState<{ status?: string; sportId?: string; gender?: string }>({});
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [deleting, setDeleting] = useState<AthleteDto | null>(null);
  const [restoring, setRestoring] = useState<AthleteDto | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [offlineRows, setOfflineRows] = useState<AthleteDto[]>([]);
  const [isOffline, setIsOffline] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const list = useList<AthleteDto>('/athletes', { sort: '-createdAt' });
  const sports = useApi<SportDto[]>('/sports', { params: { pageSize: 100 } });
  const rows = isOffline ? offlineRows : list.data ?? [];

  useEffect(() => {
    const update = () => setIsOffline(!navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  useEffect(() => { if (list.data?.length) void cacheAthletes(list.data); }, [list.data]);
  useEffect(() => { if (isOffline) void readCachedAthletes().then(setOfflineRows).catch(() => undefined); }, [isOffline]);

  const applyFilters = (next: typeof filters, deleted: boolean) => {
    setFilters(next);
    list.setFilters({ status: next.status || undefined, sportId: next.sportId || undefined, gender: next.gender || undefined, includeDeleted: deleted ? 'true' : undefined });
  };
  const doDelete = async () => {
    if (!deleting) return;
    try {
      if (isOffline) {
        await queueOfflineOperation({ path: `/athletes/${deleting.id}`, method: 'DELETE', body: { version: deleting.version } });
        await removeCachedAthletes([deleting.id]);
        setOfflineRows((previous) => previous.filter((row) => row.id !== deleting.id));
      } else await apiDelete(`/athletes/${deleting.id}`, { version: deleting.version });
      toast.success(`${t('titlePlural')} — ${tc('deleted')}`);
      list.reload();
    } catch (e) { toast.error(errorText(e)); }
    finally { setDeleting(null); }
  };
  const doBulkDelete = async () => {
    const items = rows.filter((row) => selectedIds.includes(row.id)).map((row) => ({ id: row.id, version: row.version }));
    if (!items.length) return;
    try {
      if (isOffline) {
        for (const item of items) await queueOfflineOperation({ path: `/athletes/${item.id}`, method: 'DELETE', body: { version: item.version } });
        await removeCachedAthletes(items.map((item) => item.id));
        setOfflineRows((previous) => previous.filter((row) => !selectedIds.includes(row.id)));
      } else await apiRequest('/athletes/bulk-delete', { method: 'DELETE', body: { items } });
      toast.success(`${tc('deleted')} (${items.length})`);
      setSelectedIds([]); list.reload();
    } catch (e) { toast.error(errorText(e)); }
  };
  const doRestore = async () => {
    if (!restoring) return;
    try { await apiPost(`/athletes/${restoring.id}/restore`, { version: restoring.version }); toast.success(tc('restore')); list.reload(); }
    catch (e) { toast.error(errorText(e)); }
    finally { setRestoring(null); }
  };
  const doExport = async () => {
    try { await downloadFile('/reports/athletes/export', { format: 'csv', ...filters }); }
    catch (e) { toast.error(errorText(e)); }
  };
  const doImport = async () => {
    if (!importFile) return;
    setImporting(true); setImportMessage(null);
    try {
      const form = new FormData(); form.set('file', importFile); form.set('entityType', 'athlete'); form.set('mode', 'skip_invalid');
      const uploaded = await apiUpload<{ id: string }>('/imports', form);
      const info = await apiGet<{ suggestedMapping: Record<string, number> }>(`/imports/${uploaded.data.id}/mapping`);
      await apiPost(`/imports/${uploaded.data.id}/mapping`, { mapping: info.data.suggestedMapping });
      const preview = await apiGet<{ validRows: number; invalidRows: number; duplicateRows: number }>(`/imports/${uploaded.data.id}/preview`, { limit: 1 });
      await apiPost(`/imports/${uploaded.data.id}/confirm`, { acknowledge: true });
      setImportMessage(`${preview.data.validRows} ${tc('imported')} — ${preview.data.invalidRows + preview.data.duplicateRows} ${tc('skipped')}`);
      list.reload();
    } catch (e) { setImportMessage(errorText(e)); }
    finally { setImporting(false); }
  };

  const columns: DataTableColumn<AthleteDto>[] = [
    { header: '', cell: (a) => <span onClick={(e) => e.stopPropagation()}><Checkbox label="" checked={selectedIds.includes(a.id)} onChange={(e) => setSelectedIds((ids) => e.target.checked ? [...ids, a.id] : ids.filter((id) => id !== a.id))} /></span>, showInCard: true },
    { key: 'registrationNo', header: t('registrationNo'), cell: (a) => <span className="ltr-field font-mono text-xs">{a.registrationNo}</span> },
    { key: 'firstName', header: tc('fullName'), cell: (a) => <span className="flex items-center gap-2">{a.photoUrl ? <img src={a.photoUrl} alt="" className="size-8 rounded-full object-cover" /> : <span className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">{a.firstName[0]}{a.lastName[0]}</span>}<span className="font-medium">{a.firstName} {a.lastName}</span>{a.deletedAt ? <StatusBadge value="INACTIVE" label={tc('deleted')} tone="muted" /> : null}</span>, showInCard: true },
    { key: 'birthDate', header: t('birthDate'), cell: (a) => fmt.date(a.birthDate), showInCard: false },
    { header: t('gender'), cell: (a) => a.gender === 'MALE' ? tc('male') : tc('female'), showInCard: false },
    { header: t('sport'), cell: (a) => a.sport?.name ?? '—' },
    { header: t('ageCategory'), cell: (a) => a.ageCategory?.name ?? '—', showInCard: false },
    { header: tc('phone'), cell: (a) => a.phone ? <span className="ltr-field">{a.phone}</span> : '—', showInCard: false },
    { key: 'status', header: tc('status'), cell: (a) => <StatusBadge value={a.status} /> },
    { header: tc('actions'), align: 'end', cell: (a) => <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()} role="presentation">{a.deletedAt ? (can('athletes.restore') ? <Button type="button" size="icon-sm" variant="ghost" aria-label={tc('restore')} onClick={() => setRestoring(a)}><RotateCcw className="size-4" aria-hidden /></Button> : null) : <>{can('athletes.edit') ? <Button type="button" size="sm" variant="ghost" onClick={() => router.push(`/athletes/${a.id}/edit`)}>{tc('edit')}</Button> : null}{can('athletes.delete') ? <Button type="button" size="icon-sm" variant="ghost" className="text-destructive" aria-label={tc('delete')} onClick={() => setDeleting(a)}><Trash2 className="size-4" aria-hidden /></Button> : null}</>}</div>, showInCard: true },
  ];
  return <div>
    <PageHeader title={t('titlePlural')} actions={<>{can('athletes.export') ? <Button type="button" variant="outline" onClick={() => void doExport()}><Download className="size-4" aria-hidden />{tc('export')}</Button> : null}{can('athletes.import') ? <Button type="button" variant="outline" onClick={() => setImportOpen(true)}><FileSpreadsheet className="size-4" aria-hidden />{tc('import')}</Button> : null}{can('athletes.create') ? <Button type="button" onClick={() => router.push('/athletes/new')}><Plus className="size-4" aria-hidden />{t('newAthlete')}</Button> : null}</>} />
    {selectedIds.length > 0 && can('athletes.delete') ? <div className="mb-3 flex items-center justify-between rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"><span className="flex items-center gap-2"><CheckSquare className="size-4" aria-hidden />{t('markedCount', { count: selectedIds.length })}</span><Button type="button" size="sm" variant="destructive" onClick={() => void doBulkDelete()}><Trash2 className="size-4" aria-hidden />{t('deleteSelected')}</Button></div> : null}
    {isOffline ? <div className="mb-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">{t('offlineMode')}</div> : null}
    <div className="mb-3 flex flex-wrap items-center gap-2"><div className="min-w-52 flex-1"><SearchInput value={list.list.q} onSearch={list.setQ} placeholder={`${t('titlePlural')}…`} /></div><div className="w-40"><Select aria-label={t('status')} value={filters.status ?? ''} placeholder={`${tc('all')} — ${t('status')}`} options={ATHLETE_STATUSES.map((s) => ({ value: s, label: ts(s) }))} onChange={(e) => applyFilters({ ...filters, status: e.target.value }, includeDeleted)} /></div><div className="w-40"><Select aria-label={t('sport')} value={filters.sportId ?? ''} placeholder={`${tc('all')} — ${t('sport')}`} options={(sports.data ?? []).map((s) => ({ value: s.id, label: s.name }))} onChange={(e) => applyFilters({ ...filters, sportId: e.target.value }, includeDeleted)} /></div><div className="w-36"><Select aria-label={t('gender')} value={filters.gender ?? ''} placeholder={`${tc('all')} — ${t('gender')}`} options={GENDERS.map((g) => ({ value: g.value, label: tt(g.labelKey) }))} onChange={(e) => applyFilters({ ...filters, gender: e.target.value }, includeDeleted)} /></div>{can('athletes.restore') ? <Checkbox label={tc('deleted')} checked={includeDeleted} onChange={(e) => { setIncludeDeleted(e.target.checked); applyFilters(filters, e.target.checked); }} /> : null}<Button type="button" size="sm" variant="outline" onClick={() => setSelectedIds(rows.length && selectedIds.length !== rows.length ? rows.map((r) => r.id) : [])}>{selectedIds.length === rows.length && rows.length ? tc('clear') : tc('selectAll')}</Button></div>
    <div className="card p-0"><DataTable columns={columns} rows={rows} getRowId={(a) => a.id} loading={list.loading && !isOffline} error={list.error && !isOffline ? errorText(list.error) : null} onRetry={list.reload} sort={list.list.sort} onSortChange={list.setSort} onRowClick={(a) => router.push(`/athletes/${a.id}`)} /><Pagination page={list.list.page} totalPages={isOffline ? 1 : list.totalPages} total={isOffline ? rows.length : list.total} pageSize={list.list.pageSize} onPageChange={list.setPage} onPageSizeChange={list.setPageSize} /></div>
    <ConfirmDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)} title={tc('delete')} message={t('deleteConfirm')} confirmLabel={tc('delete')} onConfirm={() => void doDelete()} />
    <ConfirmDialog open={restoring !== null} onOpenChange={(o) => !o && setRestoring(null)} title={tc('restore')} message={t('restoreConfirm')} tone="primary" confirmLabel={tc('restore')} onConfirm={() => void doRestore()} />
    <Modal open={importOpen} onOpenChange={setImportOpen} title={t('importTitle')} description={t('importHint')} size="lg" footer={<><Button type="button" variant="outline" onClick={() => setImportOpen(false)}>{tc('cancel')}</Button><Button type="button" onClick={() => void doImport()} disabled={!importFile || importing} loading={importing}><Upload className="size-4" aria-hidden />{tc('import')}</Button></>}><FileUpload file={importFile} onFileChange={setImportFile} accept=".xlsx,.csv" maxSizeMb={20} label={t('importFile')} uploading={importing} />{importMessage ? <p className="mt-3 rounded-md bg-muted p-3 text-sm">{importMessage}</p> : null}</Modal>
  </div>;
}
