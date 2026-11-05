# Secret-rotation drill (F5)

`AI_SHARED_SECRET` lives on two Workers: **shortstop-ai** (the consumer, which checks it) and **shortstop** (the producer, which sends it). A rotation has to change both without a moment when they disagree.

**Status: run live on 2026-11-05** against the deployed Workers (secrets were first set to a known value on both, so the drill could be repeated cleanly; the values are never printed or committed).

## 1. Wrong order (do this first, on purpose)
1. `wrangler secret put AI_SHARED_SECRET` on **shortstop-ai** only, with a new value.
2. Commit a lot or index a notice on the live app.
3. Expected: the AI Worker answers `403`, the main Worker's precedent call returns `null`, allocation still works, the board shows no precedent note. Check with `wrangler tail shortstop-ai` (403s) and `wrangler tail shortstop`.
4. Put the old value back on the AI Worker to recover.

Captured (new secret on shortstop-ai only, then a notice was ingested, twice):
- The lot was still allocated (`status ready`), but `precedent` was `null` both times.
- `wrangler tail shortstop-ai` showed the `/precedent` invocation as `canceled` after ~7.9 s with no response status: the main Worker's 8 s timeout fired. So the mismatch did not fail fast with a 403; it cost the ingest step its full precedent timeout.
- With the secrets matching again, the same call showed `ok`, status 200, in 1.6 s.

## 2. Right order (dual-key window)
1. **Consumer first:** `wrangler secret put AI_SHARED_SECRET_NEXT` on shortstop-ai with the new value. It now accepts old or new. Nothing breaks.
2. **Producer:** `wrangler secret put AI_SHARED_SECRET` on shortstop with the new value. Calls now use the new key and are accepted via `_NEXT`.
3. **Retire the old key:** put the new value into `AI_SHARED_SECRET` on shortstop-ai, then `wrangler secret delete AI_SHARED_SECRET_NEXT`.
4. Confirm a precedent note is produced and a request with the old value gets `403`.

Captured:
- Dual-key window (ai: old current + new in `_NEXT`; main sends new): tail showed `ok`, status 200, 997 ms.
- After retiring the old key (ai current = new, `_NEXT` deleted): `ok`, status 200, 729 ms.
- A precedent note was `null` in these runs because the model's answer was discarded as ungrounded (`discarded_ungrounded` in the AI Worker log), not because of the secret: the AI Worker answered 200 each time. The unit test "accepts either secret during a rotation window" covers the old-key-refused-after-retire case, since the AI Worker has no public URL to call by hand.

## Answer: what breaks in the wrong order?
Whichever side moves first locks the other out. Here the damage is small by design: the precedent call is advisory and returns `null`, so allocation never blocks, though each ingest waits out the 8 s timeout. For a secret that guards a write path, the same mistake would be an outage.
