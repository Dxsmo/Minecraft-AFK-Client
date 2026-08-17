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

pub struct BehaviorState {
    config: BehaviorConfig,
    last_afk_at: Instant,
    last_movement_at: Instant,
    last_auto_command_at: Instant,
    /// When `Some`, the bot is currently walking and should stop at this time.
    stop_walking_at: Option<Instant>,
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
            },
            last_afk_at: now,
            last_movement_at: now,
            last_auto_command_at: now,
            stop_walking_at: None,
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
    }
}
