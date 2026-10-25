//! NDJSON protocol shared between this Rust process and the Node.js backend.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JavaNetworkMode {
    #[default]
    Optimized,
    Standard,
}

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
    /// Microsoft account password. When present, the bot attempts an automated
    /// email+password sign-in and only falls back to the device-code flow if
    /// that fails (e.g. the account uses two-step verification).
    #[serde(default)]
    pub password: Option<String>,
    /// Directory used to persist the Microsoft auth token cache for this
    /// specific account, so re-authentication is only needed once.
    pub cache_dir: String,
    /// Optional per-account comparison with Azalea's standard network reader.
    #[serde(default)]
    pub java_network_mode: JavaNetworkMode,

    /// When true, continuously sneak/crouch.
    #[serde(default)]
    pub crouch_enabled: bool,
    /// Periodically sell the inventory by running the sell command and moving
    /// all items into the sell menu the server opens.
    #[serde(default)]
    pub autosell_enabled: bool,
    /// Seconds between two auto-sell cycles (supports fractional seconds, e.g. 1.5).
    #[serde(default = "default_autosell_interval")]
    pub autosell_interval_seconds: f64,
    /// The command that opens the server's sell menu (e.g. "/sell").
    #[serde(default = "default_autosell_command")]
    pub autosell_command: String,
    /// Restart pause offsets relative to process startup, retained across reconnects by Node.
    #[serde(default)]
    pub autosell_pause_after_ms: u64,
    #[serde(default)]
    pub autosell_resume_after_ms: u64,
    /// The configured spawner type id (e.g. "cow"), or empty when the account
    /// has not picked one. Empty selects the legacy "empty the whole container"
    /// behavior; anything else means the drop/sell lists are authoritative, even
    /// when both are empty (= every item set to "keep").
    #[serde(default)]
    pub spawner_type: String,
    /// Item ids (e.g. "minecraft:beef") that Clean Spawner throws out of the
    /// spawner. Dropping always runs before selling and stops once fewer than
    /// two stacks of the item remain.
    #[serde(default)]
    pub spawner_drop_items: Vec<String>,
    /// Item ids that Clean Spawner sells via the spawner's own sell button,
    /// likewise down to fewer than two remaining stacks.
    #[serde(default)]
    pub spawner_sell_items: Vec<String>,
}

fn default_autosell_interval() -> f64 {
    60.0
}

fn default_autosell_command() -> String {
    "/sell".to_string()
}

/// Behavior-only subset of [`Config`], sent again later to update settings
/// live without needing to reconnect.
#[derive(Debug, Clone, Deserialize)]
pub struct BehaviorConfig {
    #[serde(default)]
    pub crouch_enabled: bool,
    #[serde(default)]
    pub autosell_enabled: bool,
    #[serde(default = "default_autosell_interval")]
    pub autosell_interval_seconds: f64,
    #[serde(default = "default_autosell_command")]
    pub autosell_command: String,
    #[serde(default)]
    pub spawner_type: String,
    #[serde(default)]
    pub spawner_drop_items: Vec<String>,
    #[serde(default)]
    pub spawner_sell_items: Vec<String>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    /// Send a raw chat message or slash command (Node.js normalizes the `/`
    /// prefix before sending here).
    Chat { text: String },
    /// Update account automation settings live.
    Configure(BehaviorConfig),
    /// Clean a nearby spawner as a foreground one-shot task: right-click a
    /// spawner within reach (without walking to it), drop the items in the
    /// container it opens, and close it. Pauses auto-sell for the duration.
    CleanSpawner,
    /// Read the nine top-row SELL MULTI tooltips without clicking any items.
    ReadSellMultipliers,
    /// Verify server sneak metadata and reassert enabled crouch on demand.
    CheckCrouch,
    /// Schedule the restart pause independently of behavior settings and world transitions.
    PauseAutosell {
        autosell_pause_after_ms: u64,
        autosell_resume_after_ms: u64,
    },
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
    /// A behavior fired an action worth logging (e.g. a menu was recovered).
    BehaviorLog {
        message: String,
    },
    SellMultipliers {
        entries: Vec<SellMultiplier>,
    },
    /// Periodic liveness signal so the Node supervisor can distinguish a hung
    /// bot from a healthy but idle one.
    Heartbeat,

}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SellMultiplier {
    pub name: String,
    pub multiplier: String,
    pub progress: String,
}
