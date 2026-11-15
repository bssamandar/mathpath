# MathPath: Product Requirements Document (PRD)

|          |                                                         |
| -------- | ------------------------------------------------------- |
| Status   | Draft for approval (Phase 2)                            |
| Version  | 0.1.0                                                   |
| Date     | 2026-11-15                                              |
| Owner    | Samandar                                                |
| Codename | MathPath (set in config; renaming is a one-line change) |

---

## 1. Summary

MathPath is a mobile-first web platform (PWA) that teaches mathematics for
grades 1–11 in Uzbekistan. It also continuously tests how well students have
mastered each topic and monitors their progress. It combines four tracks: the
school curriculum, international programmes, olympiad preparation and entrance-exam
preparation. They share one content model, one knowledge graph of topics and one
adaptive engine.

The **MVP** ships **Grade 5 (school curriculum)** and **Presidential and
specialised schools entrance-exam preparation**. The full role, security and
payment foundation is built into the MVP, so that adding the remaining grades and
tracks only means adding content, not re-architecting.

---

## 2. Problem and opportunity

- Students in Uzbekistan have uneven access to good maths tutoring. Private tutors
  are expensive and concentrated in Tashkent and regional centres.
- The textbooks have no built-in practice feedback, so a gap in an earlier topic
  (for example fractions) goes unnoticed until the student fails a later topic.
- Parents have little visibility into how their child is doing between school
  terms.
- There is strong demand for entrance preparation for Presidential, specialised
  and international schools, but existing material is mostly static PDFs and
  test banks.

**Our answer:** short lessons, interactive practice with instant feedback,
mastery checks, automatic routing back to missing prerequisite topics, and
weekly reports to parents. All of it works on a low-end Android phone on a slow
connection.

---

## 3. Goals and success metrics

| Goal                      | Metric (first 6 months after MVP launch)                               | Target                    |
| ------------------------- | ---------------------------------------------------------------------- | ------------------------- |
| Students learn            | Topic mastery-test pass rate on the first or second attempt            | ≥ 60%                     |
| Students learn            | Score gain from entry diagnostic to end-of-chapter test                | +20 percentage points     |
| Students come back        | Week-4 retention of activated students                                 | ≥ 30%                     |
| It works on slow networks | First lesson screen interactive on a 3G profile (1.6 Mbps, 300 ms RTT) | < 4 s                     |
| The business works        | Free to paid conversion                                                | ≥ 3%                      |
| Platform is trusted       | Security incidents involving personal data                             | 0                         |
| Platform is fair          | Accounts flagged as fake and confirmed by review                       | Tracked; < 2% of sign-ups |

Non-goals for the MVP: native mobile apps, live tutoring and video calls,
a public content marketplace, or AI chat tutoring.

---

## 4. Users and roles

| Role                                     | Primary needs                                                           | In MVP?                                            |
| ---------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------- |
| **Student** (age 6–18; MVP mostly 10–12) | Lessons, practice, tests, achievements; a simple, encouraging UI        | Yes                                                |
| **Parent**                               | Child's progress, weekly report, consent, payment management            | Yes                                                |
| **Content author / methodologist**       | Create lessons and questions without code; review and approval workflow | Yes                                                |
| **Administrator**                        | Users, payments, moderation, security, audit                            | Yes                                                |
| **Teacher / tutor**                      | Classes, assignments, class analytics                                   | Yes, but delivered last (Phase 6, dashboards step) |

**Account model.** A child under 16 cannot hold an account without a linked parent
account that has given verified consent (see §9). One parent account can manage
several children (needed for the family plan). Staff roles (author, admin) are
separate accounts with mandatory 2FA.

Why 16: it is a common threshold for parental consent in data-protection practice.
The exact age will be confirmed with a local lawyer and kept in config. The alternative
is to require parental consent for every user under 18, which is stricter and adds
friction for older students.

---

## 5. Content structure

```
Track → Course (grade or programme) → Chapter → Topic → Lesson steps
```

- **Topic** is the unit of mastery. Every topic belongs to one chapter and has:
  - **prerequisites:** edges in the knowledge graph (topic → topic), which
    may cross tracks and grades;
  - **mappings:** links to equivalent topics in other tracks (for example
    a grade 5 fraction topic ↔ Cambridge Lower Secondary Stage 7 fractions);
  - **a lesson**, made of up to five ordered steps.
- **Lesson steps:**
  1. Video, 5–8 minutes, with subtitles in the lesson language.
  2. Interactive activity.
  3. Practice set, ordered from easy to hard, with a hint and a full worked
     solution after each mistake.
  4. Mastery test (pass threshold 80%, configurable).
  5. Spaced-repetition review, scheduled automatically after mastery.
- Steps are **optional per topic** (for example an entrance-logic topic may have
  no video). This keeps the model flexible without special cases.
- **All content is versioned.** A student keeps the version they started with
  until they finish the topic, so an edit never changes a test halfway through.

### 5.1 Question types

| Type                          | MVP   | Notes                                                    |
| ----------------------------- | ----- | -------------------------------------------------------- |
| Single choice                 | ✅    |                                                          |
| Multiple choice               | ✅    | Partial credit is configurable                           |
| Numeric input                 | ✅    | Tolerance and accepted forms (for example 0.5 = 1/2)     |
| Formula input (math keyboard) | ✅    | Checked by symbolic equivalence, not string match        |
| Matching                      | ✅    |                                                          |
| Ordering                      | ✅    |                                                          |
| Graphing                      | Later | The number line is in the MVP as an interactive activity |
| Open response                 | Later | Needs teacher marking; comes with the teacher role       |

**Parameterised questions.** Every question is a template with variables,
constraints and an answer formula. For example:
`a ∈ [2..9], b ∈ [2..9], a ≠ b; answer = a·b`. Each student gets their own seeded
instance. **Answers are checked only on the server**, and the client never receives
the answer.

All maths is rendered with **KaTeX**. It is faster and lighter than MathJax,
which matters on low-end phones. The alternative, MathJax, supports more
LaTeX but is several times slower to render.

### 5.2 Interactive activities (MVP set)

Drag-and-drop, number line, fraction bars and area models, and step-by-step
solving. Geometric construction and function graphing come after the MVP; they
matter more from grade 7 onward.

---

## 6. Assessment and adaptivity

### 6.1 Entry diagnostic

- Free, 15–25 minutes, adaptive (each answer chooses the next question).
- Covers the MVP course plus the grade 3–4 prerequisites of its topics.
- Output: a mastery estimate per topic and a **personal learning path**, which
  is an ordered list of topics, skipping those already mastered.

### 6.2 Mastery model

- Each (student, topic) pair has a mastery state: _not started → learning →
  mastered → needs review_.
- A topic is **mastered** when the student scores ≥ 80% on its mastery test.
- The spaced-repetition review uses SM-2-style intervals (1, 3, 7, 16, 35 days,
  configurable). A failed review moves the topic back to _needs review_.
- Why SM-2: it is simple, well understood and easy for you to maintain. The
  alternative is FSRS, which is more accurate but harder to explain and tune.
  It can replace SM-2 later behind the same interface.

### 6.3 Gap routing (adaptive algorithm)

- When a student fails a mastery test, or makes repeated errors in practice, the
  engine checks the prerequisites of that topic in the knowledge graph.
- If a prerequisite is not mastered, or its mastery is out of date, the student
  is offered a short **prerequisite review** (a mini-diagnostic followed by that
  topic's practice). After that the student returns to the original topic.
- Limits keep this from becoming a loop: at most 2 levels deep, and at most one
  detour per session. Both are in config.
- Why rule-based first: the rules are transparent, can be debugged and need
  no training data. The alternative is a statistical model (Bayesian Knowledge
  Tracing or IRT), which only becomes worthwhile once we have real answer
  data. The engine is designed so that it can be swapped later.

### 6.4 Tests

| Test                                 | MVP                               |
| ------------------------------------ | --------------------------------- |
| Topic mastery test                   | ✅                                |
| Chapter test                         | ✅                                |
| Term and annual tests                | Later (same engine, more content) |
| Timed mock exam, entrance format     | ✅                                |
| Timed mock exam, SAT/GMAT/GRE format | Later (with those tracks)         |

### 6.5 Analytics

Student and parent views: mastery by topic (a heat map over the chapter tree),
time spent, weak areas, a streak and activity calendar, and a **predicted
entrance-exam score**. In the MVP, the prediction is a simple weighted mastery
estimate and is labelled _estimate_.

### 6.6 Certificates

When a student completes a course, a PDF certificate is issued with a
**QR code linking to a public verification page**. The page shows the
certificate ID, course, date and the student's first name and last initial
only, following the data-minimisation rule. The certificate is signed
server-side so it cannot be forged.

---

## 7. Monetisation

### 7.1 Free tier

- The first topic of every chapter, the entry diagnostic, and a daily limit of
  practice exercises (default 20, configurable).

### 7.2 Paid plans (all prices are in config, not code)

| Plan                                    | MVP                                     |
| --------------------------------------- | --------------------------------------- |
| Monthly / annual individual             | ✅                                      |
| Family (one parent, up to N children)   | ✅                                      |
| School licence (seats, invoice billing) | Later (needs the teacher role at scale) |

- Free trial (default 7 days), **one per device and one per payment card**.
- Promo codes ✅. Referral programme: a bonus only after the referred account
  is verified _and_ active for 7 days. The referral programme ships at the end
  of the MVP.
- Payments: **Payme and Click in the MVP**, behind one `PaymentProvider`
  interface. Uzum Bank, direct Uzcard/Humo, and Visa/Mastercard for
  international users come after the MVP.
- Required behaviour: auto-renewal (where the provider supports card tokens),
  self-service cancellation, admin-initiated refunds, fiscal receipts through
  the providers' fiscalisation features, **no card data on our servers**
  (provider tokens only), webhook signature verification, and idempotent
  payment operations.

---

## 8. Gamification

| Mechanic                              | MVP                          |
| ------------------------------------- | ---------------------------- |
| XP and levels                         | ✅                           |
| Daily streak (with a "streak freeze") | ✅                           |
| Badges                                | ✅                           |
| Daily quests                          | ✅                           |
| Weekly leagues and leaderboards       | ✅ (end of MVP)              |
| Avatars and virtual coins             | Later                        |
| Class vs class competitions           | Later (with teacher classes) |

Rules, enforced in code:

- **XP is earned only for real learning.** XP comes from a correct first-attempt
  answer, a passed mastery test or a passed review. There is no XP for watching a
  video or retrying an answer you already saw.
- **Leaderboards never show a full name.** They show a display nickname
  (moderated) or first name and last initial, plus the avatar.
- **No compulsion mechanics:** no loss-aversion pop-ups, no paid streak
  repair, and no notifications after 21:00 local time. There is an optional
  daily time limit set by the parent.
- **Gamification works from server results only**, so cheating the client gives
  nothing.

---

## 9. Security, privacy and abuse protection (requirements level)

The details come in Phase 4 (STRIDE threat model). These are the requirements the
MVP must meet:

**Authentication and access**

- Sign-up with phone + SMS OTP (one account per phone number). Parents and staff
  also set a password. Children can sign in through their parent's
  device or a parent-issued PIN.
- Passwords are hashed with Argon2id. Breached-password check (k-anonymity
  API). 2FA is mandatory for staff and optional for parents.
- Short-lived access tokens (≈ 15 minutes) with refresh-token rotation and reuse
  detection.
- RBAC is enforced server-side on every request; there is no client-side trust.

**Children's data and legal compliance**

- Compliance with the Law of the Republic of Uzbekistan "On Personal Data"
  (No. ZRU-547), including its requirement to **store citizens' personal data on
  servers located in Uzbekistan**. This must be confirmed by a local lawyer
  before launch.
- Data minimisation: for a child we store a first name, a nickname, the grade,
  the parent link and learning data. We do **not** store the child's phone,
  email, school address or photo in the MVP.
- Verified parental consent, recorded with a timestamp and the policy version.
- Self-service data export (JSON + PDF) and account deletion, with a grace period
  and then a hard delete; anonymised analytics are kept.

**Abuse protection (MVP)**

- OTP limits per phone, IP and device; blocking of suspicious prefixes;
  alerts on SMS spend.
- Invisible CAPTCHA that escalates with risk; disposable-email blocking;
  basic device fingerprint.
- Velocity rules and a simple risk score that leads to step-up verification
  or manual review.
- Login attempt limits; alerts on logins from a new device.
- Limits on concurrent sessions and devices per subscription.
- Anti-cheating: server-side checking, parameterised questions, and
  detection of abnormally fast or identical answer patterns.

**Platform security**

- OWASP Top 10 and ASVS Level 2 as the target. TLS 1.3, encryption at rest,
  a secret manager, CSP and secure headers, rate limiting, audit log, backups,
  and SAST, dependency scanning and DAST in CI. Penetration test before public
  launch.
- Video: encrypted HLS (AES-128) with signed expiring URLs and a dynamic
  user-ID watermark. Full DRM (Widevine/FairPlay) after the MVP.

---

## 10. Non-functional requirements

| Area            | Requirement                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Performance     | Lesson page JS ≤ 200 KB gzipped on first load; API p95 < 300 ms for read endpoints                                       |
| Slow networks   | Works on 3G; videos have adaptive bitrate down to 240p; the practice set can be completed offline and synced later (PWA) |
| Scale           | 100k registered users, ~5k concurrent at peak; stateless API scaled horizontally; Redis caching; background queue        |
| Availability    | 99.5% monthly in the MVP                                                                                                 |
| Localisation    | Uzbek (Latin), Russian, English. Every UI string goes through i18n. MVP content is in Uzbek and Russian                  |
| Accessibility   | WCAG 2.1 AA; large touch targets and audio prompts for young children                                                    |
| Quality         | Unit, integration and e2e tests; ≥ 80% coverage of backend business logic; e2e for key flows                             |
| Maintainability | Business rules in config; versioned migrations with rollback; linter and formatter; docstrings; ADRs                     |
| Hosting         | Docker-based and provider-agnostic; production in an Uzbek data centre                                                   |

---

## 11. MVP scope

### 11.1 Content

**Track 1: School curriculum, Grade 5.** The chapter list will follow the
current national grade 5 textbook. A methodologist must check it against the
edition in use. The provisional chapter list is:

1. Natural numbers and operations
2. Expressions, equations and word problems
3. Divisibility (factors, multiples, primes, GCD, LCM)
4. Common fractions
5. Decimal fractions
6. Percentages (introductory)
7. Geometry: lines, angles, triangles, perimeter, area, volume of a cuboid
8. Data: tables and simple charts

**Track 4: Entrance preparation, Presidential and specialised schools.**

- A course of topic blocks: arithmetic and number sense, word problems,
  logic and mathematical reasoning (patterns, sequences, sets, simple
  combinatorics, "true/false" logic puzzles), and spatial reasoning.
- Timed mock exams in the entrance format. The exact format (number of questions,
  time and structure) must be confirmed by a methodologist against the current
  admission rules, since these change from year to year.
- Mapped to grade 5 topics through the knowledge graph, so weak school topics
  are routed back to Track 1.

**Content volume in the MVP build:** I seed 2–3 complete demo topics so
that every feature is testable. Your content team fills the rest through the CMS.
Only the textbook **structure** (chapter and topic names) is used, never the
textbook text, to avoid copyright problems.

### 11.2 In scope / out of scope

| In MVP                                                                  | After MVP                                             |
| ----------------------------------------------------------------------- | ----------------------------------------------------- |
| Student, parent, author, admin, teacher (basic classes and assignments) | School licence, class vs class competitions           |
| Grade 5 + entrance-prep track                                           | Grades 1–4, 6–11; Cambridge, SAT, GMAT, GRE; olympiad |
| Uzbek and Russian content; trilingual UI                                | English content                                       |
| Six question types, four activity types                                 | Graphing, open response, geometric construction       |
| Diagnostic, mastery tests, chapter tests, entrance mock exams           | Term/annual tests, SAT/GMAT/GRE mocks                 |
| Payme, Click                                                            | Uzum Bank, direct Uzcard/Humo, Visa/Mastercard        |
| XP, levels, streaks, badges, quests, leagues                            | Avatars, coins, class competitions                    |
| Encrypted HLS, watermark                                                | Widevine/FairPlay DRM                                 |
| PWA                                                                     | Android and iOS apps                                  |
| Rule-based adaptivity, SM-2                                             | BKT/IRT, FSRS                                         |

### 11.3 Build order (Phase 6)

1. Repository, CI and documentation skeleton
2. Authentication and fake-account protection
3. Content (CMS + review workflow) and lesson player
4. Testing system (diagnostic, mastery, chapter, mock exams, adaptivity)
5. Payments (Payme, Click)
6. Gamification
7. Parent, teacher and admin dashboards

---

## 12. User stories (MVP acceptance level)

**Student**

- S1. As a student, I take a diagnostic test and get a learning path that skips
  what I already know.
- S2. As a student, I complete a lesson (video → activity → practice → mastery test)
  and see my mastery update.
- S3. As a student, when I make a mistake I get a hint, and after a second
  mistake I see a full solution.
- S4. As a student, when I fail a test because of an older gap, I'm offered a
  short review of the missing topic and then return.
- S5. As a student, I take a timed entrance mock exam and get a score and a
  breakdown by topic.
- S6. As a student, I earn XP and badges and keep a streak, and I see my league
  position under my nickname.

**Parent**

- P1. As a parent, I create my account with phone + OTP, add my child and give
  consent.
- P2. As a parent, I see my child's progress and receive a weekly report.
- P3. As a parent, I buy, renew, cancel or request a refund of a subscription
  with Payme or Click and receive a fiscal receipt.
- P4. As a parent, I export or delete my child's data.

**Author / methodologist**

- A1. As an author, I create a topic with lesson steps and parameterised questions
  using a visual editor with live LaTeX preview.
- A2. As an author, I submit content for review. A reviewer approves it or returns
  it with comments, and only approved versions are published.

**Teacher**

- T1. As a teacher, I create a class, invite students with a code, assign topics
  or tests with a due date, and see class results.

**Admin**

- AD1. As an admin, I search users, view the audit log, review accounts the risk
  engine flagged, issue refunds and manage promo codes.

---

## 13. Assumptions, risks and open items

| #   | Item                                                                   | Type                | Mitigation / owner                                                            |
| --- | ---------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------- |
| 1   | The Personal Data law and localisation rules apply as described        | Legal risk          | Lawyer review before launch                                                   |
| 2   | The entrance exam format changes each year                             | Content risk        | The format is in config; a methodologist checks it each season                |
| 3   | Payme and Click merchant accounts need a legal entity                  | Business dependency | Samandar to start onboarding early; sandbox keys are enough for development   |
| 4   | Content production (videos, questions) is the slowest part             | Delivery risk       | CMS first; demo topics seeded; content team runs in parallel with development |
| 5   | Grade 5 chapter list matches the current textbook                      | Assumption          | Methodologist check                                                           |
| 6   | Uzbek data-centre hosting supports managed Postgres and object storage | Infrastructure risk | Docker + S3-compatible storage keeps us provider-agnostic                     |
| 7   | SMS pumping costs                                                      | Financial risk      | Limits and spend alerts from day one                                          |

---

## 14. Decision log (Phase 1 and 2)

| Decision                    | Chosen                                                                                     | Alternative                         | Why                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| MVP prep track              | Presidential/specialised entrance prep                                                     | Cambridge Lower Secondary           | Same age group as grade 5, strong local demand, exercises the logic question types                                       |
| Content languages at launch | Uzbek + Russian (UI in all three)                                                          | All three at once                   | Halves the content effort while keeping English ready in i18n                                                            |
| Stack                       | TypeScript monorepo: Next.js PWA, NestJS, PostgreSQL, Redis, BullMQ, S3-compatible storage | Python (Django/FastAPI) backend     | One language for client and server; shared types for the API; large hiring pool. Full justification in an ADR in Phase 3 |
| Payments at launch          | Payme + Click                                                                              | All local providers at once         | Covers most local card payments; the provider interface makes adding others mechanical                                   |
| SMS                         | Eskiz.uz behind an interface                                                               | Playmobile and other local gateways | Popular local gateway with a simple API; swappable                                                                       |
| Video protection            | Encrypted HLS + signed URLs + watermark                                                    | Full DRM                            | DRM licences cost money and add complexity; this level stops casual piracy                                               |
| Adaptivity                  | Rule-based prerequisite routing + SM-2                                                     | BKT/IRT, FSRS                       | Transparent and maintainable with no training data; can be swapped later                                                 |
| Formula rendering           | KaTeX                                                                                      | MathJax                             | Much faster on low-end phones                                                                                            |
| Child accounts              | Linked to a consenting parent; no child phone or email                                     | Independent child accounts          | Data minimisation and parental consent requirements                                                                      |
| Design docs                 | Markdown, moving into the repo's `docs/`                                                   | Google Docs / Claude Docs           | Versioned together with the code                                                                                         |

---

## 15. Approval

Approve this PRD (or list changes) to start **Phase 3: system architecture,
database schema and API contract**.
