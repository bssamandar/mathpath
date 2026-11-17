'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { useI18n } from '../../components/i18n-provider';
import { SignedIn } from '../../components/signed-in';
import { ErrorText, LinkButton } from '../../components/ui';
import { useLoad } from '../../components/use-load';
import { api } from '../../lib/api';
import { type FamilyChild, trend, type WeeklyReport } from '../../lib/report';

interface ChildCard {
  child: FamilyChild;
  report: WeeklyReport | null;
}

/**
 * Parent home (UX S10): one card per child with this week's minutes against
 * last week, topics mastered and one line that needs attention.
 */
export default function ParentHomePage() {
  const { t, locale } = useI18n();
  const load = useCallback(async () => {
    const family = await api<{ items: FamilyChild[]; familyCode: string }>('/children');
    // One report per child; a report that fails leaves its card with the name only.
    const cards = await Promise.all(
      family.items.map(async (child) => ({
        child,
        report: await api<WeeklyReport>(
          `/students/${child.id}/reports/weekly?locale=${encodeURIComponent(locale)}`,
        ).catch(() => null),
      })),
    );
    return { cards, familyCode: family.familyCode };
  }, [locale]);
  const { data, error } = useLoad(load);

  return (
    <SignedIn title={t('parent.children')}>
      <ErrorText message={error} />
      {data && data.cards.length === 0 && <p className="lead">{t('parent.noChildren')}</p>}
      {data && data.cards.length > 0 && (
        <ul className="cards child-cards">
          {data.cards.map((card) => (
            <li key={card.child.id}>
              <ChildSummary card={card} />
            </li>
          ))}
        </ul>
      )}
      {data && data.cards.length > 0 && (
        <p className="hint">{t('parent.familyCode', { code: data.familyCode })}</p>
      )}
      <div className="stack">
        <LinkButton href="/parent/children/new">{t('parent.addChild')}</LinkButton>
        <LinkButton href="/parent/plan" variant="secondary">
          {t('parent.plan')}
        </LinkButton>
      </div>
    </SignedIn>
  );
}

function ChildSummary({ card }: { card: ChildCard }) {
  const { t } = useI18n();
  const { child, report } = card;
  const concern = report?.concerns[0];
  return (
    <Link className="card child-card" href={`/parent/report/${child.id}`}>
      <span className="child-name">
        {child.firstName} <span className="hint">({child.nickname})</span>
      </span>
      {report ? (
        <>
          <span>
            {t('report.minutes', { n: report.minutesActive })}{' '}
            <span className={`trend ${trend(report)}`}>{t(`report.trend.${trend(report)}`)}</span>
          </span>
          <span>{t('report.masteredCount', { n: report.topicsMastered.length })}</span>
          {concern && (
            <span className="alert-line">
              {t(`report.concern.${concern.reason}`, { title: concern.title })}
            </span>
          )}
        </>
      ) : (
        <span className="hint">{t('report.unavailable')}</span>
      )}
      <span className="link-text">{t('report.open')} →</span>
    </Link>
  );
}
