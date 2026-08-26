//! Shared Microsoft (online-mode) authentication.
//!
//! Used by both `azalea-bot` (which then joins a Minecraft server) and
//! `namesniper-bot` (which only ever needs a valid Minecraft access token and
//! never joins a server). Extracted here so both binaries authenticate
//! identically and share the exact same on-disk token cache format/behavior
//! instead of duplicating this logic.

use std::path::PathBuf;

use azalea::account::microsoft::MicrosoftAccountOpts;
use azalea::auth;
use azalea::prelude::*;

use crate::emit;
use crate::mspassword;
use crate::protocol::OutEvent;

/// Build a Microsoft (online-mode) [`Account`], authenticating if nothing is
/// cached yet under `cache_dir`.
///
/// If nothing is cached yet we authenticate, preferring an automated email +
/// password sign-in (see [`mspassword`]) and falling back to the device-code
/// flow — which we run *manually* so the link + code can be surfaced as an
/// NDJSON [`OutEvent::MsaCode`] event instead of Azalea printing it to stdout
/// (which would corrupt the protocol). The full result is written to Azalea's
/// on-disk cache so future starts for this account authenticate silently.
pub async fn build_microsoft_account(
    cache_dir: &str,
    email: Option<&str>,
    password: Option<&str>,
    fallback_username: &str,
) -> Result<Account, String> {
    let _ = std::fs::create_dir_all(cache_dir);
    let cache_file = PathBuf::from(cache_dir).join("azalea-auth.json");
    let email = email.filter(|e| !e.is_empty());
    let password = password.filter(|p| !p.is_empty());
    let cache_key = email
        .map(str::to_string)
        .unwrap_or_else(|| fallback_username.to_string());
    let client = reqwest::Client::new();

    if auth::cache::get_account_in_cache(&cache_file, &cache_key)
        .await
        .is_none()
    {
        // Preferred path: automated email + password sign-in. Falls back to the
        // device-code flow below if it fails (e.g. the account uses 2FA).
        let mut authenticated = false;
        if let (Some(email), Some(password)) = (email, password) {
            match mspassword::login(email, password).await {
                Ok(msa) => {
                    finalize_auth_cache(&client, &cache_file, &cache_key, msa).await?;
                    authenticated = true;
                }
                Err(e) => emit(&OutEvent::Warning {
                    message: format!(
                        "Password sign-in failed ({e}). Falling back to device-code sign-in."
                    ),
                }),
            }
        }

        // Fallback: device-code flow. We run it manually so the link + code can
        // be surfaced as an NDJSON event instead of Azalea printing to stdout
        // (which would corrupt the protocol).
        if !authenticated {
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
            finalize_auth_cache(&client, &cache_file, &cache_key, msa.data).await?;
        }
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

/// Exchange an MSA token for a Minecraft token + profile and persist the full
/// result to Azalea's on-disk cache, so future starts authenticate silently
/// (and can refresh via the stored refresh token). Shared by both the
/// password and device-code sign-in paths.
async fn finalize_auth_cache(
    client: &reqwest::Client,
    cache_file: &std::path::Path,
    cache_key: &str,
    msa_token: azalea::auth::AccessTokenResponse,
) -> Result<(), String> {
    let mc = auth::get_minecraft_token(client, &msa_token.access_token)
        .await
        .map_err(|e| e.to_string())?;
    let profile = auth::get_profile(client, &mc.minecraft_access_token)
        .await
        .map_err(|e| e.to_string())?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let msa = auth::cache::ExpiringValue {
        expires_at: now + msa_token.expires_in,
        data: msa_token,
    };

    auth::cache::set_account_in_cache(
        cache_file,
        cache_key,
        auth::cache::CachedAccount {
            cache_key: cache_key.to_string(),
            msa,
            xbl: mc.xbl,
            mca: mc.mca,
            profile,
        },
    )
    .await
    .map_err(|e| e.to_string())
}
