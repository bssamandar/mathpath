'use client';

import { api } from '@mathpath/client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { StaffShell } from '../components/staff-shell';
import { Badge, ErrorText } from '../components/ui';
import { anyText, errorMessage, type LocalisedText, type VersionStatus } from '../lib/editor';
import { t } from '../lib/i18n';

interface TreeTopic {
  id: string;
  slug: string;
  isFree: boolean;
  publishedVersionId: string | null;
  title: LocalisedText;
  latest: { id: string; versionNo: number; status: VersionStatus } | null;
}

interface Tree {
  tracks: {
    id: string;
    title: LocalisedText;
    courses: {
      id: string;
      title: LocalisedText;
      grade: number | null;
      status: string;
      chapters: { id: string; title: LocalisedText; topics: TreeTopic[] }[];
    }[];
  }[];
}

/** Content tree (UX §3.4): track → course → chapter → topic, with each topic's newest version. */
export default function TreePage() {
  return <StaffShell>{() => <TreeView />}</StaffShell>;
}

function TreeView() {
  const [tree, setTree] = useState<Tree | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Tree>('/studio/tree')
      .then(setTree)
      .catch((e: unknown) => setError(errorMessage(t, e)));
  }, []);

  if (error) return <ErrorText message={error} />;
  if (!tree) return null;
  const courses = tree.tracks.flatMap((track) => track.courses);
  return (
    <>
      <h1>{t('tree.title')}</h1>
      {courses.length === 0 && <p>{t('tree.empty')}</p>}
      {tree.tracks.map((track) => (
        <section key={track.id} className="track">
          <h2>{anyText(track.title)}</h2>
          {track.courses.map((course) => (
            <div key={course.id} className="course">
              <h3>{anyText(course.title)}</h3>
              {course.chapters.map((chapter) => (
                <div key={chapter.id} className="chapter">
                  <h4>{anyText(chapter.title)}</h4>
                  <ul className="topics">
                    {chapter.topics.map((topic) => (
                      <li key={topic.id}>
                        <Link href={`/topics/${topic.id}`}>
                          {anyText(topic.title) || topic.slug || t('tree.untitled')}
                        </Link>
                        {topic.isFree && <Badge tone="neutral">{t('tree.free')}</Badge>}
                        {topic.latest ? (
                          <Badge tone={topic.latest.status}>
                            {t('editor.version', { n: topic.latest.versionNo })} ·{' '}
                            {t(`status.${topic.latest.status}`)}
                          </Badge>
                        ) : (
                          <Badge tone="neutral">{t('tree.noDraft')}</Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ))}
        </section>
      ))}
    </>
  );
}
