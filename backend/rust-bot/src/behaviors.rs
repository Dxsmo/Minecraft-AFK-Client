//! AFK / movement / auto-command behaviors, ported from the Node.js
//! `BehaviorManager` system to run natively inside the Rust bot process.
//!
//! Everything here is driven from `Event::Tick` (fired 20x/second by Azalea
//! while the bot is in a loaded world). This intentionally avoids spawning any
//! Tokio tasks: Azalea runs its ECS systems outside of a Tokio runtime context,
//! so `tokio::spawn`/`spawn_local` from inside an event handler is unreliable.
//! Tick-driven timing keeps behaviors simple, deterministic and cheap.

use std::collections::VecDeque;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use azalea::registry::builtin::BlockKind;
use azalea::block::BlockStates;
use azalea::{BlockPos, Client, WalkDirection};
use azalea_inventory::operations::{PickupClick, ThrowClick};
use azalea_inventory::ItemStack;
use rand::Rng;
use regex::Regex;

use crate::emit;
use crate::protocol::{BehaviorConfig, Config, InventorySlot, OutEvent};

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
/// How long to wait for the server to answer a balance query before giving up.
const BALANCE_TIMEOUT: Duration = Duration::from_secs(5);
/// After an auto-sell command runs, sell-confirmation messages arriving within
/// this window are attributed to auto-sell earnings. Unrelated income (e.g.
/// `/pay`) outside this window is never counted.
const SELL_EARNING_WINDOW: Duration = Duration::from_secs(5);
/// How close (in blocks) a spawner must be for Clean Spawner to interact with
/// it. The bot never walks, so anything beyond normal interaction reach is
/// ignored rather than approached.
const SPAWNER_MAX_REACH: f64 = 5.0;
/// How long to wait for a right-clicked spawner to open its container before
/// giving up on the clean-spawner cycle.
const SPAWNER_MENU_TIMEOUT: Duration = Duration::from_millis(2000);
/// After an inventory move/drop, wait this long before emitting a fresh
/// snapshot so the server's click acknowledgement has been applied and the UI
/// resyncs with the bot's real inventory state.
const INVENTORY_RESYNC_DELAY: Duration = Duration::from_millis(300);

/// Tracks the two-step auto-sell cycle: send the sell command, then move all
/// inventory items into the container the server opens in response.
enum AutoSellPhase {
    Idle,
    WaitingForMenu { since: Instant },
}

/// A one-shot, foreground task. While one is queued or running, the continuous
/// auto-sell loop is paused (it won't start a new cycle), and a queued task
/// only begins once auto-sell is back to `Idle`. This guarantees the bot never
/// runs two menu/inventory interactions at once — the core of the task-interrupt
/// (pause/resume) system. Scheduling/timing lives in Node; this just ensures
/// safe, non-overlapping execution.
enum ForegroundTask {
    /// Send a single chat line (e.g. a scheduled daily command).
    Chat(String),
    /// Send a balance query, then wait for the reply (parsed in `on_chat`).
    Balance(String),
    /// Right-click a nearby spawner and drop the items in its container.
    CleanSpawner,
    /// Move an item between two of the bot's own inventory slots.
    MoveItem { from: u16, to: u16 },
    /// Drop the whole stack in one of the bot's own inventory slots.
    DropItem { slot: u16 },
}

/// A foreground task that is mid-execution and spans multiple ticks.
enum ActiveTask {
    /// Waiting for the server to answer a balance query.
    Balance { deadline: Instant },
    /// Waiting for a right-clicked spawner's container to open.
    CleanSpawner { menu_deadline: Instant },
}

pub struct BehaviorState {
    config: BehaviorConfig,
    last_afk_at: Instant,
    last_movement_at: Instant,
    last_auto_command_at: Instant,
    /// Next due time for random-range auto-command mode.
    next_random_auto_command_at: Option<Instant>,
    /// When `Some`, the bot is currently walking and should stop at this time.
    stop_walking_at: Option<Instant>,
    last_autosell_at: Instant,
    autosell_phase: AutoSellPhase,
    /// When set, sell-confirmation messages until this time count as earnings.
    sell_earning_window: Option<Instant>,
    /// Foreground one-shot tasks awaiting execution (see [`ForegroundTask`]).
    task_queue: VecDeque<ForegroundTask>,
    /// The foreground task currently mid-execution, if any.
    active_task: Option<ActiveTask>,
    /// The last `/tpaccept …` command we sent and when, for de-duplication.
    last_tpaccept: Option<(String, Instant)>,
    /// When set, emit a fresh inventory snapshot at this time (after an
    /// inventory move/drop, so the UI resyncs with the bot's real state once the
    /// click packets have been processed).
    inventory_resync_at: Option<Instant>,
    /// Signature of the last inventory we emitted, so we can push a fresh
    /// snapshot whenever the bot's real inventory changes (e.g. after the server
    /// corrects a rejected click) instead of relying only on a fixed delay.
    last_inventory_sig: Option<u64>,
    last_heartbeat_at: Instant,
}

impl BehaviorState {
    pub fn new(config: &Config) -> Self {
        let now = Instant::now();
        Self {
            config: BehaviorConfig {
                afk_enabled: config.afk_enabled,
                movement_enabled: config.movement_enabled,
                crouch_enabled: config.crouch_enabled,
                afk_interval_seconds: config.afk_interval_seconds,
                auto_command_enabled: config.auto_command_enabled,
                auto_command_text: config.auto_command_text.clone(),
                auto_command_interval_minutes: config.auto_command_interval_minutes,
                auto_command_span_enabled: config.auto_command_span_enabled,
                auto_command_span_min_seconds: config.auto_command_span_min_seconds,
                auto_command_span_max_seconds: config.auto_command_span_max_seconds,
                tpauto_enabled: config.tpauto_enabled,
                tpauto_allowlist: config.tpauto_allowlist.clone(),
                autosell_enabled: config.autosell_enabled,
                autosell_interval_seconds: config.autosell_interval_seconds,
                autosell_command: config.autosell_command.clone(),
            },
            last_afk_at: now,
            last_movement_at: now,
            last_auto_command_at: now,
            next_random_auto_command_at: None,
            stop_walking_at: None,
            last_autosell_at: now,
            autosell_phase: AutoSellPhase::Idle,
            sell_earning_window: None,
            task_queue: VecDeque::new(),
            active_task: None,
            last_tpaccept: None,
            inventory_resync_at: None,
            last_inventory_sig: None,
            last_heartbeat_at: now,
        }
    }

    /// Apply a live settings update (from a `Command::Configure`).
    pub fn update_config(&mut self, config: BehaviorConfig) {
        self.config = config;
        // Re-arm random scheduling from "now" whenever span settings change.
        self.next_random_auto_command_at = None;
    }

    /// Enqueue a scheduled chat command as a foreground one-shot task. Auto-sell
    /// is paused until it runs, then resumed (handled by the tick loop).
    pub fn enqueue_task(&mut self, text: String) {
        let text = text.trim().to_string();
        if !text.is_empty() {
            self.task_queue.push_back(ForegroundTask::Chat(text));
        }
    }

    /// Enqueue a balance query as a foreground one-shot task. Coalesces with any
    /// pending/active balance query so repeated requests don't stack up.
    pub fn enqueue_balance(&mut self, command: String) {
        let command = command.trim().to_string();
        let command = if command.is_empty() { "/balance".to_string() } else { command };
        let already_pending = matches!(self.active_task, Some(ActiveTask::Balance { .. }))
            || self
                .task_queue
                .iter()
                .any(|t| matches!(t, ForegroundTask::Balance(_)));
        if !already_pending {
            self.task_queue.push_back(ForegroundTask::Balance(command));
        }
    }

    /// Enqueue a clean-spawner run as a foreground one-shot task. Coalesces with
    /// any pending/active clean-spawner task so repeated clicks don't stack up.
    pub fn enqueue_clean_spawner(&mut self) {
        let already_pending = matches!(self.active_task, Some(ActiveTask::CleanSpawner { .. }))
            || self
                .task_queue
                .iter()
                .any(|t| matches!(t, ForegroundTask::CleanSpawner));
        if !already_pending {
            self.task_queue.push_back(ForegroundTask::CleanSpawner);
        }
    }

    /// Enqueue an inventory move as a foreground one-shot task so it never runs
    /// concurrently with auto-sell or another Minecraft action.
    pub fn enqueue_move_item(&mut self, from: u16, to: u16) {
        self.task_queue
            .push_back(ForegroundTask::MoveItem { from, to });
    }

    /// Enqueue an inventory drop as a foreground one-shot task.
    pub fn enqueue_drop_item(&mut self, slot: u16) {
        self.task_queue.push_back(ForegroundTask::DropItem { slot });
    }

    /// Emit a live snapshot of the bot's own inventory. Read-only, so it is not
    /// routed through the task queue.
    pub fn emit_inventory(&self, bot: &Client) {
        emit_inventory_snapshot(bot);
    }

    /// True while a foreground one-shot task is queued or running; auto-sell must
    /// not start a new cycle in this state.
    fn foreground_busy(&self) -> bool {
        self.active_task.is_some() || !self.task_queue.is_empty()
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

        // Crouch: continuously hold sneak while enabled. Only send a state
        // change when the desired value differs from the bot's current one, so
        // we don't spam the server with a packet every tick.
        if self.config.crouch_enabled != bot.crouching() {
            let _ = bot.set_crouching(self.config.crouch_enabled);
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
        // interval, independent of the AFK/movement behaviors. "Zeitspanne"
        // (random-range) mode is its own independent toggle, so it must run
        // even if the fixed-interval "Interval" toggle is off.
        if self.config.auto_command_enabled || self.config.auto_command_span_enabled {
            let text = self.config.auto_command_text.trim().to_string();
            if !text.is_empty() {
                if self.config.auto_command_span_enabled {
                    if self.next_random_auto_command_at.is_none() {
                        self.next_random_auto_command_at =
                            Some(now + random_auto_command_delay(&self.config));
                    }
                    if now >= self.next_random_auto_command_at.expect("set above") {
                        bot.chat(text.clone());
                        self.next_random_auto_command_at =
                            Some(now + random_auto_command_delay(&self.config));
                        emit(&OutEvent::BehaviorLog {
                            message: format!("Auto-command sent (random range): {text}"),
                        });
                    }
                } else {
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
        } else {
            self.next_random_auto_command_at = None;
        }

        self.tick_foreground(bot, now);
        self.tick_autosell(bot, now);

        // Deferred inventory resync after a move/drop, so the UI reflects the
        // bot's real inventory once the server has acknowledged the click.
        if let Some(at) = self.inventory_resync_at {
            if now >= at {
                self.inventory_resync_at = None;
                emit_inventory_snapshot(bot);
                self.last_inventory_sig = inventory_signature(bot);
            }
        }

        // Push a fresh snapshot whenever the bot's real inventory changes (item
        // pickups, server corrections of a rejected click, etc.). This is what
        // keeps a dropped stack from lingering as a "ghost" in the UI: once the
        // server sends its authoritative slot update, we detect it and re-emit.
        if let Some(sig) = inventory_signature(bot) {
            if self.last_inventory_sig != Some(sig) {
                self.last_inventory_sig = Some(sig);
                emit_inventory_snapshot(bot);
            }
        }

        // Heartbeat: prove the tick loop is alive so the supervisor can recycle
        // a genuinely hung bot without killing a healthy but idle one.
        if now.duration_since(self.last_heartbeat_at) >= HEARTBEAT_INTERVAL {
            self.last_heartbeat_at = now;
            emit(&OutEvent::Heartbeat);
        }
    }

    /// Drives the foreground one-shot task queue (the task-interrupt system).
    /// A queued task only starts once auto-sell is idle, so menu/inventory
    /// interactions never overlap; instant tasks (a chat command) complete in
    /// the same tick, while multi-tick tasks (a balance query) become the
    /// `active_task` until they finish or time out.
    fn tick_foreground(&mut self, bot: &Client, now: Instant) {
        // Advance an in-progress multi-tick task.
        match &self.active_task {
            Some(ActiveTask::Balance { deadline }) => {
                if now >= *deadline {
                    emit(&OutEvent::BehaviorLog {
                        message: "Balance: no reply from the server (timed out)".into(),
                    });
                    self.active_task = None;
                }
            }
            Some(ActiveTask::CleanSpawner { menu_deadline }) => {
                let menu_deadline = *menu_deadline;
                if self.try_clean_spawner_container(bot) {
                    self.active_task = None;
                } else if now >= menu_deadline {
                    emit(&OutEvent::BehaviorLog {
                        message: "CleanSpawner: no container opened (timed out)".into(),
                    });
                    self.active_task = None;
                }
            }
            None => {}
        }

        // Start the next queued task, but only when nothing is active and
        // auto-sell isn't mid-cycle — this is what enforces mutual exclusion.
        if self.active_task.is_none() && matches!(self.autosell_phase, AutoSellPhase::Idle) {
            if let Some(task) = self.task_queue.pop_front() {
                match task {
                    ForegroundTask::Chat(text) => {
                        bot.chat(text.clone());
                        emit(&OutEvent::BehaviorLog {
                            message: format!("Scheduled command sent: {text}"),
                        });
                    }
                    ForegroundTask::Balance(command) => {
                        bot.chat(command.clone());
                        self.active_task = Some(ActiveTask::Balance {
                            deadline: now + BALANCE_TIMEOUT,
                        });
                    }
                    ForegroundTask::CleanSpawner => match find_spawner_in_reach(bot) {
                        Some(pos) => {
                            // Right-click the spawner in place — never walk to it.
                            bot.block_interact(pos);
                            emit(&OutEvent::BehaviorLog {
                                message: format!(
                                    "CleanSpawner: opening spawner at {}, {}, {}",
                                    pos.x, pos.y, pos.z
                                ),
                            });
                            self.active_task = Some(ActiveTask::CleanSpawner {
                                menu_deadline: now + SPAWNER_MENU_TIMEOUT,
                            });
                        }
                        None => emit(&OutEvent::BehaviorLog {
                            message: "Finden von Spawner fehlgeschlagen".into(),
                        }),
                    },
                    ForegroundTask::MoveItem { from, to } => {
                        if inventory_is_mutable(bot) {
                            // Pick the stack up from `from`, then put it down on
                            // `to` — two left clicks, exactly like a player would.
                            let inv = bot.get_inventory().expect("inventory present");
                            inv.click(PickupClick::Left { slot: Some(from) });
                            inv.click(PickupClick::Left { slot: Some(to) });
                            self.inventory_resync_at = Some(now + INVENTORY_RESYNC_DELAY);
                        } else {
                            emit(&OutEvent::BehaviorLog {
                                message: "Inventory move ignored: a container is open".into(),
                            });
                            emit_inventory_snapshot(bot);
                        }
                    }
                    ForegroundTask::DropItem { slot } => {
                        if inventory_is_mutable(bot) {
                            let inv = bot.get_inventory().expect("inventory present");
                            inv.click(ThrowClick::All { slot });
                            self.inventory_resync_at = Some(now + INVENTORY_RESYNC_DELAY);
                        } else {
                            emit(&OutEvent::BehaviorLog {
                                message: "Inventory drop ignored: a container is open".into(),
                            });
                            emit_inventory_snapshot(bot);
                        }
                    }
                }
            }
        }
    }

    /// If the spawner's container is open, drop all its items and close it.
    /// Returns true once the container has been processed (or was never the
    /// player's own inventory), false while still waiting for it to open.
    ///
    /// Only the container's own slots are dropped (the player's 36 slots are the
    /// last slots of the menu and are left untouched). The task finishes once
    /// the 3rd slot of the top row (container slot index 2) is empty, matching
    /// the requested stop condition.
    fn try_clean_spawner_container(&mut self, bot: &Client) -> bool {
        let Ok(inv) = bot.get_inventory() else {
            return false;
        };
        // id 0 == the player's own inventory: the spawner GUI hasn't opened yet.
        if inv.id() == 0 {
            return false;
        }

        let mut dropped = 0usize;
        if let Some(slots) = inv.slots() {
            let container_len = slots.len().saturating_sub(36);
            // Stop condition: as soon as the 3rd slot in the top row is empty.
            if container_len > 2 && !slots[2].is_present() {
                inv.close();
                emit(&OutEvent::BehaviorLog {
                    message: "Spawner aufgeräumt und geschlossen".into(),
                });
                return true;
            }
            for slot in 0..container_len {
                if slots[slot].is_present() {
                    inv.click(ThrowClick::All { slot: slot as u16 });
                    dropped += 1;
                }
            }
        }
        if dropped > 0 {
            emit(&OutEvent::BehaviorLog {
                message: format!("CleanSpawner: dropped {dropped} stack(s)"),
            });
        }
        false
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
                // Don't start a new cycle while a foreground one-shot task is
                // queued or running — this is the "pause" half of the interrupt
                // system. An in-progress cycle below is always allowed to finish.
                if self.foreground_busy() {
                    return;
                }
                let interval = Duration::from_secs(self.config.autosell_interval_seconds.max(1));
                if now.duration_since(self.last_autosell_at) >= interval {
                    self.last_autosell_at = now;
                    let command = self.config.autosell_command.trim();
                    let command = if command.is_empty() { "/sell" } else { command };
                    bot.chat(command.to_string());
                    // Open the earnings-attribution window: sell confirmations
                    // arriving shortly after this command count as earnings.
                    self.sell_earning_window = Some(now + SELL_EARNING_WINDOW);
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
                            if sold > 0 {
                                self.sell_earning_window = Some(now + SELL_EARNING_WINDOW);
                            }
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
        // Balance reply: while a balance query is in flight, the next chat line
        // carrying a money amount is the answer.
        if matches!(self.active_task, Some(ActiveTask::Balance { .. })) {
            if let Some(balance) = parse_balance(message) {
                self.active_task = None;
                emit(&OutEvent::Balance {
                    balance,
                    raw: message.to_string(),
                });
            }
        }

        // Auto-sell earnings: attribute sell-confirmation amounts arriving in the
        // short window after a sell command. Nothing outside that window (e.g.
        // `/pay` income) is ever counted.
        if let Some(until) = self.sell_earning_window {
            if Instant::now() <= until {
                if let Some(amount) = parse_sell_amount(message) {
                    emit(&OutEvent::SellEarning {
                        amount,
                        raw: message.to_string(),
                    });
                }
            }
        }

        if !self.config.tpauto_enabled {
            return;
        }
        let Some(command) = parse_tpa_accept_command(message) else {
            return;
        };

        // Optional allowlist: when configured, only accept requests from the
        // named players. The requester's name is the first real argument of the
        // suggested `/tpaccept …` command (e.g. "/tpaccept Desmodus tpa").
        if !self.config.tpauto_allowlist.is_empty() {
            let target = tpaccept_target_name(&command);
            let allowed = target.as_deref().is_some_and(|name| {
                self.config
                    .tpauto_allowlist
                    .iter()
                    .any(|allowed| allowed.trim().eq_ignore_ascii_case(name))
            });
            if !allowed {
                emit(&OutEvent::BehaviorLog {
                    message: format!(
                        "TPAuto: ignored teleport request from {} (not in allowlist)",
                        target.as_deref().unwrap_or("unknown")
                    ),
                });
                return;
            }
        }

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

/// Whether the bot's own inventory is currently mutable, i.e. no external
/// container GUI is open (a container occupies the same click channel, so we
/// refuse inventory edits while one is open).
fn inventory_is_mutable(bot: &Client) -> bool {
    matches!(bot.get_inventory(), Ok(inv) if inv.id() == 0)
}

fn random_auto_command_delay(cfg: &BehaviorConfig) -> Duration {
    let mut min_s = cfg.auto_command_span_min_seconds.max(1);
    let mut max_s = cfg.auto_command_span_max_seconds.max(1);
    if min_s > max_s {
        std::mem::swap(&mut min_s, &mut max_s);
    }
    let seconds = if min_s == max_s {
        min_s
    } else {
        rand::thread_rng().gen_range(min_s..=max_s)
    };
    Duration::from_secs(seconds)
}

/// A cheap signature of the bot's current menu inventory (menu id + each slot's
/// item kind and count). Changes whenever the real inventory changes, which lets
/// the tick loop re-emit a snapshot so the UI never shows a stale "ghost" slot.
fn inventory_signature(bot: &Client) -> Option<u64> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let inv = bot.get_inventory().ok()?;
    let slots = inv.slots()?;
    let mut hasher = DefaultHasher::new();
    inv.id().hash(&mut hasher);
    for stack in slots.iter() {
        if stack.is_present() {
            stack.kind().to_str().hash(&mut hasher);
            stack.count().hash(&mut hasher);
        } else {
            0u8.hash(&mut hasher);
        }
    }
    Some(hasher.finish())
}

/// Convert an item stack into a snapshot slot, or `None` if the slot is empty.
fn slot_to_snapshot(stack: &ItemStack) -> Option<InventorySlot> {
    if stack.is_present() {
        Some(InventorySlot {
            id: stack.kind().to_str().to_string(),
            count: stack.count().max(0) as u32,
        })
    } else {
        None
    }
}

/// Read the bot's own inventory and emit an [`OutEvent::Inventory`] snapshot.
///
/// The player inventory menu lays its 46 slots out as: craft result (0), craft
/// grid (1-4), armor (5-8), inventory (9-44: 27 main + 9 hotbar) and off-hand
/// (45). We surface the storage, hotbar, armor and off-hand slots. When a
/// container GUI is open the player's own inventory is the *last* 36 menu slots;
/// we still show those, but mark the snapshot immutable.
fn emit_inventory_snapshot(bot: &Client) {
    let Ok(inv) = bot.get_inventory() else {
        return;
    };
    let Some(slots) = inv.slots() else {
        return;
    };
    let n = slots.len();
    if n < 36 {
        return;
    }
    let mutable = inv.id() == 0;

    // Slot layout differs between the player's own inventory menu and a container.
    //
    // Player inventory menu (id 0, 46 slots):
    //   0 craft-out · 1-4 craft · 5-8 armor · 9-35 storage · 36-44 hotbar · 45 offhand
    // Any other (container) menu appends the player's 27 storage + 9 hotbar as the
    // final 36 slots (no armor/offhand), so "last 36" is only correct there.
    let (main, hotbar, armor, offhand): (
        Vec<Option<InventorySlot>>,
        Vec<Option<InventorySlot>>,
        Vec<Option<InventorySlot>>,
        Option<InventorySlot>,
    ) = if mutable && n >= 46 {
        (
            slots[9..36].iter().map(slot_to_snapshot).collect(),
            slots[36..45].iter().map(slot_to_snapshot).collect(),
            slots[5..9].iter().map(slot_to_snapshot).collect(),
            slot_to_snapshot(&slots[45]),
        )
    } else {
        let player = &slots[n - 36..n];
        (
            player[0..27].iter().map(slot_to_snapshot).collect(),
            player[27..36].iter().map(slot_to_snapshot).collect(),
            vec![None; 4],
            None,
        )
    };

    emit(&OutEvent::Inventory {
        main,
        hotbar,
        offhand,
        armor,
        mutable,
    });
}

/// Finds the nearest mob/trial spawner to the bot that is within interaction
/// reach, or `None` if there is none nearby. The bot never moves toward it — a
/// spawner outside [`SPAWNER_MAX_REACH`] is simply ignored.
fn find_spawner_in_reach(bot: &Client) -> Option<BlockPos> {
    let position = bot.position().ok()?;
    let world = bot.world().ok()?;
    let world = world.read();
    let states = BlockStates::from([BlockKind::Spawner, BlockKind::TrialSpawner]);
    let found = world.find_block(position, &states)?;

    let dx = (found.x as f64 + 0.5) - position.x;
    let dy = (found.y as f64 + 0.5) - position.y;
    let dz = (found.z as f64 + 0.5) - position.z;
    let distance = (dx * dx + dy * dy + dz * dz).sqrt();
    if distance <= SPAWNER_MAX_REACH {
        Some(found)
    } else {
        None
    }
}

/// Extracts a monetary amount from `text`, preferring a `$`-prefixed number and
/// otherwise falling back to the first plausible number. Thousands separators
/// (commas) are stripped; an optional decimal part is kept.
fn extract_money(text: &str) -> Option<f64> {
    static DOLLAR: OnceLock<Regex> = OnceLock::new();
    static NUMBER: OnceLock<Regex> = OnceLock::new();
    let dollar = DOLLAR.get_or_init(|| Regex::new(r"\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)").unwrap());
    let number = NUMBER.get_or_init(|| Regex::new(r"([0-9][0-9,]*(?:\.[0-9]+)?)").unwrap());

    let cap = dollar
        .captures(text)
        .or_else(|| number.captures(text))?;
    let raw = cap.get(1)?.as_str().replace(',', "");
    raw.parse::<f64>().ok()
}

/// Parses the player's balance from a server reply to a balance query. Requires
/// a currency hint so unrelated numeric chatter isn't misread as a balance.
fn parse_balance(text: &str) -> Option<f64> {
    let lower = text.to_lowercase();
    let looks_like_balance = text.contains('$')
        || lower.contains("balance")
        || lower.contains("money")
        || lower.contains("coins")
        || lower.contains("guthaben")
        || lower.contains("kontostand");
    if !looks_like_balance {
        return None;
    }
    extract_money(text)
}

/// Parses money earned from an auto-sell confirmation line. Requires a sell-verb
/// keyword and excludes transfer income (`/pay`) so only genuine sell earnings
/// are counted.
fn parse_sell_amount(text: &str) -> Option<f64> {
    let lower = text.to_lowercase();
    let is_sale = lower.contains("sold")
        || lower.contains("sale")
        || lower.contains("selling")
        || lower.contains("verkauft")
        || lower.contains("verkauf")
        // Servers often format sell payouts as a plain "+$X" line with base/bonus
        // details and no explicit "sold" keyword.
        || lower.contains("+$")
        || lower.contains("+ $")
        || lower.contains("bonus");
    let is_transfer = lower.contains("pay")
        || lower.contains("paid")
        || lower.contains("bezahlt")
        || lower.contains("erhalten von");
    if !is_sale || is_transfer {
        return None;
    }
    extract_money(text)
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

/// Extracts the requester's Minecraft name from a reconstructed `/tpaccept …`
/// command — the first argument that isn't a `tpa`/`tpahere` flag. Returns
/// `None` for a bare `/tpaccept`.
fn tpaccept_target_name(command: &str) -> Option<String> {
    command
        .split_whitespace()
        .skip(1) // "/tpaccept"
        .find(|t| !t.eq_ignore_ascii_case("tpa") && !t.eq_ignore_ascii_case("tpahere"))
        .map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::{parse_balance, parse_sell_amount, parse_tpa_accept_command, tpaccept_target_name};

    #[test]
    fn balance_dollar_with_commas() {
        assert_eq!(parse_balance("Balance: $12,450"), Some(12450.0));
        assert_eq!(parse_balance("Your balance is $1,234.56"), Some(1234.56));
        assert_eq!(parse_balance("You have 8000 coins"), Some(8000.0));
    }

    #[test]
    fn balance_ignores_non_currency_lines() {
        assert_eq!(parse_balance("Player joined at 12:00"), None);
        assert_eq!(parse_balance("You have 5 new messages"), None);
    }

    #[test]
    fn sell_amount_counts_sales_only() {
        assert_eq!(
            parse_sell_amount("You sold 64 cobblestone for $500"),
            Some(500.0)
        );
        assert_eq!(parse_sell_amount("Verkauft für $1,250"), Some(1250.0));
        assert_eq!(
            parse_sell_amount("CHAT <HUGE> +$14,492.50 (Basis: $8,525.00, Bonus: +$5,967.50 durch 1.7x)"),
            Some(14492.50)
        );
    }

    #[test]
    fn sell_amount_excludes_transfers() {
        assert_eq!(parse_sell_amount("Desmodus paid you $9000"), None);
        assert_eq!(parse_sell_amount("You received $100 from Steve"), None);
        assert_eq!(parse_sell_amount("Welcome to the server!"), None);
    }

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

    #[test]
    fn target_name_from_command() {
        assert_eq!(
            tpaccept_target_name("/tpaccept Desmodus tpa").as_deref(),
            Some("Desmodus")
        );
        assert_eq!(tpaccept_target_name("/tpaccept").as_deref(), None);
    }
}
