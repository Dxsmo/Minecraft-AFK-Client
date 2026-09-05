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

use azalea::container::ContainerHandleRef;
use azalea::registry::builtin::BlockKind;
use azalea::{BlockPos, Client, WalkDirection};
use azalea_inventory::components::{CustomName, Lore};
use azalea_inventory::operations::{PickupClick, ThrowClick};
use azalea_inventory::ItemStack;
use rand::Rng;
use regex::Regex;

use crate::emit;
use crate::protocol::{BehaviorConfig, Config, InventorySlot, OutEvent, SettingEntry};

/// How long the bot keeps walking in one direction before stopping again.
const WALK_DURATION: Duration = Duration::from_secs(2);
/// Minimum time between two random movement bursts.
const MOVEMENT_INTERVAL: Duration = Duration::from_secs(8);
/// Give the server this long to open its sell menu after the sell command is
/// sent before giving up on the current auto-sell cycle.
///
/// This used to be 1.5s, which is below the round-trip time of a busy server:
/// the menu then opened *after* the cycle had already been abandoned, so the
/// next cycle found a "lingering" menu, closed it and sent the command again —
/// selling nothing while spamming chat forever.
const AUTOSELL_MENU_TIMEOUT: Duration = Duration::from_millis(4000);
/// Once the sell container opens, wait this long before shift-clicking so the
/// server has synced the container's slot contents. Without this settle delay
/// the player slots can still read as empty the instant the menu opens, so the
/// cycle would sell nothing and close — the "opens menu but sells nothing" stall.
const AUTOSELL_SETTLE_DELAY: Duration = Duration::from_millis(250);
/// Pause between shifting items into the sell menu and pressing its confirm
/// button, so the server has processed the shift-clicks before the sale fires.
const AUTOSELL_CONFIRM_DELAY: Duration = Duration::from_millis(250);
/// Hard stop for a single sell cycle. However the server misbehaves, the menu
/// is closed and the cycle abandoned after this, so the bot can never get stuck
/// in an open GUI.
const AUTOSELL_RUN_TIMEOUT: Duration = Duration::from_secs(15);
/// Consecutive failed cycles tolerated before the retry delay starts growing.
/// Generous on purpose: a single hiccup (server lag, a menu that closed itself)
/// must not slow selling down, only a persistent problem should.
const AUTOSELL_FAILURE_GRACE: u32 = 5;
/// Shortest retry delay once auto-sell has started backing off.
const AUTOSELL_BACKOFF_BASE: Duration = Duration::from_secs(10);
/// Longest retry delay. Once here, the sell command is sent at most this often,
/// which keeps a permanently broken sell menu from flooding the server's chat.
/// Deliberately capped at a minute so auto-sell always comes back on its own.
const AUTOSELL_BACKOFF_MAX: Duration = Duration::from_secs(60);
/// How many shift-click passes one cycle makes over the player's inventory.
/// More than one because a pass can leave items behind while the server is
/// still processing the previous clicks.
const AUTOSELL_FILL_PASSES: u32 = 3;
/// Keywords identifying the sell menu's confirm button by item name/lore.
const SELL_CONFIRM_KEYWORDS: [&str; 6] = ["verkauf", "sell", "bestätig", "bestatig", "confirm", "accept"];
/// How often to re-assert the crouch (sneak) state while crouch is enabled.
/// A death/respawn or server switch silently resets sneak server-side while the
/// client still thinks it's crouching, so a plain diff-check never re-sends it.
/// Periodically forcing the packet recovers the crouch without spamming it.
const CROUCH_REASSERT_INTERVAL: Duration = Duration::from_secs(3);
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
/// How long to wait for a right-clicked spawner to open its container before
/// giving up on the clean-spawner cycle.
const SPAWNER_MENU_TIMEOUT: Duration = Duration::from_millis(2000);
/// Pause between two clicks while clearing a spawner, so the server has applied
/// the previous batch before the container is re-read.
const SPAWNER_STEP_DELAY: Duration = Duration::from_millis(400);
/// How many spawner steps may pass without reducing the item count before the
/// current stage is abandoned.
const SPAWNER_MAX_STALLS: u32 = 4;
/// Hard upper bound on a whole clean-spawner run. Without this a stage whose
/// item count merely oscillates (e.g. a mis-detected sell button that picks a
/// stack up and puts it back) would reset its stall counter forever, leaving
/// `active_task` occupied — which also starves the foreground queue and
/// auto-sell. The run is always torn down once this elapses.
const SPAWNER_RUN_TIMEOUT: Duration = Duration::from_secs(90);
/// Hard upper bound on the number of steps a single clean-spawner run may take,
/// as a second backstop that does not depend on wall-clock time.
const SPAWNER_MAX_STEPS: u32 = 200;
/// How many stacks of a handled item type are left in the spawner. "Fewer than
/// two stacks" from the requirements means exactly one stack may remain.
const SPAWNER_KEEP_STACKS: usize = 1;
/// Keywords identifying the spawner GUI's sell button by item name/lore.
const SPAWNER_SELL_KEYWORDS: [&str; 6] = ["verkauf", "sell", "vend", "money", "geld", "$"];
/// How long to wait for the server to open its settings GUI after the settings
/// command is sent before giving up on a scan/toggle.
const SETTINGS_MENU_TIMEOUT: Duration = Duration::from_millis(2500);
/// After clicking a settings toggle, wait this long for the server to update the
/// button in place before re-scanning and reporting the refreshed state.
const SETTINGS_CLICK_SETTLE: Duration = Duration::from_millis(500);
/// After an inventory move/drop, wait this long before emitting a fresh
/// snapshot so the server's click acknowledgement has been applied and the UI
/// resyncs with the bot's real inventory state.
const INVENTORY_RESYNC_DELAY: Duration = Duration::from_millis(300);

/// Tracks one auto-sell cycle. Each cycle opens the sell menu, fills it,
/// confirms the sale and closes the menu again ("open/close principle") — the
/// menu is never left open between cycles, so the bot's GUI is free for chat,
/// scheduled commands and the spawner tasks in between.
enum AutoSellPhase {
    Idle,
    WaitingForMenu {
        since: Instant,
        /// Occupied player slots when the cycle started, used to tell at the end
        /// whether anything was actually sold.
        before: usize,
    },
    /// The sell container is open and this cycle is being executed.
    Selling {
        /// Container slot index of the menu's confirm ("sell") button.
        confirm_slot: u16,
        /// Container slots that were already occupied when the menu opened, i.e.
        /// the server's own decoration and buttons. Anything appearing outside
        /// this set is our own unsold goods.
        baseline: Vec<u16>,
        stage: SellStage,
        /// Abort the cycle at this time no matter which stage it's in.
        deadline: Instant,
        /// Occupied player slots when the cycle started.
        before: usize,
    },
}

/// The steps of one auto-sell cycle, in order.
enum SellStage {
    /// Shift the player's items into the open sell menu at this time.
    Fill { at: Instant, passes: u32 },
    /// Press the menu's confirm button at this time (if there is anything left
    /// to confirm).
    Confirm { at: Instant },
    /// Close the menu at this time and end the cycle.
    Close { at: Instant },
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
    /// Open the server's settings GUI and scan its toggle buttons. When
    /// `target` is set, also click the matching button so it reaches the desired
    /// state. `command` is the chat command that opens the menu (e.g. "/settings").
    Settings {
        command: String,
        target: Option<(String, bool)>,
    },
}

/// A foreground task that is mid-execution and spans multiple ticks.
enum ActiveTask {
    /// Waiting for the server to answer a balance query.
    Balance { deadline: Instant },
    /// Driving the spawner clear-out: waiting for the container, then dropping
    /// the configured item types, then selling the rest via the spawner's own
    /// sell button.
    CleanSpawner(SpawnerProgress),
    /// Interacting with the server's settings GUI: waiting for it to open, then
    /// (optionally) clicking a button and re-scanning after it settles.
    Settings {
        menu_deadline: Instant,
        target: Option<(String, bool)>,
        /// When set, a toggle was just clicked; re-scan and finish once elapsed.
        click_settle: Option<Instant>,
    },
}

/// The ordered steps of a spawner clear-out. Dropping is always completed
/// before selling starts, exactly as requested.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SpawnerStage {
    /// Waiting for the right-clicked spawner's container to appear.
    WaitMenu,
    /// Throwing the "drop" item types out of the spawner.
    Dropping,
    /// Pressing the spawner's sell button for the "sell" item types.
    Selling,
}

/// Bookkeeping for an in-flight spawner clear-out.
#[derive(Clone, Copy)]
struct SpawnerProgress {
    /// Deadline for the container to appear at all; irrelevant once it has.
    menu_deadline: Instant,
    /// Absolute deadline for the entire run, enforced even after the container
    /// opened so a run can never occupy `active_task` indefinitely.
    run_deadline: Instant,
    /// Total steps taken so far, capped by [`SPAWNER_MAX_STEPS`].
    steps: u32,
    stage: SpawnerStage,
    /// Earliest time the next click may be sent (paces clicks so the server can
    /// apply the previous ones before we re-read the container).
    next_at: Instant,
    /// Matching stacks counted at the previous step, used to detect a stage that
    /// stops making progress (e.g. the server refuses the clicks).
    last_count: usize,
    /// Consecutive steps without progress; aborts the stage at
    /// [`SPAWNER_MAX_STALLS`].
    stalls: u32,
    dropped: usize,
    sold: usize,
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
    /// Consecutive auto-sell cycles that sold nothing (menu never opened, or it
    /// opened but no item could be moved into it). Drives the backoff below.
    autosell_failures: u32,
    /// While set, no sell command is sent before this time. This is the guard
    /// against the chat-spam loop: without it a server that stops opening the
    /// sell menu makes the bot repeat the command every interval indefinitely,
    /// which floods chat and gets the account muted by the server's anti-spam.
    autosell_retry_at: Option<Instant>,
    /// Whether the current failure/idle streak has already been logged, so the
    /// console shows one line per streak instead of one per attempt.
    autosell_streak_logged: bool,
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
    /// Last time we force-re-asserted the crouch state (see CROUCH_REASSERT_INTERVAL).
    last_crouch_reassert_at: Instant,
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
                spawner_type: config.spawner_type.clone(),
                spawner_drop_items: config.spawner_drop_items.clone(),
                spawner_sell_items: config.spawner_sell_items.clone(),
            },
            last_afk_at: now,
            last_movement_at: now,
            last_auto_command_at: now,
            next_random_auto_command_at: None,
            stop_walking_at: None,
            last_autosell_at: now,
            autosell_phase: AutoSellPhase::Idle,
            autosell_failures: 0,
            autosell_retry_at: None,
            autosell_streak_logged: false,
            sell_earning_window: None,
            task_queue: VecDeque::new(),
            active_task: None,
            last_tpaccept: None,
            inventory_resync_at: None,
            last_inventory_sig: None,
            last_heartbeat_at: now,
            last_crouch_reassert_at: now,
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

    /// Enqueue a settings-menu scan (no toggle) as a foreground one-shot task.
    pub fn enqueue_scan_settings(&mut self, command: String) {
        let command = normalize_settings_command(command);
        self.task_queue
            .push_back(ForegroundTask::Settings { command, target: None });
    }

    /// Enqueue a settings-menu toggle: open the menu and set the button whose
    /// label matches `label` to `enabled`. Runs as a foreground one-shot task.
    pub fn enqueue_set_setting(&mut self, command: String, label: String, enabled: bool) {
        let command = normalize_settings_command(command);
        self.task_queue.push_back(ForegroundTask::Settings {
            command,
            target: Some((label.trim().to_string(), enabled)),
        });
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

        // Crouch: continuously hold sneak while enabled. Normally we only send a
        // state change when the desired value differs from the bot's current one
        // (to avoid spamming a packet every tick). But a death/respawn or server
        // switch resets sneak server-side while `bot.crouching()` still reports
        // `true`, so the diff-check alone would never recover it. To fix that we
        // also force-re-assert the crouch every CROUCH_REASSERT_INTERVAL.
        if self.config.crouch_enabled {
            if !bot.crouching()
                || now.duration_since(self.last_crouch_reassert_at) >= CROUCH_REASSERT_INTERVAL
            {
                let _ = bot.set_crouching(true);
                self.last_crouch_reassert_at = now;
            }
        } else if bot.crouching() {
            let _ = bot.set_crouching(false);
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
            Some(ActiveTask::CleanSpawner(progress)) => {
                let progress = *progress;
                self.advance_clean_spawner(bot, now, progress);
            }
            Some(ActiveTask::Settings {
                menu_deadline,
                target,
                click_settle,
            }) => {
                let menu_deadline = *menu_deadline;
                let target = target.clone();
                let click_settle = *click_settle;
                self.advance_settings(bot, now, menu_deadline, target, click_settle);
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
                            self.active_task = Some(ActiveTask::CleanSpawner(SpawnerProgress {
                                menu_deadline: now + SPAWNER_MENU_TIMEOUT,
                                run_deadline: now + SPAWNER_RUN_TIMEOUT,
                                steps: 0,
                                stage: SpawnerStage::WaitMenu,
                                next_at: now,
                                last_count: usize::MAX,
                                stalls: 0,
                                dropped: 0,
                                sold: 0,
                            }));
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
                    ForegroundTask::Settings { command, target } => {
                        // Open the settings GUI; the rest is handled tick-by-tick
                        // by advance_settings once the container appears.
                        bot.chat(command.clone());
                        emit(&OutEvent::BehaviorLog {
                            message: format!("Settings: opening menu ({command})"),
                        });
                        self.active_task = Some(ActiveTask::Settings {
                            menu_deadline: now + SETTINGS_MENU_TIMEOUT,
                            target,
                            click_settle: None,
                        });
                    }
                }
            }
        }
    }

    /// Drive the settings-menu foreground task: wait for the GUI to open, scan
    /// its toggle buttons, optionally click the one matching `target` to reach
    /// the desired state, and emit an [`OutEvent::SettingsMenu`] snapshot. The
    /// button is located by matching its label text (positions vary per account).
    fn advance_settings(
        &mut self,
        bot: &Client,
        now: Instant,
        menu_deadline: Instant,
        target: Option<(String, bool)>,
        click_settle: Option<Instant>,
    ) {
        let Ok(inv) = bot.get_inventory() else {
            return;
        };
        let menu_open = inv.id() != 0 && inv.slots().map(|s| s.len() > 36).unwrap_or(false);

        // Post-click phase: wait for the server to update the button in place,
        // then re-scan and report the fresh state.
        if let Some(settle) = click_settle {
            if now < settle && menu_open {
                return;
            }
            if menu_open {
                if let Some(slots) = inv.slots() {
                    emit_settings(&scan_settings_entries(&slots));
                }
                inv.close();
            }
            self.active_task = None;
            return;
        }

        if !menu_open {
            if now >= menu_deadline {
                emit(&OutEvent::Warning {
                    message: "Settings: menu did not open".into(),
                });
                self.active_task = None;
            }
            return;
        }

        let slots = inv.slots().unwrap_or_default();
        let entries = scan_settings_entries(&slots);

        if let Some((label, desired)) = &target {
            match entries.iter().find(|(_, l, _)| l.eq_ignore_ascii_case(label)) {
                Some((slot, found_label, current)) => {
                    if *current != *desired {
                        inv.left_click(*slot);
                        emit(&OutEvent::BehaviorLog {
                            message: format!(
                                "Settings: toggled '{found_label}' -> {}",
                                if *desired { "Aktiviert" } else { "Deaktiviert" }
                            ),
                        });
                        // Re-scan after the click settles, then finish.
                        self.active_task = Some(ActiveTask::Settings {
                            menu_deadline,
                            target: None,
                            click_settle: Some(now + SETTINGS_CLICK_SETTLE),
                        });
                        return;
                    }
                    emit(&OutEvent::BehaviorLog {
                        message: format!(
                            "Settings: '{found_label}' already {}",
                            if *desired { "Aktiviert" } else { "Deaktiviert" }
                        ),
                    });
                }
                None => emit(&OutEvent::Warning {
                    message: format!("Settings: button '{label}' not found in menu"),
                }),
            }
        }

        // No toggle needed (scan-only, already-correct, or not found): report the
        // current state and close the menu.
        emit_settings(&entries);
        inv.close();
        self.active_task = None;
    }

    /// Drives one tick of a spawner clear-out.
    ///
    /// Once the spawner's container is open the configured item types are
    /// handled in a fixed order: every "drop" type is thrown out first, then
    /// every "sell" type is sold through the spawner's own sell button. Both
    /// stop as soon as fewer than two stacks of that type are left, so the
    /// spawner keeps its stock. Accounts without a configured spawner type fall
    /// back to the previous behavior of emptying the container completely.
    fn advance_clean_spawner(&mut self, bot: &Client, now: Instant, mut p: SpawnerProgress) {
        let Ok(inv) = bot.get_inventory() else { return };
        // id 0 == the player's own inventory: the spawner GUI hasn't opened yet.
        if inv.id() == 0 {
            if now >= p.menu_deadline {
                emit(&OutEvent::BehaviorLog {
                    message: "CleanSpawner: no container opened (timed out)".into(),
                });
                self.active_task = None;
            }
            return;
        }

        // Hard stop for the whole run. This must be checked with the container
        // open too: it is the only guarantee that the task releases
        // `active_task` (and with it the foreground queue and auto-sell) even if
        // a stage's item count oscillates instead of steadily decreasing.
        if now >= p.run_deadline || p.steps >= SPAWNER_MAX_STEPS {
            inv.close();
            emit(&OutEvent::BehaviorLog {
                message: format!(
                    "CleanSpawner: Zeitlimit erreicht ({} gedroppt, {} Verkauf-Klicks) — Menü geschlossen",
                    p.dropped, p.sold
                ),
            });
            self.active_task = None;
            return;
        }

        let Some(slots) = inv.slots() else { return };
        let container_len = slots.len().saturating_sub(36);
        if container_len == 0 {
            return;
        }

        let drop_items = self.config.spawner_drop_items.clone();
        let sell_items = self.config.spawner_sell_items.clone();

        // Unconfigured account: keep the legacy "throw everything out" behavior
        // so Clean Spawner still does something useful before a spawner type has
        // been picked in the settings. Gated on the *type*, not on the lists
        // being empty — an account that deliberately sets every item to "keep"
        // also has empty lists and must NOT have its spawner emptied.
        if self.config.spawner_type.trim().is_empty() {
            self.clean_spawner_legacy(&inv, &slots, container_len, now, p);
            return;
        }

        // The container is open, so pick the first real stage.
        if p.stage == SpawnerStage::WaitMenu {
            p.stage = if drop_items.is_empty() {
                SpawnerStage::Selling
            } else {
                SpawnerStage::Dropping
            };
            p.last_count = usize::MAX;
            p.stalls = 0;
        }

        if now < p.next_at {
            self.active_task = Some(ActiveTask::CleanSpawner(p));
            return;
        }

        let targets = if p.stage == SpawnerStage::Dropping { &drop_items } else { &sell_items };
        let matching = matching_slots(&slots, container_len, targets);

        // Progress tracking: a step that leaves the count unchanged counts as a
        // stall, so a server that silently refuses our clicks can't loop forever.
        if matching.len() < p.last_count {
            p.stalls = 0;
        }
        p.last_count = matching.len();

        // "Fewer than two stacks left" is the stop condition for both stages.
        let finished = matching.len() <= SPAWNER_KEEP_STACKS;
        let stalled = p.stalls >= SPAWNER_MAX_STALLS;

        if finished || stalled {
            if stalled {
                emit(&OutEvent::BehaviorLog {
                    message: "CleanSpawner: no further progress in this step, moving on".into(),
                });
            }
            if p.stage == SpawnerStage::Dropping {
                // Dropping is done (or gave up) — always continue with selling.
                self.active_task = Some(ActiveTask::CleanSpawner(SpawnerProgress {
                    stage: SpawnerStage::Selling,
                    next_at: now + SPAWNER_STEP_DELAY,
                    last_count: usize::MAX,
                    stalls: 0,
                    ..p
                }));
            } else {
                inv.close();
                emit(&OutEvent::BehaviorLog {
                    message: format!(
                        "Spawner aufgeräumt: {} Stack(s) gedroppt, {} Verkauf-Klick(s) — Menü geschlossen",
                        p.dropped, p.sold
                    ),
                });
                self.active_task = None;
            }
            return;
        }

        match p.stage {
            SpawnerStage::Dropping => {
                let mut thrown = 0usize;
                for &slot in matching.iter().take(matching.len() - SPAWNER_KEEP_STACKS) {
                    inv.click(ThrowClick::All { slot });
                    thrown += 1;
                }
                emit(&OutEvent::BehaviorLog {
                    message: format!("CleanSpawner: dropping {thrown} stack(s) out of the spawner"),
                });
                p.dropped += thrown;
            }
            SpawnerStage::Selling => {
                // Everything the spawner can hold, so a stock stack is never
                // mistaken for the sell button.
                let stock: Vec<String> = drop_items.iter().chain(sell_items.iter()).cloned().collect();
                let Some(sell_slot) = find_spawner_sell_slot(&slots, container_len, &stock) else {
                    inv.close();
                    emit(&OutEvent::BehaviorLog {
                        message: "CleanSpawner: Verkaufen-Knopf nicht gefunden — Menü geschlossen".into(),
                    });
                    self.active_task = None;
                    return;
                };
                inv.click(PickupClick::Left { slot: Some(sell_slot) });
                // Sale confirmations right after the click count as earnings.
                self.sell_earning_window = Some(now + SELL_EARNING_WINDOW);
                p.sold += 1;
            }
            SpawnerStage::WaitMenu => unreachable!("normalized above"),
        }

        p.stalls += 1;
        p.steps += 1;
        p.next_at = now + SPAWNER_STEP_DELAY;
        self.active_task = Some(ActiveTask::CleanSpawner(p));
    }

    /// Fallback clear-out for accounts without a configured spawner type: throw
    /// out every stack the container holds, finishing once the third slot of the
    /// top row is empty (the original Clean Spawner behavior).
    fn clean_spawner_legacy(
        &mut self,
        inv: &ContainerHandleRef,
        slots: &[ItemStack],
        container_len: usize,
        now: Instant,
        mut p: SpawnerProgress,
    ) {
        if container_len > 2 && !slots[2].is_present() {
            inv.close();
            emit(&OutEvent::BehaviorLog {
                message: "Spawner aufgeräumt und geschlossen".into(),
            });
            self.active_task = None;
            return;
        }
        if now < p.next_at {
            self.active_task = Some(ActiveTask::CleanSpawner(p));
            return;
        }

        let remaining = (0..container_len).filter(|&s| slots[s].is_present()).count();
        // Give up when the server keeps refusing the throws, so a spawner whose
        // contents can't be dropped never traps the bot in an open GUI.
        if remaining < p.last_count {
            p.stalls = 0;
        } else if p.stalls >= SPAWNER_MAX_STALLS {
            inv.close();
            emit(&OutEvent::BehaviorLog {
                message: "CleanSpawner: keine Fortschritte mehr, Menü geschlossen".into(),
            });
            self.active_task = None;
            return;
        }
        p.last_count = remaining;

        let mut thrown = 0usize;
        for slot in 0..container_len {
            if slots[slot].is_present() {
                inv.click(ThrowClick::All { slot: slot as u16 });
                thrown += 1;
            }
        }
        if thrown > 0 {
            emit(&OutEvent::BehaviorLog {
                message: format!("CleanSpawner: dropped {thrown} stack(s)"),
            });
        }
        p.stage = SpawnerStage::Dropping;
        p.dropped += thrown;
        p.stalls += 1;
        p.steps += 1;
        p.next_at = now + SPAWNER_STEP_DELAY;
        self.active_task = Some(ActiveTask::CleanSpawner(p));
    }

    /// Drives the auto-sell cycle (open/close principle).
    ///
    /// One cycle per `autosell_interval_seconds`: send the sell command, wait
    /// for the server's sell menu, shift the inventory in (repeating until
    /// nothing more fits), press the menu's confirm button *only if the items
    /// are actually still sitting in the menu*, then close it again.
    ///
    /// The confirm click is conditional because servers behave differently:
    /// some collect the goods and sell them when the green button is pressed,
    /// others (HugoSMP's "Sellmulti") sell each stack the instant it is
    /// shift-clicked in and then close the GUI themselves. Clicking a button in
    /// a menu that already sold everything is at best useless and at worst
    /// picks an item up onto the cursor.
    ///
    /// Success is measured by the only thing that actually matters: whether the
    /// bot's inventory got emptier. That keeps a server closing its own menu
    /// from being mistaken for a failure.
    fn tick_autosell(&mut self, bot: &Client, now: Instant) {
        if !self.config.autosell_enabled {
            if !matches!(self.autosell_phase, AutoSellPhase::Idle) {
                self.close_open_menu(bot);
            }
            self.autosell_phase = AutoSellPhase::Idle;
            self.autosell_failures = 0;
            self.autosell_retry_at = None;
            self.autosell_streak_logged = false;
            return;
        }

        let interval = Duration::from_secs_f64(self.config.autosell_interval_seconds.max(0.05));

        match self.autosell_phase {
            AutoSellPhase::Idle => {
                // Don't start a new cycle while a foreground one-shot task is
                // queued or running - this is the "pause" half of the interrupt
                // system. An in-progress cycle below is always allowed to finish.
                if self.foreground_busy() {
                    return;
                }
                // Backoff after repeated failures. Checked before the interval
                // so a sub-second interval can't override it.
                if let Some(retry_at) = self.autosell_retry_at {
                    if now < retry_at {
                        return;
                    }
                    self.autosell_retry_at = None;
                }
                if now.duration_since(self.last_autosell_at) < interval {
                    return;
                }
                self.last_autosell_at = now;

                // Close any lingering/stale menu before starting so we never
                // shift-click into the wrong container. Skip this cycle; the
                // next tick starts fresh.
                if let Ok(inv) = bot.get_inventory() {
                    if inv.id() != 0 {
                        inv.close();
                        return;
                    }
                }

                // Nothing to sell -> don't send the command at all. Sending it
                // with an empty inventory is pure chat spam.
                let before = player_occupied(bot);
                if before == 0 {
                    // An empty inventory is not a malfunction, so it must clear
                    // any pending failure backoff. Otherwise a streak recorded
                    // earlier would survive the idle period and delay selling by
                    // minutes once items finally show up again.
                    self.autosell_failures = 0;
                    self.autosell_retry_at = None;
                    if !self.autosell_streak_logged {
                        self.autosell_streak_logged = true;
                        emit(&OutEvent::BehaviorLog {
                            message: "AutoSell: nichts zu verkaufen, warte auf Items".into(),
                        });
                    }
                    return;
                }

                let command = self.config.autosell_command.trim();
                let command = if command.is_empty() { "/sell" } else { command };
                bot.chat(command.to_string());
                self.sell_earning_window = Some(now + SELL_EARNING_WINDOW);
                self.autosell_phase = AutoSellPhase::WaitingForMenu { since: now, before };
            }

            AutoSellPhase::WaitingForMenu { since, before } => {
                // A real sell container is open once the menu id is non-zero AND
                // the menu has slots in front of the player's own section.
                if let Ok(inv) = bot.get_inventory() {
                    if inv.id() != 0 {
                        if let Some(slots) = inv.slots() {
                            if let Some(container_len) = container_len(bot) {
                                if container_len > 0 && slots.len() > container_len {
                                    // Snapshot the menu's own decoration/button
                                    // items before anything is shifted in, so we
                                    // can later tell our unsold goods apart from
                                    // the server's furniture.
                                    let baseline: Vec<u16> = (0..container_len)
                                        .filter(|&s| slots[s].is_present())
                                        .map(|s| s as u16)
                                        .collect();
                                    let confirm_slot =
                                        find_sell_confirm_slot(&slots, container_len);
                                    self.autosell_phase = AutoSellPhase::Selling {
                                        confirm_slot,
                                        baseline,
                                        stage: SellStage::Fill {
                                            at: now + AUTOSELL_SETTLE_DELAY,
                                            passes: 0,
                                        },
                                        deadline: now + AUTOSELL_RUN_TIMEOUT,
                                        before,
                                    };
                                    return;
                                }
                            }
                        }
                    }
                }

                if now.duration_since(since) >= AUTOSELL_MENU_TIMEOUT {
                    // No menu appeared. On some servers the sell command sells
                    // outright without any GUI, so this only counts as a failure
                    // if the inventory is still as full as before.
                    self.close_open_menu(bot);
                    self.autosell_phase = AutoSellPhase::Idle;
                    self.finish_autosell_cycle(bot, now, interval, before, "Verkaufsmenü ging nicht auf");
                }
            }

            AutoSellPhase::Selling {
                confirm_slot,
                ref baseline,
                ref stage,
                deadline,
                before,
            } => {
                let baseline = baseline.clone();
                let stage_at = match *stage {
                    SellStage::Fill { at, .. } | SellStage::Confirm { at } | SellStage::Close { at } => at,
                };

                // The menu vanished (the server closed it after selling, death,
                // server switch, ...). Whether that was good or bad is decided
                // purely by the inventory.
                let inv = match bot.get_inventory() {
                    Ok(inv) if inv.id() != 0 => inv,
                    _ => {
                        self.autosell_phase = AutoSellPhase::Idle;
                        self.finish_autosell_cycle(bot, now, interval, before, "Verkaufsmenü ging zu früh zu");
                        return;
                    }
                };

                // Whatever goes wrong, never stay stuck in the GUI.
                if now >= deadline {
                    inv.close();
                    self.autosell_phase = AutoSellPhase::Idle;
                    self.finish_autosell_cycle(bot, now, interval, before, "Verkauf hat zu lange gedauert");
                    return;
                }

                if now < stage_at {
                    return;
                }

                let Some(slots) = inv.slots() else { return };
                let Some(container_len) = container_len(bot) else {
                    return;
                };
                if container_len == 0 || slots.len() <= container_len {
                    return;
                }

                match *stage {
                    SellStage::Fill { passes, .. } => {
                        let mut moved = 0;
                        for slot in container_len..slots.len() {
                            if slots[slot].is_present() {
                                inv.shift_click(slot);
                                moved += 1;
                            }
                        }
                        // Another pass: a single pass can leave items behind
                        // when the menu was momentarily full or the server was
                        // still processing earlier clicks.
                        if moved > 0 && passes + 1 < AUTOSELL_FILL_PASSES {
                            self.autosell_phase = AutoSellPhase::Selling {
                                confirm_slot,
                                baseline,
                                stage: SellStage::Fill {
                                    at: now + AUTOSELL_CONFIRM_DELAY,
                                    passes: passes + 1,
                                },
                                deadline,
                                before,
                            };
                            return;
                        }
                        self.autosell_phase = AutoSellPhase::Selling {
                            confirm_slot,
                            baseline,
                            stage: SellStage::Confirm {
                                at: now + AUTOSELL_CONFIRM_DELAY,
                            },
                            deadline,
                            before,
                        };
                    }

                    SellStage::Confirm { .. } => {
                        // Only press the button when our goods are actually
                        // still lying in the menu. If the server already sold
                        // them on shift-click there is nothing to confirm.
                        let pending = (0..container_len).any(|s| {
                            let slot = s as u16;
                            slot != confirm_slot
                                && !baseline.contains(&slot)
                                && slots[s].is_present()
                        });
                        if pending && (confirm_slot as usize) < container_len {
                            inv.click(PickupClick::Left {
                                slot: Some(confirm_slot),
                            });
                            self.sell_earning_window = Some(now + SELL_EARNING_WINDOW);
                        }
                        self.autosell_phase = AutoSellPhase::Selling {
                            confirm_slot,
                            baseline,
                            stage: SellStage::Close {
                                at: now + AUTOSELL_CONFIRM_DELAY,
                            },
                            deadline,
                            before,
                        };
                    }

                    SellStage::Close { .. } => {
                        inv.close();
                        self.autosell_phase = AutoSellPhase::Idle;
                        self.finish_autosell_cycle(bot, now, interval, before, "nichts verkauft");
                    }
                }
            }
        }
    }

    /// Ends a sell cycle and decides whether it worked.
    ///
    /// The only reliable success signal is the bot's own inventory: if it holds
    /// fewer stacks than when the cycle started, items were sold — no matter
    /// which menu the server used or who closed it.
    fn finish_autosell_cycle(
        &mut self,
        bot: &Client,
        now: Instant,
        interval: Duration,
        before: usize,
        failure_reason: &str,
    ) {
        let after = player_occupied(bot);
        if after < before {
            let sold = before - after;
            emit(&OutEvent::BehaviorLog {
                message: format!("AutoSell: {sold} Stack(s) verkauft"),
            });
            if self.autosell_streak_logged {
                self.autosell_streak_logged = false;
            }
            self.autosell_failures = 0;
            self.autosell_retry_at = None;
            return;
        }
        self.register_autosell_failure(now, interval, failure_reason);
    }

    /// Records a sell cycle that achieved nothing and schedules the next
    /// attempt. The delay grows once [`AUTOSELL_FAILURE_GRACE`] cycles in a row
    /// have failed, so a broken sell menu can never turn into a chat flood —
    /// while a single hiccup still retries immediately.
    fn register_autosell_failure(&mut self, now: Instant, interval: Duration, reason: &str) {
        self.autosell_failures = self.autosell_failures.saturating_add(1);
        if self.autosell_failures <= AUTOSELL_FAILURE_GRACE {
            return;
        }

        let steps = (self.autosell_failures - AUTOSELL_FAILURE_GRACE - 1).min(8);
        let backoff = AUTOSELL_BACKOFF_BASE
            .checked_mul(1u32 << steps)
            .unwrap_or(AUTOSELL_BACKOFF_MAX)
            .min(AUTOSELL_BACKOFF_MAX)
            .max(interval);
        self.autosell_retry_at = Some(now + backoff);
        if !self.autosell_streak_logged {
            self.autosell_streak_logged = true;
            emit(&OutEvent::BehaviorLog {
                message: format!(
                    "AutoSell: {reason} ({}x) - neuer Versuch alle {}s",
                    self.autosell_failures,
                    backoff.as_secs()
                ),
            });
        }
    }

    /// Close any container the bot currently has open (best-effort no-op if none).
    fn close_open_menu(&self, bot: &Client) {
        if let Ok(inv) = bot.get_inventory() {
            if inv.id() != 0 {
                inv.close();
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

/// Normalize the settings-open command: default to "/settings" when blank and
/// ensure it starts with a slash so `bot.chat` runs it as a command.
fn normalize_settings_command(command: String) -> String {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return "/settings".to_string();
    }
    if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    }
}

/// Extract an item's display name and lore as plain strings (formatting stripped).
fn item_text(stack: &ItemStack) -> (String, Vec<String>) {
    let name = stack
        .get_component::<CustomName>()
        .map(|c| c.name.to_string())
        .unwrap_or_default();
    let lore = stack
        .get_component::<Lore>()
        .map(|l| l.lines.iter().map(|line| line.to_string()).collect())
        .unwrap_or_default();
    (name, lore)
}

/// Strips the namespace from a Minecraft item id so `"minecraft:beef"` and
/// `"beef"` compare equal regardless of which form the config uses.
fn bare_item_id(id: &str) -> &str {
    id.rsplit_once(':').map(|(_, name)| name).unwrap_or(id)
}

/// Container slot indices holding one of `targets` (namespace-insensitive).
///
/// Only real stock matches: a spawner GUI's decorative buttons are never one of
/// the configured drop/sell item types, so this doubles as the filter that keeps
/// the bot from ever throwing away or clicking a control button.
fn matching_slots(slots: &[ItemStack], container_len: usize, targets: &[String]) -> Vec<u16> {
    let wanted: Vec<&str> = targets.iter().map(|t| bare_item_id(t)).collect();
    (0..container_len)
        .filter(|&slot| {
            slots[slot].is_present() && wanted.contains(&bare_item_id(slots[slot].kind().to_str()))
        })
        .map(|slot| slot as u16)
        .collect()
}

/// Locates the spawner GUI's sell button, or `None` when it can't be identified.
///
/// Layouts differ per server and resource pack, so the button is found by its
/// display name/lore. Slots holding the spawner's own stock are excluded first:
/// shop servers routinely put a price like "Wert: $12" in an item's lore, which
/// would otherwise match the `$` keyword and make the bot left-click a real
/// stack onto its cursor (silently losing it when the GUI closes).
///
/// Returns `None` rather than guessing a slot — clicking an unknown slot in a
/// container full of items is destructive, so the caller stops instead.
fn find_spawner_sell_slot(
    slots: &[ItemStack],
    container_len: usize,
    stock_items: &[String],
) -> Option<u16> {
    let stock: Vec<&str> = stock_items.iter().map(|t| bare_item_id(t)).collect();
    for slot in 0..container_len {
        if !slots[slot].is_present() {
            continue;
        }
        if stock.contains(&bare_item_id(slots[slot].kind().to_str())) {
            continue;
        }
        let (name, lore) = item_text(&slots[slot]);
        let hay = format!("{} {}", name, lore.join(" ")).to_lowercase();
        if SPAWNER_SELL_KEYWORDS.iter().any(|kw| hay.contains(kw)) {
            return Some(slot as u16);
        }
    }
    None
}

/// Number of slots the currently open menu has *in front of* the player's own
/// inventory section, i.e. the size of the server's container.
///
/// Derived from Azalea's per-menu layout rather than the "last 36 slots"
/// assumption: that only holds for container menus. The player's own inventory
/// menu also has crafting, armour and offhand slots, so the assumption read the
/// wrong slots whenever no container was open.
fn container_len(bot: &Client) -> Option<usize> {
    let menu = bot.menu().ok()?;
    Some(*menu.player_slots_range().start())
}

/// How many of the player's own inventory slots hold an item.
///
/// This is auto-sell's success metric: a cycle worked if this number dropped.
/// It is far more reliable than watching the menu, because servers differ in
/// when (and whether) they close their sell GUI.
fn player_occupied(bot: &Client) -> usize {
    let Ok(menu) = bot.menu() else { return 0 };
    let slots = menu.slots();
    menu.player_slots_range()
        .filter(|&slot| slots.get(slot).map(|s| s.is_present()).unwrap_or(false))
        .count()
}

/// Locates the sell menu's confirm ("sell everything") button among the
/// container's own slots.
///
/// Button positions differ between servers and resource packs, so the item's
/// display name and lore are searched for a sell/confirm keyword first. Only if
/// no labelled button is found does it fall back to the menu's last container
/// slot, which is where the green checkmark sits in the common layout.
fn find_sell_confirm_slot(slots: &[ItemStack], container_len: usize) -> u16 {
    for slot in 0..container_len.min(slots.len()) {
        if !slots[slot].is_present() {
            continue;
        }
        let (name, lore) = item_text(&slots[slot]);
        let hay = format!("{} {}", name, lore.join(" ")).to_lowercase();
        if SELL_CONFIRM_KEYWORDS.iter().any(|kw| hay.contains(kw)) {
            return slot as u16;
        }
    }
    container_len.saturating_sub(1) as u16
}

/// Parse a settings-menu button into `(label, enabled)`, or `None` if the item
/// isn't a stateful toggle (decorations, glass panes, a "Schließen"/close button
/// carry no Aktiviert/Deaktiviert state and are skipped). The state is read from
/// the item's name/lore; "deaktiviert" is checked before "aktiviert" because the
/// former contains the latter as a substring.
fn parse_setting_item(stack: &ItemStack) -> Option<(String, bool)> {
    if !stack.is_present() {
        return None;
    }
    let (name, lore) = item_text(stack);
    if name.trim().is_empty() {
        return None;
    }
    let hay = format!("{} {}", name, lore.join(" ")).to_lowercase();
    let enabled = if hay.contains("deaktiviert") || hay.contains("disabled") {
        false
    } else if hay.contains("aktiviert") || hay.contains("enabled") {
        true
    } else {
        return None;
    };
    let label = strip_state_suffix(&name);
    if label.is_empty() {
        return None;
    }
    Some((label, enabled))
}

/// Strip a trailing ": Aktiviert"/": Deaktiviert" (or similar) state suffix from
/// a button name, leaving just the setting label.
fn strip_state_suffix(name: &str) -> String {
    if let Some((lhs, _rhs)) = name.rsplit_once(':') {
        let lhs = lhs.trim();
        if !lhs.is_empty() {
            return lhs.to_string();
        }
    }
    name.trim().to_string()
}

/// Scan a settings GUI's container slots (excluding the player's own 36 slots)
/// for toggle buttons, returning `(slot_index, label, enabled)` for each,
/// de-duplicated by label.
fn scan_settings_entries(slots: &[ItemStack]) -> Vec<(usize, String, bool)> {
    let container_len = slots.len().saturating_sub(36);
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (i, slot) in slots.iter().enumerate().take(container_len) {
        if let Some((label, enabled)) = parse_setting_item(slot) {
            if seen.insert(label.to_lowercase()) {
                out.push((i, label, enabled));
            }
        }
    }
    out
}

/// Emit an [`OutEvent::SettingsMenu`] from scanned settings entries.
fn emit_settings(entries: &[(usize, String, bool)]) {
    let settings = entries
        .iter()
        .map(|(_, label, enabled)| SettingEntry {
            label: label.clone(),
            enabled: *enabled,
        })
        .collect();
    emit(&OutEvent::SettingsMenu { settings });
}

/// Read the bot's own inventory and emit an [`OutEvent::Inventory`] snapshot.
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

/// Returns the position of the spawner the bot is **currently looking at**, or
/// `None` if the crosshair is not on a mob/trial spawner. Deliberately does not
/// search the surroundings: the bot must be aimed at the spawner it should
/// clear, so a misaimed bot never opens the wrong block.
fn find_spawner_in_reach(bot: &Client) -> Option<BlockPos> {
    let hit = bot.hit_result().ok()?;
    let block_hit = hit.as_block_hit_result_if_not_miss()?;
    let pos = block_hit.block_pos;

    let world = bot.world().ok()?;
    let world = world.read();
    let state = world.get_block_state(pos)?;
    matches!(BlockKind::from(state), BlockKind::Spawner | BlockKind::TrialSpawner).then_some(pos)
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
