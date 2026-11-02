# Forms (5.12.36): release steps

Forms in Back Office (Customers, Forms), the Form block in the website builder, the embed code for
any website, and the "Form submitted" automation that sends a promo code. Nothing here charges
money. Customer facing: until step 1 runs, a Form block paints nothing and the embed page says
"This form is not available"; nothing else changes.

## 1. SQL (Ops project, tbetcegmszzotrwdtqhi)

Paste `supabase/migrations/20261111a_OPS_marketing_forms.sql` into the Ops SQL editor and run it.
It is additive and safe to run twice. It adds:

- `marketing_forms` and `marketing_form_submissions` (submissions: FORCE row level security, a Back
  Office login reads its own company, nobody but the service role writes)
- `marketing_form_public(form id, venue ids)` for the public pages (anon may call it)
- `promo_codes.form_id`, `promo_codes.workflow_id` (which form and automation sent a code)
- `workflow_enrollments.round` (a second code when the offer allows more than one each)

It ends with a self check and raises an error if anything is missing. Undo:
`20261111a_OPS_marketing_forms_ROLLBACK.sql` (drops every form and submission).

## 2. Functions (Ops project), in this order

One Terminal paste. Each deploy asks a Yes or No question that defaults to No: press the left
arrow, then Enter, to answer Yes.

```
cd ~/servos-worktrees/wt-forms && source ~/.zshrc && npx supabase functions deploy marketing-run --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt && npx supabase functions deploy marketing-workflows --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt && npx supabase functions deploy website-admin --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt && npx supabase functions deploy marketing-forms --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt && npx supabase functions deploy form-submit --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt
```

| Function | Why |
|---|---|
| marketing-run | shares the workflow engine (rounds, code attribution, no code without a channel) |
| marketing-workflows | the "Form submitted" trigger, the company check on save |
| website-admin | accepts the new Form block when a page is saved |
| marketing-forms | new: Back Office forms and submissions |
| form-submit | new: the public submit path (public, no login: `--no-verify-jwt` is required) |

No new secret is needed. Optional: `FORM_IP_SALT` (the ip hash salt; without it one is derived
from the service key) and `FORMS_APP_ORIGIN` (default `https://app.serv-os.app`). form-submit
reads `PLATFORM_SUPABASE_URL` and `PLATFORM_SUPABASE_SERVICE_ROLE_KEY`, already set for
wifi-capture.

## 3. Merge the PR

Vercel ships the Back Office screens, `api/form.js` (the hosted form and the embed loader) and the
website changes in `api/site.js`. Nothing to deploy by hand.

## 4. Proof on Provo

1. Back Office, Customers, Forms: New form, a name, Email required, Create. It shows `0 sent`.
2. Customers, Automations: New automation, trigger Form submitted, pick the form, remove the
   empty step, + Send a promo code, pick an offer, Create, Activate.
3. Forms, Embed: Open the form page. Fill it in with a test email, tick the box, send. The thank
   you words show. Customers shows the person; Submissions shows the row with Marketing tick Yes.
4. Marketing report, Codes: a code for that person. Marketing messages: one email (sandbox until
   the email provider is live), the code in the subject.
5. Online ordering for Provo: type the code at checkout. It applies.
6. Website builder: drop the Form block on a page, pick the form, Publish. Open the page with
   JavaScript off (or curl it): the HTML holds `<form ... method="post" action=".../form-submit"`.
7. Paste the embed code into any plain HTML page: the form shows in the Provo colours and sends.
