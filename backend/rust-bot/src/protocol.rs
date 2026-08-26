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
    /// Microsoft account password. When present, the bot attempts an automated
    /// email+password sign-in and only falls back to the device-code flow if
    /// that fails (e.g. the account uses two-step verification).
    #[serde(default)]
    pub password: Option<String>,
    /// Directory used to persist the Microsoft auth token cache for this
    /// specific account, so re-authentication is only needed once.
    pub cache_dir: String,

    pub afk_enabled: bool,
    pub movement_enabled: bool,
    /// When true, continuously sneak/crouch (re-applied every tick).
    #[serde(default)]
    pub crouch_enabled: bool,
    pub afk_interval_seconds: u64,
    pub auto_command_enabled: bool,
    pub auto_command_text: String,
    pub auto_command_interval_minutes: u64,
    #[serde(default)]
    pub auto_command_span_enabled: bool,
    #[serde(default = "default_auto_command_span_min_seconds")]
    pub auto_command_span_min_seconds: u64,
    #[serde(default = "default_auto_command_span_max_seconds")]
    pub auto_command_span_max_seconds: u64,

    /// Auto-accept incoming `/tpa` teleport requests (but never `/tpahere`).
    #[serde(default)]
    pub tpauto_enabled: bool,
    /// If non-empty, only auto-accept `/tpa` requests from these Minecraft
    /// names (case-insensitive). Empty means accept from anyone.
    #[serde(default)]
    pub tpauto_allowlist: Vec<String>,
    /// Periodically sell the inventory by running the sell command and moving
    /// all items into the sell menu the server opens.
    #[serde(default)]
    pub autosell_enabled: bool,
    /// Seconds between two auto-sell cycles.
    #[serde(default = "default_autosell_interval")]
    pub autosell_interval_seconds: u64,
    /// The command that opens the server's sell menu (e.g. "/sell").
    #[serde(default = "default_autosell_command")]
    pub autosell_command: String,
}

fn default_autosell_interval() -> u64 {
    60
}

fn default_autosell_command() -> String {
    "/sell".to_string()
}

fn default_auto_command_span_min_seconds() -> u64 {
    600
}

fn default_auto_command_span_max_seconds() -> u64 {
    1800
}

/// Behavior-only subset of [`Config`], sent again later to update settings
/// live without needing to reconnect.
#[derive(Debug, Clone, Deserialize)]
pub struct BehaviorConfig {
    pub afk_enabled: bool,
    pub movement_enabled: bool,
    #[serde(default)]
    pub crouch_enabled: bool,
    pub afk_interval_seconds: u64,
    pub auto_command_enabled: bool,
    pub auto_command_text: String,
    pub auto_command_interval_minutes: u64,
    #[serde(default)]
    pub auto_command_span_enabled: bool,
    #[serde(default = "default_auto_command_span_min_seconds")]
    pub auto_command_span_min_seconds: u64,
    #[serde(default = "default_auto_command_span_max_seconds")]
    pub auto_command_span_max_seconds: u64,
    #[serde(default)]
    pub tpauto_enabled: bool,
    /// If non-empty, only auto-accept `/tpa` requests from these Minecraft
    /// names (case-insensitive). Empty means accept from anyone.
    #[serde(default)]
    pub tpauto_allowlist: Vec<String>,
    #[serde(default)]
    pub autosell_enabled: bool,
    #[serde(default = "default_autosell_interval")]
    pub autosell_interval_seconds: u64,
    #[serde(default = "default_autosell_command")]
    pub autosell_command: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    /// Send a raw chat message or slash command (Node.js normalizes the `/`
    /// prefix before sending here).
    Chat { text: String },
    /// Update AFK/movement/auto-command behavior settings live.
    Configure(BehaviorConfig),
    /// Run a chat command as a *foreground one-shot task*: any continuous task
    /// (auto-sell) is paused until it has been sent, then resumed. Used by the
    /// Node-side daily-command scheduler so a scheduled command never collides
    /// with an in-progress auto-sell cycle.
    RunTask { text: String },
    /// Query the player's balance as a foreground one-shot task: pauses
    /// auto-sell, sends the given balance command, and waits for the server's
    /// reply (parsed into an [`OutEvent::Balance`]).
    QueryBalance { command: String },
    /// Clean a nearby spawner as a foreground one-shot task: right-click a
    /// spawner within reach (without walking to it), drop the items in the
    /// container it opens, and close it. Pauses auto-sell for the duration.
    CleanSpawner,
    /// Emit a snapshot of the bot's own inventory (an [`OutEvent::Inventory`]).
    /// Read-only, so it runs immediately without touching the task queue.
    RequestInventory,
    /// Move an item between two of the bot's own inventory slots (raw player
    /// menu slot indices). Runs as a foreground one-shot task so it never
    /// collides with auto-sell or other Minecraft actions.
    MoveItem { from: u16, to: u16 },
    /// Drop the whole stack in one of the bot's own inventory slots (raw player
    /// menu slot index). Runs as a foreground one-shot task.
    DropItem { slot: u16 },
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
    /// The bot's current health (0..=20) and food/hunger level (0..=20),
    /// emitted whenever either value changes.
    Health { health: f32, food: u32 },
    /// The player's balance, parsed from the server's reply to a balance query.
    Balance { balance: f64, raw: String },
    /// Money earned from an auto-sell action, parsed from the server's sell
    /// confirmation message. Attributed only within a short window after the
    /// sell command runs, so unrelated income (e.g. `/pay`) is not counted.
    SellEarning { amount: f64, raw: String },
    /// A live snapshot of the bot's own inventory. Slots use the player-menu
    /// layout: `main` is the 27 storage slots, `hotbar` the 9 hotbar slots,
    /// `offhand` the off-hand slot, and `armor` the 4 armor slots. Each entry is
    /// `null` for an empty slot. `mutable` is true only when the player's own
    /// inventory is open (no container GUI in the way), i.e. when move/drop
    /// actions are accepted.
    Inventory {
        main: Vec<Option<InventorySlot>>,
        hotbar: Vec<Option<InventorySlot>>,
        offhand: Option<InventorySlot>,
        armor: Vec<Option<InventorySlot>>,
        mutable: bool,
    },
    /// Periodic liveness signal so the Node supervisor can distinguish a hung
    /// bot from a healthy but idle one.
    Heartbeat,
    /// Emitted by `namesniper-bot` right before each rename request.
    RenameAttempt {
        desired_name: String,
        /// Which worker/proxy strand issued this attempt (e.g. "Direkt",
        /// "Proxy 1"); `None` for single-strand mode.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
    },
    /// Emitted by `namesniper-bot` after a rename request completes.
    RenameResult {
        success: bool,
        message: String,
        /// The account's current in-game name, when known (set on success).
        current_name: Option<String>,
        /// Which worker/proxy strand produced this result.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
    },
}

/// A single occupied inventory slot in an [`OutEvent::Inventory`] snapshot.
#[derive(Debug, Clone, Serialize)]
pub struct InventorySlot {
    /// The item identifier, e.g. `"minecraft:diamond"`.
    pub id: String,
    /// The stack size.
    pub count: u32,
}

/// The first stdin line for the `namesniper-bot` binary (see `bin/namesniper.rs`).
/// Deliberately separate from [`Config`]: the name sniper never joins a
/// server, so none of the server/behavior fields apply.
#[derive(Debug, Clone, Deserialize)]
pub struct SniperConfig {
    /// Microsoft account email used to authenticate (and as the on-disk
    /// token cache key).
    pub email: String,
    /// Directory used to persist the Microsoft auth token cache for this
    /// specific sniper account, so re-authentication is only needed once.
    pub cache_dir: String,
    /// The Minecraft username to repeatedly try to claim.
    pub desired_name: String,
    /// Seconds to wait between two rename attempts (1-60, enforced by the
    /// Node.js backend's validation but clamped here too as a safety net).
    pub cooldown_seconds: u64,
    /// When true, HTTP 429 responses trigger a Retry-After-aware backoff
    /// instead of the normal cooldown (see `bin/namesniper.rs`).
    #[serde(default)]
    pub rate_limit_protection: bool,
    /// Optional list of proxy URLs (http/https/socks5). When non-empty, one
    /// independent rename-attempt worker is spawned per proxy so requests are
    /// distributed across multiple outbound IPs — the per-IP rate limit then
    /// applies separately to each, genuinely increasing coverage. Empty means
    /// a single direct (no-proxy) worker.
    #[serde(default)]
    pub proxies: Vec<String>,
}

/// Live-updatable settings for a running `namesniper-bot`, sent as
/// subsequent stdin lines so the desired name / cooldown can change without
/// restarting the (potentially long-lived, mid-device-code-auth) process.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SniperCommand {
    Configure {
        desired_name: String,
        cooldown_seconds: u64,
        #[serde(default)]
        rate_limit_protection: bool,
    },
    /// Gracefully stop the attempt loop and exit.
    Stop,
}
