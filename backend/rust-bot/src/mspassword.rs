//! Automated Microsoft (login.live.com) email + password authentication.
//!
//! `azalea-auth` only implements the device-code flow. Many users prefer to
//! store an account's email + password and have the bot sign in automatically,
//! without the one-time device-code link. This module reproduces the classic
//! legacy-MSA "credential" flow against login.live.com using the SAME client id
//! and scope as `azalea-auth` (a Nintendo-Switch legacy client whose MBI_SSL
//! access token is a raw Xbox Live RPS ticket), so the resulting token feeds
//! straight into [`azalea::auth::get_minecraft_token`].
//!
//! Limitations: accounts protected by two-step verification (2FA) or that hit
//! an interactive interstitial (e.g. "verify it's you") cannot complete this
//! flow. Callers should fall back to the device-code flow in that case.

use azalea::auth::AccessTokenResponse;
use regex::Regex;
use reqwest::redirect::Policy;

const CLIENT_ID: &str = "00000000441cc96b";
const REDIRECT_URI: &str = "https://login.live.com/oauth20_desktop.srf";
const REDIRECT_URI_ENC: &str = "https%3A%2F%2Flogin.live.com%2Foauth20_desktop.srf";
const SCOPE_ENC: &str = "service%3A%3Auser.auth.xboxlive.com%3A%3AMBI_SSL";
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// Attempt an email + password sign-in and return the resulting MSA token.
///
/// The token is equivalent to what the device-code flow yields, so callers can
/// pass `.access_token` straight to [`azalea::auth::get_minecraft_token`].
pub async fn login(email: &str, password: &str) -> Result<AccessTokenResponse, String> {
    let client = reqwest::Client::builder()
        .cookie_store(true)
        .user_agent(UA)
        // Follow the ordinary login-page redirects, but STOP at the final
        // redirect to the desktop redirect URI so we can read the token
        // fragment out of its `Location` header instead of losing it.
        .redirect(Policy::custom(|attempt| {
            if attempt.url().as_str().starts_with(REDIRECT_URI) {
                attempt.stop()
            } else if attempt.previous().len() > 20 {
                attempt.error("too many redirects during Microsoft sign-in")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| format!("failed to build http client: {e}"))?;

    let authorize_url = format!(
        "https://login.live.com/oauth20_authorize.srf?client_id={CLIENT_ID}\
&response_type=token&redirect_uri={REDIRECT_URI_ENC}&scope={SCOPE_ENC}\
&display=touch&locale=en"
    );

    let page = client
        .get(&authorize_url)
        .send()
        .await
        .map_err(|e| format!("could not load the Microsoft login page: {e}"))?
        .text()
        .await
        .map_err(|e| format!("could not read the Microsoft login page: {e}"))?;

    // The "Sign in to Minecraft" page embeds these in a JS config blob where
    // the HTML input is stored as a string with escaped quotes (`\"`), so the
    // patterns tolerate an optional backslash before each quote.
    let ppft = first_capture(&page, r#"name=\\?"PPFT\\?"[^>]*?value=\\?"([^"\\]+)"#)
        .ok_or_else(|| {
            "could not find the PPFT token on the login page \
             (Microsoft may have changed the sign-in flow)"
                .to_string()
        })?;
    let url_post = first_capture(&page, r#""urlPost":"([^"]+)""#)
        .or_else(|| first_capture(&page, r#"urlPost=\\?"([^"\\]+)"#))
        .or_else(|| first_capture(&page, r#"urlPost:'([^']+)'"#))
        .ok_or_else(|| "could not find the login POST url on the login page".to_string())?;

    let form = [
        ("login", email),
        ("loginfmt", email),
        ("passwd", password),
        ("PPFT", ppft.as_str()),
    ];

    let res = client
        .post(&url_post)
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("login request failed: {e}"))?;

    // A successful login is a redirect to the desktop redirect URI whose
    // fragment carries the tokens. Our redirect policy stops there, so the URL
    // is either in the `Location` header or already the response's final URL.
    let location = res
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .filter(|l| l.starts_with(REDIRECT_URI))
        .or_else(|| {
            let u = res.url().as_str();
            if u.starts_with(REDIRECT_URI) {
                Some(u.to_owned())
            } else {
                None
            }
        })
        .ok_or_else(|| {
            "sign-in was not accepted — wrong email/password, or the account \
             requires interactive verification (e.g. two-step verification)"
                .to_string()
        })?;

    let fragment = location
        .split_once('#')
        .map(|(_, f)| f)
        .or_else(|| location.split_once('?').map(|(_, f)| f))
        .ok_or_else(|| "the sign-in redirect did not contain a token".to_string())?;

    parse_token_fragment(fragment)
}

/// Parse an OAuth implicit-flow fragment (`access_token=...&refresh_token=...`)
/// into an [`AccessTokenResponse`]. Values are percent-decoded.
fn parse_token_fragment(fragment: &str) -> Result<AccessTokenResponse, String> {
    let mut access_token = None;
    let mut refresh_token = None;
    let mut token_type = String::from("bearer");
    let mut scope = String::new();
    let mut user_id = String::new();
    let mut expires_in: u64 = 86_400;

    for pair in fragment.split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        let value = percent_decode(value);
        match key {
            "access_token" => access_token = Some(value),
            "refresh_token" => refresh_token = Some(value),
            "token_type" => token_type = value,
            "scope" => scope = value,
            "user_id" => user_id = value,
            "expires_in" => expires_in = value.parse().unwrap_or(86_400),
            _ => {}
        }
    }

    Ok(AccessTokenResponse {
        token_type,
        expires_in,
        scope,
        access_token: access_token
            .ok_or_else(|| "sign-in response was missing an access token".to_string())?,
        refresh_token: refresh_token.unwrap_or_default(),
        user_id,
    })
}

/// Return the first capture group of `pattern` in `text`, if any.
fn first_capture(text: &str, pattern: &str) -> Option<String> {
    Regex::new(pattern)
        .ok()?
        .captures(text)?
        .get(1)
        .map(|m| m.as_str().to_string())
}

/// Minimal `%XX` percent-decoder (does not turn `+` into a space, matching
/// `decodeURIComponent` semantics used by other Minecraft auth libraries).
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
