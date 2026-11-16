'use client';

import type Hls from 'hls.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import {
  orderSubtitles,
  type Playback,
  playbackExpired,
  qualityLabel,
  SPEEDS,
  watermarkPosition,
} from '../lib/lesson';
import { useI18n } from './i18n-provider';
import { Button } from './ui';

/**
 * Lesson video (UX S5, architecture §7.3). Plays the encrypted HLS stream with
 * hls.js, or natively where MediaSource is missing (iOS Safari). Shows the
 * viewer's watermark over the picture, offers speed, quality and subtitles,
 * and asks for a fresh playback token when the old one has run out.
 */
export function VideoPlayer({ mediaId, onEnded }: { mediaId: string; onEnded(): void }) {
  const { t, locale } = useI18n();
  const video = useRef<HTMLVideoElement>(null);
  const hls = useRef<Hls | null>(null);
  const [playback, setPlayback] = useState<Playback | null>(null);
  const [levels, setLevels] = useState<{ index: number; label: string }[]>([]);
  const [level, setLevel] = useState(-1);
  const [speed, setSpeed] = useState(1);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);

  const start = useCallback(
    async (resumeAt = 0) => {
      setFailed(false);
      const element = video.current;
      if (!element) return;
      try {
        const next = await api<Playback>(`/media/${mediaId}/playback`);
        setPlayback(next);
        hls.current?.destroy();
        hls.current = null;
        const { default: HlsClass } = await import('hls.js');
        if (HlsClass.isSupported()) {
          const player = new HlsClass({ enableWorker: true, lowLatencyMode: false });
          hls.current = player;
          player.on(HlsClass.Events.MANIFEST_PARSED, (_event, data) => {
            setLevels(
              data.levels
                .map((l, index) => ({
                  index,
                  label: l.height ? qualityLabel(l) : t('lesson.audioOnly'),
                }))
                .reverse(),
            );
            if (resumeAt) element.currentTime = resumeAt;
          });
          player.on(HlsClass.Events.ERROR, (_event, data) => {
            if (!data.fatal) return;
            if (data.type === HlsClass.ErrorTypes.MEDIA_ERROR) player.recoverMediaError();
            else setFailed(true);
          });
          player.loadSource(next.manifestUrl);
          player.attachMedia(element);
        } else if (element.canPlayType('application/vnd.apple.mpegurl')) {
          element.src = next.manifestUrl;
          if (resumeAt) element.currentTime = resumeAt;
        } else {
          setFailed(true);
        }
      } catch {
        setFailed(true);
      }
    },
    [mediaId, t],
  );

  useEffect(() => {
    void start();
    return () => {
      hls.current?.destroy();
      hls.current = null;
    };
  }, [start]);

  // The watermark moves every 7 seconds.
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 7000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (video.current) video.current.playbackRate = speed;
  }, [speed]);

  /** After a long pause the token may be gone; start again from the same second. */
  const retry = () => void start(video.current?.currentTime ?? 0);
  const onPlay = () => {
    if (playback && playbackExpired(playback) && !hls.current) retry();
  };

  const position = playback ? watermarkPosition(playback.watermark, tick) : null;
  return (
    <div className="video">
      <div className="video-frame">
        <video
          ref={video}
          controls
          playsInline
          crossOrigin="anonymous"
          controlsList="nodownload"
          onContextMenu={(e) => e.preventDefault()}
          onEnded={onEnded}
          onPlay={onPlay}
          onError={() => setFailed(true)}
        >
          {playback &&
            orderSubtitles(playback.subtitles, locale).map((track, i) => (
              <track
                key={track.locale}
                kind="subtitles"
                src={track.url}
                srcLang={track.locale}
                label={track.locale}
                default={i === 0 && track.locale === locale}
              />
            ))}
        </video>
        {position && (
          <span
            className="watermark"
            aria-hidden
            style={{ left: `${position.left}%`, top: `${position.top}%` }}
          >
            {playback?.watermark}
          </span>
        )}
      </div>
      {failed && (
        <div className="video-error" role="alert">
          <p>{t('lesson.videoError')}</p>
          <Button type="button" variant="secondary" onClick={retry}>
            {t('lesson.retry')}
          </Button>
        </div>
      )}
      <div className="video-controls">
        <label>
          {t('lesson.speed')}
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
        {levels.length > 1 && (
          <label>
            {t('lesson.quality')}
            <select
              value={level}
              onChange={(e) => {
                const next = Number(e.target.value);
                setLevel(next);
                if (hls.current) hls.current.currentLevel = next;
              }}
            >
              <option value={-1}>{t('lesson.auto')}</option>
              {levels.map((l) => (
                <option key={l.index} value={l.index}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </div>
  );
}
