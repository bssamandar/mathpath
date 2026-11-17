'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { useI18n } from '../../components/i18n-provider';
import { SignedIn } from '../../components/signed-in';
import { ErrorText } from '../../components/ui';
import { useLoad } from '../../components/use-load';
import { api } from '../../lib/api';
import { daysLeft, type LeagueView, zoneOf } from '../../lib/gamification';
import type { MessageKey } from '../../lib/i18n';
import { en } from '../../lib/i18n/en';

/** A tier's name ("Bronze", "Silver"…), or "Tier 6" past the named ones. */
function useTierName() {
  const { t } = useI18n();
  return (tier: number) => {
    const key = `league.tier${tier}`;
    return key in en ? t(key as MessageKey) : t('league.tierN', { n: tier });
  };
}

/**
 * The weekly league (UX S8): the learner's place highlighted, nicknames and
 * weekly XP, promotion and demotion zones in neutral colours. No pressure:
 * nothing here is sent as a notification.
 */
export default function LeaguePage() {
  const { t } = useI18n();
  const tierName = useTierName();
  const load = useCallback(() => api<LeagueView>('/leagues/current'), []);
  const { data, error } = useLoad(load);
  return (
    <SignedIn title={t('league.title')}>
      <p>
        <Link href="/student">← {t('league.back')}</Link>
      </p>
      <ErrorText message={error} />
      {data?.status === 'off' && <p className="lead">{t('league.off')}</p>}
      {data && data.status !== 'off' && (
        <>
          <section className="league-head">
            <h2>{t('league.tierTitle', { name: tierName(data.tier) })}</h2>
            <p className="hint">{t('league.daysLeft', { n: daysLeft(data.endsAt, new Date()) })}</p>
            {data.lastWeek && (
              <p>
                {t(`league.last.${data.lastWeek.outcome}`, {
                  rank: data.lastWeek.rank,
                  name: tierName(data.lastWeek.tier),
                })}
              </p>
            )}
          </section>
          {data.status === 'not_joined' && <p className="lead">{t('league.notJoined')}</p>}
          {data.status === 'active' && (
            <>
              <p className="hint">
                {data.zones.up > 0 && t('league.upHint', { n: data.zones.up })}{' '}
                {data.zones.down > 0 && t('league.downHint', { n: data.zones.down })}
              </p>
              <ol className="standings">
                {data.standings.map((row) => {
                  const zone = zoneOf(row.rank, data.standings.length, data.zones);
                  return (
                    <li
                      key={row.rank}
                      className={[row.isMe ? 'me' : '', zone ? `zone-${zone}` : '']
                        .filter(Boolean)
                        .join(' ')}
                      aria-current={row.isMe ? 'true' : undefined}
                    >
                      <span className="rank">{row.rank}</span>
                      <span className="avatar" aria-hidden="true">
                        {row.nickname.charAt(0).toUpperCase()}
                      </span>
                      <span className="name">
                        {row.nickname}
                        {row.isMe && <span className="hint"> ({t('league.you')})</span>}
                      </span>
                      <span className="xp">{t('league.xp', { n: row.weeklyXp })}</span>
                      {zone && (
                        <span className="visually-hidden">
                          {zone === 'up' ? t('league.zoneUp') : t('league.zoneDown')}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ol>
            </>
          )}
        </>
      )}
    </SignedIn>
  );
}
