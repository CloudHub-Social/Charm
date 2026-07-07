//! The event envelope pushed over each session's WebSocket connection.
//!
//! Mirrors what `app.emit(name, payload)` does for the desktop Tauri
//! frontend (see `src-tauri/src/matrix/{sync,timeline,ephemeral,presence,
//! profiles,verification,send}.rs`) — same event names, same payload DTOs
//! (reused directly from `charm_lib`, not redefined), just adjacently-tagged
//! into one JSON envelope per WebSocket message instead of separate
//! Tauri-channel events, since a browser WebSocket has one message stream to
//! multiplex rather than Tauri's per-event-name channel.

use charm_lib::matrix::ephemeral::{ReceiptUpdate, TypingUpdate};
use charm_lib::matrix::presence::PresenceUpdate;
use charm_lib::matrix::profiles::SelfProfileUpdate;
use charm_lib::matrix::room_admin::RoomDetails;
use charm_lib::matrix::rooms::RoomSummary;
use charm_lib::matrix::send::UploadProgress;
use charm_lib::matrix::shell::BadgeState;
use charm_lib::matrix::sync::SyncStateEvent;
use charm_lib::matrix::timeline::RoomTimelineUpdate;
use charm_lib::matrix::verification::{SasUpdateEvent, VerificationRequestSummary};
use serde::Serialize;

/// A SAS verification state change for one flow. Desktop encodes the flow id
/// into the *event name* itself (`verification:sas_update:{flow_id}`, since
/// Tauri events are just named channels); a WebSocket has a single message
/// stream, so this carries the flow id as a field instead.
#[derive(Debug, Clone, Serialize)]
pub struct SasUpdatePayload {
    pub flow_id: String,
    #[serde(flatten)]
    pub update: SasUpdateEvent,
}

/// Adjacently tagged (`{"event": "...", "data": ...}`) so the frontend can
/// dispatch on `event` the same way it currently switches on a Tauri event
/// name, without redefining any payload shape.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum ServerEvent {
    #[serde(rename = "sync:state")]
    SyncState(SyncStateEvent),
    #[serde(rename = "room_list:update")]
    RoomList(Vec<RoomSummary>),
    #[serde(rename = "badge:update")]
    Badge(BadgeState),
    #[serde(rename = "receipts:update")]
    Receipts(ReceiptUpdate),
    #[serde(rename = "typing:update")]
    Typing(TypingUpdate),
    #[serde(rename = "room_details:update")]
    RoomDetails(RoomDetails),
    #[serde(rename = "timeline:update")]
    Timeline(RoomTimelineUpdate),
    #[serde(rename = "presence:update")]
    Presence(PresenceUpdate),
    #[serde(rename = "profile:self")]
    ProfileSelf(SelfProfileUpdate),
    #[serde(rename = "upload:progress")]
    UploadProgress(UploadProgress),
    #[serde(rename = "verification:request")]
    VerificationRequest(VerificationRequestSummary),
    #[serde(rename = "verification:sas_update")]
    VerificationSasUpdate(SasUpdatePayload),
}

/// Bounded so a session whose browser tab is closed (nobody draining the
/// receiver) can't grow this queue forever — `broadcast` drops the oldest
/// entries and marks the lagging receiver `Lagged` instead, which the
/// WebSocket forwarder treats as "skip ahead, keep streaming" rather than a
/// fatal error (a missed `room_list:update`/`timeline:update` is superseded
/// by the next one anyway).
pub const EVENT_CHANNEL_CAPACITY: usize = 256;
