//! AFK / movement / auto-command behaviors, ported from the Node.js
//! `BehaviorManager` system to run natively inside the Rust bot process
//! (Azalea's movement API differs enough from Mineflayer's that behaviors
//! live here now instead of being controlled packet-by-packet from Node).

use std::time::{Duration, Instant};

use azalea::{Client, WalkDirection};
use rand::Rng;
use tokio::task::JoinHandle;

use crate::protocol::{BehaviorConfig, Config, OutEvent};

const TICK_INTERVAL: Duration = Duration::from_millis(1000);
const WALK_DURATION: Duration = Duration::from_secs(2);

fn emit(event: &OutEvent) {
    if let Ok(line) = serde_json::to_string(event) {
        println!("{line}");
    }
}

pub struct BehaviorState {
    config: BehaviorConfig,
    last_afk_at: Instant,
    last_movement_at: Instant,
    last_auto_command_at: Instant,
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
            // Stagger the first fire slightly into the future rather than
            // immediately, mirroring the Node-side behaviors' original
            // "start on connect, first action after one interval" feel.
            last_afk_at: now,
            last_movement_at: now,
            last_auto_command_at: now,
        }
    }

    pub fn update_config(&mut self, config: &BehaviorConfig) {
        self.config = config.clone();
    }
}

/// Spawns a background task that periodically checks elapsed time against
/// each behavior's configured interval and fires the corresponding action.
/// Checking a shared config on every tick (rather than resetting individual
/// timers) means live `Command::Configure` updates take effect immediately
/// without needing to restart anything.
/// 
/// Note: This must be called from within a Tokio LocalSet (as required by
/// Azalea's internal ECS scheduler).
pub fn spawn_ticker(
    client: Client,
    state: std::sync::Arc<parking_lot::Mutex<BehaviorState>>,
) -> JoinHandle<()> {
    tokio::task::spawn_local(async move {
        let mut interval = tokio::time::interval(TICK_INTERVAL);
        loop {
            interval.tick().await;
            let now = Instant::now();

            let (do_afk, do_movement, do_auto_command, auto_command_text) = {
                let mut s = state.lock();
                let do_afk = s.config.afk_enabled
                    && now.duration_since(s.last_afk_at)
                        >= Duration::from_secs(s.config.afk_interval_seconds.max(5));
                let do_movement = s.config.movement_enabled
                    && now.duration_since(s.last_movement_at) >= Duration::from_secs(8);
                let do_auto_command = s.config.auto_command_enabled
                    && !s.config.auto_command_text.trim().is_empty()
                    && now.duration_since(s.last_auto_command_at)
                        >= Duration::from_secs(s.config.auto_command_interval_minutes.max(1) * 60);

                if do_afk {
                    s.last_afk_at = now;
                }
                if do_movement {
                    s.last_movement_at = now;
                }
                if do_auto_command {
                    s.last_auto_command_at = now;
                }

                (do_afk, do_movement, do_auto_command, s.config.auto_command_text.clone())
            };

            if do_afk {
                run_afk_tick(&client);
            }
            if do_movement {
                run_movement_tick(&client);
            }
            if do_auto_command {
                client.chat(&auto_command_text);
                emit(&OutEvent::BehaviorLog {
                    message: format!("Auto-command sent: {auto_command_text}"),
                });
            }
        }
    })
}

/// Keeps the bot from being kicked for inactivity: looks in a random
/// direction and jumps, without moving away from its current position.
fn run_afk_tick(client: &Client) {
    let mut rng = rand::thread_rng();
    let yaw: f32 = rng.gen_range(-180.0..180.0);
    let pitch: f32 = rng.gen_range(-20.0..20.0);
    let _ = client.set_direction(yaw, pitch);
    client.jump();
}

/// Makes the bot wander a short distance in a random direction, then stop.
fn run_movement_tick(client: &Client) {
    let directions = [
        WalkDirection::Forward,
        WalkDirection::Backward,
        WalkDirection::Left,
        WalkDirection::Right,
    ];
    let direction = directions[rand::thread_rng().gen_range(0..directions.len())];
    client.walk(direction);

    let client = client.clone();
    tokio::task::spawn_local(async move {
        tokio::time::sleep(WALK_DURATION).await;
        client.walk(WalkDirection::None);
    });
}
