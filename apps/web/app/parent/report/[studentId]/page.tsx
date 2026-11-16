'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, use, useCallback } from 'react';
import { useI18n } from '../../../../components/i18n-provider';
import { SignedIn } from '../../../../components/signed-in';
import { ErrorText } from '../../../../components/ui';
import { useLoad } from '../../../../components/use-load';
import { api } from '../../../../lib/api';
import { formatDate } from '../../../../lib/billing';
import {
  barHeights,
  type FamilyChild,
  nextWeek,
  previousWeek,
  rightShare,
  trend,
  type WeeklyReport,
} from '../../../../lib/report';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** The weekly report for one child (UX S11). `?week=YYYY-MM-DD` shows an earlier week. */
export default function ReportPage({ params }: { params: Promise<{ studentId: string }> }) {
  const { studentId } = use(params);
  return (
    <Suspense>
      <ReportView studentId={studentId} />
    </Suspense>
  );
}

function ReportView({ studentId }: { studentId: string }) {
  const { t, locale } = useI18n();
  const week = useSearchParams().get('week');
  const load = useCallback(async () => {
    const query = `locale=${encodeURIComponent(locale)}${week ? `&weekStart=${encodeURIComponent(week)}` : ''}`;
    const [report, family, current] = await Promise.all([
      api<WeeklyReport>(`/students/${studentId}/reports/weekly?${query}`),
      api<{ items: FamilyChild[] }>('/children'),
      // This week's Monday, to know when "next week" would be in the future.
      week
        ? api<WeeklyReport>(`/students/${studentId}/reports/weekly`).then((r) => r.weekStart)
        : Promise.resolve(null),
    ]);
    return {
      report,
      child: family.items.find((c) => c.id === studentId) ?? null,
      current: current ?? report.weekStart,
    };
  }, [locale, studentId, week]);
  const { data, error } = useLoad(load);
  const report = data?.report;
  const share = report ? rightShare(report) : null;
  const later = report && data ? nextWeek(report.weekStart, data.current) : null;

  return (
    <SignedIn title={t('report.title')}>
      <p>
        <Link href="/parent">← {t('report.back')}</Link>
      </p>
      <ErrorText message={error} />
      {report && data && (
        <>
          <section className="report-head">
            <h2>{data.child?.firstName ?? ''}</h2>
            <p className="hint">
              {formatDate(`${report.weekStart}T12:00:00Z`, locale)} –{' '}
              {formatDate(`${report.weekEnd}T12:00:00Z`, locale)}
            </p>
            <nav className="row week-nav" aria-label={t('report.weeks')}>
              <Link href={`/parent/report/${studentId}?week=${previousWeek(report.weekStart)}`}>
                ← {t('report.earlier')}
              </Link>
              {later && (
                <Link
                  href={`/parent/report/${studentId}${later === data.current ? '' : `?week=${later}`}`}
                >
                  {t('report.later')} →
                </Link>
              )}
            </nav>
          </section>

          <section className="report-section">
            <p className="lead">
              {report.minutesActive === 0
                ? t('report.summaryNone')
                : t('report.summary', {
                    minutes: report.minutesActive,
                    days: report.daysActive,
                  })}{' '}
              {t(`report.trendLong.${trend(report)}`, { before: report.minutesLastWeek })}
            </p>
            {share !== null && (
              <p>{t('report.questions', { n: report.questionsAnswered, share })}</p>
            )}
            {report.xpEarned > 0 && (
              <p>
                {t('report.xp', { n: report.xpEarned })}
                {report.streak > 1 && ` ${t('report.streak', { n: report.streak })}`}
              </p>
            )}
          </section>

          <section className="report-section">
            <h3>{t('report.timeTitle')}</h3>
            <div className="day-bars" aria-hidden="true">
              {barHeights(report.minutesByDay).map((height, i) => (
                <div key={i} className="day-bar">
                  <span className="bar-value">{report.minutesByDay[i] || ''}</span>
                  <span className="bar-fill" style={{ height: `${Math.max(height, 2)}%` }} />
                  <span className="bar-label">{t(`day.${DAYS[i]!}`)}</span>
                </div>
              ))}
            </div>
            <table className="visually-hidden">
              <caption>{t('report.timeTitle')}</caption>
              <tbody>
                {DAYS.map((day, i) => (
                  <tr key={day}>
                    <th scope="row">{t(`day.${day}`)}</th>
                    <td>{t('report.minutes', { n: report.minutesByDay[i] ?? 0 })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint">{t('report.timeNote')}</p>
          </section>

          <section className="report-section">
            <h3>{t('report.masteredTitle')}</h3>
            {report.topicsMastered.length === 0 ? (
              <p className="hint">{t('report.masteredNone')}</p>
            ) : (
              <ul className="plain-list">
                {report.topicsMastered.map((topic) => (
                  <li key={topic.topicId}>⭐ {topic.title}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="report-section">
            <h3>{t('report.attentionTitle')}</h3>
            {report.concerns.length === 0 ? (
              <p className="hint">{t('report.attentionNone')}</p>
            ) : (
              <ul className="plain-list concerns">
                {report.concerns.map((concern) => (
                  <li key={concern.topicId}>
                    <strong>
                      {t(`report.concern.${concern.reason}`, { title: concern.title })}
                    </strong>
                    <span className="hint">{t(`report.suggest.${concern.reason}`)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </SignedIn>
  );
}
