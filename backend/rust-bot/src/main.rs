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
mod protocol;

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use azalea::account::microsoft::MicrosoftAccountOpts;
use azalea::prelude::*;
use azalea::{ClientInformation, auth};
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

/// State shared between the stdin-reader thread (producer) and the Azalea event
/// handler (consumer). There's exactly one bot per process, so a single global
/// is simpler and safer than threading it through Azalea's ECS state.
struct Shared {
    behavior: BehaviorState,
    pending: Vec<Command>,
}

static SHARED: OnceLock<Arc<Mutex<Shared>>> = OnceLock::new();

fn shared() -> &'static Arc<Mutex<Shared>> {
    SHARED.get().expect("shared state not initialized")
}

#[derive(Clone, Component, Default)]
struct State;

#[tokio::main]
async fn main() -> AppExit {
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
        build_microsoft_account(config).await
    } else {
        Ok(Account::offline(&config.username))
    }
}

/// Build a Microsoft (online-mode) account.
///
/// If nothing is cached yet, we run the device-code flow *manually* so the
/// link + code can be surfaced as an NDJSON [`OutEvent::MsaCode`] event instead
/// of Azalea printing it to stdout (which would corrupt the protocol). The full
/// result is then written to Azalea's on-disk cache so future starts for this
/// account authenticate silently.
async fn build_microsoft_account(config: &Config) -> Result<Account, String> {
    let _ = std::fs::create_dir_all(&config.cache_dir);
    let cache_file = PathBuf::from(&config.cache_dir).join("azalea-auth.json");
    let cache_key = config
        .email
        .clone()
        .filter(|e| !e.is_empty())
        .unwrap_or_else(|| config.username.clone());
    let client = reqwest::Client::new();

    if auth::cache::get_account_in_cache(&cache_file, &cache_key)
        .await
        .is_none()
    {
        let code = auth::get_ms_link_code(&client, None, None)
            .await
            .map_err(|e| e.to_string())?;
        emit(&OutEvent::MsaCode {
            verification_uri: code.verification_uri.clone(),
            user_code: code.user_code.clone(),
            expires_in: code.expires_in,
        });

        let msa = auth::get_ms_auth_token(&client, code, None)
            .await
            .map_err(|e| e.to_string())?;
        let mc = auth::get_minecraft_token(&client, &msa.data.access_token)
            .await
            .map_err(|e| e.to_string())?;
        let profile = auth::get_profile(&client, &mc.minecraft_access_token)
            .await
            .map_err(|e| e.to_string())?;

        auth::cache::set_account_in_cache(
            &cache_file,
            &cache_key,
            auth::cache::CachedAccount {
                cache_key: cache_key.clone(),
                msa,
                xbl: mc.xbl,
                mca: mc.mca,
                profile,
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    }

    let opts = MicrosoftAccountOpts {
        cache_file: Some(cache_file),
        ..Default::default()
    };
    let account = Account::microsoft_with_opts(&cache_key, opts)
        .await
        .map_err(|e| e.to_string())?;

    emit(&OutEvent::Profile {
        username: account.username().to_string(),
        uuid: account.uuid().to_string(),
    });

    Ok(account)
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
