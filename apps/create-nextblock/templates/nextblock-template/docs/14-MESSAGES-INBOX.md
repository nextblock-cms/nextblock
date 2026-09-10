# 14 · Messages — the unified inbox

Everything a visitor sends the site arrives in one place: **CMS → Messages**
(`/cms/messages`). Four sources feed it, and the admin can reply to all of them from
there.

The inbox is one *view* over **two storage models**, because the sources are genuinely
different and flattening them would break something real.

| Source | Table | Visibility | What a reply is |
|---|---|---|---|
| Product enquiry | `message_threads` + `thread_messages` | private | a private message, delivered via a tokenised link |
| Contact form | `message_threads` + `thread_messages` | private | same |
| Product review | `cms_interactions` | already public | a **public** reply under the review |
| Post comment | `cms_interactions` | already public | a **public** reply under the comment |

`app/cms/messages/loadInbox.ts` performs the merge in the read path and normalises both
into an `InboxItem`. The detail pane branches on `item.kind`.

## Why not one table

`cms_interactions` cannot hold an enquiry, and the reasons are all enforced by the
schema rather than by convention:

- `user_id` is `NOT NULL` with a foreign key to `profiles` — every review and comment
  belongs to a registered account. Enquiry senders are anonymous.
- `check_product_or_post` requires *exactly one* of `product_id` / `post_id`. A contact
  form targets neither.
- Reviews and comments are readable by `anon` through an open `SELECT` policy once
  approved. Enquiries carry visitor PII and have **no anon grant or policy at all**.
- `update_product_ratings()` fires on every `cms_interactions` write.

That last point is the sharp edge. The trigger aggregates
`WHERE product_id = ? AND type='review' AND status='approved'`, so anything stored as an
approved review moves the product's star average. **A staff reply is therefore stored as
`type='comment'` with a NULL rating**, carrying the parent's target. That is not a
workaround for convenience — `check_rating_only_for_review` is an exhaustive `OR` over
`('review','comment')`, so a `review` row with a NULL rating is rejected outright, and
adding a third enum value would violate the same constraint *and* hit PostgreSQL's rule
that an enum value cannot be used in the transaction that added it (i.e. in one
migration file). `cms_interactions_reply_check` pins the invariant in the schema.

## The private lane

`message_threads` is the spine; `thread_messages` holds the turns. Message *content* is
append-only, enforced by a trigger that binds the service role too — only the delivery
flags may change after insert. A consequence worth knowing: because the foreign key
cascades and the trigger blocks `DELETE`, **a thread cannot be deleted**. "Delete" in
the CMS means `status='closed'` plus a revoked token.

### The visitor's token

The only opaque credential this codebase issues to an anonymous person.

- 32 bytes of `crypto.randomBytes`, prefixed `nbt_`. Guessing is infeasible by
  keyspace, which matters because the GET has no rate limit.
- Only `sha256` is stored, in `message_threads.token_hash` under a unique index. The
  plaintext exists long enough to go into one email and is never written down.
- **Minted on the first admin reply, never at submission.** A store with a hundred
  unanswered enquiries has zero live credentials.
- Rolling 90-day expiry, extended by each reply; revocable from the CMS.

`/thread/[token]` exchanges the token for an **HttpOnly cookie** and redirects to a
token-less `/thread`. This is the most important control in the feature: the app sends
`Referrer-Policy: strict-origin-when-cross-origin`, so a token left in the address bar
would travel in the `Referer` header of every same-origin navigation, and into history,
screenshots and proxy logs.

Every failure — expired, revoked, never existed — renders the *same* page. Distinguishing
them would make the route an oracle.

Reading the thread uses the service role **after** verifying the token in application
code. No RLS policy here authenticates an anonymous caller by token, and none was
invented; this matches how `/api/mcp` treats `mcp_access_tokens`.

## Contact forms and `form_key`

A form block used to store its destination in its own `content`. `FormBlockRenderer` is
a `"use client"` component that receives that content wholesale, so **the address was
serialized into the RSC payload of every page carrying a form** — published in the
markup.

Migration `00000000000027` moved every stored address into `form_endpoints` and left a
`form_key` behind: an opaque handle that grants nothing and is safe to serialize. The
migration walks three shapes, because a form nested in a section has no `blocks` row of
its own:

1. `blocks.content` where `block_type='form'`
2. `blocks.content` where `block_type='section'` (`column_blocks`, `slides`)
3. `content_drafts.blocks` / `product_drafts.blocks`

`form_endpoints.fields` is a **server-side snapshot** of the field manifest, so
notification emails and the inbox render labels the browser did not supply.

`BlockRenderer` and `SectionBlockRenderer` also strip `recipient_email` defensively
before handing content to the client — an import, a restored revision, or a fork that
has not migrated can still produce one.

## Delivery is best-effort; the row is the record

`sendEmail` **throws** when SMTP is unconfigured, and a store that has not finished one
piece of setup often has not finished the other. So every path writes first and notifies
afterwards, inside `after()`. A failed send sets `email_delivered = false` and records
`email_error`; the CMS shows "Not emailed" rather than pretending the owner was told.

The visitor is still shown success, because from their side it *was* one.

## Recipient resolution

Contact forms: per-form `form_endpoints.recipient_email` → `site_settings.forms_contact`
→ the seller-contact ladder (`lib/commerce/seller-contact.ts`: explicit store contact →
invoice email → privacy support email → oldest ADMIN's auth email). The sandbox
overrides everything.

**The address is never sent to the browser.** The form posts a `form_key`; the server
resolves the destination.

## The reply link and `NEXT_PUBLIC_URL`

`sendThreadNotice` refuses to send when the site URL was never configured, but happily
sends a local URL you chose deliberately.

`resolveSiteUrl()` falls back to `http://localhost:3000` when nothing is set, and a link
to that is dead for anyone not sitting at the machine. What must never happen is the code
*inventing* a localhost link because nothing was configured and mailing it to a customer.
A deliberate local URL is different: that is how you test the round trip, and it works.

So: honour an explicit choice, refuse an accidental default.

- Testing locally: set `NEXT_PUBLIC_URL=http://localhost:3000` (or your dev port). The
  link is sent and works on that machine; a warning is logged saying who can open it.
- Production: set it to the public site URL. Vercel's project URL is picked up
  automatically.
- Unset: the notice is refused and the reason is recorded on the message.

> An earlier version of this document blamed a `localhost` link for a quarantined
> message. That was wrong — a probe carrying exactly such a link was delivered normally.
> The real cause is below.

## Mail threading: two conversations, two roots

Outbound mail carries `In-Reply-To` and `References` pointing at a stable synthetic root,
because a `Re:` subject with no threading headers is itself a forged-reply heuristic, and
one consistent id per conversation groups the exchange in the recipient's client.

**The owner's notifications and the visitor's notices use DIFFERENT roots**, and that
separation is load-bearing:

- owner: `<nb-thread-{id}-admin@{from-domain}>`
- visitor: `<nb-thread-{id}-visitor@{from-domain}>`

They are two different exchanges with two different people. Sharing one root makes a mail
client fold them into a single conversation — and when an operator tests with their own
address as both the admin *and* the enquiring visitor (the obvious way to try the
feature), the reply is delivered, accepted, and then collapsed under the notification
they already read. It looks precisely like the email never arrived.

That symptom is a same-mailbox testing artifact, not a production fault: in real use the
customer and the shop owner are different mailboxes. But the shared root was a genuine
modelling error, and it is fixed.

## Where a form's mail goes

One rule, three rungs:

1. The form's own `form_endpoints.recipient_email`, if someone set one.
2. The site contact address from **CMS → Messages** (`site_settings.store_contact`).
3. The **first admin account's** own login address.

**A form has no address of its own by default**, and that is the intended state — since
the messaging system arrived, an operator does not need to think about per-form routing
at all. Submissions are stored as threads and answered in the CMS; the notification
address is one site-wide setting. A per-form address exists only to route one particular
form elsewhere — a careers form to HR, say.

Because rung 3 always resolves on a provisioned install, a fresh site reaches a real
human without configuring anything.

The sandbox overrides all of it: `resolveFormRecipient` returns `SANDBOX_CONTACT_EMAIL`
when `NEXT_PUBLIC_IS_SANDBOX` is set, so the hosted demo routes to the operator's inbox
without storing an address anywhere.

### Placeholder addresses count as unset

The starter content used to ship a contact form addressed to `contact@example.com`, and
migration 27 faithfully carried that into `form_endpoints`. Faithful was wrong:
`example.com` is reserved by RFC 2606 so it can never be registered, which makes the
address *guaranteed* undeliverable while looking like a real setting to every layer
downstream. The visitor is thanked, the relay accepts, nobody is notified, nothing errors.
An install ran that way without knowing.

Migration 29 clears those to NULL, so they fall through to the ladder above.
`lib/email/placeholder-address.ts` also treats the reserved domains (`example.com/.org/
.net/.edu` and the `.example`, `.invalid`, `.test`, `.localhost`, `.local` suffixes) as
unset at runtime, and `lib/cms/contact-reminder.ts` raises an ADMIN banner if one
reappears — via an import, a restored revision, or someone typing it.

The banner stays quiet when a form simply has no address, because that is now the correct
configuration rather than an omission.

## Subjects are per-conversation, and why that matters

|  | contact form | product enquiry |
|---|---|---|
| **owner** | `Nicolas sent you a message [NRH-VWQOLB]` | `Nicolas asked about Brass Kettle [NRH-EMISCX]` |
| **visitor** | `New Roots Herbal replied to your message [NRH-VWQOLB]` | `New Roots Herbal replied about Brass Kettle [NRH-EMISCX]` |

`threadReference(threadId, siteName)` folds the first 32 bits of the thread id into six
base36 characters and prefixes the site's initials — about 2.2 billion references, read as
a ticket number rather than a hex dump.

**There is no `Re:` anywhere.** The visitor's message was never an email, so a reply
prefix is both a spam heuristic and a small lie; naming the site is what actually tells
them who is writing. The `In-Reply-To` / `References` headers still group each
conversation properly.

The reference is not decoration. **Exchange derives its ConversationTopic from the
subject, not from References**, so separating the References headers — necessary, and
done — was not sufficient. With a constant subject, every enquiry a site ever receives
collapses into one Outlook conversation, and anything applied to that conversation applies
to all of them: a rule, a filter, or Ignore Conversation.

A real install hit exactly this. Replies were accepted by the relay, accepted by Microsoft
with `250 Queued mail for delivery`, and routed straight to Deleted Items, because a
"Contact form" conversation had been ignored at some point. Nothing anywhere reported a
fault. It was isolated by sending two messages with byte-identical bodies and different
subjects: the unique subject arrived, `Re: Contact form` did not. When mail "doesn't
arrive", that A/B is the first thing to run — not a theory.

## Deliverability: accepted is not delivered

A reply can be accepted by the relay, accepted by the recipient's server with
`250 Queued mail for delivery`, appear in the inbox — and then be **removed from the
mailbox minutes later**. Microsoft calls this ZAP (Zero-hour Auto Purge): threat intel
updates after delivery and the message is retracted. There is no bounce and no SMTP
error, so `email_delivered = true` is accurate and every log upstream reports success.

**This is largely outside the application's control.** A strict corporate tenant can
purge a transactional message on its overall shape — a reply-styled body carrying a
quoted excerpt and a link to an opaque tokenised URL — and no rendering tested reliably
survived one such tenant. An intermediate result suggesting that showing the destination
URL was the deciding factor did not hold up against the real notice.

What the application does do:

**1. No secrecy language.** The message used to end "This link is personal to you —
please don't forward it." A secret one-off link, a prominent button, and an instruction
not to share it is a near-literal phishing template. The link's security comes from the
token rotating on every reply, not from asking the recipient to keep a secret.

**2. The destination is visible.** The call-to-action is a button, with the URL also
printed as plain text beneath it. Good practice regardless, and it survives clients that
strip styling.

**3. There is a manual channel.** `createVisitorLink` mints a link and hands it to the
admin without sending anything ("Copy visitor link" in the thread pane). When a
recipient's filtering removes the mail, the conversation is still intact and the link is
still obtainable — send it by whatever works.

### Diagnosing it

Send messages with **byte-identical bodies** differing in exactly one variable, and check
the recipient's Deleted Items as well as the inbox. Reasoning from correlation produced
five wrong answers here — a `localhost` link, spam filtering in general, a shared thread
root, the subject line, and the secrecy phrase — each of which fitted the evidence and
was killed by the next test.

The send path logs what actually went out:

```
[messages] Reply on thread <id> handed to SMTP — to="…" replyTo="…" subject="…" link=tokenised
```

Start there. **Accepted by SMTP is not arrived, and arrived is not still there.** When a
tenant is purging on shape, testing against a different provider (a personal Gmail, say)
separates "the app is broken" from "this mailbox rejects this class of mail".

## Rate limiting

There is no shared rate limiter in this repo. Both public write paths throttle by
counting recent rows for a masked IP, and both **fail closed**: an absent or unparseable
`X-Forwarded-For` buckets under the literal `'unknown'` rather than skipping the check.
Trusted platform headers (`x-vercel-forwarded-for`, `x-real-ip`) are preferred over
`x-forwarded-for`, whose leftmost entry the client can write.

## Files

- `libs/db/src/supabase/migrations/02001_baseline_schema.sql` (originally `00000000000027_message_threads`, folded in by the generation-2 squash) — private lane, `form_endpoints`, the form-block data migration
- `libs/db/src/supabase/migrations/02001_baseline_schema.sql` (originally `00000000000028_interaction_replies`, folded in by the generation-2 squash) — `parent_id`, the reply CHECK, and the indexes `cms_interactions` never had
- `apps/nextblock/lib/messages/thread-token.ts` (+ `.test.ts`) — mint, parse, verify
- `apps/nextblock/lib/messages/threads.ts` — thread creation, recipient resolution, both notification emails
- `apps/nextblock/app/thread/**` — the visitor's page and the token-exchange route
- `apps/nextblock/app/actions/threadActions.ts` — visitor replies
- `apps/nextblock/app/cms/messages/**` — the inbox, its loader and its admin actions
- `apps/nextblock/app/actions/interactions.ts` — `replyToInteraction`, the public lane
- `apps/nextblock/components/StaffReplies.tsx` — nested public replies on the storefront

`/cms/inquiries` and `/cms/interactions` are now redirects into the inbox; both were
linked from notification emails and bookmarks, so neither was deleted.

## Known gaps

- Interactions have **no per-user read marker** anywhere in the schema, so the nav badge
  counts "pending moderation". Two admins working the queue see the same number.
- Public replies do not email the review/comment author. They have a reachable address,
  but that would be the first time the platform emails a registered user about content
  activity, with no preference to opt out of.
- Visitors get no acknowledgement email at submission time — that would require minting
  a token immediately, which is exactly the live-credential surface this design avoids.
