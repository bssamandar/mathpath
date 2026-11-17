# Launch checklist

Everything that must be true before real families use MathPath. The code is
ready; what is left needs accounts, contracts, money or a decision that only
the owner can give. Work through it top to bottom: later sections depend on
earlier ones. Each item says where it goes and how to check it.

Nothing here belongs in Git: secrets go into `infra/.env.prod` on the server
(mode 600) or into GitHub repository settings.

## 1. Legal and business

- [ ] **Lawyer review** of the personal data law and the localisation rule
      (PRD §9 risk 1): the age of consent, the consent text, the privacy policy
      and the terms, and that hosting in Uzbekistan satisfies the law.
- [ ] **Legal entity and merchant contracts** with Payme and Click (PRD risk 3).
- [ ] **IKPU code** for the subscription registered at tasnif.soliq.uz.
- [ ] **Real prices** decided for every plan.

## 2. Business rules in the repository

Change these in a pull request; they are not secrets.

- [ ] `config/billing.yaml`: replace the placeholder `priceTiyin` of each plan
      (amounts in tiyin: 99 000 so‘m is `9900000`).
- [ ] `config/billing.yaml`: uncomment `fiscal` and fill in `ikpuCode`,
      `packageCode`, `vatPercent` and `title`. Until then no receipt items are
      sent to Payme and Click.
- [ ] `config/reports.yaml`: confirm the Sunday SMS audience (`subscribers`)
      and time (19:00–21:00).
- [ ] Demo content replaced or joined by real topics, written and published
      in the studio (two people: author and reviewer).

## 3. Server and domain

Steps are in [deploy.md](deploy.md), "Server preparation".

- [ ] A server in a data centre in Uzbekistan (start: 8 vCPU, 16 GB RAM,
      200 GB SSD, Ubuntu 24.04), hardened SSH, firewall 22/80/443.
- [ ] Docker Engine with Compose, and **cosign** (the deploy script refuses to
      run without it).
- [ ] A domain, with DNS records for `DOMAIN`, `www.DOMAIN`, `studio.DOMAIN`
      and `media.DOMAIN` pointing at the server **before** the first start.
- [ ] `infra/.env.prod` created from `env.prod.example`, mode 600, every empty
      value filled in: `DOMAIN`, `ACME_EMAIL`, the database passwords, the JWT
      key and `AUTH_HMAC_SECRET`, the S3 keys and `MEDIA_KEY_SECRET`.
- [ ] `MEDIA_KEY_SECRET` and `BACKUP_CIPHER_PASS` also stored in a password
      manager. Without them videos and backups cannot be read.

## 4. Backups

Steps are in [backups.md](backups.md).

- [ ] A bucket at a **second** S3-compatible provider in Uzbekistan, with
      versioning (and object lock if offered); `BACKUP_S3_*` and
      `BACKUP_CIPHER_PASS` in `.env.prod`.
- [ ] Backup timers installed, the first backup run by hand, and one restore
      drill completed.

## 5. GitHub

- [ ] Repository variable `TURNSTILE_SITE_KEY` (Settings → Secrets and
      variables → Actions → Variables); it is built into the web and studio.
- [ ] After the first release: each GHCR package made public, or
      `docker login ghcr.io` on the server with a `read:packages` token.
- [ ] The open CodeQL alerts dismissed as "won't fix / used by protocol": the
      two on PR 2, and the SHA-1/MD5 alerts in the Click adapter (Click's
      protocol requires those hashes; explained on each alert).
- [ ] The leftover branch `feature/refunds-weekly-sms` deleted.
- [ ] Branch protection on `main` and `develop` (required checks, no force
      push), if not already set.
- [ ] For load tests: a staging server, the `LOAD_TEST_PIN` secret and the
      `PRODUCTION_URL` variable ([testing.md](testing.md)).

## 6. SMS (Eskiz.uz) and CAPTCHA

- [ ] Eskiz account with balance; `ESKIZ_EMAIL`, `ESKIZ_PASSWORD` and the
      approved sender name in `ESKIZ_SENDER`.
- [ ] **Every SMS template approved in the Eskiz dashboard**, with the numbers
      and the link as variables. Eskiz does not deliver unapproved texts. The
      texts are in `packages/sms/src/messages.ts`: sign-in code, confirmation
      code, child PIN locked, already registered, account locked, and the
      weekly report in Uzbek, Russian and English (one-child and
      several-children forms).
- [ ] Cloudflare Turnstile site: `TURNSTILE_SECRET_KEY` in `.env.prod`, the
      site key as the repository variable above.
- [ ] `config/risk.yaml`: the hourly and daily SMS budget matches the Eskiz
      price and what you are willing to lose to abuse.

## 7. Payments

- [ ] Payme: `PAYME_MERCHANT_ID` and `PAYME_KEY`; in the Payme cabinet the
      endpoint is `https://DOMAIN/api/v1/payments/payme`. Pass Payme's sandbox
      test suite against it before asking for production keys.
- [ ] Click: `CLICK_SERVICE_ID`, `CLICK_MERCHANT_ID`, `CLICK_SECRET_KEY`; in the
      Click cabinet the Prepare URL is
      `https://DOMAIN/api/v1/payments/click/prepare` and the Complete URL
      `https://DOMAIN/api/v1/payments/click/complete`.
- [ ] `PAYMENT_PROVIDERS=payme,click` (empty keeps checkout closed).
- [ ] Click refunds: `CLICK_MERCHANT_USER_ID` from the Click cabinet. **Ask
      Click to confirm** that the Merchant API `payment_id` is the
      `click_trans_id` we store, and that reversal is
      `DELETE /v2/merchant/payment/reversal/{service_id}/{payment_id}`. This
      was built from Click's public documentation and has not been tried
      against the real service.
- [ ] Payme refunds: **confirm with one real payment** that cancelling a
      transaction in the Payme business cabinet makes Payme call
      `CancelTransaction`. The refund flow depends on it
      ([payments.md](payments.md)).
- [ ] One real payment and one refund through each provider on production,
      with a small-price test plan or your own card, then check the daily
      reconciliation reports nothing.

## 8. First deploy

- [ ] Tag a release (`deploy.md`, "Releasing") and run `infra/deploy.sh <tag>`.
- [ ] **First admin.** Sign up in the web app with your own phone, then grant
      the role once in the database (every later role is granted in the
      studio, with 2FA and an audit entry):
      `sh
  infra/compose.sh exec -u postgres postgres psql -d mathpath -c \
    "INSERT INTO user_roles (user_id, role) SELECT id, 'admin' FROM users WHERE phone_e164 = '+998XXXXXXXXX'"
  `
      Then sign in to `studio.DOMAIN` and enrol 2FA; keep the recovery codes
      offline.
- [ ] Monitoring stack started with its four secrets, the Telegram chat ID,
      SMTP settings and the real domain in the probes
      ([monitoring.md](monitoring.md)). Send a test alert and see it arrive.

## 9. Before opening to the public

- [ ] The whole journey by hand on a cheap Android phone on mobile data:
      sign up, add a child, a lesson with video, practice, mastery test,
      payment, weekly report.
- [ ] Load test at twice the expected peak against staging (C-36).
- [ ] An independent penetration test, with every high and critical finding
      fixed (C-46).
- [ ] TLS 1.2 is allowed at launch; review after three months.
- [ ] A support channel for parents and a named person who receives alerts.

## Known limits at launch

Deliberately left for after the MVP: teacher dashboards and classes, four-eyes
approval of large refunds, automatic comparison with provider statements, full
DRM for video, a CSP report endpoint, and an allow-list of provider callback
IPs at the proxy.
