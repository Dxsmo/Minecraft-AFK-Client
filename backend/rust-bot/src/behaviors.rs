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
/// sent before giving up on the current auto-sell cycle. Kept short so a fast
/// (sub-5s) auto-sell interval isn't bottlenecked waiting for a menu that
/// already opened or will never open.
const AUTOSELL_MENU_TIMEOUT: Duration = Duration::from_millis(1500);
/// Ignore an identical `/tpaccept …` command if we already sent it within this
/// window, to avoid reacting multiple times to a burst of duplicate server
/// messages (request line + clickable hint often arrive together).
const TPACCEPT_DEDUP: Duration = Duration::from_secs(4);
/// How often the bot emits a heartbeat so the Node supervisor can tell a live
/// (but silent) bot apart from a hung one and recycle the latter.
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);

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
    /// The last `/tpaccept …` command we sent and when, for de-duplication.
    last_tpaccept: Option<(String, Instant)>,
    last_heartbeat_at: Instant,
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
            last_tpaccept: None,
            last_heartbeat_at: now,
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

        // Heartbeat: prove the tick loop is alive so the supervisor can recycle
        // a genuinely hung bot without killing a healthy but idle one.
        if now.duration_since(self.last_heartbeat_at) >= HEARTBEAT_INTERVAL {
            self.last_heartbeat_at = now;
            emit(&OutEvent::Heartbeat);
        }
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
                let interval = Duration::from_secs(self.config.autosell_interval_seconds.max(1));
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
                        // Always close the menu so we never leave the bot stuck
                        // in an open GUI (which otherwise blocks further actions
                        // and looks like a hang until a manual restart).
                        inv.close();
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
    /// the bot), it accepts it. Requests where the bot would be teleported **to**
    /// someone else (`/tpahere`) are deliberately ignored.
    ///
    /// Rather than guessing the server's phrasing, we look for the clickable
    /// `/tpaccept …` command the server itself puts in the message and replay it
    /// verbatim — this works across servers/languages (e.g. HugoSMP's
    /// `/tpaccept <name> tpa`) and only falls back to a bare `/tpaccept` when no
    /// such hint is present.
    pub fn on_chat(&mut self, bot: &Client, message: &str) {
        if !self.config.tpauto_enabled {
            return;
        }
        let Some(command) = parse_tpa_accept_command(message) else {
            return;
        };

        let now = Instant::now();
        if let Some((last_cmd, last_at)) = &self.last_tpaccept {
            if *last_cmd == command && now.duration_since(*last_at) < TPACCEPT_DEDUP {
                return;
            }
        }
        self.last_tpaccept = Some((command.clone(), now));

        bot.chat(command.clone());
        emit(&OutEvent::BehaviorLog {
            message: format!("TPAuto: accepted teleport request ({command})"),
        });
    }
}

/// Words that commonly follow `/tpaccept` as prose rather than as real command
/// arguments, used to stop argument collection when replaying a suggested
/// command (English + German).
const TPACCEPT_STOP_WORDS: &[&str] = &[
    "to", "the", "this", "that", "and", "or", "type", "click", "accept", "request",
    "um", "zu", "die", "der", "den", "das", "und", "oder", "dich", "dir", "anfrage",
    "annehmen", "akzeptieren", "tippe", "schreibe", "hier", "klicke",
];

/// Returns true if `lower` (an already-lowercased message) describes a
/// `/tpahere`-style request, i.e. one where the bot would teleport **to** the
/// requester. Such requests must never be auto-accepted.
fn is_tpahere_request(lower: &str) -> bool {
    lower.contains("tpahere")
        || lower.contains("teleport to them")
        || lower.contains("teleport to their")
        || lower.contains("you to teleport")
        || lower.contains("that you teleport")
        || lower.contains("dass du dich")
        || lower.contains("zu ihm")
        || lower.contains("zu ihr")
        || lower.contains("zu sich")
}

/// Derives the exact `/tpaccept …` command to send for an incoming teleport
/// request, or `None` if the message isn't an acceptable `/tpa` request.
///
/// We only act on the clickable/typed `/tpaccept …` command the server puts in
/// the message. This is deliberate: it avoids firing twice when the request
/// line and the accept hint arrive as separate messages, and it means we send
/// exactly the command the server expects (including any trailing flag such as
/// HugoSMP's `tpa`).
fn parse_tpa_accept_command(message: &str) -> Option<String> {
    let lower = message.to_lowercase();
    if is_tpahere_request(&lower) {
        return None;
    }

    let command = extract_tpaccept_command(message)?;
    // A suggested command that itself targets tpahere must be ignored.
    if command.to_lowercase().contains("tpahere") {
        return None;
    }
    Some(command)
}

/// Finds a `/tpaccept` command suggestion inside `message` and reconstructs it,
/// keeping only genuine command arguments (usernames / short flags like `tpa`)
/// and dropping any surrounding prose.
fn extract_tpaccept_command(message: &str) -> Option<String> {
    let lower = message.to_lowercase();
    let start = lower.find("/tpaccept")?;
    // Limit to the remainder of the same line.
    let rest = &message[start..];
    let line = rest.split(['\n', '\r']).next().unwrap_or(rest);

    let mut parts = line.split_whitespace();
    parts.next(); // "/tpaccept" itself
    let mut command = String::from("/tpaccept");
    for token in parts {
        let cleaned: String = token
            .trim_matches(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .to_string();
        let valid = (1..=16).contains(&cleaned.len())
            && cleaned.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !valid || TPACCEPT_STOP_WORDS.contains(&cleaned.to_lowercase().as_str()) {
            break;
        }
        command.push(' ');
        command.push_str(&cleaned);
    }
    Some(command)
}

#[cfg(test)]
mod tests {
    use super::parse_tpa_accept_command;

    #[test]
    fn hugosmp_accept_hint_line() {
        assert_eq!(
            parse_tpa_accept_command("Annehmen - /tpaccept Desmodus tpa").as_deref(),
            Some("/tpaccept Desmodus tpa")
        );
    }

    #[test]
    fn hugosmp_full_block() {
        let msg = "[HugoSMP] Desmodus hat dir eine Teleportations-Anfrage gesendet!\n\
                   Annehmen - /tpaccept Desmodus tpa\n\
                   Ablehnen - /tpdeny Desmodus tpa";
        assert_eq!(
            parse_tpa_accept_command(msg).as_deref(),
            Some("/tpaccept Desmodus tpa")
        );
    }

    #[test]
    fn ignores_tpahere_variant() {
        assert_eq!(
            parse_tpa_accept_command("Annehmen - /tpaccept Desmodus tpahere"),
            None
        );
    }

    #[test]
    fn ignores_tpahere_german_request() {
        let msg = "[HugoSMP] Desmodus möchte, dass du dich zu ihm teleportierst!\n\
                   Annehmen - /tpaccept Desmodus tpahere";
        assert_eq!(parse_tpa_accept_command(msg), None);
    }

    #[test]
    fn request_line_without_hint_is_ignored() {
        assert_eq!(
            parse_tpa_accept_command("[HugoSMP] Desmodus hat dir eine Teleportations-Anfrage gesendet!"),
            None
        );
    }

    #[test]
    fn essentials_style_bare_accept() {
        assert_eq!(
            parse_tpa_accept_command("To teleport, type /tpaccept.").as_deref(),
            Some("/tpaccept")
        );
    }

    #[test]
    fn essentials_prose_after_command_is_dropped() {
        assert_eq!(
            parse_tpa_accept_command("Type /tpaccept to accept this request").as_deref(),
            Some("/tpaccept")
        );
    }
}
