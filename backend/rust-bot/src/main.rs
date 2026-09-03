//! Azalea-based Minecraft bot subprocess.
//!
//! One process == one Minecraft account. It's driven entirely over stdio using
//! a small NDJSON protocol (see [`protocol`]):
//!
//!   * The **first** stdin line is a [`Config`] JSON object.
//!   * Every **subsequent** stdin line is a [`Command`] JSON object
//!     (chat / configure / disconnect).
//!   * Every stdout line is an [`OutEvent`] JSON object.
//!
//! The Node.js backend owns the reconnect policy, so Azalea's own
//! auto-reconnect is disabled and this process simply exits whenever the
//! connection ends (or fails). Node observes the exit and reschedules.

mod behaviors;
mod mspassword;
mod msauth;
mod protocol;

use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use azalea::entity::metadata::Health;
use azalea::prelude::*;
use azalea::ClientInformation;
use parking_lot::Mutex;

use behaviors::BehaviorState;
use protocol::{Command, Config, OutEvent};

/// How long to wait for the bot to spawn into the world before giving up on a
/// connection attempt. Azalea doesn't reliably surface an event for every kind
/// of connection failure (e.g. a fast connection-refused can be dropped before
/// the client's event channel is wired up), so this watchdog guarantees we
/// always terminate — letting Node own the reconnect schedule — instead of
/// hanging in CONNECTING forever. Overridable via `BOT_CONNECT_TIMEOUT_SECS`.
const DEFAULT_CONNECT_TIMEOUT_SECS: u64 = 45;

/// Set once the bot has spawned into the world; disables the connect watchdog.
static SPAWNED: AtomicBool = AtomicBool::new(false);

/// Serialize and print a single NDJSON event on stdout, then flush so Node
/// receives it immediately (line-buffered pipes otherwise hold it back).
pub(crate) fn emit(event: &OutEvent) {
    if let Ok(line) = serde_json::to_string(event) {
        let stdout = std::io::stdout();
        let mut lock = stdout.lock();
        let _ = writeln!(lock, "{line}");
        let _ = lock.flush();
    }
}

fn flush_stdout() {
    let _ = std::io::stdout().flush();
}

/// Reads the bot's current health and food and emits a [`OutEvent::Health`]
/// whenever either value changes. Values are unavailable before the bot has
/// spawned, in which case this is a no-op.
fn report_health(bot: &Client) {
    let Ok(health_component) = bot.component::<Health>() else {
        return;
    };
    let health = **health_component;
    let Ok(hunger) = bot.hunger() else {
        return;
    };
    let food = hunger.food;

    let mut s = shared().lock();
    if s.last_health != Some((health, food)) {
        s.last_health = Some((health, food));
        drop(s);
        emit(&OutEvent::Health { health, food });
    }
}

/// State shared between the stdin-reader thread (producer) and the Azalea event
/// handler (consumer). There's exactly one bot per process, so a single global
/// is simpler and safer than threading it through Azalea's ECS state.
struct Shared {
    behavior: BehaviorState,
    pending: Vec<Command>,
    /// Last health/food we reported, so we only emit a Health event on change.
    last_health: Option<(f32, u32)>,
}

static SHARED: OnceLock<Arc<Mutex<Shared>>> = OnceLock::new();

fn shared() -> &'static Arc<Mutex<Shared>> {
    SHARED.get().expect("shared state not initialized")
}

#[derive(Clone, Component, Default)]
struct State;

/// Entry point. We drive Azalea on a **single-threaded** Tokio runtime plus a
/// [`LocalSet`](tokio::task::LocalSet): one Minecraft account is very light, and
/// since each account is its own OS process, a multi-threaded runtime per bot
/// would otherwise spawn a full worker pool per bot (≈4 threads each), which
/// adds up fast when running dozens of accounts on a Raspberry Pi. A
/// current-thread runtime keeps each bot to a handful of threads while behaving
/// identically for an AFK workload.
fn main() -> AppExit {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("failed to build the Tokio runtime");
    let local = tokio::task::LocalSet::new();
    local.block_on(&runtime, async_main())
}

async fn async_main() -> AppExit {
    // 1. Read the config line (the very first stdin line). Nothing else runs
    //    yet, so a blocking read here is fine.
    let config = match read_config() {
        Some(c) => c,
        None => {
            emit(&OutEvent::FatalError {
                error: "No config received on stdin".into(),
            });
            std::process::exit(1);
        }
    };

    // 2. Initialize shared state before spawning the reader thread so commands
    //    always have somewhere to go.
    let _ = SHARED.set(Arc::new(Mutex::new(Shared {
        behavior: BehaviorState::new(&config),
        pending: Vec::new(),
        last_health: None,
    })));

    // 3. Read subsequent command lines on a dedicated OS thread.
    spawn_command_reader();

    // 4. Build the account. For Microsoft accounts this may surface a
    //    device-code sign-in prompt (as an NDJSON event) and/or a profile.
    let account = match build_account(&config).await {
        Ok(a) => a,
        Err(e) => {
            emit(&OutEvent::FatalError {
                error: format!("Authentication failed: {e}"),
            });
            std::process::exit(1);
        }
    };

    // 5. Start the connect watchdog (only now, so a slow Microsoft device-code
    //    sign-in above isn't counted against the connection timeout).
    spawn_connect_watchdog();

    // 6. Join the server. `reconnect_after(None)` disables Azalea's built-in
    //    auto-reconnect — Node owns that policy and respawns us on exit.
    let address = format!("{}:{}", config.host, config.port);
    ClientBuilder::new()
        .set_handler(handle)
        .set_state(State)
        .reconnect_after(None::<std::time::Duration>)
        .start(account, address.as_str())
        .await
}

/// Spawn a background thread that exits the process if the bot hasn't spawned
/// into the world within the connect timeout. See [`DEFAULT_CONNECT_TIMEOUT_SECS`].
fn spawn_connect_watchdog() {
    let timeout = std::env::var("BOT_CONNECT_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(DEFAULT_CONNECT_TIMEOUT_SECS);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(timeout));
        if !SPAWNED.load(Ordering::SeqCst) {
            emit(&OutEvent::ConnectionFailed {
                error: format!("Timed out after {timeout}s before joining the world"),
            });
            flush_stdout();
            std::process::exit(1);
        }
    });
}

/// Read and parse the first stdin line into a [`Config`].
fn read_config() -> Option<Config> {
    let mut line = String::new();
    if std::io::stdin().read_line(&mut line).ok()? == 0 {
        return None;
    }
    match serde_json::from_str(line.trim()) {
        Ok(config) => Some(config),
        Err(e) => {
            emit(&OutEvent::FatalError {
                error: format!("Invalid config JSON: {e}"),
            });
            None
        }
    }
}

/// Continuously read command lines from stdin and queue them for the handler.
fn spawn_command_reader() {
    std::thread::spawn(|| {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            match serde_json::from_str::<Command>(line) {
                Ok(cmd) => shared().lock().pending.push(cmd),
                Err(e) => emit(&OutEvent::Warning {
                    message: format!("Ignored malformed command: {e}"),
                }),
            }
        }
    });
}

/// Build the Azalea [`Account`] for the configured auth type.
async fn build_account(config: &Config) -> Result<Account, String> {
    if config.auth_type.eq_ignore_ascii_case("microsoft") {
        msauth::build_microsoft_account(
            &config.cache_dir,
            config.email.as_deref(),
            config.password.as_deref(),
            &config.username,
        )
        .await
    } else {
        Ok(Account::offline(&config.username))
    }
}

/// The per-bot Azalea event handler. Translates Azalea events into NDJSON
/// [`OutEvent`]s, applies queued [`Command`]s and drives behaviors on ticks.
async fn handle(bot: Client, event: Event, _state: State) -> eyre::Result<()> {
    match event {
        Event::Init => {
            // A small view distance keeps memory/CPU low, which matters on a
            // Raspberry Pi and doesn't affect AFK behavior.
            let _ = bot.set_client_information(ClientInformation {
                view_distance: 4,
                ..Default::default()
            });
        }
        Event::Login => emit(&OutEvent::Login),
        Event::Spawn => {
            SPAWNED.store(true, Ordering::SeqCst);
            emit(&OutEvent::Spawn);
        }
        Event::Chat(packet) => {
            let (sender, message) = packet.split_sender_and_content();
            // Auto-accept /tpa requests before the message is moved into the event.
            shared().lock().behavior.on_chat(&bot, &message);
            emit(&OutEvent::Chat { sender, message });
        }
        Event::Tick => {
            // Drain queued commands first, then run behavior timers.
            let pending: Vec<Command> = {
                let mut s = shared().lock();
                std::mem::take(&mut s.pending)
            };
            for cmd in pending {
                match cmd {
                    Command::Chat { text } => bot.chat(text),
                    Command::Configure(cfg) => shared().lock().behavior.update_config(cfg),
                    Command::RunTask { text } => shared().lock().behavior.enqueue_task(text),
                    Command::QueryBalance { command } => {
                        shared().lock().behavior.enqueue_balance(command)
                    }
                    Command::CleanSpawner => shared().lock().behavior.enqueue_clean_spawner(),
                    Command::RequestInventory => {
                        shared().lock().behavior.emit_inventory(&bot)
                    }
                    Command::MoveItem { from, to } => {
                        shared().lock().behavior.enqueue_move_item(from, to)
                    }
                    Command::DropItem { slot } => {
                        shared().lock().behavior.enqueue_drop_item(slot)
                    }
                    Command::ScanSettings { command } => {
                        shared().lock().behavior.enqueue_scan_settings(command)
                    }
                    Command::SetSetting { command, label, enabled } => {
                        shared().lock().behavior.enqueue_set_setting(command, label, enabled)
                    }
                    Command::Disconnect => {
                        emit(&OutEvent::Disconnect {
                            reason: Some("Requested by controller".into()),
                        });
                        flush_stdout();
                        std::process::exit(0);
                    }
                }
            }
            shared().lock().behavior.on_tick(&bot);
            report_health(&bot);
        }
        Event::Disconnect(reason) => {
            emit(&OutEvent::Disconnect {
                reason: reason.map(|r| r.to_string()),
            });
            flush_stdout();
            // Node owns reconnect: exit so it can respawn us on its own schedule.
            std::process::exit(0);
        }
        Event::ConnectionFailed(err) => {
            emit(&OutEvent::ConnectionFailed {
                error: format!("{err}"),
            });
            flush_stdout();
            std::process::exit(1);
        }
        _ => {}
    }
    Ok(())
}
