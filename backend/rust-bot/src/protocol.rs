//! NDJSON protocol shared between this Rust process and the Node.js backend.

use serde::{Deserialize, Serialize};

/// The first line sent on stdin when the process starts.
#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub host: String,
    pub port: u16,
    /// "offline" or "microsoft".
    pub auth_type: String,
    /// Offline-mode display name (also used as a fallback display name).
    pub username: String,
    /// Microsoft account email; required when `auth_type == "microsoft"`.
    pub email: Option<String>,
    /// Directory used to persist the Microsoft auth token cache for this
    /// specific account, so re-authentication is only needed once.
    pub cache_dir: String,

    pub afk_enabled: bool,
    pub movement_enabled: bool,
    pub afk_interval_seconds: u64,

    pub auto_command_enabled: bool,
    pub auto_command_text: String,
    pub auto_command_interval_minutes: u64,
}

/// Behavior-only subset of [`Config`], sent again later to update settings
/// live without needing to reconnect.
#[derive(Debug, Clone, Deserialize)]
pub struct BehaviorConfig {
    pub afk_enabled: bool,
    pub movement_enabled: bool,
    pub afk_interval_seconds: u64,
    pub auto_command_enabled: bool,
    pub auto_command_text: String,
    pub auto_command_interval_minutes: u64,
}

/// Commands sent from Node.js to this process after the initial config line.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    /// Send a raw chat message or slash command (Node.js normalizes the `/`
    /// prefix before sending here).
    Chat { text: String },
    /// Update AFK/movement/auto-command behavior settings live.
    Configure(BehaviorConfig),
    /// Gracefully disconnect and exit.
    Disconnect,
}

/// Events emitted by this process on stdout, one JSON object per line.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OutEvent {
    /// A Microsoft device-code sign-in is required.
    MsaCode {
        verification_uri: String,
        user_code: String,
        expires_in: u64,
    },
    /// The authenticated Minecraft profile, emitted once right after building a
    /// Microsoft account. Node uses this to auto-name the account after the
    /// real in-game username.
    Profile { username: String, uuid: String },
    /// Login packet received (before the player has fully spawned).
    Login,
    /// The bot has fully spawned into the world.
    Spawn,
    /// A chat message was received. `sender` is `None` for system messages.
    Chat {
        sender: Option<String>,
        message: String,
    },
    /// The connection ended after having successfully logged in.
    Disconnect { reason: Option<String> },
    /// The initial connection attempt failed (e.g. unsupported version,
    /// DNS/network error).
    ConnectionFailed { error: String },
    /// A non-fatal issue worth surfacing in the console (e.g. a malformed
    /// command from Node.js).
    Warning { message: String },
    /// An unrecoverable error before or during setup (auth failure, etc.).
    /// The process exits with a non-zero code immediately after this.
    FatalError { error: String },
    /// A behavior fired an action worth logging (e.g. an auto-command was sent).
    BehaviorLog { message: String },
}
