/**
 * File explorer: browse the data directory (sandboxed server-side), with new
 * folder, upload, download, rename, and delete. Glass-styled, RTL-safe.
 */
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Folder,
  File as FileIcon,
  FolderPlus,
  Upload,
  Download,
  Pencil,
  Trash2,
  ChevronRight,
  Home,
  Check,
  X,
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import { filesDownloadUrl, uploadFile, joinPath } from '../lib/files';
import { formatBytes } from '../lib/format';
import { Page } from '../components/Page';
import { Modal } from '../components/Modal';
import { useToast } from '../components/ToastProvider';

export function Files() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();

  const [path, setPath] = useState('/');
  const [busy, setBusy] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const list = trpc.files.list.useQuery({ path });
  const refresh = () => utils.files.list.invalidate();

  const mkdir = trpc.files.mkdir.useMutation({
    onSuccess: () => { setNewFolderOpen(false); setNewFolderName(''); refresh(); },
    onError: (e) => toast(e.message || t('files.genericError'), 'error'),
  });
  const rename = trpc.files.rename.useMutation({
    onSuccess: () => { setRenaming(null); refresh(); },
    onError: (e) => toast(e.message || t('files.genericError'), 'error'),
  });
  const remove = trpc.files.remove.useMutation({
    onSuccess: () => { setConfirmDelete(null); refresh(); },
    onError: (e) => toast(e.message || t('files.genericError'), 'error'),
  });

  async function onUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      for (const f of Array.from(files)) await uploadFile(path, f);
      refresh();
    } catch (e) {
      toast((e as Error).message || t('files.uploadError'), 'error');
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  const segments = path === '/' ? [] : path.replace(/^\//, '').split('/');
  const crumbPath = (i: number) => '/' + segments.slice(0, i + 1).join('/');

  return (
    <Page>
      <header className="page-head">
        <h1 className="page-title">{t('files.title')}</h1>
        <p className="page-sub">{t('files.subtitle')}</p>
      </header>

      {/* Breadcrumbs */}
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <button className="crumb" onClick={() => setPath('/')} aria-label={t('files.home')}>
          <Home size={15} />
        </button>
        {segments.map((seg, i) => (
          <span key={i} style={{ display: 'inline-flex', alignItems: 'center' }}>
            <ChevronRight size={14} className="crumb-sep" />
            <button className="crumb" onClick={() => setPath(crumbPath(i))}>{seg}</button>
          </span>
        ))}
      </nav>

      {/* Toolbar */}
      <div style={{ display: 'flex', gap: '0.5rem', margin: '0.5rem 0 1rem' }}>
        <button className="btn btn--sm" onClick={() => setNewFolderOpen(true)}>
          <FolderPlus size={15} /> {t('files.newFolder')}
        </button>
        <button className="btn btn--sm btn--primary" disabled={busy} onClick={() => fileInput.current?.click()}>
          <Upload size={15} /> {busy ? t('files.uploading') : t('files.upload')}
        </button>
        <input ref={fileInput} type="file" multiple className="visually-hidden" onChange={(e) => onUpload(e.target.files)} />
      </div>

      <div className="glass panel" style={{ padding: 0, overflow: 'hidden' }}>
        {list.isLoading ? (
          <div style={{ padding: '1rem' }}>
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="skeleton" style={{ height: 40, marginBottom: 8 }} />
            ))}
          </div>
        ) : list.error ? (
          <div className="empty-state"><p>{t('files.loadError')}</p></div>
        ) : (list.data?.entries.length ?? 0) === 0 ? (
          <div className="empty-state"><p>{t('files.empty')}</p></div>
        ) : (
          <ul className="file-list">
            {list.data!.entries.map((entry) => (
              <li key={entry.name} className="file-row">
                <button
                  className="file-main"
                  type="button"
                  onClick={() => entry.isDir && setPath(joinPath(path, entry.name))}
                  style={{ cursor: entry.isDir ? 'pointer' : 'default' }}
                >
                  <span className="file-icon">
                    {entry.isDir ? <Folder size={18} /> : <FileIcon size={18} />}
                  </span>
                  {renaming === entry.name ? (
                    <span style={{ display: 'inline-flex', gap: '0.3rem', alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
                      <input
                        className="input glass-inset"
                        style={{ padding: '0.2rem 0.4rem', width: '12rem' }}
                        value={renameValue}
                        autoFocus
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') rename.mutate({ path: joinPath(path, entry.name), name: renameValue }); }}
                      />
                      <button className="icon-btn" onClick={() => rename.mutate({ path: joinPath(path, entry.name), name: renameValue })}><Check size={15} /></button>
                      <button className="icon-btn" onClick={() => setRenaming(null)}><X size={15} /></button>
                    </span>
                  ) : (
                    <span className="file-name">{entry.name}</span>
                  )}
                </button>

                <span className="file-size">{entry.isDir ? '—' : formatBytes(entry.size)}</span>

                <span className="file-actions">
                  {!entry.isDir && (
                    <a className="icon-btn" href={filesDownloadUrl(joinPath(path, entry.name))} aria-label={t('files.download')}>
                      <Download size={16} />
                    </a>
                  )}
                  <button className="icon-btn" aria-label={t('files.rename')} onClick={() => { setRenaming(entry.name); setRenameValue(entry.name); }}>
                    <Pencil size={16} />
                  </button>
                  <button className="icon-btn" aria-label={t('files.delete')} style={{ color: 'var(--color-danger)' }} onClick={() => setConfirmDelete(entry.name)}>
                    <Trash2 size={16} />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Modal open={newFolderOpen} onClose={() => setNewFolderOpen(false)} title={t('files.newFolder')}>
        <input
          className="input glass-inset"
          placeholder={t('files.newFolderPrompt')}
          value={newFolderName}
          autoFocus
          onChange={(e) => setNewFolderName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && newFolderName.trim()) mkdir.mutate({ path, name: newFolderName.trim() }); }}
        />
        <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
          <button className="btn" onClick={() => setNewFolderOpen(false)}>{t('common.cancel')}</button>
          <button className="btn btn--primary" disabled={!newFolderName.trim() || mkdir.isPending} onClick={() => mkdir.mutate({ path, name: newFolderName.trim() })}>
            {t('files.newFolder')}
          </button>
        </div>
      </Modal>

      <Modal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} title={t('files.delete')}>
        <p>{t('files.deleteConfirm', { name: confirmDelete ?? '' })}</p>
        <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
          <button className="btn" onClick={() => setConfirmDelete(null)}>{t('common.cancel')}</button>
          <button className="btn btn--danger" disabled={remove.isPending} onClick={() => confirmDelete && remove.mutate({ path: joinPath(path, confirmDelete) })}>
            {t('files.delete')}
          </button>
        </div>
      </Modal>
    </Page>
  );
}
