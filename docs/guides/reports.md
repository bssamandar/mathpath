# Weekly report SMS

On Sunday evening the worker texts parents a short summary of their children's
week with a link to the parent page (UX S11, PRD P2). The full report is in the
app; the SMS only brings the parent there.

## Who gets it

Set in `config/reports.yaml` (`weeklySms.audience`):

| Value            | Who                                                                        |
| ---------------- | -------------------------------------------------------------------------- |
| `subscribers`    | Parents with a paid subscription running now (a free trial does not count) |
| `active_parents` | Every parent                                                               |
| `off`            | Nobody                                                                     |

In every case the parent needs a verified phone and an active account, and
only children with consent in force who answered at least one question that
week are listed. A parent with no active child gets nothing. Samandar chose
`subscribers` on 2026-11-17.

## When

Sunday from `sendAt` (19:00) until `stopAt` (21:00), Tashkent time. The config
refuses a `stopAt` after 21:00. If the worker restarts inside the window it
carries on; outside the window it sends nothing, and whatever was left is not
sent late. `maxPerRun` caps one evening's messages; `concurrency` is how many
go out at once.

## Once per parent, no retries

Before each message the worker writes a row to `report_sms_log`
(`parent_id`, `week_start`) and skips parents who already have one, so a
restart or a second worker never sends twice. A failed send is recorded with
Eskiz's answer and is not retried that week, so an Eskiz outage cannot turn
into a burst of messages later.

```sql
SELECT status, count(*) FROM report_sms_log
WHERE week_start = date_trunc('week', now() AT TIME ZONE 'Asia/Tashkent')::date
GROUP BY status;
```

## Text and cost

The text is in the parent's language (Uzbek, Russian or English). The Uzbek
text uses a plain apostrophe (`o'`), not `o‘`, so it stays in the GSM-7
alphabet: 160 characters per SMS segment instead of 70. One child fits one
segment; with more children two are named and the rest counted. **Register the
three templates (`weeklyReport` in `packages/sms/src/messages.ts`) in the Eskiz
dashboard before launch**, or Eskiz will not deliver them.

These messages are not counted in the sign-in SMS budget (security plan C-20):
they go only to verified parents, once a week, with a cap. They have their own
metric, `mathpath_report_sms_total{outcome}`, and the **ReportSmsFailing** alert
fires when over a fifth of an evening's messages fail (usually Eskiz balance or
an unapproved template). The worker log (`weekly-report-sms`) has each failure
with the phone masked and a summary line per run.

## Network

The worker reaches Eskiz through its own outbound network (`worker-egress` in
`infra/docker-compose.prod.yml`); it does not join the proxy's network, and
nothing listens on it.
