//! Account automation, run natively inside the Rust bot process.
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
use azalea::{BlockPos, Client};
use azalea_inventory::components::{CustomName, Lore};
use azalea_inventory::operations::{PickupClick, ThrowClick};
use azalea_inventory::ItemStack;
use rand::Rng;
use regex::Regex;

use crate::emit;
use crate::protocol::{BehaviorConfig, Config, InventorySlot, OutEvent};

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
const AUTOSELL_SETTLE_DELAY: Duration = Duration::from_millis(150);

/// Hard stop for a single sell cycle. However the server misbehaves, the menu
/// is closed and the cycle abandoned after this, so the bot can never get stuck
/// in an open GUI.
const AUTOSELL_RUN_TIMEOUT: Duration = Duration::from_secs(15);
/// Pace inventory clicks so the server can acknowledge each one before the
/// next stack is moved. Sending all clicks and closing in one tick caused busy
/// servers to discard the tail of a sell cycle.
const AUTOSELL_CLICK_DELAY: Duration = Duration::from_millis(75);
/// Give the server time to publish its authoritative inventory update after the
/// last click before deciding whether the cycle made progress.
const AUTOSELL_CONFIRM_DELAY: Duration = Duration::from_millis(400);
/// Wait after a full spawn before sending automation commands. `Spawn` means
/// the chunk is usable, but proxy networks may still be restoring the player
/// inventory for a brief moment (the attached HugoSMP log showed exactly this).
const SPAWN_STABILIZE_DELAY: Duration = Duration::from_secs(2);
/// Position sync packets are emitted for /home, accepted TPAs and other
/// same-world teleports. Let the destination and inventory settle before the
/// next sell cycle starts.
const TELEPORT_STABILIZE_DELAY: Duration = Duration::from_millis(1250);
/// A teleport command is paused immediately, even before its position packet
/// arrives. This also covers rejected/slow commands without freezing forever.
const TELEPORT_COMMAND_GUARD: Duration = Duration::from_secs(3);
/// Small serialization gap after a normal chat command. Commands can open a
/// GUI asynchronously, so auto-sell must not start on the following tick.
const CHAT_COMMAND_GUARD: Duration = Duration::from_secs(1);
/// Retry delay when the server explicitly says the inventory is still being
/// saved/loaded. This is a transient lifecycle state, not an auto-sell failure.
const INVENTORY_BUSY_DELAY: Duration = Duration::from_secs(2);
/// Repeated menu failures are logged at most this often. Retrying itself still
/// follows the configured interval and is never slowed down by logging.
const AUTOSELL_FAILURE_LOG_INTERVAL: Duration = Duration::from_secs(30);
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
/// After an inventory move/drop, wait this long before emitting a fresh
/// snapshot so the server's click acknowledgement has been applied and the UI
/// resyncs with the bot's real inventory state.
const INVENTORY_RESYNC_DELAY: Duration = Duration::from_millis(300);

/// Tracks one auto-sell cycle. Each cycle opens the sell menu, fills it,
/// confirms the sale and closes the menu again ("open/close principle") — the
/// menu is never left open between cycles, so the bot's GUI is free for chat,
/// scheduled commands and the spawner tasks in between.
#[derive(Clone, Copy)]
enum AutoSellPhase {
    Idle,
    /// The sell command was sent; waiting for the server to open its GUI.
    WaitingForMenu {
        since: Instant,
        /// Used only to shorten an empty probe; it never suppresses `/sell`.
        started_empty: bool,
    },
    /// The sell container is open. Fill it and close it again.
    Selling {
        /// Earliest time the next shift-click may be sent.
        next_at: Instant,
        /// Abort the cycle at this time no matter what.
        deadline: Instant,
        /// Next player-menu slot to inspect. Each occupied slot is clicked once.
        next_slot: usize,
        clicks: usize,
    },
    /// All occupied player slots were clicked. Give the server a short
    /// acknowledgement window, then close the GUI unconditionally.
    Confirming {
        check_at: Instant,
        clicks: usize,
        menu_closed: bool,
    },
}

/// A one-shot, foreground task. While one is queued or running, the continuous
/// auto-sell loop is paused (it won't start a new cycle), and a queued task
/// only begins once auto-sell is back to `Idle`. This guarantees the bot never
/// runs two menu/inventory interactions at once — the core of the task-interrupt
/// (pause/resume) system. Scheduling/timing lives in Node; this just ensures
/// safe, non-overlapping execution.
enum ForegroundTask {
    /// Send a single chat line (e.g. a scheduled daily command).
    Chat { text: String, teleporting: bool },
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
    /// Driving the spawner clear-out: waiting for the container, then dropping
    /// the configured item types, then selling the rest via the spawner's own
    /// sell button.
    CleanSpawner(SpawnerProgress),
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
    /// Consecutive reads where the spawner's sell button was not yet visible.
    /// Kept separate from item-progress stalls so a late GUI sync can recover.
    button_misses: u32,
    dropped: usize,
    sold: usize,
}

pub struct BehaviorState {
    config: BehaviorConfig,
    last_auto_command_at: Instant,
    /// Next due time for random-range auto-command mode.
    next_random_auto_command_at: Option<Instant>,
    /// Earliest time a new auto-sell cycle may start. The timestamp is advanced
    /// when a command is sent, so a slow cycle never overlaps the next one.
    next_autosell_at: Instant,
    autosell_phase: AutoSellPhase,
    last_autosell_failure_log: Option<Instant>,
    /// Automation is disabled before the first Spawn and between Login/Spawn
    /// during world/server changes. This prevents commands while the server is
    /// saving or loading the inventory.
    spawned: bool,
    /// Shared quiescence gate for spawn, teleports and asynchronous commands.
    automation_ready_at: Instant,
    /// A non-teleport foreground chat command may open its own menu (for
    /// example `/homes`). Close only that command-owned menu after its guard;
    /// auto-sell itself never closes an unrelated pre-existing GUI.
    command_menu_close_at: Option<Instant>,
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
    /// Set only after a real respawn/world switch, when the server has already
    /// cleared sneak and Azalea needs a local transition to re-send it.
    crouch_repress_pending: bool,
}

impl BehaviorState {
    pub fn new(config: &Config) -> Self {
        let now = Instant::now();
        Self {
            config: BehaviorConfig {
                crouch_enabled: config.crouch_enabled,
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
            last_auto_command_at: now,
            next_random_auto_command_at: None,
            next_autosell_at: now,
            autosell_phase: AutoSellPhase::Idle,
            last_autosell_failure_log: None,
            spawned: false,
            automation_ready_at: now,
            command_menu_close_at: None,
            sell_earning_window: None,
            task_queue: VecDeque::new(),
            active_task: None,
            last_tpaccept: None,
            inventory_resync_at: None,
            last_inventory_sig: None,
            last_heartbeat_at: now,
            crouch_repress_pending: false,
        }
    }

    /// Apply a live settings update (from a `Command::Configure`).
    pub fn update_config(&mut self, config: BehaviorConfig) {
        let autosell_schedule_changed = self.config.autosell_enabled != config.autosell_enabled
            || self.config.autosell_interval_seconds != config.autosell_interval_seconds
            || self.config.autosell_command != config.autosell_command;
        self.config = config;
        // Re-arm random scheduling from "now" whenever span settings change.
        self.next_random_auto_command_at = None;
        if autosell_schedule_changed && self.config.autosell_enabled {
            let now = Instant::now();
            self.next_autosell_at = self.automation_ready_at.max(now);
        }
    }

    /// Enqueue a scheduled chat command as a foreground one-shot task. Auto-sell
    /// is paused until it runs, then resumed (handled by the tick loop).
    pub fn enqueue_task(&mut self, text: String) {
        let text = text.trim().to_string();
        if !text.is_empty() {
            let teleporting = is_teleport_command(&text);
            self.task_queue
                .push_back(ForegroundTask::Chat { text, teleporting });
        }
    }

    /// Queue a user/background chat command through the same serialization
    /// point as auto-sell. Teleport commands are urgent: they cancel an open
    /// sell GUI first, then run before ordinary queued work.
    pub fn enqueue_chat(&mut self, bot: &Client, text: String) {
        let text = text.trim().to_string();
        if text.is_empty() {
            return;
        }
        let teleporting = is_teleport_command(&text);
        let task = ForegroundTask::Chat { text, teleporting };
        if teleporting {
            self.interrupt_for_transition(bot);
            self.task_queue.push_front(task);
        } else {
            self.task_queue.push_back(task);
        }
    }

    /// Enqueue a balance query as a foreground one-shot task. Coalesces with any
    /// pending/active balance query so repeated requests don't stack up.
    pub fn enqueue_balance(&mut self, command: String) {
        let command = command.trim().to_string();
        let command = if command.is_empty() {
            "/balance".to_string()
        } else {
            command
        };
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

    fn postpone_automation_until(&mut self, at: Instant) {
        if at > self.automation_ready_at {
            self.automation_ready_at = at;
        }
        if at > self.next_autosell_at {
            self.next_autosell_at = at;
        }
    }

    /// Tear down interactions whose container/world identity becomes invalid
    /// across a teleport, respawn or proxy server transfer.
    fn interrupt_for_transition(&mut self, bot: &Client) {
        self.close_open_menu(bot);
        self.autosell_phase = AutoSellPhase::Idle;
        self.sell_earning_window = None;
        self.active_task = None;
        self.command_menu_close_at = None;
    }

    fn guard_after_chat(&mut self, now: Instant, teleporting: bool) {
        let delay = if teleporting {
            TELEPORT_COMMAND_GUARD
        } else {
            CHAT_COMMAND_GUARD
        };
        self.postpone_automation_until(now + delay);
        self.command_menu_close_at = (!teleporting).then_some(now + CHAT_COMMAND_GUARD);
    }

    /// Called for Login, including proxy server and dimension/world changes.
    /// No automation is allowed again until the matching Spawn event arrives.
    pub fn on_login(&mut self, bot: &Client) {
        self.interrupt_for_transition(bot);
        self.spawned = false;
    }

    /// Called for a server position synchronization. After the initial spawn
    /// these packets cover /home, TPA and same-world teleports that do not emit
    /// another Login/Spawn pair.
    pub fn on_position_sync(&mut self, bot: &Client) {
        if !self.spawned {
            return;
        }
        let now = Instant::now();
        self.interrupt_for_transition(bot);
        self.postpone_automation_until(now + TELEPORT_STABILIZE_DELAY);
    }

    /// Called whenever the player (re)spawns into a world: initial join, after
    /// a death, and after a server/world switch. Respawns clear sneak server-side,
    /// so create one local transition there only. Normal gameplay never releases
    /// crouch periodically.
    pub fn on_spawn(&mut self, bot: &Client) {
        let now = Instant::now();
        self.interrupt_for_transition(bot);
        self.spawned = true;
        self.automation_ready_at = now + SPAWN_STABILIZE_DELAY;
        self.next_autosell_at = self.automation_ready_at;
        self.last_autosell_failure_log = None;

        if self.config.crouch_enabled {
            if bot.crouching() {
                // The server already cleared sneak as part of the respawn/world
                // switch. Reset Azalea's stale local value, then press next tick.
                let _ = bot.set_crouching(false);
                self.crouch_repress_pending = true;
            } else {
                let _ = bot.set_crouching(true);
                self.crouch_repress_pending = false;
            }
        } else {
            self.crouch_repress_pending = false;
        }
    }

    pub fn on_tick(&mut self, bot: &Client) {
        let now = Instant::now();
        let mut command_sent_this_tick = false;

        // Crouch: continuously hold sneak while enabled.
        //
        // `set_crouching` only writes a local field; the sneak flag reaches the
        // server inside ServerboundPlayerInput, which azalea sends *only when
        // the input differs from the last one it sent*. So calling
        // `set_crouching(true)` while it is already true sends nothing at all.
        //
        // That matters because a death/respawn or a server switch clears the
        // sneak state server-side while the client still believes it is
        // crouching. Nothing differs locally, no packet goes out, and the bot
        // silently stands up for good.
        //
        // A real transition is only needed after a spawn event. Never toggle
        // crouch on a timer: doing that made the bot visibly stand up every
        // three seconds.
        if self.config.crouch_enabled {
            if self.crouch_repress_pending {
                let _ = bot.set_crouching(true);
                self.crouch_repress_pending = false;
            } else if !bot.crouching() {
                let _ = bot.set_crouching(true);
            }
        } else {
            self.crouch_repress_pending = false;
            if bot.crouching() {
                let _ = bot.set_crouching(false);
            }
        }

        if self.command_menu_close_at.is_some_and(|at| now >= at) {
            self.close_open_menu(bot);
            self.command_menu_close_at = None;
        }

        // Before Spawn, and for a short stabilization period after a spawn or
        // teleport, only passive reporting may run. In particular no /sell or
        // queued chat command may touch the inventory-loading phase.
        let automation_ready = self.spawned && now >= self.automation_ready_at;

        // Auto-command: type a configured chat message/command at a fixed
        // interval. "Zeitspanne"
        // (random-range) mode is its own independent toggle, so it must run
        // even if the fixed-interval "Interval" toggle is off.
        if automation_ready
            && (self.config.auto_command_enabled || self.config.auto_command_span_enabled)
        {
            let text = self.config.auto_command_text.trim().to_string();
            if !text.is_empty() {
                if self.config.auto_command_span_enabled {
                    if self.next_random_auto_command_at.is_none() {
                        self.next_random_auto_command_at =
                            Some(now + random_auto_command_delay(&self.config));
                    }
                    if now >= self.next_random_auto_command_at.expect("set above")
                        && matches!(self.autosell_phase, AutoSellPhase::Idle)
                        && !self.foreground_busy()
                        && (is_teleport_command(&text) || inventory_is_mutable(bot))
                    {
                        if is_teleport_command(&text) {
                            self.close_open_menu(bot);
                        }
                        bot.chat(text.clone());
                        command_sent_this_tick = true;
                        self.guard_after_chat(now, is_teleport_command(&text));
                        self.next_random_auto_command_at =
                            Some(now + random_auto_command_delay(&self.config));
                        emit(&OutEvent::BehaviorLog {
                            message: format!("Auto-command sent (random range): {text}"),
                        });
                    }
                } else {
                    let interval =
                        Duration::from_secs(self.config.auto_command_interval_minutes.max(1) * 60);
                    if now.duration_since(self.last_auto_command_at) >= interval
                        && matches!(self.autosell_phase, AutoSellPhase::Idle)
                        && !self.foreground_busy()
                        && (is_teleport_command(&text) || inventory_is_mutable(bot))
                    {
                        self.last_auto_command_at = now;
                        if is_teleport_command(&text) {
                            self.close_open_menu(bot);
                        }
                        bot.chat(text.clone());
                        command_sent_this_tick = true;
                        self.guard_after_chat(now, is_teleport_command(&text));
                        emit(&OutEvent::BehaviorLog {
                            message: format!("Auto-command sent: {text}"),
                        });
                    }
                }
            }
        } else if !self.config.auto_command_enabled && !self.config.auto_command_span_enabled {
            self.next_random_auto_command_at = None;
        }

        if automation_ready && !command_sent_this_tick {
            let foreground_ran = self.tick_foreground(bot, now);
            if !foreground_ran {
                self.tick_autosell(bot, now);
            }
        }

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
    fn tick_foreground(&mut self, bot: &Client, now: Instant) -> bool {
        let mut ran = self.active_task.is_some();
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
            None => {}
        }

        // Start the next queued task, but only when nothing is active and
        // auto-sell isn't mid-cycle — this is what enforces mutual exclusion.
        if self.active_task.is_none() && matches!(self.autosell_phase, AutoSellPhase::Idle) {
            if let Some(task) = self.task_queue.pop_front() {
                ran = true;
                match task {
                    ForegroundTask::Chat { text, teleporting } => {
                        if !teleporting && !inventory_is_mutable(bot) {
                            self.task_queue
                                .push_front(ForegroundTask::Chat { text, teleporting });
                            return true;
                        }
                        if teleporting {
                            self.close_open_menu(bot);
                        }
                        bot.chat(text.clone());
                        self.guard_after_chat(now, teleporting);
                        emit(&OutEvent::BehaviorLog {
                            message: format!("Scheduled command sent: {text}"),
                        });
                    }
                    ForegroundTask::Balance(command) => {
                        if !inventory_is_mutable(bot) {
                            self.task_queue.push_front(ForegroundTask::Balance(command));
                            return true;
                        }
                        bot.chat(command.clone());
                        self.guard_after_chat(now, false);
                        self.active_task = Some(ActiveTask::Balance {
                            deadline: now + BALANCE_TIMEOUT,
                        });
                    }
                    ForegroundTask::CleanSpawner if !inventory_is_mutable(bot) => {
                        self.task_queue.push_front(ForegroundTask::CleanSpawner);
                        return true;
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
                                button_misses: 0,
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
                            self.task_queue
                                .push_front(ForegroundTask::MoveItem { from, to });
                            return true;
                        }
                    }
                    ForegroundTask::DropItem { slot } => {
                        if inventory_is_mutable(bot) {
                            let inv = bot.get_inventory().expect("inventory present");
                            inv.click(ThrowClick::All { slot });
                            self.inventory_resync_at = Some(now + INVENTORY_RESYNC_DELAY);
                        } else {
                            self.task_queue.push_front(ForegroundTask::DropItem { slot });
                            return true;
                        }
                    }
                }
            }
        }
        ran
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

        let targets = if p.stage == SpawnerStage::Dropping {
            &drop_items
        } else {
            &sell_items
        };
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
                    button_misses: 0,
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
                let stock: Vec<String> = drop_items
                    .iter()
                    .chain(sell_items.iter())
                    .cloned()
                    .collect();
                let Some(sell_slot) = find_spawner_sell_slot(&slots, container_len, &stock) else {
                    p.button_misses += 1;
                    p.steps += 1;
                    if p.button_misses >= SPAWNER_MAX_STALLS {
                        inv.close();
                        emit(&OutEvent::BehaviorLog {
                            message: "CleanSpawner: Verkaufen-Knopf nach mehreren Versuchen nicht gefunden — Menü geschlossen".into(),
                        });
                        self.active_task = None;
                    } else {
                        p.next_at = now + SPAWNER_STEP_DELAY;
                        self.active_task = Some(ActiveTask::CleanSpawner(p));
                    }
                    return;
                };
                p.button_misses = 0;
                inv.click(PickupClick::Left {
                    slot: Some(sell_slot),
                });
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

        let remaining = (0..container_len)
            .filter(|&s| slots[s].is_present())
            .count();
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

    /// Drives the auto-sell cycle.
    ///
    /// Opens the menu, moves one stack at a time and always closes it again.
    /// A cycle that got as far as sending shift-clicks is considered complete:
    /// at fast farms, newly arriving items can fully mask a decreasing total
    /// item count, so total-count confirmation creates false failures.
    fn tick_autosell(&mut self, bot: &Client, now: Instant) {
        if !self.config.autosell_enabled {
            if !matches!(self.autosell_phase, AutoSellPhase::Idle) {
                self.close_open_menu(bot);
            }
            self.autosell_phase = AutoSellPhase::Idle;
            self.last_autosell_failure_log = None;
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

                // Never gate a due sell cycle on a local "empty" snapshot. It
                // may be stale for a moment after close or while drops arrive.
                if now < self.next_autosell_at {
                    return;
                }

                // Never shift-click into, or close, a menu auto-sell did not
                // open. Wait until the other interaction is finished.
                if let Ok(inv) = bot.get_inventory() {
                    if inv.id() != 0 {
                        return;
                    }
                }

                let command = self.config.autosell_command.trim();
                let command = if command.is_empty() { "/sell" } else { command };
                self.next_autosell_at = now + interval;
                bot.chat(command.to_string());
                self.sell_earning_window = Some(now + SELL_EARNING_WINDOW);
                self.autosell_phase = AutoSellPhase::WaitingForMenu {
                    since: now,
                    started_empty: player_item_count(bot) == 0,
                };
            }

            AutoSellPhase::WaitingForMenu {
                since,
                started_empty,
            } => {
                // A real sell container is open once the menu id is non-zero AND
                // the menu has slots in front of the player's own section.
                if let Ok(inv) = bot.get_inventory() {
                    if inv.id() != 0 {
                        if let Some(slots) = inv.slots() {
                            if let Some(container_len) = container_len(bot) {
                                if container_len > 0 && slots.len() > container_len {
                                    self.autosell_phase = AutoSellPhase::Selling {
                                        next_at: now + AUTOSELL_SETTLE_DELAY,
                                        deadline: now + AUTOSELL_RUN_TIMEOUT,
                                        next_slot: container_len,
                                        clicks: 0,
                                    };
                                    return;
                                }
                            }
                        }
                    }
                }

                // If drops arrive during an empty probe, restart immediately.
                // This removes the old "empty interval + another full interval"
                // delay without ever overlapping two open menu cycles.
                if started_empty && player_item_count(bot) > 0 {
                    self.autosell_phase = AutoSellPhase::Idle;
                    self.next_autosell_at = now;
                    return;
                }

                let timeout = if started_empty {
                    interval.min(AUTOSELL_MENU_TIMEOUT)
                } else {
                    AUTOSELL_MENU_TIMEOUT
                };
                if now.duration_since(since) >= timeout {
                    self.close_open_menu(bot);
                    self.autosell_phase = AutoSellPhase::Idle;
                    if started_empty {
                        // Empty is a normal no-op. The next attempt is due now,
                        // so the configured cadence continues without a skip.
                        self.next_autosell_at = now;
                    } else {
                        self.log_autosell_failure(now, "Verkaufsmenü ging nicht auf");
                    }
                }
            }

            AutoSellPhase::Selling {
                next_at,
                deadline,
                next_slot,
                clicks,
            } => {
                // Some servers close the GUI as soon as one stack sells. That
                // is a completed cycle as long as at least one click was sent.
                let inv = match bot.get_inventory() {
                    Ok(inv) if inv.id() != 0 => inv,
                    _ => {
                        self.autosell_phase = AutoSellPhase::Confirming {
                            check_at: now + AUTOSELL_CONFIRM_DELAY,
                            clicks,
                            menu_closed: true,
                        };
                        return;
                    }
                };

                // Whatever goes wrong, never stay stuck in the GUI.
                if now >= deadline {
                    inv.close();
                    self.autosell_phase = AutoSellPhase::Idle;
                    self.log_autosell_failure(now, "Verkauf hat zu lange gedauert");
                    return;
                }

                // Give the server a moment to sync the container's contents,
                // otherwise the player slots can still read as empty and the
                // cycle would sell nothing.
                if now < next_at {
                    return;
                }

                let Some(slots) = inv.slots() else { return };
                let Ok(menu) = bot.menu() else { return };
                let next = menu.player_slots_range().find(|&slot| {
                    slot >= next_slot && slots.get(slot).is_some_and(ItemStack::is_present)
                });
                if let Some(slot) = next {
                    inv.shift_click(slot);
                    self.sell_earning_window = Some(now + SELL_EARNING_WINDOW);
                    self.autosell_phase = AutoSellPhase::Selling {
                        next_at: now + AUTOSELL_CLICK_DELAY,
                        deadline,
                        next_slot: slot + 1,
                        clicks: clicks + 1,
                    };
                    return;
                }

                self.autosell_phase = AutoSellPhase::Confirming {
                    check_at: now + AUTOSELL_CONFIRM_DELAY,
                    clicks,
                    menu_closed: false,
                };
            }

            AutoSellPhase::Confirming {
                check_at,
                clicks,
                menu_closed,
            } => {
                // Keep the GUI open briefly after the final click so the server
                // can acknowledge it, then close it before releasing the cycle.
                if !menu_closed {
                    if now < check_at {
                        return;
                    }
                    self.close_open_menu(bot);
                    self.autosell_phase = AutoSellPhase::Confirming {
                        check_at: now + AUTOSELL_CONFIRM_DELAY,
                        clicks,
                        menu_closed: true,
                    };
                    return;
                }
                if now < check_at {
                    return;
                }
                self.close_open_menu(bot);
                self.autosell_phase = AutoSellPhase::Idle;
                if clicks > 0 {
                    self.last_autosell_failure_log = None;
                    self.sell_earning_window = Some(now + SELL_EARNING_WINDOW);
                    emit(&OutEvent::BehaviorLog {
                        message: format!("AutoSell: Zyklus abgeschlossen ({clicks} Klick(s))"),
                    });
                }
            }
        }
    }

    /// Log repeated server/menu failures without changing the configured retry
    /// cadence. This keeps diagnostics useful without turning a transient miss
    /// into a 10-60 second period where auto-sell appears to have stopped.
    fn log_autosell_failure(&mut self, now: Instant, reason: &str) {
        let should_log = self
            .last_autosell_failure_log
            .is_none_or(|at| now.duration_since(at) >= AUTOSELL_FAILURE_LOG_INTERVAL);
        if should_log {
            self.last_autosell_failure_log = Some(now);
            emit(&OutEvent::BehaviorLog {
                message: format!("AutoSell: {reason} - versuche es weiter"),
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
        let now = Instant::now();
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
            if now <= until {
                if let Some(amount) = parse_sell_amount(message) {
                    emit(&OutEvent::SellEarning {
                        amount,
                        raw: message.to_string(),
                    });
                }
            }
        }

        // Proxy networks reject commands while they are persisting/restoring
        // the inventory. Treat that reply as a lifecycle signal: tear down the
        // current menu, wait briefly, then resume at normal configured cadence.
        if is_inventory_busy_message(message) {
            self.interrupt_for_transition(bot);
            self.postpone_automation_until(now + INVENTORY_BUSY_DELAY);
            return;
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

        if let Some((last_cmd, last_at)) = &self.last_tpaccept {
            if *last_cmd == command && now.duration_since(*last_at) < TPACCEPT_DEDUP {
                return;
            }
        }
        self.last_tpaccept = Some((command.clone(), now));

        // TPA acceptance may itself trigger a position sync. It must never be
        // sent while auto-sell owns a container; queue it first after forcibly
        // closing/cancelling that sell cycle.
        self.enqueue_chat(bot, command.clone());
        emit(&OutEvent::BehaviorLog {
            message: format!("TPAuto: teleport acceptance queued ({command})"),
        });
    }
}

/// Whether the bot's own inventory is currently mutable, i.e. no external
/// container GUI is open (a container occupies the same click channel, so we
/// refuse inventory edits while one is open).
fn inventory_is_mutable(bot: &Client) -> bool {
    matches!(bot.get_inventory(), Ok(inv) if inv.id() == 0)
}

/// Commands that commonly move the player or transfer it through a proxy.
/// They get priority over inventory work and a longer stabilization guard.
fn is_teleport_command(text: &str) -> bool {
    let Some(command) = text
        .trim()
        .strip_prefix('/')
        .and_then(|rest| rest.split_whitespace().next())
    else {
        return false;
    };
    matches!(
        command.to_ascii_lowercase().as_str(),
        "home"
            | "spawn"
            | "warp"
            | "server"
            | "hub"
            | "lobby"
            | "back"
            | "rtp"
            | "wild"
            | "tpaccept"
            | "tpyes"
            | "is"
            | "island"
            | "skyblock"
    )
}

/// Server reply emitted while a proxy is persisting/restoring inventory data.
fn is_inventory_busy_message(message: &str) -> bool {
    let lower = message.to_lowercase();
    (lower.contains("inventar") || lower.contains("inventory"))
        && ((lower.contains("gespeichert") && lower.contains("geladen"))
            || lower.contains("saved or loaded")
            || lower.contains("saving or loading")
            || lower.contains("being saved")
            || lower.contains("being loaded"))
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

/// Total number of items in the player's storage/hotbar section. This is only
/// used to wake an empty probe when fresh drops arrive; it is deliberately not
/// used to decide whether `/sell` may run or whether clicks were successful.
fn player_item_count(bot: &Client) -> u64 {
    let Ok(menu) = bot.menu() else { return 0 };
    let slots = menu.slots();
    menu.player_slots_range()
        .filter_map(|slot| slots.get(slot))
        .filter(|stack| stack.is_present())
        .map(|stack| stack.count().max(0) as u64)
        .sum()
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
    matches!(
        BlockKind::from(state),
        BlockKind::Spawner | BlockKind::TrialSpawner
    )
    .then_some(pos)
}

/// Extracts a monetary amount from `text`, preferring a `$`-prefixed number and
/// otherwise falling back to the first plausible number. Thousands separators
/// (commas) are stripped; an optional decimal part is kept.
fn extract_money(text: &str) -> Option<f64> {
    static DOLLAR: OnceLock<Regex> = OnceLock::new();
    static NUMBER: OnceLock<Regex> = OnceLock::new();
    let dollar = DOLLAR.get_or_init(|| Regex::new(r"\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)").unwrap());
    let number = NUMBER.get_or_init(|| Regex::new(r"([0-9][0-9,]*(?:\.[0-9]+)?)").unwrap());

    let cap = dollar.captures(text).or_else(|| number.captures(text))?;
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
    "to",
    "the",
    "this",
    "that",
    "and",
    "or",
    "type",
    "click",
    "accept",
    "request",
    "um",
    "zu",
    "die",
    "der",
    "den",
    "das",
    "und",
    "oder",
    "dich",
    "dir",
    "anfrage",
    "annehmen",
    "akzeptieren",
    "tippe",
    "schreibe",
    "hier",
    "klicke",
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
            && cleaned
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_');
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
    use super::{
        is_inventory_busy_message, is_teleport_command, parse_balance, parse_sell_amount,
        parse_tpa_accept_command, tpaccept_target_name,
    };

    #[test]
    fn lifecycle_commands_are_detected() {
        assert!(is_teleport_command("/home farm"));
        assert!(is_teleport_command(" /SERVER survival "));
        assert!(is_teleport_command("/tpaccept Steve tpa"));
        assert!(!is_teleport_command("/balance"));
        assert!(!is_teleport_command("hello"));
    }

    #[test]
    fn inventory_loading_reply_is_detected() {
        assert!(is_inventory_busy_message(
            "Du kannst dies nicht tun, weil dein Inventar gerade gespeichert oder geladen wird."
        ));
        assert!(is_inventory_busy_message(
            "Your inventory is currently being loaded"
        ));
        assert!(!is_inventory_busy_message("Dein Inventar ist leer"));
    }

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
            parse_sell_amount(
                "CHAT <HUGE> +$14,492.50 (Basis: $8,525.00, Bonus: +$5,967.50 durch 1.7x)"
            ),
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
            parse_tpa_accept_command(
                "[HugoSMP] Desmodus hat dir eine Teleportations-Anfrage gesendet!"
            ),
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
