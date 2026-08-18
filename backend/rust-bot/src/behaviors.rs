//! AFK / movement / auto-command behaviors, ported from the Node.js
//! `BehaviorManager` system to run natively inside the Rust bot process.
//!
//! Everything here is driven from `Event::Tick` (fired 20x/second by Azalea
//! while the bot is in a loaded world). This intentionally avoids spawning any
//! Tokio tasks: Azalea runs its ECS systems outside of a Tokio runtime context,
//! so `tokio::spawn`/`spawn_local` from inside an event handler is unreliable.
//! Tick-driven timing keeps behaviors simple, deterministic and cheap.

use std::time::{Duration, Instant};

use azalea::{Client, WalkDirection};
use rand::Rng;

use crate::emit;
use crate::protocol::{BehaviorConfig, Config, OutEvent};

/// How long the bot keeps walking in one direction before stopping again.
const WALK_DURATION: Duration = Duration::from_secs(2);
/// Minimum time between two random movement bursts.
const MOVEMENT_INTERVAL: Duration = Duration::from_secs(8);
/// Give the server this long to open its sell menu after the sell command is
/// sent before giving up on the current auto-sell cycle.
const AUTOSELL_MENU_TIMEOUT: Duration = Duration::from_secs(3);
/// Minimum spacing between two auto-accepted teleport requests, to avoid
/// reacting multiple times to a burst of duplicate server messages.
const TPACCEPT_COOLDOWN: Duration = Duration::from_secs(2);

/// Tracks the two-step auto-sell cycle: send the sell command, then move all
/// inventory items into the container the server opens in response.
enum AutoSellPhase {
    Idle,
    WaitingForMenu { since: Instant },
}

pub struct BehaviorState {
    config: BehaviorConfig,
    last_afk_at: Instant,
    last_movement_at: Instant,
    last_auto_command_at: Instant,
    /// When `Some`, the bot is currently walking and should stop at this time.
    stop_walking_at: Option<Instant>,
    last_autosell_at: Instant,
    autosell_phase: AutoSellPhase,
    last_tpaccept_at: Option<Instant>,
}

impl BehaviorState {
    pub fn new(config: &Config) -> Self {
        let now = Instant::now();
        Self {
            config: BehaviorConfig {
                afk_enabled: config.afk_enabled,
                movement_enabled: config.movement_enabled,
                afk_interval_seconds: config.afk_interval_seconds,
                auto_command_enabled: config.auto_command_enabled,
                auto_command_text: config.auto_command_text.clone(),
                auto_command_interval_minutes: config.auto_command_interval_minutes,
                tpauto_enabled: config.tpauto_enabled,
                autosell_enabled: config.autosell_enabled,
                autosell_interval_seconds: config.autosell_interval_seconds,
                autosell_command: config.autosell_command.clone(),
            },
            last_afk_at: now,
            last_movement_at: now,
            last_auto_command_at: now,
            stop_walking_at: None,
            last_autosell_at: now,
            autosell_phase: AutoSellPhase::Idle,
            last_tpaccept_at: None,
        }
    }

    /// Apply a live settings update (from a `Command::Configure`).
    pub fn update_config(&mut self, config: BehaviorConfig) {
        self.config = config;
    }

    /// Called on every `Event::Tick`. Checks each behavior's elapsed time
    /// against its configured interval and fires the corresponding action.
    pub fn on_tick(&mut self, bot: &Client) {
        let now = Instant::now();

        // Stop a previous movement burst once its duration has elapsed.
        if let Some(stop_at) = self.stop_walking_at {
            if now >= stop_at {
                bot.walk(WalkDirection::None);
                self.stop_walking_at = None;
            }
        }

        // AFK: look somewhere random and jump. Keeps the player active without
        // moving away from its spot, resetting most servers' AFK timers.
        if self.config.afk_enabled {
            let interval = Duration::from_secs(self.config.afk_interval_seconds.max(5));
            if now.duration_since(self.last_afk_at) >= interval {
                self.last_afk_at = now;
                let mut rng = rand::thread_rng();
                let yaw: f32 = rng.gen_range(-180.0..180.0);
                let pitch: f32 = rng.gen_range(-20.0..20.0);
                let _ = bot.set_direction(yaw, pitch);
                bot.jump();
            }
        }

        // Movement: wander a short distance in a random direction, then stop
        // (handled by `stop_walking_at` above). Skipped while already walking.
        if self.config.movement_enabled
            && self.stop_walking_at.is_none()
            && now.duration_since(self.last_movement_at) >= MOVEMENT_INTERVAL
        {
            self.last_movement_at = now;
            let directions = [
                WalkDirection::Forward,
                WalkDirection::Backward,
                WalkDirection::Left,
                WalkDirection::Right,
            ];
            let direction = directions[rand::thread_rng().gen_range(0..directions.len())];
            bot.walk(direction);
            self.stop_walking_at = Some(now + WALK_DURATION);
        }

        // Auto-command: type a configured chat message/command at a fixed
        // interval, independent of the AFK/movement behaviors.
        if self.config.auto_command_enabled {
            let text = self.config.auto_command_text.trim().to_string();
            if !text.is_empty() {
                let interval =
                    Duration::from_secs(self.config.auto_command_interval_minutes.max(1) * 60);
                if now.duration_since(self.last_auto_command_at) >= interval {
                    self.last_auto_command_at = now;
                    bot.chat(text.clone());
                    emit(&OutEvent::BehaviorLog {
                        message: format!("Auto-command sent: {text}"),
                    });
                }
            }
        }

        self.tick_autosell(bot, now);
    }

    /// Drives the periodic auto-sell cycle. When enabled, every
    /// `autosell_interval_seconds` it runs the configured sell command (which
    /// makes the server open a sell container), then — once that container is
    /// open — shift-clicks every item from the player's inventory into it,
    /// mirroring what the original AutoSell client mod does.
    fn tick_autosell(&mut self, bot: &Client, now: Instant) {
        if !self.config.autosell_enabled {
            self.autosell_phase = AutoSellPhase::Idle;
            return;
        }

        match self.autosell_phase {
            AutoSellPhase::Idle => {
                let interval = Duration::from_secs(self.config.autosell_interval_seconds.max(5));
                if now.duration_since(self.last_autosell_at) >= interval {
                    self.last_autosell_at = now;
                    let command = self.config.autosell_command.trim();
                    let command = if command.is_empty() { "/sell" } else { command };
                    bot.chat(command.to_string());
                    self.autosell_phase = AutoSellPhase::WaitingForMenu { since: now };
                    emit(&OutEvent::BehaviorLog {
                        message: format!("AutoSell: opening sell menu ({command})"),
                    });
                }
            }
            AutoSellPhase::WaitingForMenu { since } => {
                if let Ok(inv) = bot.get_inventory() {
                    // A non-zero container id means the server opened a menu
                    // (the sell GUI) in response to our sell command.
                    if inv.id() != 0 {
                        if let Some(slots) = inv.slots() {
                            // The player's own 36 inventory slots are always the
                            // last slots of an open container's menu.
                            let player_start = slots.len().saturating_sub(36);
                            let mut sold = 0;
                            for slot in player_start..slots.len() {
                                if slots[slot].is_present() {
                                    inv.shift_click(slot);
                                    sold += 1;
                                }
                            }
                            emit(&OutEvent::BehaviorLog {
                                message: format!("AutoSell: moved {sold} stack(s) into the sell menu"),
                            });
                        }
                        self.autosell_phase = AutoSellPhase::Idle;
                        return;
                    }
                }

                // The server never opened a menu (e.g. it sells directly, or the
                // command failed) — give up on this cycle and try again later.
                if now.duration_since(since) >= AUTOSELL_MENU_TIMEOUT {
                    self.autosell_phase = AutoSellPhase::Idle;
                }
            }
        }
    }

    /// Handles an incoming chat/system message. When `tpauto` is enabled and the
    /// message is an incoming `/tpa` request (someone wanting to teleport **to**
    /// the bot), it auto-accepts with `/tpaccept`. Requests where the bot would
    /// be teleported **to** someone else (`/tpahere`) are deliberately ignored.
    pub fn on_chat(&mut self, bot: &Client, message: &str) {
        if !self.config.tpauto_enabled {
            return;
        }
        if !is_incoming_tpa_request(message) {
            return;
        }

        let now = Instant::now();
        if let Some(last) = self.last_tpaccept_at {
            if now.duration_since(last) < TPACCEPT_COOLDOWN {
                return;
            }
        }
        self.last_tpaccept_at = Some(now);

        let command = match extract_username(message) {
            Some(user) => format!("/tpaccept {user}"),
            None => "/tpaccept".to_string(),
        };
        bot.chat(command.clone());
        emit(&OutEvent::BehaviorLog {
            message: format!("TPAuto: accepted teleport request ({command})"),
        });
    }
}

/// Returns true if `message` looks like an incoming teleport request where the
/// sender wants to teleport **to** the bot (`/tpa`), and NOT one where the bot
/// would be sent to the requester (`/tpahere`). Matches common English and
/// German EssentialsX-style phrasings.
fn is_incoming_tpa_request(message: &str) -> bool {
    let lower = message.to_lowercase();

    let mentions_teleport = lower.contains("teleport") || lower.contains("tpa");
    if !mentions_teleport {
        return false;
    }

    // "tpahere": the requester wants the bot to come to THEM — must be ignored.
    let is_tpahere = lower.contains("tpahere")
        || lower.contains("teleport to them")
        || lower.contains("teleport to their")
        || lower.contains("you to teleport")
        || lower.contains("that you teleport")
        || lower.contains("dass du dich")
        || lower.contains("zu sich");
    if is_tpahere {
        return false;
    }

    // "tpa": the requester wants to come TO the bot.
    lower.contains("teleport to you")
        || lower.contains("to your location")
        || lower.contains("zu dir")
        || lower.contains("tpa")
}

/// Best-effort extraction of the requesting player's name from a teleport
/// request message. Teleport request messages almost always start with the
/// player name, so we return the first Minecraft-username-like token.
fn extract_username(message: &str) -> Option<String> {
    message
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .find(|token| {
            let len = token.len();
            (3..=16).contains(&len) && !token.eq_ignore_ascii_case("tpa")
        })
        .map(|s| s.to_string())
}
