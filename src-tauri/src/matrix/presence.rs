use matrix_sdk::ruma::api::client::presence::{get_presence, set_presence};
use matrix_sdk::ruma::events::presence::PresenceEvent;
use matrix_sdk::ruma::presence::PresenceState;
use matrix_sdk::ruma::UserId;
use matrix_sdk::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use ts_rs::TS;

use super::MatrixState;

/// Mirrors ruma's `PresenceState` for the frontend. `PresenceState` itself has
/// a hidden `_Custom` variant for forward-compat, which isn't meaningful to
/// surface as a DTO — anything that isn't one of the three known states is
/// mapped to `Offline` (see `presence_state_to_dto`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum PresenceStateDto {
    Online,
    Unavailable,
    Offline,
}

impl Default for PresenceStateDto {
    /// Matches the SDK's own `SyncSettings` default (`PresenceState::Online`)
    /// and what `set_presence_online` sets right after login.
    fn default() -> Self {
        Self::Online
    }
}

impl From<PresenceStateDto> for PresenceState {
    fn from(dto: PresenceStateDto) -> Self {
        match dto {
            PresenceStateDto::Online => PresenceState::Online,
            PresenceStateDto::Unavailable => PresenceState::Unavailable,
            PresenceStateDto::Offline => PresenceState::Offline,
        }
    }
}

/// Pushed to the frontend whenever an `m.presence` event arrives for another
/// user, and returned (wrapped in `Option`) by `get_presence`'s best-effort
/// lookup.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct PresenceUpdate {
    pub user_id: String,
    pub presence: PresenceStateDto,
    pub status_msg: Option<String>,
    // Milliseconds stay well within JS's safe-integer range; emit `number`
    // rather than ts-rs's default `bigint` so the frontend can use it directly.
    // `#[ts(type = "...")]` replaces the *whole* field type (including the
    // `Option` wrapper), so `"number"` alone would drop the `| null` half —
    // spell it out explicitly instead.
    #[ts(type = "number | null")]
    pub last_active_ago_ms: Option<u64>,
}

/// Maps a raw `PresenceState` to the DTO, treating any unrecognized custom
/// state as `Offline` — the frontend only needs to distinguish "reachable now"
/// (Online), "reachable but idle" (Unavailable), and everything else.
fn presence_state_to_dto(state: &PresenceState) -> PresenceStateDto {
    match state {
        PresenceState::Online => PresenceStateDto::Online,
        PresenceState::Unavailable => PresenceStateDto::Unavailable,
        _ => PresenceStateDto::Offline,
    }
}

/// Maps an incoming `m.presence` event to the DTO pushed to the frontend.
pub fn presence_event_to_update(event: &PresenceEvent) -> PresenceUpdate {
    PresenceUpdate {
        user_id: event.sender.to_string(),
        presence: presence_state_to_dto(&event.content.presence),
        status_msg: event.content.status_msg.clone(),
        // `js_int::UInt` only has a `From` impl into `i64`/`i128`, not `u64` directly —
        // safe here since this is always a non-negative millisecond duration.
        last_active_ago_ms: event
            .content
            .last_active_ago
            .map(|ago| i64::from(ago) as u64),
    }
}

/// Registers the handler that turns incoming `m.presence` events (delivered
/// per-sync in `SyncResponse::presence`, but matrix-sdk also offers them as a
/// regular event-handler feed) into a `presence:update` push to the frontend.
/// Called once, right after the client is built (login or session restore),
/// mirroring `verification::register_verification_handler`.
pub fn register_presence_handler(app: AppHandle, client: &Client) {
    client.add_event_handler(move |ev: PresenceEvent| {
        let app = app.clone();
        async move {
            let _ = app.emit("presence:update", presence_event_to_update(&ev));
        }
    });
}

/// Sets our own presence state (and optional status message). Called once on
/// login/session-restore (best-effort — see the caller) and on any explicit
/// user action; Spec 05 explicitly excludes auto-away/interval-based presence.
///
/// Also records `presence` on `MatrixState.sync_presence` so the running
/// sync loop reports it on the *next* `/sync` too — otherwise a
/// `Unavailable`/`Offline` choice here would be silently reverted back to
/// `Online` by the sync loop's own `set_presence` parameter on its next poll.
#[tauri::command]
pub async fn set_presence(
    state: State<'_, MatrixState>,
    presence: PresenceStateDto,
    status_msg: Option<String>,
) -> Result<(), String> {
    let client = state.require_client().await?;
    set_presence_impl(&client, presence, status_msg).await?;
    *state
        .sync_presence
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = presence;
    Ok(())
}

/// Core logic behind [`set_presence`], shared with [`set_presence_online`]
/// (the one-shot post-login call, which has no `MatrixState` handle available
/// at its call site in `spawn_sync_loop`). Doesn't itself update
/// `MatrixState.sync_presence` — that's a session-multiplexing concern the
/// Tauri wrapper owns (mirroring `MatrixState::get_or_create_timeline`'s
/// caching staying out of `get_timeline_page_impl`), not part of the Matrix
/// operation itself.
pub async fn set_presence_impl(
    client: &matrix_sdk::Client,
    presence: PresenceStateDto,
    status_msg: Option<String>,
) -> Result<(), String> {
    let user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?
        .to_owned();

    let mut request = set_presence::v3::Request::new(user_id, presence.into());
    request.status_msg = status_msg;

    client.send(request).await.map_err(|e| e.to_string())?;

    Ok(())
}

/// Sets presence to `Online` once, right after login/session-restore
/// succeeds. Best-effort by contract — the caller in `spawn_sync_loop`
/// discards the error so a homeserver that disables presence (or any other
/// failure here) never blocks or fails login.
pub async fn set_presence_online(client: &matrix_sdk::Client) -> Result<(), String> {
    set_presence_impl(client, PresenceStateDto::Online, None).await
}

/// Best-effort presence lookup for a single user. Returns `Ok(None)` — not an
/// error — when the homeserver disables presence or the lookup otherwise
/// fails, so the frontend never has to treat "presence unknown" as a hard
/// failure (per spec's non-goals/risks section).
#[tauri::command]
pub async fn get_presence(
    state: State<'_, MatrixState>,
    user_id: String,
) -> Result<Option<PresenceUpdate>, String> {
    let client = state.require_client().await?;
    get_presence_impl(&client, &user_id).await
}

/// Core logic behind [`get_presence`].
pub async fn get_presence_impl(
    client: &matrix_sdk::Client,
    user_id: &str,
) -> Result<Option<PresenceUpdate>, String> {
    let Ok(parsed_user_id) = UserId::parse(user_id) else {
        return Ok(None);
    };

    let request = get_presence::v3::Request::new(parsed_user_id.clone());
    let Ok(response) = client.send(request).await else {
        return Ok(None);
    };

    Ok(Some(PresenceUpdate {
        user_id: parsed_user_id.to_string(),
        presence: presence_state_to_dto(&response.presence),
        status_msg: response.status_msg,
        last_active_ago_ms: response.last_active_ago.map(|d| d.as_millis() as u64),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use matrix_sdk::ruma::events::presence::PresenceEventContent;
    use matrix_sdk::ruma::user_id;

    fn make_event(presence: PresenceState, status_msg: Option<&str>) -> PresenceEvent {
        let mut content = PresenceEventContent::new(presence);
        content.status_msg = status_msg.map(str::to_owned);
        content.last_active_ago = Some(matrix_sdk::ruma::UInt::try_from(1234_i64).unwrap());
        PresenceEvent {
            content,
            sender: user_id!("@alice:example.com").to_owned(),
        }
    }

    #[test]
    fn maps_online_presence_event() {
        let event = make_event(PresenceState::Online, Some("Making cupcakes"));
        let update = presence_event_to_update(&event);

        assert_eq!(update.user_id, "@alice:example.com");
        assert!(matches!(update.presence, PresenceStateDto::Online));
        assert_eq!(update.status_msg.as_deref(), Some("Making cupcakes"));
        assert_eq!(update.last_active_ago_ms, Some(1234));
    }

    #[test]
    fn maps_unavailable_presence_event() {
        let event = make_event(PresenceState::Unavailable, None);
        let update = presence_event_to_update(&event);

        assert!(matches!(update.presence, PresenceStateDto::Unavailable));
        assert_eq!(update.status_msg, None);
    }

    #[test]
    fn maps_offline_presence_event() {
        let event = make_event(PresenceState::Offline, None);
        let update = presence_event_to_update(&event);

        assert!(matches!(update.presence, PresenceStateDto::Offline));
    }

    #[test]
    fn dto_round_trips_into_ruma_presence_state() {
        assert_eq!(
            PresenceState::from(PresenceStateDto::Online),
            PresenceState::Online
        );
        assert_eq!(
            PresenceState::from(PresenceStateDto::Unavailable),
            PresenceState::Unavailable
        );
        assert_eq!(
            PresenceState::from(PresenceStateDto::Offline),
            PresenceState::Offline
        );
    }

    // Kept out of the ts-rs-annotated PresenceStateDto -> PresenceState `From`
    // impl by using a plain match arm, verified above; nothing further to
    // assert about the "unknown custom state" branch of
    // `presence_state_to_dto` here since ruma's `PresenceState::_Custom` is a
    // private variant this crate cannot construct.
}
