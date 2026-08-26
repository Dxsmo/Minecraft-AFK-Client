//! Standalone "Name Sniper" subprocess.
//!
//! One process == one sniper account. It authenticates a Microsoft account
//! exactly like `azalea-bot` (see [`msauth`]) but never joins a Minecraft
//! server — instead it repeatedly calls the Mojang name-change API
//! (`PUT https://api.minecraftservices.com/minecraft/profile/name/{name}`)
//! trying to claim the configured desired name, waiting a configurable
//! cooldown between attempts.
//!
//! Speaks the same NDJSON-over-stdio style as `azalea-bot`:
//!   * The **first** stdin line is a [`protocol::SniperConfig`] JSON object.
//!   * Every **subsequent** stdin line is a [`protocol::SniperCommand`] JSON
//!     object (configure / stop).
//!   * Every stdout line is a [`protocol::OutEvent`] JSON object.
//!
//! These sibling modules are shared with `main.rs` (the `azalea-bot` binary)
//! via `#[path]` inclusion rather than duplicated, so both binaries
//! authenticate identically and speak the identical wire protocol types.

#[path = "../mspassword.rs"]
mod mspassword;
#[path = "../msauth.rs"]
mod msauth;
#[path = "../protocol.rs"]
mod protocol;

use std::io::{BufRead, Write};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use protocol::{OutEvent, SniperCommand, SniperConfig};

/// How often the Microsoft/Minecraft access token is proactively refreshed
/// while the loop is running, well within its typical ~24h lifetime.
const TOKEN_REFRESH_INTERVAL: Duration = Duration::from_secs(20 * 60);
/// How long the idle loop (no desired name configured yet) sleeps between
/// checks.
const IDLE_POLL_INTERVAL: Duration = Duration::from_secs(2);
/// Granularity used while sleeping out a cooldown, so a `Stop` command takes
/// effect quickly instead of waiting out the full cooldown.
const STOP_POLL_INTERVAL: Duration = Duration::from_millis(250);

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

/// State shared between the stdin-reader thread (producer) and the main loop
/// (consumer).
struct Shared {
    desired_name: String,
    cooldown_seconds: u64,
    stop: bool,
}

static SHARED: OnceLock<Arc<Mutex<Shared>>> = OnceLock::new();

fn shared() -> &'static Arc<Mutex<Shared>> {
    SHARED.get().expect("shared state not initialized")
}

fn main() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("failed to build the Tokio runtime");
    runtime.block_on(async_main());
}

async fn async_main() {
    let config = match read_config() {
        Some(c) => c,
        None => {
            emit(&OutEvent::FatalError {
                error: "No config received on stdin".into(),
            });
            std::process::exit(1);
        }
    };

    let _ = SHARED.set(Arc::new(Mutex::new(Shared {
        desired_name: config.desired_name.clone(),
        cooldown_seconds: config.cooldown_seconds.clamp(1, 60),
        stop: false,
    })));

    spawn_command_reader();

    let account = match msauth::build_microsoft_account(
        &config.cache_dir,
        Some(config.email.as_str()),
        None,
        &config.email,
    )
    .await
    {
        Ok(a) => a,
        Err(e) => {
            emit(&OutEvent::FatalError {
                error: format!("Authentication failed: {e}"),
            });
            std::process::exit(1);
        }
    };

    let http = reqwest::Client::new();
    let mut last_refresh = Instant::now();

    loop {
        let (stop, desired_name, cooldown_seconds) = {
            let s = shared().lock();
            (s.stop, s.desired_name.clone(), s.cooldown_seconds)
        };
        if stop {
            flush_stdout();
            std::process::exit(0);
        }

        if desired_name.trim().is_empty() {
            sleep_checking_stop(IDLE_POLL_INTERVAL).await;
            continue;
        }

        if last_refresh.elapsed() > TOKEN_REFRESH_INTERVAL {
            let _ = account.refresh().await;
            last_refresh = Instant::now();
        }

        let Some(token) = account.access_token() else {
            emit(&OutEvent::FatalError {
                error: "No access token available after authentication".into(),
            });
            std::process::exit(1);
        };

        emit(&OutEvent::RenameAttempt {
            desired_name: desired_name.clone(),
        });

        match attempt_rename(&http, &token, &desired_name).await {
            RenameOutcome::Success { current_name } => {
                emit(&OutEvent::RenameResult {
                    success: true,
                    message: format!(
                        "Name erfolgreich zu \"{current_name}\" geändert! Sniper wird gestoppt."
                    ),
                    current_name: Some(current_name),
                });
                // Goal achieved: nothing more to do. Node distinguishes this
                // clean exit(0) from a user-requested stop (which sends a
                // `Stop` command first) and marks the account as disabled.
                flush_stdout();
                std::process::exit(0);
            }
            RenameOutcome::Unauthorized => {
                // Token expired/invalid: refresh immediately rather than
                // waiting out the full proactive-refresh interval.
                let _ = account.refresh().await;
                last_refresh = Instant::now();
                emit(&OutEvent::Warning {
                    message: "Zugriffstoken abgelaufen, wird erneuert...".into(),
                });
            }
            RenameOutcome::Failed { message } => {
                emit(&OutEvent::RenameResult {
                    success: false,
                    message,
                    current_name: None,
                });
            }
        }

        sleep_checking_stop(Duration::from_secs(cooldown_seconds.clamp(1, 60))).await;
    }
}

enum RenameOutcome {
    Success { current_name: String },
    Unauthorized,
    Failed { message: String },
}

/// Call the Mojang name-change API once and classify the result.
async fn attempt_rename(client: &reqwest::Client, token: &str, desired_name: &str) -> RenameOutcome {
    let url = format!("https://api.minecraftservices.com/minecraft/profile/name/{desired_name}");
    let res = match client.put(&url).bearer_auth(token).send().await {
        Ok(r) => r,
        Err(e) => {
            return RenameOutcome::Failed {
                message: format!("Anfrage fehlgeschlagen: {e}"),
            };
        }
    };

    let status = res.status();
    let body = res.text().await.unwrap_or_default();

    if status.is_success() {
        let name = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(str::to_string))
            .unwrap_or_else(|| desired_name.to_string());
        return RenameOutcome::Success { current_name: name };
    }

    if status.as_u16() == 401 {
        return RenameOutcome::Unauthorized;
    }

    let message = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| {
            v.get("errorMessage")
                .or_else(|| v.get("error"))
                .and_then(|m| m.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| format!("Name nicht verfügbar (HTTP {status})"));
    RenameOutcome::Failed { message }
}

/// Sleep for `total`, checking the shared `stop` flag frequently so a `Stop`
/// command interrupts the wait almost immediately instead of blocking for the
/// full cooldown.
async fn sleep_checking_stop(total: Duration) {
    let mut elapsed = Duration::ZERO;
    while elapsed < total {
        if shared().lock().stop {
            return;
        }
        let step = STOP_POLL_INTERVAL.min(total - elapsed);
        tokio::time::sleep(step).await;
        elapsed += step;
    }
}

/// Read and parse the first stdin line into a [`SniperConfig`].
fn read_config() -> Option<SniperConfig> {
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

/// Continuously read command lines from stdin and apply them to [`Shared`].
fn spawn_command_reader() {
    std::thread::spawn(|| {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            match serde_json::from_str::<SniperCommand>(line) {
                Ok(SniperCommand::Configure { desired_name, cooldown_seconds }) => {
                    let mut s = shared().lock();
                    s.desired_name = desired_name;
                    s.cooldown_seconds = cooldown_seconds.clamp(1, 60);
                }
                Ok(SniperCommand::Stop) => {
                    shared().lock().stop = true;
                }
                Err(e) => emit(&OutEvent::Warning {
                    message: format!("Ignored malformed command: {e}"),
                }),
            }
        }
    });
}
