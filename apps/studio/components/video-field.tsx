'use client';

import { useEffect, useRef, useState } from 'react';
import { errorMessage, formatDuration } from '../lib/editor';
import { t } from '../lib/i18n';
import { type MediaAsset, uploadMedia, waitUntilReady } from '../lib/upload';
import { Button, ErrorText } from './ui';

const SUBTITLE_LOCALES = [
  { code: 'uz-Latn', name: 'O‘zbekcha' },
  { code: 'ru', name: 'Русский' },
];

/**
 * A video step's media: upload with progress, then the transcoding status,
 * then subtitles per language. Calls `onChange` with the media ID as soon as
 * the upload is accepted, so the author can save while the worker runs.
 */
export function VideoField({
  mediaId,
  disabled,
  error,
  onChange,
}: {
  mediaId: string;
  disabled: boolean;
  error?: string;
  onChange(mediaId: string): void;
}) {
  const [asset, setAsset] = useState<MediaAsset | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [subtitles, setSubtitles] = useState<Record<string, string>>({});
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    if (mediaId) {
      void waitUntilReady(mediaId, (a) => alive.current && setAsset(a)).catch((e: unknown) =>
        setProblem(errorMessage(t, e)),
      );
    }
    return () => {
      alive.current = false;
    };
  }, [mediaId]);

  const upload = async (file: File) => {
    setProblem(null);
    setProgress(0);
    try {
      const uploaded = await uploadMedia({ kind: 'video', file }, setProgress);
      setAsset(uploaded);
      onChange(uploaded.id);
    } catch (e) {
      setProblem(errorMessage(t, e));
    } finally {
      setProgress(null);
    }
  };

  const uploadSubtitle = async (locale: string, file: File) => {
    try {
      // Browsers often give .vtt files no type; the bytes are what matter.
      const vtt = new Blob([file], { type: 'text/vtt' });
      await uploadMedia({ kind: 'subtitle', file: vtt, locale, videoId: mediaId }, () => undefined);
      setSubtitles((s) => ({ ...s, [locale]: file.name }));
    } catch (e) {
      setProblem(errorMessage(t, e));
    }
  };

  return (
    <div className="video-field">
      {progress !== null && (
        <p>
          {t('video.uploading', { percent: Math.round(progress * 100) })}{' '}
          <progress max={1} value={progress} />
        </p>
      )}
      {!mediaId && progress === null && <p className="hint">{t('video.noVideo')}</p>}
      {asset && (asset.status === 'uploaded' || asset.status === 'processing') && (
        <p role="status">{t('video.processing')}</p>
      )}
      {asset?.status === 'ready' && (
        <p role="status" className="ok">
          {t('video.ready', {
            duration: formatDuration(asset.durationS ?? 0),
            renditions: asset.renditions.map((r) => r.name).join(', '),
          })}
        </p>
      )}
      {asset?.status === 'failed' && (
        <p className="field-error">{t('video.failed', { reason: asset.error ?? '' })}</p>
      )}
      {!disabled && (
        <>
          <input
            ref={input}
            type="file"
            accept="video/mp4"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void upload(file);
            }}
          />
          <Button
            variant="secondary"
            busy={progress !== null}
            onClick={() => input.current?.click()}
          >
            {mediaId ? t('video.replace') : t('video.choose')}
          </Button>
        </>
      )}
      {mediaId && asset?.status === 'ready' && !disabled && (
        <fieldset className="subtitles">
          <legend>{t('video.subtitles')}</legend>
          {SUBTITLE_LOCALES.map(({ code, name }) => (
            <label key={code} className="file-label">
              {subtitles[code]
                ? `${name}: ${subtitles[code]}`
                : t('video.addSubtitle', { locale: name })}
              <input
                type="file"
                accept=".vtt,text/vtt"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void uploadSubtitle(code, file);
                }}
              />
            </label>
          ))}
        </fieldset>
      )}
      <ErrorText message={problem ?? error ?? null} />
    </div>
  );
}
