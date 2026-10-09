//! Account automation, run natively inside the Rust bot process.
//!
//! Everything here is driven from `Event::Tick` (fired 20x/second by Azalea
//! while the bot is in a loaded world). This intentionally avoids spawning any
//! Tokio tasks: Azalea runs its ECS systems outside of a Tokio runtime context,
//! so `tokio::spawn`/`spawn_local` from inside an event handler is unreliable.
//! Tick-driven timing keeps behaviors simple, deterministic and cheap.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use azalea::container::ContainerHandleRef;
use azalea::entity::{inventory::Inventory, InLoadedChunk};
use azalea::movement::LastSentInput;
use azalea::protocol::packets::game::ClientboundContainerSetContent;
use azalea::registry::builtin::BlockKind;
use azalea::{BlockPos, Client, InGameState};
use azalea_inventory::components::{CustomName, Lore};
use azalea_inventory::operations::{PickupClick, ThrowClick};
use azalea_inventory::ItemStack;

use crate::emit;
use crate::protocol::{BehaviorConfig, Config, OutEvent};

/// Allow slow servers/proxies to finish opening and synchronizing the menu.
/// Healthy cycles still proceed immediately; this only bounds missing replies.
const AUTOSELL_MENU_TIMEOUT: Duration = Duration::from_secs(5);
/// Never overlap sell commands, and cap even very short configured intervals
/// at four commands per second.
const AUTOSELL_MIN_COMMAND_INTERVAL: Duration = Duration::from_millis(250);
/// All player slots are shift-clicked immediately when the populated container
/// becomes visible. Keep it open for one game tick so the queued click packets
/// precede the close packet on the wire.
const AUTOSELL_CLOSE_DELAY: Duration = Duration::from_millis(50);
/// A menu that appears while auto-sell is idle is a delayed response from an
/// earlier timed-out request (or a close that has not settled locally). Close
/// it and give the close packet two game ticks before issuing another command.
const AUTOSELL_ORPHAN_RECOVERY_DELAY: Duration = Duration::from_millis(100);
/// Wait after a full spawn before sending automation commands. `Spawn` means
/// the chunk is usable, but proxy networks may still be restoring the player
/// inventory for a brief moment (the attached HugoSMP log showed exactly this).
const SPAWN_STABILIZE_DELAY: Duration = Duration::from_secs(2);
/// Position sync packets are emitted for /home, accepted TPAs and other
/// same-world teleports. Let the destination and inventory settle before the
/// next sell cycle starts.
const TELEPORT_STABILIZE_DELAY: Duration = Duration::from_millis(100);
/// A proxy may omit/reorder Spawn during a transfer. Recover once the actual
/// destination chunk and inventory are usable, after a bounded loading guard.
const WORLD_TRANSITION_RECOVERY_DELAY: Duration = Duration::from_secs(5);
/// A teleport command is paused immediately, even before its position packet
/// arrives. This also covers rejected/slow commands without freezing forever.
const TELEPORT_COMMAND_GUARD: Duration = Duration::from_millis(750);
/// Small serialization gap after a normal chat command. Commands can open a
/// GUI asynchronously, so auto-sell must not start on the following tick.
const CHAT_COMMAND_GUARD: Duration = Duration::from_millis(100);
const COMMAND_MENU_CLOSE_DELAY: Duration = Duration::from_millis(750);
/// Accept delayed replies only while the sell request still owns the channel.
const AUTOSELL_LATE_MENU_WINDOW: Duration = Duration::from_secs(10);
/// Retry delay when the server explicitly says the inventory is still being
/// saved/loaded. This is a transient lifecycle state, not an auto-sell failure.
const INVENTORY_BUSY_DELAY: Duration = Duration::from_secs(1);
/// Repeated menu failures are logged at most this often. Retrying itself still
/// follows the configured interval and is never slowed down by logging.
const AUTOSELL_FAILURE_LOG_INTERVAL: Duration = Duration::from_secs(30);
/// How often the bot emits a heartbeat so the Node supervisor can tell a live
/// (but silent) bot apart from a hung one and recycle the latter.
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);
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
/// Tracks one auto-sell cycle. Each cycle opens the sell menu, immediately
/// shift-clicks the inventory and closes it again ("open/close principle") —
/// the menu is never left open between cycles, so the bot's GUI is free for chat,
/// manual commands and the spawner tasks in between.
#[derive(Clone, Copy)]
enum AutoSellPhase {
    Idle,
    /// The sell command was sent; waiting for the server to open its GUI.
    WaitingForMenu {
        since: Instant,
        /// Local inventory state at request time; only used to retry fresh drops.
        started_empty: bool,
        /// Full content packet for this cycle (container id and slot count).
        /// Menu slot arrays are preallocated, so their length alone is not a
        /// loading signal. A confirmed empty menu is still fully loaded.
        content_received: Option<(i32, usize)>,
    },
    /// Every occupied player slot has already been shift-clicked. Close the
    /// menu on the following game tick and immediately release the next cycle.
    Closing {
        close_at: Instant,
    },
}

/// A one-shot, foreground task. While one is queued or running, the continuous
/// auto-sell loop is paused (it won't start a new cycle), and a queued task
/// only begins once auto-sell is back to `Idle`. This guarantees the bot never
/// runs two menu/inventory interactions at once — the core of the task-interrupt
/// (pause/resume) system. Scheduling/timing lives in Node; this just ensures
/// safe, non-overlapping execution.
enum ForegroundTask {
    /// Send a single chat line requested by the user.
    Chat { text: String, teleporting: bool },
    /// Right-click a nearby spawner and drop the items in its container.
    CleanSpawner,
}

/// A foreground task that is mid-execution and spans multiple ticks.
enum ActiveTask {
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
    /// Earliest time a new auto-sell cycle may start. The timestamp is advanced
    /// when a command is sent, so a slow cycle never overlaps the next one.
    next_autosell_at: Instant,
    /// Independent of spawn/teleport/config guards, which may be reset at any time.
    restart_sell_pause: Option<(Instant, Instant)>,
    manual_chat_queue: VecDeque<String>,
    autosell_phase: AutoSellPhase,
    last_autosell_failure_log: Option<Instant>,
    /// Automation is disabled before the first Spawn and during Login/Respawn
    /// world/server changes. This prevents commands while the server is
    /// saving or loading the inventory.
    spawned: bool,
    /// Azalea does not emit another Spawn for every Respawn packet. In that
    /// case the following position synchronization completes the world switch.
    awaiting_respawn_position: bool,
    transition_recovery_at: Option<Instant>,
    /// Shared quiescence gate for spawn, teleports and asynchronous commands.
    automation_ready_at: Instant,
    /// Background scan commands may open a temporary menu. Manual command
    /// menus have separate ownership and are never closed by this timer.
    command_menu_close_at: Option<Instant>,
    /// A manual command can open a GUI even when it looks like a teleport.
    manual_menu_guard_until: Option<Instant>,
    manual_menu_id: Option<i32>,
    manual_priority_until: Option<Instant>,
    cancelled_sell_until: Option<Instant>,
    /// Only a response to our own sell request may be clicked or recovered.
    last_sell_request_at: Option<Instant>,
    sell_menu: Option<(i32, String)>,
    /// Foreground one-shot tasks awaiting execution (see [`ForegroundTask`]).
    task_queue: VecDeque<ForegroundTask>,
    /// The foreground task currently mid-execution, if any.
    active_task: Option<ActiveTask>,
    last_heartbeat_at: Instant,
    /// Re-send held crouch after a world/position transition has settled.
    crouch_resync_pending: bool,
    next_crouch_check_at: Instant,
}

impl BehaviorState {
    pub fn new(config: &Config) -> Self {
        let now = Instant::now();
        Self {
            config: BehaviorConfig {
                crouch_enabled: config.crouch_enabled,
                autosell_enabled: config.autosell_enabled,
                autosell_interval_seconds: config.autosell_interval_seconds,
                autosell_command: config.autosell_command.clone(),
                spawner_type: config.spawner_type.clone(),
                spawner_drop_items: config.spawner_drop_items.clone(),
                spawner_sell_items: config.spawner_sell_items.clone(),
            },
            next_autosell_at: now,
            restart_sell_pause: (config.autosell_resume_after_ms > 0).then(|| {
                (
                    now + Duration::from_millis(config.autosell_pause_after_ms),
                    now + Duration::from_millis(config.autosell_resume_after_ms),
                )
            }),
            manual_chat_queue: VecDeque::new(),
            autosell_phase: AutoSellPhase::Idle,
            last_autosell_failure_log: None,
            spawned: false,
            awaiting_respawn_position: false,
            transition_recovery_at: None,
            automation_ready_at: now,
            command_menu_close_at: None,
            manual_menu_guard_until: None,
            manual_menu_id: None,
            manual_priority_until: None,
            cancelled_sell_until: None,
            last_sell_request_at: None,
            sell_menu: None,
            task_queue: VecDeque::new(),
            active_task: None,
            last_heartbeat_at: now,
            crouch_resync_pending: false,
            next_crouch_check_at: now,
        }
    }

    /// Apply a live settings update (from a `Command::Configure`).
    pub fn update_config(&mut self, config: BehaviorConfig) {
        let autosell_schedule_changed = self.config.autosell_enabled != config.autosell_enabled
            || self.config.autosell_interval_seconds != config.autosell_interval_seconds
            || self.config.autosell_command != config.autosell_command;
        self.config = config;
        if autosell_schedule_changed && self.config.autosell_enabled {
            let now = Instant::now();
            self.next_autosell_at = self.automation_ready_at.max(now);
        }
    }

    /// Manual console commands have their own FIFO and can interrupt inventory
    /// automation on the next tick; menu timeouts must never hold them hostage.
    pub fn enqueue_chat(&mut self, _bot: &Client, text: String) {
        let text = text.trim();
        if !text.is_empty() {
            self.manual_chat_queue.push_back(text.to_string());
        }
    }

    /// Background scans retain the serialized foreground queue and yield to
    /// manual commands. They must not repeatedly cancel a sell/spawner cycle.
    pub fn enqueue_background_chat(&mut self, text: String) {
        let text = text.trim();
        if !text.is_empty() {
            self.task_queue.push_back(ForegroundTask::Chat {
                text: text.to_string(),
                teleporting: is_teleport_command(text),
            });
        }
    }

    fn tick_manual_chat(&mut self, bot: &Client, now: Instant) -> bool {
        // Spawn may still describe the previous world while a proxy has moved
        // the connection into configuration. Azalea discards game packets then.
        if bot.component::<InGameState>().is_err() {
            return false;
        }
        let Some(text) = self.manual_chat_queue.pop_front() else {
            return false;
        };
        let manual_sell = text.trim() == self.config.autosell_command.trim();
        if !manual_sell
            && (self.last_sell_request_at.is_some()
                || !matches!(self.autosell_phase, AutoSellPhase::Idle)
                || self.owns_sell_menu(bot))
        {
            self.cancelled_sell_until = Some(now + AUTOSELL_LATE_MENU_WINDOW);
        } else if manual_sell {
            self.cancelled_sell_until = None;
        }
        self.manual_priority_until = Some(now + AUTOSELL_MENU_TIMEOUT);
        self.close_open_menu(bot);
        // Closing is deferred in Azalea's ECS. Interrupting again before it
        // settles would send a second close for the same container.
        self.reset_interactions();
        bot.ecs.write().flush();
        if !self.send_manual_chat_now(bot, &text) {
            self.manual_chat_queue.push_front(text);
            return false;
        }
        self.guard_after_chat(now, is_teleport_command(&text));
        // Manual GUIs stay open until the server closes them, a teleport
        // completes, or the user issues another command. /home may open a GUI.
        self.command_menu_close_at = None;
        self.manual_menu_guard_until = text.starts_with('/').then_some(now + AUTOSELL_MENU_TIMEOUT);
        emit(&OutEvent::BehaviorLog {
            message: format!("Command dispatched: {text}"),
        });
        true
    }

    /// Drain the pending chat messages through the real Azalea packet handlers
    /// now. Waiting for Update can leave a manual command behind a queued sell.
    /// Drain consumed messages afterwards so Update cannot send them twice.
    fn send_manual_chat_now(&self, bot: &Client, text: &str) -> bool {
        use azalea::client_chat::{
            handle_send_chat_event,
            handler::{handle_send_chat_kind_event, SendChatKindEvent},
            SendChatEvent,
        };
        use azalea::ecs::prelude::Messages;
        use azalea::ecs::system::RunSystemOnce;
        let mut ecs = bot.ecs.write();
        let pending: Vec<_> = ecs
            .resource_mut::<Messages<SendChatEvent>>()
            .drain()
            .filter(|event| {
                event.entity != bot.entity
                    || event.content.trim() != self.config.autosell_command.trim()
            })
            .collect();
        ecs.write_message(SendChatEvent {
            entity: bot.entity,
            content: text.to_owned(),
        });
        ecs.write_message_batch(pending);
        ecs.init_resource::<Messages<SendChatKindEvent>>();
        let result = ecs
            .run_system_once(handle_send_chat_event)
            .and_then(|_| ecs.run_system_once(handle_send_chat_kind_event));
        if let Err(error) = &result {
            emit(&OutEvent::Warning {
                message: format!("Command-Paket konnte nicht erstellt werden: {error}"),
            });
        }
        ecs.resource_mut::<Messages<SendChatEvent>>()
            .drain()
            .for_each(drop);
        ecs.resource_mut::<Messages<SendChatKindEvent>>()
            .drain()
            .for_each(drop);
        ecs.flush();
        if result.is_ok() {
            if let Some(mut connection) =
                ecs.get_mut::<azalea::connection::RawConnection>(bot.entity)
            {
                if let Some(network) = connection.net_conn() {
                    network.poll_writer();
                }
            }
        }
        result.is_ok()
    }

    fn close_cancelled_sell_menu(&self, bot: &Client, now: Instant) {
        if self.cancelled_sell_until.is_some_and(|until| now < until) && self.owns_sell_menu(bot) {
            self.close_sell_menu(bot);
            bot.ecs.write().flush();
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

    pub fn pause_autosell(&mut self, after_ms: u64, resume_ms: u64) {
        let now = Instant::now();
        self.restart_sell_pause = (resume_ms > 0).then(|| {
            (
                now + Duration::from_millis(after_ms),
                now + Duration::from_millis(resume_ms),
            )
        });
    }

    fn sell_paused(&self, now: Instant) -> bool {
        self.restart_sell_pause
            .is_some_and(|(start, end)| now >= start && now < end)
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
        if self.active_task.is_some() || self.command_menu_close_at.is_some() {
            self.close_open_menu(bot);
        } else {
            self.close_sell_menu(bot);
        }
        self.reset_interactions();
    }

    fn reset_interactions(&mut self) {
        self.autosell_phase = AutoSellPhase::Idle;
        self.active_task = None;
        self.command_menu_close_at = None;
        self.manual_menu_guard_until = None;
        self.manual_menu_id = None;
        self.last_sell_request_at = None;
        self.sell_menu = None;
    }

    fn guard_after_chat(&mut self, now: Instant, teleporting: bool) {
        let delay = if teleporting {
            TELEPORT_COMMAND_GUARD
        } else {
            CHAT_COMMAND_GUARD
        };
        self.postpone_automation_until(now + delay);
        self.command_menu_close_at = (!teleporting).then_some(now + COMMAND_MENU_CLOSE_DELAY);
    }

    /// Called for Login, including proxy server and dimension/world changes.
    /// Automation resumes on Spawn, authoritative position synchronization,
    /// or a loaded-world check when the proxy omits those events.
    pub fn on_login(&mut self, bot: &Client) {
        self.interrupt_for_transition(bot);
        self.spawned = false;
        self.awaiting_respawn_position = true;
        self.transition_recovery_at = Some(Instant::now() + WORLD_TRANSITION_RECOVERY_DELAY);
        self.crouch_resync_pending = true;
    }

    pub fn on_respawn(&mut self, bot: &Client) {
        self.on_login(bot);
        self.awaiting_respawn_position = true;
    }

    /// Called for a server position synchronization. After the initial spawn
    /// these packets cover /home, TPA and same-world teleports that do not emit
    /// another Login/Spawn pair.
    pub fn on_position_sync(&mut self, bot: &Client) {
        if self.awaiting_respawn_position {
            // A position packet alone does not mean the destination chunk or
            // the player inventory has finished loading.
            if bot.component::<InLoadedChunk>().is_err() {
                return;
            }
            self.spawned = true;
            self.awaiting_respawn_position = false;
            self.transition_recovery_at = None;
            self.postpone_automation_until(Instant::now() + SPAWN_STABILIZE_DELAY);
        }
        if !self.spawned {
            return;
        }
        let now = Instant::now();
        self.interrupt_for_transition(bot);
        // A position acknowledgement must not shorten a spawn/loading guard
        // or erase the separate manual-command pause.
        self.postpone_automation_until(now + TELEPORT_STABILIZE_DELAY);
        self.next_autosell_at = self.automation_ready_at;
        self.crouch_resync_pending = true;
    }

    pub fn check_crouch(&mut self, bot: &Client) {
        if !self.config.crouch_enabled {
            return;
        }
        let status = bot
            .component::<azalea::entity::metadata::AbstractEntityShiftKeyDown>()
            .map(|flag| if **flag { "bestätigt" } else { "nicht aktiv" })
            .unwrap_or("noch nicht bestätigt");
        emit(&OutEvent::BehaviorLog { message: format!("Crouch-Check nach Weltneustart: Serverstatus {status}; Sneak wird erneut angefordert") });
        self.crouch_resync_pending = true;
        self.next_crouch_check_at = Instant::now();
    }

    /// Initial join, respawn and proxy/world switches reset the server's input.
    pub fn on_spawn(&mut self, bot: &Client) {
        let now = Instant::now();
        self.interrupt_for_transition(bot);
        self.spawned = true;
        self.awaiting_respawn_position = false;
        self.transition_recovery_at = None;
        self.automation_ready_at = now + SPAWN_STABILIZE_DELAY;
        self.next_autosell_at = self.automation_ready_at;
        self.last_autosell_failure_log = None;
        self.crouch_resync_pending = true;
    }

    /// Invalidate Azalea's input cache without ever releasing the sneak key.
    /// A false/true toggle between ticks can be coalesced and send no packet.
    fn resync_crouch(bot: &Client) -> bool {
        if bot.set_crouching(true).is_err() {
            return false;
        }
        let mut ecs = bot.ecs.write();
        let Ok(mut entity) = ecs.get_entity_mut(bot.entity) else {
            return false;
        };
        entity.remove::<LastSentInput>();
        true
    }

    pub fn on_tick(&mut self, bot: &Client) {
        let now = Instant::now();
        self.recover_loaded_world(bot, now);
        // Cancel menu interactions at the pause boundary before any more sell clicks.
        if self.sell_paused(now)
            && (!matches!(self.autosell_phase, AutoSellPhase::Idle) || self.active_task.is_some())
        {
            self.interrupt_for_transition(bot);
        }

        // Only restore input once the destination is ready. Keep the pending
        // flag on failures so missing components during transfer are retried.
        if self.config.crouch_enabled {
            if self.spawned
                && (self.crouch_resync_pending || now >= self.next_crouch_check_at)
                && now >= self.automation_ready_at
            {
                if Self::resync_crouch(bot) {
                    self.crouch_resync_pending = false;
                    let server_sneaking = bot
                        .component::<azalea::entity::metadata::AbstractEntityShiftKeyDown>()
                        .is_ok_and(|state| state.0);
                    self.next_crouch_check_at = now
                        + if server_sneaking {
                            Duration::from_secs(2)
                        } else {
                            Duration::from_millis(500)
                        };
                }
            } else if self.spawned && !bot.crouching() {
                let _ = bot.set_crouching(true);
            }
        } else {
            self.crouch_resync_pending = false;
            if bot.crouching() {
                let _ = bot.set_crouching(false);
            }
        }

        self.close_cancelled_sell_menu(bot, now);
        let manual_ran = self.tick_manual_chat(bot, now);

        if self.command_menu_close_at.is_some_and(|at| now >= at) {
            self.close_open_menu(bot);
            self.command_menu_close_at = None;
        }

        // Before Spawn, and for a short stabilization period after a spawn or
        // teleport, automatic actions wait for inventory loading. Explicit
        // manual commands above remain responsive once the client has spawned.
        let automation_ready = self.spawned
            && now >= self.automation_ready_at
            && bot.component::<InGameState>().is_ok();

        // A late sell-menu response used to leave auto-sell in `Idle` with a
        // non-zero container id. Both the foreground queue and auto-sell then
        // waited for each other forever, and only a full account restart reset
        // the inventory state. Recover that orphan before dispatching either
        // kind of work. Command-owned and active spawner menus are excluded.
        let recovered_orphan_menu =
            automation_ready && !manual_ran && self.recover_orphaned_autosell_menu(bot, now);

        if automation_ready && !manual_ran && !recovered_orphan_menu {
            let foreground_ran = self.tick_foreground(bot, now);
            if !foreground_ran {
                self.tick_autosell(bot, now);
            }
        }

        // Heartbeat: prove the tick loop is alive so the supervisor can recycle
        // a genuinely hung bot without killing a healthy but idle one.
        if now.duration_since(self.last_heartbeat_at) >= HEARTBEAT_INTERVAL {
            self.last_heartbeat_at = now;
            emit(&OutEvent::Heartbeat);
        }
    }

    /// Keep explicit commands responsive on login/packet events even when no
    /// world Tick is being emitted. This must not run automatic selling.
    pub fn on_control_event(&mut self, bot: &Client) {
        let now = Instant::now();
        self.close_cancelled_sell_menu(bot, now);
        self.tick_manual_chat(bot, now);
    }

    pub fn on_menu_open(&mut self, id: i32, title: String) {
        let now = Instant::now();
        self.manual_menu_id = None;
        if self.manual_menu_guard_until.is_some_and(|at| now < at) {
            self.manual_menu_id = Some(id);
            emit(&OutEvent::BehaviorLog {
                message: format!("Manuelles Menü geöffnet: {title}; AutoSell wartet"),
            });
            return;
        }
        if self.active_task.is_none()
            && self.command_menu_close_at.is_none()
            && (is_sell_menu_title(&title)
                || self.last_sell_request_at.is_some_and(|at| {
                    now.saturating_duration_since(at) <= AUTOSELL_LATE_MENU_WINDOW
                }))
        {
            self.sell_menu = Some((id, title));
        } else if self.active_task.is_none() && self.command_menu_close_at.is_none() {
            emit(&OutEvent::BehaviorLog {
                message: format!("AutoSell wartet: fremdes Menü geöffnet ({title}); manuelle Commands bleiben verfügbar"),
            });
        }
    }

    fn manual_menu_pending(&self, bot: &Client, now: Instant) -> bool {
        self.manual_priority_until.is_some_and(|at| now < at)
            || self.manual_menu_guard_until.is_some_and(|at| now < at)
            || self.manual_menu_id.is_some_and(|id| {
                bot.component::<Inventory>().is_ok_and(|inventory| {
                    inventory.id == id
                        && !inventory
                            .container_menu_title
                            .as_ref()
                            .is_some_and(|title| is_sell_menu_title(&title.to_string()))
                })
            })
    }

    fn owns_sell_menu(&self, bot: &Client) -> bool {
        bot.component::<Inventory>().is_ok_and(|inventory| {
            inventory.id != 0
                && inventory
                    .container_menu_title
                    .as_ref()
                    .is_some_and(|current| {
                        let current = current.to_string();
                        // Read the authoritative ECS menu as well as the request
                        // association: packet callbacks can lag behind ECS updates,
                        // and Spawn/position events clear the previous request.
                        is_sell_menu_title(&current)
                            || self
                                .sell_menu
                                .as_ref()
                                .is_some_and(|(id, title)| inventory.id == *id && current == *title)
                    })
        })
    }

    fn close_sell_menu(&self, bot: &Client) {
        if self.owns_sell_menu(bot) {
            self.close_open_menu(bot);
        }
    }

    /// Drives the foreground one-shot task queue (the task-interrupt system).
    /// A queued task only starts once auto-sell is idle, so menu/inventory
    /// interactions never overlap; instant tasks (a chat command) complete in
    /// the same tick, while multi-tick tasks (a spawner clear) become the
    /// `active_task` until they finish or time out.
    fn tick_foreground(&mut self, bot: &Client, now: Instant) -> bool {
        // Scheduled scans/spawner tasks must not close a user's pending GUI.
        if self.manual_menu_pending(bot, now) {
            return false;
        }
        let mut ran = self.active_task.is_some();
        // Advance an in-progress multi-tick task.
        match &self.active_task {
            Some(ActiveTask::CleanSpawner(progress)) => {
                let progress = *progress;
                self.advance_clean_spawner(bot, now, progress);
            }
            None => {}
        }

        // Start the next queued task, but only when nothing is active and
        // auto-sell isn't mid-cycle — this is what enforces mutual exclusion.
        if self.active_task.is_none()
            && matches!(self.autosell_phase, AutoSellPhase::Idle)
            && self.command_menu_close_at.is_none()
        {
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
                            message: format!("Command sent: {text}"),
                        });
                    }
                    ForegroundTask::CleanSpawner
                        if self.sell_paused(now) || !inventory_is_mutable(bot) =>
                    {
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
    /// Basic fast path: open the menu, shift every occupied player slot in one
    /// pass, close on the next game tick. There is no batch/confirmation phase
    /// and no success logging on the hot path.
    fn tick_autosell(&mut self, bot: &Client, now: Instant) {
        if !self.config.autosell_enabled || self.sell_paused(now) {
            if !matches!(self.autosell_phase, AutoSellPhase::Idle) {
                self.close_sell_menu(bot);
            }
            self.autosell_phase = AutoSellPhase::Idle;
            self.last_autosell_failure_log = None;
            return;
        }

        let configured_interval =
            Duration::from_secs_f64(self.config.autosell_interval_seconds.max(0.05));
        let interval = configured_interval.max(AUTOSELL_MIN_COMMAND_INTERVAL);

        match self.autosell_phase {
            AutoSellPhase::Idle => {
                // Don't start a new cycle while a foreground one-shot task is
                // queued or running - this is the "pause" half of the interrupt
                // system. An in-progress cycle below is always allowed to finish.
                if self.foreground_busy()
                    || self.command_menu_close_at.is_some()
                    || self.manual_menu_pending(bot, now)
                {
                    return;
                }

                if now < self.next_autosell_at {
                    return;
                }

                // Orphaned sell menus are normally removed before reaching
                // this function. Keep this guard as a final safety net for a
                // container that opened between the recovery pass and now.
                if let Ok(inv) = bot.get_inventory() {
                    if inv.id() != 0 {
                        // A spawn/home/server selector is not an orphaned sale.
                        // Leave it alone; explicit commands can always interrupt it.
                        return;
                    }
                }

                let started_empty = player_item_count(bot) == 0;
                let command = self.config.autosell_command.trim();
                let command = if command.is_empty() { "/sell" } else { command };
                self.next_autosell_at = now + interval;
                self.last_sell_request_at = Some(now);
                // A fresh request owns the sell channel again; its response
                // must not be closed under the previous cancellation guard.
                self.cancelled_sell_until = None;
                bot.chat(command.to_string());
                self.autosell_phase = AutoSellPhase::WaitingForMenu {
                    since: now,
                    started_empty,
                    content_received: None,
                };
            }

            AutoSellPhase::WaitingForMenu {
                since,
                started_empty,
                content_received,
            } => {
                let mut failure = "Inventar momentan nicht verfügbar".to_string();
                // Copy the id and menu together, then release the ECS read
                // guard before shift_click needs its write lock.
                if let Ok((id, menu)) = bot
                    .component::<Inventory>()
                    .map(|inventory| (inventory.id, inventory.container_menu.clone()))
                {
                    failure = "Server hat kein Verkaufsmenü geöffnet".into();
                    if id != 0 && self.owns_sell_menu(bot) {
                        let inv = ContainerHandleRef::new(id, bot.clone());
                        if let Some(menu) = menu {
                            let slots = menu.slots();
                            let player_slots: Vec<usize> = menu
                                .player_slots_range()
                                .filter(|&slot| slots.get(slot).is_some_and(ItemStack::is_present))
                                .collect();
                            let complete_content = content_received
                                .is_some_and(|(id, count)| id == inv.id() && count >= slots.len());
                            let has_container = *menu.player_slots_range().start() > 0;
                            // Non-empty player slots are also valid for servers
                            // that synchronize via individual slot packets.
                            if has_container && (complete_content || !player_slots.is_empty()) {
                                // Process a ready menu before the deadline check:
                                // a delayed tick must not discard data that has
                                // already arrived. Empty menus need no clicks.
                                for slot in &player_slots {
                                    inv.shift_click(*slot);
                                }
                                self.last_autosell_failure_log = None;
                                self.autosell_phase = AutoSellPhase::Closing {
                                    close_at: now + AUTOSELL_CLOSE_DELAY,
                                };
                                return;
                            }
                            failure = format!(
                                "Menü {} offen, aber Inventardaten fehlen ({} Slots, {} Spieler-Stacks, Inhaltspaket: {})",
                                inv.id(), slots.len(), player_slots.len(),
                                if complete_content { "ja" } else { "nein" },
                            );
                        } else {
                            failure =
                                format!("Menü {} offen, Menüstruktur nicht verfügbar", inv.id());
                        }
                    }
                }
                // No early return on partial/empty shells: every unresolved
                // request obeys this deadline, including initially empty probes.
                if now.saturating_duration_since(since) >= AUTOSELL_MENU_TIMEOUT {
                    self.close_sell_menu(bot);
                    self.autosell_phase = AutoSellPhase::Idle;
                    let retry_at = now + AUTOSELL_ORPHAN_RECOVERY_DELAY;
                    if started_empty && player_item_count(bot) > 0 {
                        self.next_autosell_at = retry_at;
                    } else {
                        self.next_autosell_at = self.next_autosell_at.max(retry_at);
                    }
                    if !started_empty || player_item_count(bot) > 0 {
                        self.log_autosell_failure(now, &format!("{failure} (5s Timeout)"));
                    }
                }
            }

            AutoSellPhase::Closing { close_at } => {
                if now < close_at {
                    return;
                }
                self.close_sell_menu(bot);
                self.autosell_phase = AutoSellPhase::Idle;
                self.last_sell_request_at = None;
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

    /// Recover an identified sell menu after a late reply or a spawn reset.
    /// Reuse populated menus; close empty shells so retries can proceed.
    fn recover_orphaned_autosell_menu(&mut self, bot: &Client, now: Instant) -> bool {
        if !self.config.autosell_enabled
            || !matches!(self.autosell_phase, AutoSellPhase::Idle)
            || self.active_task.is_some()
            || self.command_menu_close_at.is_some()
            || self.manual_menu_pending(bot, now)
            || !self.owns_sell_menu(bot)
        {
            return false;
        }

        let Ok(inv) = bot.get_inventory() else {
            return false;
        };
        if inv.id() == 0 {
            return false;
        }

        if player_item_count(bot) > 0 && !self.sell_paused(now) {
            // A populated late/initial sell menu is already usable. Sell its
            // player slots instead of discarding it and requesting it again.
            self.autosell_phase = AutoSellPhase::WaitingForMenu {
                since: now,
                started_empty: false,
                content_received: None,
            };
            self.next_autosell_at = now
                + Duration::from_secs_f64(self.config.autosell_interval_seconds.max(0.05))
                    .max(AUTOSELL_MIN_COMMAND_INTERVAL);
            self.tick_autosell(bot, now);
            return true;
        }
        inv.close();
        self.next_autosell_at = now + AUTOSELL_ORPHAN_RECOVERY_DELAY;
        self.log_autosell_failure(now, "verspätetes/offenes Verkaufsmenü zurückgesetzt");
        true
    }

    /// Close any container the bot currently has open (best-effort no-op if none).
    fn close_open_menu(&self, bot: &Client) {
        if let Ok(inv) = bot.get_inventory() {
            if inv.id() != 0 {
                inv.close();
            }
        }
    }

    /// Contents/revisions are applied synchronously by the packet reader.
    /// Delayed callbacks must never overwrite newer slot revisions.
    pub fn on_container_content(&mut self, bot: &Client, packet: &ClientboundContainerSetContent) {
        if !bot
            .component::<Inventory>()
            .is_ok_and(|inv| inv.id == packet.container_id)
        {
            return;
        }
        if packet.container_id != 0 {
            if let AutoSellPhase::WaitingForMenu {
                content_received, ..
            } = &mut self.autosell_phase
            {
                *content_received = Some((packet.container_id, packet.items.len()));
            }
        }
    }

    /// A server inventory-loading reply invalidates the current sell GUI.
    pub fn on_chat(&mut self, bot: &Client, message: &str) {
        if is_teleport_success_message(message) {
            self.crouch_resync_pending = true;
            self.next_crouch_check_at = Instant::now();
            // The chat can precede the actual position packet. Keep checking
            // held input afterwards even if the local input cache stays true.
        }
        if is_inventory_busy_message(message) {
            // A rejected sell/pickup must not erase ownership of a manual GUI
            // or its independent pause and let AutoSell overtake the command.
            if !matches!(self.autosell_phase, AutoSellPhase::Idle)
                || self.last_sell_request_at.is_some()
            {
                self.close_sell_menu(bot);
            }
            self.autosell_phase = AutoSellPhase::Idle;
            self.last_sell_request_at = None;
            self.postpone_automation_until(Instant::now() + INVENTORY_BUSY_DELAY);
        }
    }

    fn recover_loaded_world(&mut self, bot: &Client, now: Instant) {
        if !self.spawned
            && self.transition_recovery_at.is_some_and(|at| now >= at)
            && bot.component::<InGameState>().is_ok()
            && bot.component::<InLoadedChunk>().is_ok()
            && bot.get_inventory().is_ok()
        {
            self.on_spawn(bot);
            emit(&OutEvent::BehaviorLog {
                message: "Weltwechsel abgeschlossen: Automation wieder aufgenommen".into(),
            });
        }
    }
}

/// Exact known titles only: a homes/server selector must never be clicked as a
/// sale merely because it arrived near a command. Custom sell menus still use
/// the association with the configured sell request above.
fn is_sell_menu_title(title: &str) -> bool {
    let mut plain = String::new();
    let mut chars = title.chars();
    while let Some(character) = chars.next() {
        if character == '§' {
            chars.next();
        } else {
            plain.push(character);
        }
    }
    matches!(
        plain
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase()
            .as_str(),
        "items verkaufen" | "sell"
    )
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
            | "tp"
            | "tpa"
            | "tpahere"
            | "tphere"
            | "tpaccept"
            | "tpyes"
            | "is"
            | "island"
            | "skyblock"
    )
}

fn is_teleport_success_message(message: &str) -> bool {
    let mut plain = String::new();
    let mut chars = message.chars();
    while let Some(c) = chars.next() {
        if c == '§' {
            chars.next();
        } else {
            plain.push(c);
        }
    }
    let plain = plain.trim();
    let plain = plain
        .strip_prefix("<HugoSMP>")
        .or_else(|| plain.strip_prefix("[HugoSMP]"))
        .unwrap_or(plain)
        .trim();
    (plain.starts_with("Du wurdest zu deinem Home ") && plain.ends_with(" teleportiert!"))
        || (plain.ends_with(" hat deine Teleportations-Anfrage angenommen!")
            && !plain.contains(':'))
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

/// Local player item count is only a hint for diagnostics and timeout recovery.
/// It must never slow the configured sell cadence: snapshots may be stale.
fn player_item_count(bot: &Client) -> u64 {
    let Ok(menu) = bot.menu() else { return 0 };
    let slots = menu.slots();
    menu.player_slots_range()
        .filter_map(|slot| slots.get(slot))
        .filter(|stack| stack.is_present())
        .map(|stack| stack.count().max(0) as u64)
        .sum()
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use azalea::client_chat::SendChatEvent;
    use azalea::ecs as bevy_ecs;
    use azalea::ecs::prelude::*;
    use azalea::entity::PlayerAbilities;
    use azalea::entity::{inventory::Inventory, InLoadedChunk, Jumping};
    use azalea::inventory::{
        handle_client_side_close_container_trigger, handle_set_container_content_trigger,
        ClientsideCloseContainerEvent, CloseContainerEvent, ContainerClickEvent,
    };
    use azalea::movement::{send_player_input_packet, LastSentInput};
    use azalea::packet::game::SendGamePacketEvent;
    use azalea::protocol::packets::game::{
        ClientboundContainerSetContent, ClientboundContainerSetSlot, ServerboundGamePacket,
        ServerboundPlayerInput,
    };
    use azalea::registry::builtin::ItemKind;
    use azalea::{Client, ClientMovementState, InGameState};
    use azalea_inventory::{ItemStack, Menu};
    use parking_lot::{Mutex, RwLock};

    use super::{
        is_inventory_busy_message, is_teleport_command, AutoSellPhase, BehaviorState,
        AUTOSELL_MENU_TIMEOUT,
    };

    fn crouch_client(enabled: bool) -> (Client, BehaviorState, Arc<Mutex<Vec<bool>>>) {
        let mut world = World::new();
        // Simulate stale input carried over from the previous server/world.
        let entity = world
            .spawn((
                ClientMovementState {
                    trying_to_crouch: true,
                    ..Default::default()
                },
                Jumping::default(),
                azalea::entity::metadata::AbstractEntityShiftKeyDown(true),
                LastSentInput(ServerboundPlayerInput {
                    shift: true,
                    ..Default::default()
                }),
            ))
            .id();
        let packets = Arc::new(Mutex::new(Vec::new()));
        let captured = packets.clone();
        world.add_observer(move |event: On<SendGamePacketEvent>| {
            if let ServerboundGamePacket::PlayerInput(input) = &event.packet {
                captured.lock().push(input.shift);
            }
        });
        let client = Client {
            entity,
            ecs: Arc::new(RwLock::new(world)),
        };
        let config = serde_json::from_value(serde_json::json!({
            "host": "localhost", "port": 25565, "auth_type": "offline",
            "username": "Bot", "cache_dir": "", "crouch_enabled": enabled
        }))
        .unwrap();
        (client, BehaviorState::new(&config), packets)
    }

    fn send_input(client: &Client) {
        let mut schedule = Schedule::default();
        schedule.add_systems(send_player_input_packet);
        schedule.run(&mut client.ecs.write());
    }

    fn sell_client() -> (Client, BehaviorState) {
        let (client, mut state, _) = crouch_client(false);
        let mut world = client.ecs.write();
        world.init_resource::<Messages<SendChatEvent>>();
        world.init_resource::<SentManualCommands>();
        world.add_observer(
            |event: On<SendGamePacketEvent>, mut sent: ResMut<SentManualCommands>| {
                if let ServerboundGamePacket::ChatCommand(packet) = &event.packet {
                    sent.0.push(format!("/{}", packet.command));
                }
            },
        );
        world
            .entity_mut(client.entity)
            .insert((Inventory::default(), InGameState, InLoadedChunk));
        world.add_observer(handle_client_side_close_container_trigger);
        world.add_observer(handle_set_container_content_trigger);
        world.add_observer(
            |event: On<CloseContainerEvent>,
             inventories: Query<&Inventory>,
             mut commands: Commands| {
                let inventory = inventories.get(event.entity).unwrap();
                assert_eq!(event.id, inventory.id);
                commands.trigger(ClientsideCloseContainerEvent {
                    entity: event.entity,
                });
            },
        );
        drop(world);
        state.config.autosell_enabled = true;
        state.config.autosell_interval_seconds = 0.25;
        state.spawned = true;
        (client, state)
    }

    fn put_player_stack(client: &Client) {
        *client
            .ecs
            .write()
            .get_mut::<Inventory>(client.entity)
            .unwrap()
            .inventory_menu
            .slot_mut(9)
            .unwrap() = ItemStack::new(ItemKind::Beef, 64);
    }

    fn open_foreign_menu(client: &Client, state: &mut BehaviorState, title: &str) {
        let mut world = client.ecs.write();
        let mut inventory = world.get_mut::<Inventory>(client.entity).unwrap();
        inventory.id = 7;
        inventory.container_menu_title = Some(title.into());
        inventory.container_menu = Some(Menu::Generic9x3 {
            contents: Default::default(),
            player: Default::default(),
        });
        drop(inventory);
        drop(world);
        state.on_menu_open(7, title.into());
    }

    #[test]
    fn spawn_selector_is_neither_closed_nor_shift_clicked_by_autosell() {
        let (client, mut state) = sell_client();
        let clicks = capture_sell_clicks(&client);
        open_foreign_menu(&client, &mut state, "Serverauswahl");
        state.on_spawn(&client);
        client.ecs.write().flush();
        state.automation_ready_at = Instant::now();
        for _ in 0..3 {
            state.on_tick(&client);
        }
        assert_eq!(client.get_inventory().unwrap().id(), 7);
        assert!(take_commands(&client).is_empty());
        assert!(clicks.lock().is_empty());
    }

    #[test]
    fn manual_home_menu_survives_guards_and_next_explicit_command_can_escape() {
        let (client, mut state) = sell_client();
        let clicks = capture_sell_clicks(&client);
        state.enqueue_chat(&client, "/home".into());
        state.on_control_event(&client);
        assert_eq!(take_commands(&client), vec!["/home"]);
        open_foreign_menu(&client, &mut state, "Homes");
        // The old implementation closed this as an orphan after just 750ms.
        state.manual_menu_guard_until = Some(Instant::now() - Duration::from_secs(10));
        state.manual_priority_until = None;
        state.automation_ready_at = Instant::now();
        state.next_autosell_at = Instant::now();
        state.on_tick(&client);
        client.ecs.write().flush();
        assert_eq!(client.get_inventory().unwrap().id(), 7);
        assert!(take_commands(&client).is_empty());
        assert!(clicks.lock().is_empty());
        state.enqueue_chat(&client, "/home farm".into());
        state.on_control_event(&client);
        client.ecs.write().flush();
        assert_eq!(take_commands(&client), vec!["/home farm"]);
        assert_eq!(client.get_inventory().unwrap().id(), 0);
    }

    #[test]
    fn commands_work_in_game_without_spawn_or_world_ticks_even_during_restart_pause() {
        let (client, mut state) = sell_client();
        state.on_login(&client);
        client.ecs.write().flush();
        client
            .ecs
            .write()
            .entity_mut(client.entity)
            .insert(InGameState);
        state.pause_autosell(0, 300_000);
        state.enqueue_chat(&client, "/home farm".into());
        state.on_control_event(&client);
        assert_eq!(take_commands(&client), vec!["/home farm"]);
        assert!(!state.spawned);
        assert!(matches!(state.autosell_phase, AutoSellPhase::Idle));
    }

    #[test]
    fn delayed_reply_after_sell_timeout_is_recovered_only_for_the_owned_menu() {
        let (client, mut state) = sell_client();
        let since = Instant::now();
        tick_sell(&client, &mut state, since);
        assert_eq!(take_commands(&client), vec!["/sell"]);
        tick_sell(&client, &mut state, since + AUTOSELL_MENU_TIMEOUT);
        open_foreign_menu(&client, &mut state, "Sell");
        assert!(state.recover_orphaned_autosell_menu(&client, since + Duration::from_secs(6)));
        client.ecs.write().flush();
        assert_eq!(client.get_inventory().unwrap().id(), 0);
        // A new manual command cancels ownership of the outstanding sell request.
        state.enqueue_chat(&client, "/home".into());
        state.on_control_event(&client);
        take_commands(&client);
        open_foreign_menu(&client, &mut state, "Homes");
        state.manual_menu_guard_until = None;
        state.manual_priority_until = None;
        assert!(!state.recover_orphaned_autosell_menu(&client, since + Duration::from_secs(10)));
        tick_sell(&client, &mut state, since + Duration::from_secs(10));
        assert_eq!(client.get_inventory().unwrap().id(), 7);
        assert!(take_commands(&client).is_empty());
    }

    #[test]
    fn reused_container_id_does_not_turn_a_home_menu_into_a_sell_menu() {
        let (client, mut state) = sell_client();
        let clicks = capture_sell_clicks(&client);
        state.sell_menu = Some((7, "Sell".into()));
        open_foreign_menu(&client, &mut state, "Homes");
        let now = Instant::now();
        assert!(!state.recover_orphaned_autosell_menu(&client, now));
        tick_sell(&client, &mut state, now);
        assert_eq!(client.get_inventory().unwrap().id(), 7);
        assert!(take_commands(&client).is_empty());
        assert!(clicks.lock().is_empty());
    }

    #[test]
    fn empty_inventory_keeps_the_configured_sell_interval() {
        let (client, mut state) = sell_client();
        state.config.autosell_interval_seconds = 5.0;
        let since = Instant::now();
        for cycle in 0..12 {
            let now = since + Duration::from_secs(cycle * 5);
            tick_sell(&client, &mut state, now);
            assert_eq!(take_commands(&client), vec!["/sell"]);
            open_empty_sell_menu(&client, &mut state);
            state.autosell_phase = AutoSellPhase::WaitingForMenu {
                since: now,
                started_empty: true,
                content_received: Some((7, 63)),
            };
            tick_sell(&client, &mut state, now + Duration::from_millis(50));
            tick_sell(&client, &mut state, now + Duration::from_millis(100));
            assert!(take_commands(&client).is_empty());
        }
    }

    #[test]
    fn restart_pause_cancels_pending_clicks_and_survives_world_and_config_changes() {
        let (client, mut state) = sell_client();
        let clicks = capture_sell_clicks(&client);
        state.pause_autosell(20_000, 210_000);
        let (start, end) = state.restart_sell_pause.unwrap();
        tick_sell(&client, &mut state, start - Duration::from_millis(1));
        assert_eq!(take_commands(&client), vec!["/sell"]);
        open_empty_sell_menu(&client, &mut state);
        let mut slots = vec![ItemStack::Empty; 63];
        slots[27] = ItemStack::new(ItemKind::Beef, 64);
        receive_content(&client, &mut state, 7, slots);
        tick_sell(&client, &mut state, start);
        assert!(clicks.lock().is_empty());
        assert_eq!(client.get_inventory().unwrap().id(), 0);
        assert!(matches!(state.autosell_phase, AutoSellPhase::Idle));
        state.on_login(&client);
        state.on_spawn(&client);
        state.on_position_sync(&client);
        let mut config = state.config.clone();
        config.autosell_interval_seconds = 5.0;
        state.update_config(config);
        tick_sell(&client, &mut state, end - Duration::from_millis(1));
        assert!(take_commands(&client).is_empty());
        tick_sell(&client, &mut state, end);
        assert_eq!(take_commands(&client), vec!["/sell"]);
    }

    #[test]
    fn manual_commands_interrupt_sell_and_bypass_guards_in_fifo_order() {
        let (client, mut state) = sell_client();
        state.enqueue_background_chat("/background".into());
        for command in ["/tpahere Steve", "/home", "/homes"] {
            state.enqueue_chat(&client, command.into());
        }
        state.spawned = false;
        client
            .ecs
            .write()
            .entity_mut(client.entity)
            .remove::<InGameState>();
        state.on_tick(&client);
        assert!(take_commands(&client).is_empty());
        state.spawned = true;
        client
            .ecs
            .write()
            .entity_mut(client.entity)
            .insert(InGameState);
        for command in ["/tpahere Steve", "/home", "/homes"] {
            open_empty_sell_menu(&client, &mut state);
            state.autosell_phase = AutoSellPhase::WaitingForMenu {
                since: Instant::now(),
                started_empty: false,
                content_received: None,
            };
            state.automation_ready_at = Instant::now() + Duration::from_secs(60);
            state.on_tick(&client);
            client.ecs.write().flush();
            assert_eq!(take_commands(&client), vec![command]);
            assert_eq!(client.get_inventory().unwrap().id(), 0);
            assert!(matches!(state.autosell_phase, AutoSellPhase::Idle));
        }
        assert_eq!(state.task_queue.len(), 1);
    }

    #[test]
    fn manual_command_cancels_a_queued_sell_and_keeps_priority_after_teleport() {
        use azalea::client_chat::{handle_send_chat_event, handler::handle_send_chat_kind_event};
        let (client, mut state) = sell_client();
        let now = Instant::now();
        tick_sell(&client, &mut state, now);
        // /sell is still in the chat queue; Update has not sent it yet.
        assert!(state.last_sell_request_at.is_some());
        state.enqueue_chat(&client, "/tpa Steve".into());
        state.on_control_event(&client);
        assert_eq!(take_commands(&client), vec!["/tpa Steve"]);
        let mut schedule = Schedule::default();
        schedule.add_systems((handle_send_chat_event, handle_send_chat_kind_event).chain());
        schedule.run(&mut client.ecs.write());
        assert!(
            take_commands(&client).is_empty(),
            "do not send a cancelled /sell or duplicate the manual command"
        );
        state.on_position_sync(&client);
        let until = state.manual_priority_until.unwrap();
        tick_sell(&client, &mut state, until - Duration::from_millis(1));
        assert!(
            take_commands(&client).is_empty(),
            "a teleport must not erase manual priority"
        );
        tick_sell(&client, &mut state, until);
        assert_eq!(take_commands(&client), vec!["/sell"]);
        assert!(
            state.cancelled_sell_until.is_none(),
            "a fresh sell response must not be cancelled"
        );
    }

    #[test]
    fn cancelled_sell_reply_is_closed_without_clicking_and_home_menu_is_preserved() {
        let (client, mut state) = sell_client();
        let clicks = capture_sell_clicks(&client);
        tick_sell(&client, &mut state, Instant::now());
        take_commands(&client);
        state.enqueue_chat(&client, "/homes".into());
        state.on_control_event(&client);
        assert_eq!(take_commands(&client), vec!["/homes"]);
        open_empty_sell_menu(&client, &mut state);
        state.on_control_event(&client);
        assert_eq!(client.get_inventory().unwrap().id(), 0);
        assert!(clicks.lock().is_empty());
        open_foreign_menu(&client, &mut state, "Homes");
        state.on_chat(&client, "<HugoSMP> Du kannst dies nicht tun, weil dein Inventar gerade gespeichert oder geladen wird.");
        state.on_control_event(&client);
        state.manual_menu_guard_until = None;
        state.manual_priority_until = None;
        state.automation_ready_at = Instant::now();
        state.on_tick(&client);
        client.ecs.write().flush();
        assert_eq!(client.get_inventory().unwrap().id(), 7);
        assert!(take_commands(&client).is_empty());
        assert!(clicks.lock().is_empty());
        // An explicitly requested /sell must escape the cancelled response guard.
        state.enqueue_chat(&client, "/sell".into());
        state.on_control_event(&client);
        assert_eq!(take_commands(&client), vec!["/sell"]);
        open_empty_sell_menu(&client, &mut state);
        state.on_chat(&client, "Dein Inventar wird gerade geladen");
        state.on_control_event(&client);
        assert_eq!(client.get_inventory().unwrap().id(), 7);
    }

    #[test]
    fn position_before_destination_chunk_never_starts_selling() {
        let (client, mut state) = sell_client();
        client
            .ecs
            .write()
            .entity_mut(client.entity)
            .remove::<InLoadedChunk>();
        state.on_login(&client);
        state.on_position_sync(&client);
        assert!(!state.spawned);
        state.on_tick(&client);
        assert!(take_commands(&client).is_empty());
        client
            .ecs
            .write()
            .entity_mut(client.entity)
            .insert(InLoadedChunk);
        state.on_spawn(&client);
        let ready = state.automation_ready_at;
        state.on_position_sync(&client);
        assert_eq!(
            state.automation_ready_at, ready,
            "a later position packet must preserve the join guard"
        );
        tick_sell(&client, &mut state, ready - Duration::from_millis(1));
        assert!(take_commands(&client).is_empty());
        // Fresh slot updates during loading do not extend the join deadline.
        for i in 0..120 {
            azalea::inventory::apply_container_slot(
                &mut client
                    .ecs
                    .write()
                    .get_mut::<Inventory>(client.entity)
                    .unwrap(),
                &ClientboundContainerSetSlot {
                    container_id: 0,
                    state_id: i,
                    slot: 9,
                    item_stack: ItemStack::new(ItemKind::Beef, 64),
                },
            );
        }
        assert_eq!(state.automation_ready_at, ready);
        tick_sell(&client, &mut state, ready);
        assert_eq!(take_commands(&client), vec!["/sell"]);
    }

    fn open_empty_sell_menu(client: &Client, state: &mut BehaviorState) {
        let mut world = client.ecs.write();
        let mut inventory = world.get_mut::<Inventory>(client.entity).unwrap();
        inventory.id = 7;
        inventory.container_menu = Some(Menu::Generic9x3 {
            contents: Default::default(),
            player: Default::default(),
        });
        inventory.container_menu_title = Some("Items verkaufen".into());
        drop(inventory);
        drop(world);
        state.on_menu_open(7, "Items verkaufen".into());
    }

    #[test]
    fn hugosmp_sell_reply_after_spawn_reset_is_still_sold() {
        let (client, mut state) = sell_client();
        let clicks = capture_sell_clicks(&client);
        let now = Instant::now();
        tick_sell(&client, &mut state, now);
        assert_eq!(take_commands(&client), vec!["/sell"]);
        // Spawn/position events can invalidate the request before its GUI arrives.
        state.on_spawn(&client);
        open_foreign_menu(&client, &mut state, "Items verkaufen");
        let mut slots = vec![ItemStack::Empty; 63];
        slots[27] = ItemStack::new(ItemKind::Beef, 64);
        receive_content(&client, &mut state, 7, slots);
        assert!(state.owns_sell_menu(&client));
        state.automation_ready_at = Instant::now();
        state.next_autosell_at = Instant::now();
        state.on_tick(&client);
        client.ecs.write().flush();
        assert_eq!(clicks.lock().len(), 1);
        assert!(
            take_commands(&client).is_empty(),
            "reuse the open sell menu"
        );
    }

    #[test]
    fn hugosmp_sell_menu_does_not_require_an_open_screen_callback() {
        let (client, mut state) = sell_client();
        let clicks = capture_sell_clicks(&client);
        let now = Instant::now();
        tick_sell(&client, &mut state, now);
        take_commands(&client);
        open_foreign_menu(&client, &mut state, "Items verkaufen");
        // The inventory component can be newer than the queued handler events.
        state.sell_menu = None;
        let mut slots = vec![ItemStack::Empty; 63];
        slots[27] = ItemStack::new(ItemKind::Beef, 64);
        receive_content(&client, &mut state, 7, slots);
        tick_sell(&client, &mut state, now + Duration::from_millis(50));
        assert_eq!(clicks.lock().len(), 1);
        tick_sell(&client, &mut state, now + Duration::from_millis(100));
        assert_eq!(client.get_inventory().unwrap().id(), 0);
    }

    #[test]
    fn manual_command_survives_configuration_with_a_stale_spawn_flag() {
        let (client, mut state) = sell_client();
        client
            .ecs
            .write()
            .entity_mut(client.entity)
            .remove::<InGameState>();
        assert!(state.spawned);
        state.enqueue_chat(&client, "/home".into());
        state.on_control_event(&client);
        state.on_tick(&client);
        assert!(take_commands(&client).is_empty());
        assert_eq!(state.manual_chat_queue.len(), 1);
        client
            .ecs
            .write()
            .entity_mut(client.entity)
            .insert(InGameState);
        state.on_control_event(&client);
        assert_eq!(take_commands(&client), vec!["/home"]);
        assert!(state.manual_chat_queue.is_empty());
    }

    #[tokio::test]
    async fn hugosmp_sell_and_manual_commands_reach_the_socket_in_order() {
        use std::io::Cursor;

        use azalea::app::App;
        use azalea::bevy_tasks::{IoTaskPool, TaskPool};
        use azalea::client_chat::{
            handle_send_chat_event,
            handler::{handle_send_chat_kind_event, SendChatKindEvent},
        };
        use azalea::connection::RawConnection;
        use azalea::inventory::{InventoryPlugin, MenuOpenedEvent};
        use azalea::packet::game::handle_outgoing_packets_observer;
        use azalea::protocol::connect::{RawReadConnection, RawWriteConnection};
        use azalea::protocol::packets::ConnectionProtocol;
        use azalea::protocol::read::{deserialize_packet, read_raw_packet};
        use azalea::registry::builtin::MenuKind;
        use azalea::world::{WorldName, Worlds};
        use tokio::net::{TcpListener, TcpStream};

        // Use the real Azalea inventory/chat/outgoing handlers and a loopback
        // socket. A SendChatEvent alone does not prove a command was sent.
        IoTaskPool::get_or_init(TaskPool::new);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (client_socket, accepted) = tokio::join!(
            TcpStream::connect(listener.local_addr().unwrap()),
            listener.accept(),
        );
        let (mut server_socket, _) = accepted.unwrap();
        let (read_stream, write_stream) = client_socket.unwrap().into_split();
        let connection = RawConnection::new(
            RawReadConnection {
                read_stream,
                buffer: Cursor::new(Vec::new()),
                compression_threshold: None,
                dec_cipher: None,
            },
            RawWriteConnection {
                write_stream,
                compression_threshold: None,
                enc_cipher: None,
            },
            ConnectionProtocol::Game,
        );
        let mut app = App::new();
        app.add_plugins(InventoryPlugin);
        let mut world = std::mem::take(app.world_mut());
        world.init_resource::<Messages<SendChatEvent>>();
        world.init_resource::<Messages<SendChatKindEvent>>();
        world.add_observer(handle_outgoing_packets_observer);
        let world_name = WorldName::new("minecraft:overworld");
        let mut worlds = Worlds::default();
        let _game_world = worlds.get_or_insert(world_name.clone(), 384, -64, &Default::default());
        world.insert_resource(worlds);
        let entity = world
            .spawn((Inventory::default(), InGameState, connection, world_name))
            .id();
        world.trigger(MenuOpenedEvent {
            entity,
            window_id: 7,
            menu_type: MenuKind::Generic9x3,
            title: "Items verkaufen".into(),
        });
        let client = Client {
            entity,
            ecs: Arc::new(RwLock::new(world)),
        };
        let (_, mut state) = sell_client();
        let mut slots = vec![ItemStack::Empty; 63];
        slots[27] = ItemStack::new(ItemKind::Beef, 64);
        receive_content(&client, &mut state, 7, slots);
        assert!(state.recover_orphaned_autosell_menu(&client, Instant::now()));
        assert!(matches!(
            state.autosell_phase,
            AutoSellPhase::Closing { .. }
        ));
        // Now interrupt the sale with manual commands, without Spawn or Tick,
        // and even while the world-restart pause is active.
        state.spawned = false;
        state.pause_autosell(0, 300_000);
        let mut schedule = Schedule::default();
        schedule.add_systems((handle_send_chat_event, handle_send_chat_kind_event).chain());
        for text in ["/home", "/homes", "/tpa Steve"] {
            state.enqueue_chat(&client, text.into());
            state.on_control_event(&client);
        }
        let packets = tokio::time::timeout(Duration::from_secs(3), async {
            let mut packets = Vec::new();
            let mut buffer = Cursor::new(Vec::new());
            for _ in 0..5 {
                let raw = read_raw_packet(&mut server_socket, &mut buffer, None, &mut None)
                    .await
                    .unwrap();
                packets.push(
                    deserialize_packet::<ServerboundGamePacket>(&mut Cursor::new(raw.as_ref()))
                        .unwrap(),
                );
            }
            packets
        })
        .await
        .expect("manual commands must actually reach the socket");
        assert!(
            matches!(&packets[0], ServerboundGamePacket::ContainerClick(packet)
            if packet.container_id == 7 && packet.slot_num == 27 && packet.state_id == 18)
        );
        assert!(
            matches!(&packets[1], ServerboundGamePacket::ContainerClose(packet)
            if packet.container_id == 7)
        );
        for (packet, expected) in packets[2..].iter().zip(["home", "homes", "tpa Steve"]) {
            assert!(
                matches!(packet, ServerboundGamePacket::ChatCommand(command)
                if command.command == expected),
                "expected {expected}, got {packet:?}"
            );
        }
        assert_eq!(client.get_inventory().unwrap().id(), 0);
        {
            let mut world = client.ecs.write();
            schedule.run(&mut world);
            world
                .get_mut::<RawConnection>(entity)
                .unwrap()
                .net_conn()
                .unwrap()
                .poll_writer();
        }
        assert!(
            tokio::time::timeout(
                Duration::from_millis(100),
                read_raw_packet(
                    &mut server_socket,
                    &mut Cursor::new(Vec::new()),
                    None,
                    &mut None
                )
            )
            .await
            .is_err(),
            "regular Update must not duplicate dispatched commands"
        );
    }

    #[derive(Resource, Default)]
    struct SentManualCommands(Vec<String>);

    fn take_commands(client: &Client) -> Vec<String> {
        let mut ecs = client.ecs.write();
        let mut sent: Vec<_> = ecs
            .resource_mut::<Messages<SendChatEvent>>()
            .drain()
            .map(|event| event.content)
            .collect();
        if let Some(mut manual) = ecs.get_resource_mut::<SentManualCommands>() {
            sent.extend(std::mem::take(&mut manual.0));
        }
        sent
    }

    fn tick_sell(client: &Client, state: &mut BehaviorState, now: Instant) {
        state.tick_autosell(client, now);
        // Production flushes observer Commands in the ECS update following
        // the handler. Complete the same close/synchronization work here.
        client.ecs.write().flush();
    }

    fn receive_content(client: &Client, state: &mut BehaviorState, id: i32, items: Vec<ItemStack>) {
        let packet = ClientboundContainerSetContent {
            container_id: id,
            state_id: 18,
            items,
            carried_item: ItemStack::Empty,
        };
        azalea::inventory::apply_container_content(
            &mut client
                .ecs
                .write()
                .get_mut::<Inventory>(client.entity)
                .unwrap(),
            &packet,
        );
        state.on_container_content(client, &packet);
    }

    fn capture_sell_clicks(client: &Client) -> Arc<Mutex<Vec<(i32, u16, u32)>>> {
        let clicks = Arc::new(Mutex::new(Vec::new()));
        let captured = clicks.clone();
        client.ecs.write().add_observer(
            move |event: On<ContainerClickEvent>, mut inventories: Query<&mut Inventory>| {
                let mut inventory = inventories.get_mut(event.entity).unwrap();
                captured.lock().push((
                    event.window_id,
                    event.operation.slot_num().unwrap(),
                    inventory.state_id,
                ));
                inventory.simulate_click(&event.operation, &PlayerAbilities::default());
            },
        );
        clicks
    }

    #[test]
    fn delayed_content_callback_cannot_rewind_newer_pickup_revision() {
        let (client, mut state) = sell_client();
        let clicks = capture_sell_clicks(&client);
        let now = Instant::now();
        tick_sell(&client, &mut state, now);
        open_empty_sell_menu(&client, &mut state);
        let full = ClientboundContainerSetContent {
            container_id: 7,
            state_id: 18,
            items: vec![ItemStack::Empty; 63],
            carried_item: ItemStack::Empty,
        };
        let pickup = ClientboundContainerSetSlot {
            container_id: 7,
            state_id: 25,
            slot: 27,
            item_stack: ItemStack::new(ItemKind::Beef, 64),
        };
        {
            let mut ecs = client.ecs.write();
            azalea::packet::game::process_packet(
                &mut ecs,
                client.entity,
                &azalea::protocol::packets::game::ClientboundGamePacket::ContainerSetContent(
                    full.clone(),
                ),
            );
            azalea::packet::game::process_packet(
                &mut ecs,
                client.entity,
                &azalea::protocol::packets::game::ClientboundGamePacket::ContainerSetSlot(
                    pickup.clone(),
                ),
            );
        }
        // All packets in a network batch are applied before async bot events.
        state.on_container_content(&client, &full);
        tick_sell(&client, &mut state, now + Duration::from_millis(50));
        assert_eq!(*clicks.lock(), vec![(7, 27, 25)]);
    }

    #[test]
    fn player_inventory_loading_and_pickups_update_open_menu_without_changing_its_revision() {
        let (client, mut state) = sell_client();
        let clicks = capture_sell_clicks(&client);
        let now = Instant::now();
        tick_sell(&client, &mut state, now);
        open_empty_sell_menu(&client, &mut state);
        receive_content(&client, &mut state, 7, vec![ItemStack::Empty; 63]);
        for i in 0..400 {
            let pickup = ClientboundContainerSetSlot {
                container_id: 0,
                state_id: i,
                slot: 9,
                item_stack: ItemStack::new(ItemKind::Beef, 1 + (i % 64) as i32),
            };
            azalea::inventory::apply_container_slot(
                &mut client
                    .ecs
                    .write()
                    .get_mut::<Inventory>(client.entity)
                    .unwrap(),
                &pickup,
            );
        }
        assert_eq!(client.component::<Inventory>().unwrap().state_id, 18);
        tick_sell(&client, &mut state, now + Duration::from_millis(50));
        assert_eq!(*clicks.lock(), vec![(7, 27, 18)]);
        tick_sell(&client, &mut state, now + Duration::from_millis(100));
        assert!(client
            .component::<Inventory>()
            .unwrap()
            .inventory_menu
            .slot(9)
            .unwrap()
            .is_empty());
        tick_sell(&client, &mut state, now + Duration::from_millis(300));
        assert_eq!(take_commands(&client), vec!["/sell", "/sell"]);
    }

    #[test]
    fn full_player_inventory_updates_and_direct_slots_survive_menu_close() {
        let (client, mut state) = sell_client();
        open_empty_sell_menu(&client, &mut state);
        let mut items = vec![ItemStack::Empty; 46];
        items[9] = ItemStack::new(ItemKind::Beef, 64);
        items[44] = ItemStack::new(ItemKind::Cobblestone, 32);
        let full = ClientboundContainerSetContent {
            container_id: 0,
            state_id: 30,
            items,
            carried_item: ItemStack::Empty,
        };
        azalea::inventory::apply_container_content(
            &mut client
                .ecs
                .write()
                .get_mut::<Inventory>(client.entity)
                .unwrap(),
            &full,
        );
        let direct = ClientboundContainerSetSlot {
            container_id: -2,
            state_id: 0,
            slot: 9,
            item_stack: ItemStack::new(ItemKind::Beef, 20),
        };
        azalea::inventory::apply_container_slot(
            &mut client
                .ecs
                .write()
                .get_mut::<Inventory>(client.entity)
                .unwrap(),
            &direct,
        );
        assert_eq!(client.menu().unwrap().slot(27).unwrap().count(), 20);
        assert_eq!(client.menu().unwrap().slot(62).unwrap().count(), 32);
        state.close_sell_menu(&client);
        client.ecs.write().flush();
        assert_eq!(client.menu().unwrap().slot(9).unwrap().count(), 20);
        assert_eq!(client.menu().unwrap().slot(44).unwrap().count(), 32);
    }

    #[test]
    fn pickup_during_predicted_clicks_does_not_resurrect_other_sold_slots() {
        let (client, mut state) = sell_client();
        capture_sell_clicks(&client);
        let now = Instant::now();
        tick_sell(&client, &mut state, now);
        open_empty_sell_menu(&client, &mut state);
        let mut items = vec![ItemStack::Empty; 63];
        items[27] = ItemStack::new(ItemKind::Beef, 64);
        items[28] = ItemStack::new(ItemKind::Cobblestone, 64);
        receive_content(&client, &mut state, 7, items);
        tick_sell(&client, &mut state, now + Duration::from_millis(50));
        let pickup = ClientboundContainerSetSlot {
            container_id: 0,
            state_id: 50,
            slot: 11,
            item_stack: ItemStack::new(ItemKind::Beef, 32),
        };
        azalea::inventory::apply_container_slot(
            &mut client
                .ecs
                .write()
                .get_mut::<Inventory>(client.entity)
                .unwrap(),
            &pickup,
        );
        assert!(client.menu().unwrap().slot(27).unwrap().is_empty());
        assert!(client.menu().unwrap().slot(28).unwrap().is_empty());
        assert_eq!(client.menu().unwrap().slot(29).unwrap().count(), 32);
        tick_sell(&client, &mut state, now + Duration::from_millis(100));
        assert!(client.menu().unwrap().slot(9).unwrap().is_empty());
        assert!(client.menu().unwrap().slot(10).unwrap().is_empty());
        assert_eq!(client.menu().unwrap().slot(11).unwrap().count(), 32);
    }

    #[test]
    fn home_and_tpa_success_messages_restore_and_recheck_authoritative_sneak() {
        let (client, mut state, packets) = crouch_client(true);
        state.spawned = true;
        for message in [
            "<HugoSMP> Du wurdest zu deinem Home Farm teleportiert!",
            "[HugoSMP] Steve hat deine Teleportations-Anfrage angenommen!",
        ] {
            state.on_chat(&client, message);
            state.on_tick(&client);
            send_input(&client);
            client
                .ecs
                .write()
                .entity_mut(client.entity)
                .insert(azalea::entity::metadata::AbstractEntityShiftKeyDown(false));
            state.next_crouch_check_at = Instant::now();
            state.on_tick(&client);
            send_input(&client);
        }
        assert_eq!(*packets.lock(), vec![true, true, true, true]);
        assert!(client.crouching());
    }

    #[test]
    fn slow_menu_and_content_sell_real_stacks_for_empty_and_nonempty_initial_inventory() {
        for initially_empty in [false, true] {
            let (client, mut state) = sell_client();
            let clicks = capture_sell_clicks(&client);
            if !initially_empty {
                *client
                    .ecs
                    .write()
                    .get_mut::<Inventory>(client.entity)
                    .unwrap()
                    .inventory_menu
                    .slot_mut(9)
                    .unwrap() = ItemStack::new(ItemKind::Cobblestone, 64);
            }
            let since = Instant::now();
            tick_sell(&client, &mut state, since);
            assert_eq!(take_commands(&client), vec!["/sell"]);
            tick_sell(&client, &mut state, since + Duration::from_secs(1));
            assert!(matches!(
                state.autosell_phase,
                AutoSellPhase::WaitingForMenu { .. }
            ));
            open_empty_sell_menu(&client, &mut state);
            tick_sell(&client, &mut state, since + Duration::from_millis(1500));
            assert!(clicks.lock().is_empty());
            assert_eq!(client.get_inventory().unwrap().id(), 7);
            let mut slots = vec![ItemStack::Empty; 63];
            slots[27] = ItemStack::new(ItemKind::Cobblestone, 64);
            slots[62] = ItemStack::new(ItemKind::Beef, 32);
            receive_content(&client, &mut state, 7, slots);
            tick_sell(&client, &mut state, since + Duration::from_secs(2));
            assert!(matches!(
                state.autosell_phase,
                AutoSellPhase::Closing { .. }
            ));
            assert_eq!(*clicks.lock(), vec![(7, 27, 18), (7, 62, 18)]);
            let menu = client.menu().unwrap();
            assert_eq!(menu.slot(0).unwrap().count(), 64);
            assert_eq!(menu.slot(1).unwrap().count(), 32);
            assert!(menu.slot(27).unwrap().is_empty());
            assert!(menu.slot(62).unwrap().is_empty());
            tick_sell(&client, &mut state, since + Duration::from_millis(2050));
            assert_eq!(client.get_inventory().unwrap().id(), 0);
            assert!(matches!(state.autosell_phase, AutoSellPhase::Idle));
            tick_sell(&client, &mut state, since + Duration::from_millis(2200));
            assert_eq!(take_commands(&client), vec!["/sell"]);
            put_player_stack(&client);
            tick_sell(&client, &mut state, since + Duration::from_millis(2250));
            assert!(take_commands(&client).is_empty());
        }
    }

    #[test]
    fn confirmed_empty_menu_finishes_even_when_inventory_was_nonempty_before_opening() {
        let (client, mut state) = sell_client();
        let clicks = capture_sell_clicks(&client);
        *client
            .ecs
            .write()
            .get_mut::<Inventory>(client.entity)
            .unwrap()
            .inventory_menu
            .slot_mut(9)
            .unwrap() = ItemStack::new(ItemKind::Beef, 64);
        let since = Instant::now();
        tick_sell(&client, &mut state, since);
        open_empty_sell_menu(&client, &mut state);
        tick_sell(&client, &mut state, since + Duration::from_millis(100));
        assert!(matches!(
            state.autosell_phase,
            AutoSellPhase::WaitingForMenu { .. }
        ));
        receive_content(&client, &mut state, 7, vec![ItemStack::Empty; 63]);
        tick_sell(&client, &mut state, since + Duration::from_millis(150));
        assert!(matches!(
            state.autosell_phase,
            AutoSellPhase::Closing { .. }
        ));
        assert!(clicks.lock().is_empty());
        tick_sell(&client, &mut state, since + Duration::from_millis(200));
        assert_eq!(client.get_inventory().unwrap().id(), 0);
        assert!(state.last_autosell_failure_log.is_none());
    }

    #[test]
    fn individual_player_slot_updates_can_sell_without_a_full_content_packet() {
        let (client, mut state) = sell_client();
        let clicks = capture_sell_clicks(&client);
        let since = Instant::now();
        tick_sell(&client, &mut state, since);
        open_empty_sell_menu(&client, &mut state);
        *client
            .ecs
            .write()
            .get_mut::<Inventory>(client.entity)
            .unwrap()
            .container_menu
            .as_mut()
            .unwrap()
            .slot_mut(27)
            .unwrap() = ItemStack::new(ItemKind::Beef, 64);
        let packet = ClientboundContainerSetSlot {
            container_id: 7,
            state_id: 19,
            slot: 27,
            item_stack: ItemStack::new(ItemKind::Beef, 64),
        };
        azalea::inventory::apply_container_slot(
            &mut client
                .ecs
                .write()
                .get_mut::<Inventory>(client.entity)
                .unwrap(),
            &packet,
        );
        tick_sell(&client, &mut state, since + Duration::from_millis(100));
        assert_eq!(*clicks.lock(), vec![(7, 27, 19)]);
        assert!(matches!(
            state.autosell_phase,
            AutoSellPhase::Closing { .. }
        ));
    }

    #[test]
    fn a_new_cycle_does_not_reuse_content_confirmation_from_a_previous_menu() {
        let (client, mut state) = sell_client();
        let since = Instant::now();
        tick_sell(&client, &mut state, since);
        open_empty_sell_menu(&client, &mut state);
        receive_content(&client, &mut state, 7, vec![ItemStack::Empty; 63]);
        tick_sell(&client, &mut state, since + Duration::from_millis(100));
        tick_sell(&client, &mut state, since + Duration::from_millis(150));
        tick_sell(&client, &mut state, since + Duration::from_millis(30300));
        open_empty_sell_menu(&client, &mut state);
        tick_sell(&client, &mut state, since + Duration::from_millis(30400));
        assert!(matches!(
            state.autosell_phase,
            AutoSellPhase::WaitingForMenu {
                content_received: None,
                ..
            }
        ));
        assert_eq!(client.get_inventory().unwrap().id(), 7);
        assert_eq!(take_commands(&client), vec!["/sell", "/sell"]);
    }

    #[test]
    fn incomplete_content_does_not_confirm_empty_menu_but_complete_content_at_deadline_does() {
        let (client, mut state) = sell_client();
        let since = Instant::now();
        tick_sell(&client, &mut state, since);
        open_empty_sell_menu(&client, &mut state);
        let foreign = ClientboundContainerSetContent {
            container_id: 99,
            state_id: 99,
            items: vec![ItemStack::Empty; 63],
            carried_item: ItemStack::new(ItemKind::Beef, 1),
        };
        state.on_container_content(&client, &foreign);
        assert_eq!(client.component::<Inventory>().unwrap().state_id, 0);
        receive_content(&client, &mut state, 7, vec![ItemStack::Empty; 27]);
        tick_sell(&client, &mut state, since + Duration::from_secs(1));
        assert!(matches!(
            state.autosell_phase,
            AutoSellPhase::WaitingForMenu { .. }
        ));
        assert_eq!(take_commands(&client), vec!["/sell"]);
        receive_content(&client, &mut state, 7, vec![ItemStack::Empty; 63]);
        tick_sell(&client, &mut state, since + AUTOSELL_MENU_TIMEOUT);
        assert!(matches!(
            state.autosell_phase,
            AutoSellPhase::Closing { .. }
        ));
        assert!(state.last_autosell_failure_log.is_none());
    }

    #[test]
    fn half_loaded_sell_menu_times_out_and_another_sell_is_sent() {
        // Initial inventory emptiness must not change the deadline for an
        // open shell without authoritative content.
        for started_empty in [false, true] {
            let (client, mut state) = sell_client();
            open_empty_sell_menu(&client, &mut state);
            let since = Instant::now();
            state.autosell_phase = AutoSellPhase::WaitingForMenu {
                since,
                started_empty,
                content_received: None,
            };
            tick_sell(&client, &mut state, since + Duration::from_millis(50));
            assert!(matches!(
                state.autosell_phase,
                AutoSellPhase::WaitingForMenu { .. }
            ));
            tick_sell(&client, &mut state, since + AUTOSELL_MENU_TIMEOUT);
            assert!(matches!(state.autosell_phase, AutoSellPhase::Idle));
            assert_eq!(client.get_inventory().unwrap().id(), 0);
            tick_sell(
                &client,
                &mut state,
                since + AUTOSELL_MENU_TIMEOUT + Duration::from_millis(100),
            );
            assert_eq!(take_commands(&client), vec!["/sell"]);
        }
    }

    #[test]
    fn teleports_clear_stale_menu_and_resume_selling_without_spawn() {
        let (client, mut state) = sell_client();
        for command in ["/home farm", "/tpa Steve"] {
            state.enqueue_chat(&client, command.to_string());
            state.automation_ready_at = Instant::now();
            state.on_tick(&client);
            assert_eq!(take_commands(&client), vec![command]);
            open_empty_sell_menu(&client, &mut state);
            state.autosell_phase = AutoSellPhase::WaitingForMenu {
                since: Instant::now(),
                started_empty: false,
                content_received: None,
            };
            // Actual teleport completion interrupts any in-flight sell/menu.
            state.on_position_sync(&client);
            client.ecs.write().flush();
            assert_eq!(client.get_inventory().unwrap().id(), 0);
            put_player_stack(&client);
            state.automation_ready_at = Instant::now();
            state.manual_menu_guard_until = None;
            state.manual_priority_until = None;
            state.next_autosell_at = Instant::now();
            state.on_tick(&client);
            let commands = take_commands(&client);
            assert!(commands.iter().any(|text| text == "/sell"));
        }
    }

    #[test]
    fn lobby_and_world_return_resume_selling_without_spawn_events() {
        let (client, mut state) = sell_client();
        state.on_chat(&client, "<HugoSMP> Diese Welt wird in 60 Sekunden neugestartet. Droppe am besten keine Items mehr!");
        for _ in 0..2 {
            open_empty_sell_menu(&client, &mut state);
            state.on_respawn(&client);
            client.ecs.write().flush();
            state.next_autosell_at = Instant::now();
            state.on_tick(&client);
            assert!(take_commands(&client).is_empty());
            assert_eq!(client.get_inventory().unwrap().id(), 0);
            // A return can take minutes; waiting longer must not change the
            // ability to recover from the destination position packet.
            state.transition_recovery_at = Some(Instant::now() - Duration::from_secs(300));
            state.on_position_sync(&client);
            client.ecs.write().flush();
            put_player_stack(&client);
            state.automation_ready_at = Instant::now();
            state.manual_menu_guard_until = None;
            state.manual_priority_until = None;
            state.next_autosell_at = Instant::now();
            state.on_tick(&client);
            assert_eq!(take_commands(&client), vec!["/sell"]);
        }
    }

    #[test]
    fn missing_spawn_and_position_wait_for_loaded_chunk_then_resume_selling() {
        let (client, mut state) = sell_client();
        client
            .ecs
            .write()
            .entity_mut(client.entity)
            .remove::<InLoadedChunk>();
        state.on_login(&client);
        client.ecs.write().flush();
        let after_guard = Instant::now() + Duration::from_secs(6);
        client
            .ecs
            .write()
            .entity_mut(client.entity)
            .insert(InGameState);
        state.recover_loaded_world(&client, after_guard);
        assert!(!state.spawned);
        client
            .ecs
            .write()
            .entity_mut(client.entity)
            .insert(InLoadedChunk);
        state.recover_loaded_world(&client, after_guard);
        assert!(state.spawned);
        state.automation_ready_at = Instant::now();
        state.next_autosell_at = Instant::now();
        state.on_tick(&client);
        assert_eq!(take_commands(&client), vec!["/sell"]);
    }

    #[test]
    fn lobby_and_return_resend_sneak_without_releasing_it() {
        let (client, mut state, packets) = crouch_client(true);
        send_input(&client);
        assert!(packets.lock().is_empty());
        for _ in 0..2 {
            state.on_login(&client);
            client.ecs.write().flush();
            state.on_tick(&client);
            send_input(&client);
            state.on_spawn(&client);
            state.automation_ready_at = Instant::now();
            state.on_tick(&client);
            send_input(&client);
            assert!(client.crouching());
            assert!(!state.crouch_resync_pending);
        }
        state.on_tick(&client);
        send_input(&client);
        assert_eq!(*packets.lock(), vec![true, true]);
    }

    #[test]
    fn teleport_without_spawn_resends_held_sneak() {
        let (client, mut state, packets) = crouch_client(true);
        state.spawned = true;
        state.on_position_sync(&client);
        client.ecs.write().flush();
        state.automation_ready_at = Instant::now();
        state.on_tick(&client);
        send_input(&client);
        assert_eq!(*packets.lock(), vec![true]);
    }

    #[test]
    fn restart_crouch_check_reasserts_input_for_positive_and_negative_server_flags() {
        let (client, mut state, packets) = crouch_client(true);
        state.spawned = true;
        state.automation_ready_at = Instant::now();
        for server_sneaking in [true, false] {
            client.ecs.write().entity_mut(client.entity).insert((
                azalea::entity::metadata::AbstractEntityShiftKeyDown(server_sneaking),
                LastSentInput(ServerboundPlayerInput {
                    shift: true,
                    ..Default::default()
                }),
            ));
            state.check_crouch(&client);
            state.on_tick(&client);
            send_input(&client);
        }
        assert_eq!(*packets.lock(), vec![true, true]);
        state.config.crouch_enabled = false;
        state.crouch_resync_pending = false;
        state.check_crouch(&client);
        assert!(
            !state.crouch_resync_pending,
            "disabled crouch is never enabled by a restart check"
        );
    }

    #[test]
    fn respawn_and_position_restore_sneak_without_azalea_spawn_event() {
        let (client, mut state, packets) = crouch_client(true);
        client
            .ecs
            .write()
            .entity_mut(client.entity)
            .insert(InLoadedChunk);
        state.spawned = true;
        for _ in 0..2 {
            state.on_respawn(&client);
            client.ecs.write().flush();
            state.on_tick(&client);
            assert!(!state.spawned);
            assert!(state.awaiting_respawn_position);
            state.on_position_sync(&client);
            client.ecs.write().flush();
            assert!(state.spawned);
            state.automation_ready_at = Instant::now();
            state.on_tick(&client);
            send_input(&client);
        }
        assert_eq!(*packets.lock(), vec![true, true]);
    }

    #[test]
    fn missing_movement_state_retries_resync_until_world_is_ready() {
        let (client, mut state, packets) = crouch_client(true);
        client
            .ecs
            .write()
            .entity_mut(client.entity)
            .remove::<ClientMovementState>();
        state.on_spawn(&client);
        state.automation_ready_at = Instant::now();
        state.on_tick(&client);
        assert!(state.crouch_resync_pending);
        client
            .ecs
            .write()
            .entity_mut(client.entity)
            .insert(ClientMovementState::default());
        state.on_tick(&client);
        send_input(&client);
        assert_eq!(*packets.lock(), vec![true]);
        assert!(!state.crouch_resync_pending);
    }

    #[test]
    fn disabled_crouch_stays_released_after_world_change() {
        let (client, mut state, packets) = crouch_client(false);
        state.on_spawn(&client);
        state.automation_ready_at = Instant::now();
        state.on_tick(&client);
        send_input(&client);
        assert!(!client.crouching());
        assert_eq!(*packets.lock(), vec![false]);
    }

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
}
