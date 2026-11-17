// Load test: students learning at the same time (security plan C-36,
// architecture §7.5; docs/guides/testing.md).
//
// Each virtual user is one student (load-0001, load-0002, … from
// prepare-students.sql). It signs in with the family code and PIN once, then
// repeats what a child does in a lesson: open the course list, a course, a
// lesson, start practice, read a question, answer it, and think for a few
// seconds. The free daily limit (402 DAILY_LIMIT) is expected and not an error.
//
//   k6 run -e BASE_URL=https://staging.example -e FAMILY_CODE=ABCD2345 \
//     -e PIN=2580 -e PROFILE=peak tests/load/student-journey.js
//
// Profiles: smoke (CI, 20 students for 1 minute) and peak (twice the 5k
// concurrent-user target over 30 minutes). Never run peak against production.
/* global __ENV */
import { check, fail, sleep } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';

const BASE = `${__ENV.BASE_URL || 'http://127.0.0.1:4000'}/api/v1`;
const FAMILY_CODE = __ENV.FAMILY_CODE || fail('FAMILY_CODE is required');
const PIN = __ENV.PIN || fail('PIN is required');
const PROFILE = __ENV.PROFILE || 'smoke';
// One student per virtual user, so no one passes the two-session limit.
const STUDENTS = Number(__ENV.STUDENTS || (PROFILE === 'peak' ? 10000 : 20));

const profiles = {
  smoke: {
    executor: 'constant-vus',
    vus: STUDENTS,
    duration: '1m',
  },
  peak: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '5m', target: STUDENTS / 2 },
      { duration: '5m', target: STUDENTS },
      { duration: '15m', target: STUDENTS },
      { duration: '5m', target: 0 },
    ],
    gracefulRampDown: '30s',
  },
};

export const options = {
  scenarios: { students: profiles[PROFILE] },
  thresholds: {
    // Failed requests and failed checks fail every profile.
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    // Speed is judged at peak on staging hardware only (architecture §7.5); a
    // shared CI runner hashing 20 PINs at once says nothing about production.
    ...(PROFILE === 'peak' && {
      'http_req_duration{kind:read}': ['p(95)<300'],
      'http_req_duration{kind:answer}': ['p(95)<500'],
      'http_req_duration{kind:login}': ['p(95)<1500'],
    }),
  },
};

// 402 is the free daily limit, a normal answer for a free student.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 402));

const json = { 'content-type': 'application/json' };
let session = null;

function signIn() {
  const nickname = `load-${String(exec.vu.idInTest).padStart(4, '0')}`;
  const res = http.post(
    `${BASE}/auth/child-login`,
    JSON.stringify({ familyCode: FAMILY_CODE, nickname, pin: PIN }),
    { headers: { ...json, 'x-client-type': 'mobile' }, tags: { kind: 'login', name: 'login' } },
  );
  if (!check(res, { 'signed in': (r) => r.status === 200 })) {
    sleep(5);
    return null;
  }
  const body = res.json();
  return {
    headers: { authorization: `Bearer ${body.accessToken}` },
    // Sign in again a minute before the 15-minute access token ends.
    renewAt: Date.parse(body.accessExpiresAt) - 60_000,
  };
}

function get(path, name) {
  return http.get(`${BASE}${path}`, { headers: session.headers, tags: { kind: 'read', name } });
}

function post(path, body, name, kind = 'read') {
  return http.post(`${BASE}${path}`, JSON.stringify(body), {
    headers: { ...session.headers, ...json },
    tags: { kind, name },
  });
}

export default function () {
  if (!session || Date.now() > session.renewAt) session = signIn();
  if (!session) return;

  const tracks = get('/tracks', 'tracks');
  if (!check(tracks, { 'tracks 200': (r) => r.status === 200 })) return;
  const course = tracks.json('items.0.courses.0.id');
  const courseRes = get(`/courses/${course}`, 'course');
  check(courseRes, { 'course 200': (r) => r.status === 200 });
  const topic = (courseRes.json('chapters.0.topics') || []).find((t) => !t.locked);
  if (!topic) fail('the seeded course has no open topic');
  check(get(`/topics/${topic.id}/lesson`, 'lesson'), { 'lesson 200': (r) => r.status === 200 });
  sleep(2 + Math.random() * 3);

  const attempt = post('/attempts', { type: 'practice', topicId: topic.id }, 'start practice');
  if (attempt.status === 402) {
    // The free daily limit is reached: the student only reads from here on.
    sleep(10);
    return;
  }
  if (!check(attempt, { 'practice started': (r) => r.status === 200 || r.status === 201 })) return;
  const { id, answeredCount, itemCount } = attempt.json();
  if (answeredCount >= itemCount) {
    // Every question is answered: finish the practice so the next one starts.
    check(post(`/attempts/${id}/submit`, {}, 'submit', 'answer'), {
      'practice submitted': (r) => r.status === 200 || r.status === 201,
    });
    return;
  }
  const position = answeredCount + 1;

  const item = get(`/attempts/${id}/items/${position}`, 'question');
  if (!check(item, { 'question 200': (r) => r.status === 200 })) return;
  sleep(3 + Math.random() * 5); // thinking
  const choices = item.json('choices');
  const response =
    Array.isArray(choices) && choices.length > 0
      ? { choiceIds: [choices[Math.floor(Math.random() * choices.length)].id] }
      : { value: String(1 + Math.floor(Math.random() * 9)) };
  const answer = post(`/attempts/${id}/items/${position}/answer`, { response }, 'answer', 'answer');
  check(answer, {
    'answer graded': (r) =>
      r.status === 402 || (r.status === 200 && r.json('accepted') !== undefined),
  });
  sleep(2 + Math.random() * 3);
}
