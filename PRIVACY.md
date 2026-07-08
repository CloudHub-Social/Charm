# Privacy

Charm uses Sentry for crash and performance observability only after you opt in
from Settings -> Observability.

Fresh installs have every Sentry category turned off. If you do not enable
Sentry, Charm does not initialize the Sentry SDK and does not send Sentry error
events, traces, logs, replays, breadcrumbs, screenshots, or user feedback.

## What the Toggle Enables

The primary Error monitoring toggle enables redacted crash reports, unhandled
errors, performance traces, breadcrumbs, release-health sessions, app version,
environment, and platform tags.

The Session replay toggle records masked DOM sessions for debugging. Charm
configures replay to mask all text, mask all inputs, and block media.

The Canvas replay toggle allows canvas capture only when Session replay is also
enabled.

The Profiling toggle samples JavaScript performance profiles attached to traces.

The Structured logs toggle sends warning and error logs after redaction.

## What Charm Redacts

Before data leaves the app, Charm redacts Matrix identifiers such as user IDs,
room IDs, room aliases, event IDs, and `mxc://` media URIs. It also redacts
known secret fields including access tokens, refresh tokens, passwords,
passphrases, recovery keys, secret-storage keys, and session keys.

Charm does not use your Matrix ID, email, or display name as the Sentry user. If
you opt in, Charm creates a random local identifier so repeated crashes from the
same install can be correlated without sending your real account identity.

## Opting Out

Turn off Error monitoring in Settings -> Observability. Sub-options are disabled
and turned off when the primary toggle is off.

Rust-side crash monitoring is initialized during app startup, so turning the
toggle off fully applies to native crash monitoring after restarting Charm.

## Deletion

Sentry data is managed in the CloudHub Social Sentry organization. To request
deletion for data associated with your local telemetry identifier, contact the
project owner with the approximate time range and platform where the report was
sent.
