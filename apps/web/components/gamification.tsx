'use client';

import Link from 'next/link';
import {
  hasReward,
  nameKey,
  percentOf,
  type GamificationSummary,
  type Reward,
} from '../lib/gamification';
import { en } from '../lib/i18n/en';
import { useI18n } from './i18n-provider';

const KEYS = Object.keys(en);

/** The name of a badge or quest in the learner's language; the code itself if unknown. */
function useName() {
  const { t } = useI18n();
  return (kind: 'badge' | 'quest', code: string, values?: Record<string, number>) => {
    const key = nameKey(kind, code, KEYS);
    return key ? t(key, values) : code;
  };
}

/** "+10 XP", a new badge or a finished quest, under an answer or a result (UX S5, S6). */
export function RewardLine({ reward }: { reward: Reward | null | undefined }) {
  const { t } = useI18n();
  const name = useName();
  if (!hasReward(reward)) return null;
  return (
    <div className="reward" role="status">
      {reward.xp > 0 && <span className="xp-chip">{t('xp.earned', { n: reward.xp })}</span>}
      {reward.questsCompleted.map((quest) => (
        <span key={quest.code} className="reward-item">
          {t('quest.done', { name: name('quest', quest.code, { n: quest.target }) })}
        </span>
      ))}
      {reward.badges.map((code) => (
        <span key={code} className="reward-item">
          {t('badge.new', { name: name('badge', code) })}
        </span>
      ))}
    </div>
  );
}

/** Level, streak, today's quests and badges on the student home (UX S3). */
export function ProgressCard({ summary }: { summary: GamificationSummary }) {
  const { t } = useI18n();
  const name = useName();
  const { streak } = summary;
  return (
    <section className="progress-card" aria-label={t('xp.title')}>
      <div className="progress-row">
        <div>
          <p className="level">{t('xp.level', { n: summary.level })}</p>
          <p className="hint">{t('xp.total', { n: summary.xpTotal })}</p>
        </div>
        <div className={`streak ${streak.activeToday ? 'active' : ''}`}>
          <span className="streak-count" aria-hidden="true">
            🔥 {streak.current}
          </span>
          <span className="visually-hidden">{t('streak.days', { n: streak.current })}</span>
        </div>
      </div>
      <div
        className="bar"
        role="progressbar"
        aria-label={t('xp.toNext')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(summary.levelProgress * 100)}
      >
        <span style={{ width: `${Math.round(summary.levelProgress * 100)}%` }} />
      </div>
      <p className="hint">
        {streak.activeToday
          ? t('streak.today')
          : streak.current > 0
            ? t('streak.keep')
            : t('streak.start')}
        {streak.freezesLeft > 0 && ` ${t('streak.freezes', { n: streak.freezesLeft })}`}
      </p>

      <h3>{t('quests.title')}</h3>
      <ul className="quests">
        {summary.quests.map((quest) => (
          <li key={quest.code} className={quest.completed ? 'done' : ''}>
            <span>
              {quest.completed ? '✓ ' : ''}
              {name('quest', quest.code, { n: quest.target })}
            </span>
            <span className="hint">
              {quest.progress}/{quest.target}
            </span>
            <div className="bar small" aria-hidden="true">
              <span style={{ width: `${percentOf(quest.progress, quest.target)}%` }} />
            </div>
          </li>
        ))}
      </ul>

      {summary.badges.length > 0 && (
        <>
          <h3>{t('badges.title')}</h3>
          <ul className="badges">
            {summary.badges.map((badge) => (
              <li key={badge.code} className="badge">
                {name('badge', badge.code)}
              </li>
            ))}
          </ul>
        </>
      )}
      {summary.xpLeftToday === 0 && <p className="hint">{t('xp.capped')}</p>}
      <Link className="button secondary" href="/league">
        {t('league.open')}
      </Link>
    </section>
  );
}
