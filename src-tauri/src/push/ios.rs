//! iOS APNs transport, backed by SableClient's pinned MIT-licensed Tauri
//! notification plugin. The plugin owns the Swift application-delegate bridge
//! that requests authorization, calls `registerForRemoteNotifications`, and
//! resolves the resulting device token back to Rust.
//!
//! This client bridge is necessary but not sufficient for live delivery: the
//! installed app must be signed by a paid Apple Developer team with the Push
//! Notifications capability, and the gateway must hold an APNs provider key
//! for the same team/App ID. A Personal Team AltStore/SideStore re-sign cannot
//! satisfy those requirements. The runtime flag therefore remains off until
//! the signing and gateway gates have been proven on a physical device.

use std::sync::Mutex;

use tauri::AppHandle;
use tauri_plugin_notifications::NotificationsExt;

use super::{PushEndpoint, PushError, PusherKind, IOS_APP_ID};

pub struct ApnsTransport {
    app: AppHandle,
    endpoint: Mutex<Option<PushEndpoint>>,
}

impl ApnsTransport {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            endpoint: Mutex::new(None),
        }
    }
}

#[async_trait::async_trait]
impl super::NotificationTransport for ApnsTransport {
    async fn register(&self) -> Result<PushEndpoint, PushError> {
        let response = self
            .app
            .notifications()
            .register_for_push_notifications(None, None, None, None, None)
            .await
            .map_err(|error| format!("APNs registration failed: {error}"))?;
        let endpoint = PushEndpoint {
            url_or_token: response.device_token,
            app_id: IOS_APP_ID.to_string(),
            kind: PusherKind::Apns,
        };
        *self.endpoint.lock().unwrap_or_else(|error| error.into_inner()) =
            Some(endpoint.clone());
        Ok(endpoint)
    }

    async fn unregister(&self) -> Result<(), PushError> {
        self.app
            .notifications()
            .unregister_for_push_notifications()
            .await
            .map_err(|error| format!("APNs unregister failed: {error}"))?;
        *self.endpoint.lock().unwrap_or_else(|error| error.into_inner()) = None;
        Ok(())
    }

    fn endpoint(&self) -> Option<PushEndpoint> {
        self.endpoint
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }
}
