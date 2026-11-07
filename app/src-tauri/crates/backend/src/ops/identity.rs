//! user.name and user.email, in the repository and globally.
//!
//! No `unsafe_arg` here: `git config` stops reading options at the key, so what follows it is
//! the value, whatever it starts with.

use super::{args, error_of, exec, run, Fail, Outcome};
use crate::api::{Author, ConfigLocation, OpRequest};
use crate::runtime::Runtime;

fn location(l: ConfigLocation) -> &'static str {
    match l {
        ConfigLocation::Local => "--local",
        ConfigLocation::Global => "--global",
    }
}

/// `git config --unset-all` exits 5 when the key is absent - already the wanted state.
pub async fn unset(rt: &dyn Runtime, loc: &str, key: &str) -> Result<(), String> {
    let r = exec(rt, args(&["config", loc, "--unset-all", key])).await?;
    if r.exit_code == Some(5) {
        return Ok(());
    }
    match error_of(&r) {
        None => Ok(()),
        Some(e) => Err(e),
    }
}

/// The global author, or `None` when either part is unset.
pub async fn global_author(rt: &dyn Runtime) -> Result<Option<Author>, String> {
    let name = exec(rt, args(&["config", "--global", "--get", "user.name"])).await?;
    let email = exec(rt, args(&["config", "--global", "--get", "user.email"])).await?;
    let (name, email) = (name.stdout.trim(), email.stdout.trim());
    Ok(if name.is_empty() || email.is_empty() { None } else { Some(Author { name: name.into(), email: email.into() }) })
}

/// Whether the global configuration was written.
pub type Touched = bool;

/// Saving the author identities (the `authors` setting, from `previous` to `next`) keeps the
/// global author one of them, as the settings present it (by default the first):
/// - no global author yet: the first identity becomes it;
/// - the global author was one of `previous` and was edited (same position, same count): it
///   follows the edit; deleted: the first identity takes over, or with none left it is unset;
/// - a global author that never was one of the identities is the user's own: left alone.
pub async fn sync_global_author(rt: &dyn Runtime, previous: &[Author], next: &[Author]) -> Result<Touched, String> {
    let current = global_author(rt).await?;
    // Some(Some(a)): set to a; Some(None): unset; None: leave as it is.
    let target: Option<Option<&Author>> = match current {
        None => next.first().map(Some),
        Some(current) if next.iter().any(|a| *a == current) => None,
        Some(current) => match previous.iter().position(|a| *a == current) {
            None => None,
            Some(_) if next.is_empty() => Some(None),
            Some(was) => Some(if next.len() == previous.len() { next.get(was) } else { next.first() }),
        },
    };
    match target {
        None => Ok(false),
        Some(None) => {
            unset(rt, "--global", "user.name").await?;
            unset(rt, "--global", "user.email").await?;
            Ok(true)
        }
        Some(Some(author)) => {
            run(rt, args(&["config", "--global", "user.name", &author.name])).await?;
            run(rt, args(&["config", "--global", "user.email", &author.email])).await?;
            Ok(true)
        }
    }
}

pub async fn perform(rt: &dyn Runtime, request: OpRequest) -> Outcome {
    match request {
        OpRequest::EditUserDetails { name, email, location: loc, delete_local_name, delete_local_email } => {
            let l = location(loc);
            run(rt, args(&["config", l, "user.name", &name])).await?;
            run(rt, args(&["config", l, "user.email", &email])).await?;
            if loc == ConfigLocation::Global && delete_local_name {
                unset(rt, "--local", "user.name").await?;
            }
            if loc == ConfigLocation::Global && delete_local_email {
                unset(rt, "--local", "user.email").await?;
            }
            Ok(())
        }
        OpRequest::DeleteUserDetails { name, email, location: loc } => {
            let l = location(loc);
            if name {
                unset(rt, l, "user.name").await?;
            }
            if email {
                unset(rt, l, "user.email").await?;
            }
            Ok(())
        }
        OpRequest::SyncGlobalAuthor { previous, next } => {
            sync_global_author(rt, &previous, &next).await?;
            Ok(())
        }
        other => Err(Fail::from(format!("not an identity operation: {other:?}"))),
    }
}
