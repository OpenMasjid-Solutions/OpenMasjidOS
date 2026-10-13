// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Content for a file-manager window: an inline image/video/audio viewer, or a
 * simple text editor (Save writes back, guarded server-side). Rendered inside
 * the window manager, so it has full access to trpc/i18n/toast.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../lib/trpc';
import { errorText } from '../lib/errors';
import { filesRawUrl, filesDownloadUrl, type FileKind } from '../lib/files';
import { useToast } from './ToastProvider';

export function FileViewer({ path, name, kind }: { path: string; name: string; kind: FileKind }) {
  if (kind === 'image') {
    return (
      <div className="media-view">
        <img src={filesRawUrl(path)} alt={name} />
      </div>
    );
  }
  if (kind === 'video') {
    return (
      <div className="media-view">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- user media, no captions available */}
        <video src={filesRawUrl(path)} controls />
      </div>
    );
  }
  if (kind === 'audio') {
    return (
      <div className="media-view">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- user media, no captions available */}
        <audio src={filesRawUrl(path)} controls />
      </div>
    );
  }
  return <TextEditor path={path} />;
}

function TextEditor({ path }: { path: string }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const read = trpc.files.read.useQuery({ path }, { retry: false });
  const [text, setText] = useState<string | null>(null);

  const write = trpc.files.write.useMutation({
    onSuccess: () => toast(t('files.saved'), 'success'),
    onError: (e) => toast(errorText(e, t('files.genericError')), 'error'),
  });

  useEffect(() => {
    if (read.data) setText(read.data.content);
  }, [read.data]);

  if (read.isLoading) return <p className="hint">{t('common.loading')}</p>;
  if (read.error) {
    return (
      <div>
        <p className="form-error">{errorText(read.error, t('files.genericError'))}</p>
        <a className="btn" href={filesDownloadUrl(path)}>{t('files.download')}</a>
      </div>
    );
  }

  return (
    <>
      <textarea
        className="textarea glass-inset"
        style={{ minHeight: '52vh', width: '100%' }}
        value={text ?? ''}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
      />
      <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end', marginTop: '0.8rem' }}>
        <a className="btn" href={filesDownloadUrl(path)}>{t('files.download')}</a>
        <button
          className="btn btn--primary"
          disabled={write.isPending || text === null}
          onClick={() => text !== null && write.mutate({ path, content: text })}
        >
          {write.isPending ? t('common.saving') : t('files.save')}
        </button>
      </div>
    </>
  );
}
