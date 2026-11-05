# Secret-rotation drill (F5)

`AI_SHARED_SECRET` lives on two Workers: **shortstop-ai** (the consumer, which checks it) and **shortstop** (the producer, which sends it). A rotation has to change both without a moment when they disagree.

**Status: procedure and code are ready; the live drill has not been run yet.** The output sections below are filled in when it is.

## 1. Wrong order (do this first, on purpose)
1. `wrangler secret put AI_SHARED_SECRET` on **shortstop-ai** only, with a new value.
2. Commit a lot or index a notice on the live app.
3. Expected: the AI Worker answers `403`, the main Worker's precedent call returns `null`, allocation still works, the board shows no precedent note. Check with `wrangler tail shortstop-ai` (403s) and `wrangler tail shortstop`.
4. Put the old value back on the AI Worker to recover.

Captured output: _(to fill in)_

## 2. Right order (dual-key window)
1. **Consumer first:** `wrangler secret put AI_SHARED_SECRET_NEXT` on shortstop-ai with the new value. It now accepts old or new. Nothing breaks.
2. **Producer:** `wrangler secret put AI_SHARED_SECRET` on shortstop with the new value. Calls now use the new key and are accepted via `_NEXT`.
3. **Retire the old key:** put the new value into `AI_SHARED_SECRET` on shortstop-ai, then `wrangler secret delete AI_SHARED_SECRET_NEXT`.
4. Confirm a precedent note is produced and a request with the old value gets `403`.

Captured output: _(to fill in)_

## Answer: what breaks in the wrong order?
Whichever side moves first locks the other out. Here the damage is small by design: the precedent call is advisory and returns `null`, so allocation never blocks. For a secret that guards a write path, the same mistake would be an outage.
