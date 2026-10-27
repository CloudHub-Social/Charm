---
title: Isolated Spaces writer probe
description: Preparation and execution holds for the synthetic writer precondition experiment.
---

The owner paused this experiment. No bucket, credential, environment, binding
or live run has been created. This retained preparation for issue #573 and
draft PR #589 is not a production fix, rollout prerequisite or live receipt. The example is deliberately held before credential
loading or network access. Do not remove that hold merely to run it.

## Approved target and limits

Use one new private Standard bucket, `charm-writer-probe-20261027`, in `tor1`.
The control-panel operator creates it without a full-access bootstrap S3 key.
A new key has exactly bucket-only `readwrite` permission. No production key,
crypto state, fence, session, snapshot, service startup or deployment is used.
The authorization permits two objects of at most 1 KiB each, twenty requests,
64 KiB outbound and US$0.01 incremental provider cost. This implementation uses
only one object, `synthetic-writer-conditional-probe`, and fixed synthetic bodies.

## Candidate sequence

The exact existing `object_store 0.14.1` backend uses production's virtual-host
endpoint shape. Both SDK and HTTP-client retries are disabled; redirects,
proxies and TLS exceptions are disabled. The transport permits only the named
HTTPS host, exact object path, no query string, and GET/HEAD/PUT/DELETE. It has a
twenty-request guard, reserving four slots for cleanup after qualification.

1. HEAD must establish absence; otherwise stop without deleting anything.
2. Conditional create of a plain synthetic owner, then GET its ETag and body.
3. Correct-ETag conditional update to a synthetic JSON fence must succeed.
4. Reusing the stale ETag must return a precondition failure.
5. Duplicate conditional creation must fail.
6. GET must prove rejected writes did not change the JSON object.
7. DELETE and HEAD must verify removal even after a failed/uncertain write.

The normal sequence is nine requests, without retries. A failure is recorded
only as a normalized category. Neither credentials, ETags, provider response
bodies nor real identifiers are printed. Passing says only that isolated
conditional operations work; it does not establish the production failure cause.

## Readiness gaps and hosted route

The candidate accounts HTTP response headers and limits buffered response
bodies, but this is **not an enforcement mechanism for provider wire egress**.
TLS/TCP overhead and bytes sent before a client stops reading remain outside
that accounting. `PROVIDER_EGRESS_CAP_VERIFIED` therefore remains false and
blocks live execution before credential loading. Review must resolve the exact
approved 64 KiB boundary; do not silently replace it with a payload-only limit.

There is no existing protected probe environment. Metadata inspection found
only unrelated preview, production, Pages, Copilot and signing environments.
Do not reuse those or their credentials. The preparation workflow is a new
pull-request-only compile/inert-execution check, with contents-read permission
and no environment or provider secret. It is not yet a live execution route.

After scope-compliant cap enforcement and independent review, the proposed live
route is one exact-reviewed-revision hosted job with a dedicated
`charm-writer-probe` environment, branch restriction and required owner review.
Bind only `CHARM_PROBE_ACCESS_KEY_ID` and `CHARM_PROBE_SECRET_ACCESS_KEY` there.
Nonsecret guards are `CHARM_PROBE_APPROVED_BUCKET` and
`CHARM_PROBE_APPROVED_SHA`, with the latter tied to the checked-out reviewed
revision, not a PR merge SHA. Refuse rerun attempts. A branch workflow must not
implicitly gain access on every push; activation is a separate controlled step.
No live trigger, environment, credential binding or activation is implemented
by this preparation. Existing repository checks and independent source review
remain required; the draft/production hold remains intact.

## Cleanup and failure ownership

The probe attempts deletion of its sole generated key and verifies NotFound.
If the preflight fails, it must not delete pre-existing content. If a timeout or
transport error makes a write uncertain, the operator reconciles that exact
synthetic key before any retry. Do not start another probe automatically.

The operator separately verifies object absence and bucket deletion through the
approved cloud control panel, revokes the exact newly issued key, verifies it is
absent from key metadata, and removes/verifies absence of both environment
bindings. Revoke even if compilation/execution fails after key issuance. Never
assume automatic credential expiration. Leave any failed cleanup explicitly
open with resource identity and outcome certainty. Do not create a credential
until compilation, independent review, cloud route and cleanup capability are
ready. Existing organization-binding discovery HTTP403 remains a denied route.
