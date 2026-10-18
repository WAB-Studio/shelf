# tester-m3 · GoalLog /entrar late refusal (branch r18-m3)

## Tests (apps/goallog/e2e/entrar-sin-respuesta.spec.ts; Held gains abort())
- Refused late · check, wrong code: late codeInvalid replaces the check-timeout hint on the field; code kept; aria-invalid; controls enabled; no overflow at 360.
- Refused late · check, too many: late rateLimited reads its own words, not codeInvalid's.
- Refused late · resend (rewrite of the old «Late refusal dropped»): late rateLimited is the one alert, timeout sentence gone, countdown/record still the first send's, typed code kept.
- Refused late · send: late notInvited on the address hint, address kept, button enabled, no pending record.
- Cancelled · typed since: a digit typed, then late codeInvalid: no hint.
- Cancelled · newer attempt: first check timed out, second Entrar held and times out too; first released codeInvalid changes nothing (second's sentence stays). Deviation from the plan row ("still Comprobando…"): the state guard alone clears that case, so the tag could not be killed; letting the second time out makes the tag the only guard.
- Cancelled · left the step: late rateLimited after «Usar otro correo»: address step, no alert.
- Unknown stays unknown: aborted POST keeps timedOutCheck, no offlineCheck.
- Record kept: pending record intact after late codeInvalid; reload reopens the code step.
- Unchanged rows (late success, on time, pending, consent) untouched, green.
360 overflow is asserted inside the four Refused-late rows.

## Mutations
Against today's code (log private/m3-red1.log): 5 red, 16 green. Red: check wrong code, check too many, resend, send, Record kept (all "drop late refusals (today)"). Green by design: typed, newer, left, unknown (assert unchanged behaviour).
To prove the green-today rows can fail I wrote a reference implementation (private/m3-ref.patch, applied only temporarily; reverted, tree clean): all 21 green (private/m3-green1.log). Then, one build each, patches private/m3-mut-<name>.patch, logs private/m3-mut-<name>.log:

| Test | Mutation | Result |
|---|---|---|
| typed since | apply whenever state is sent (ignore shown sentence) | red |
| newer attempt | drop `mine !== attempt.current` in handleVerify | red (7.3s) |
| left the step | resend applies late refusal regardless of attempt/state | red |
| unknown | late rejection sets offlineCheck | red |
| record kept | clearPending() on late refusal | red |
| check too many | every late refusal mapped to codeInvalid | red |
| resend | refusal set on the field, sentence kept (beside, not in place) | red |
| send | late refusals applied on resend and check only | red |
| 4 Refused-late rows | today's code | red |
Not mutated separately: the two-alerts variant (covered by the `beside` mutation's alert-text assert and the count of 1 alert).

## Uncovered
- Late rejection in resend/send (not just check): same code path family; only check is driven.
- Late refusals other than codeInvalid/rateLimited/notInvited: not driven.
- Playwright run was local under next build + start; the pulsar-e2e CI run on the branch is pending.

## Deferred
None.
