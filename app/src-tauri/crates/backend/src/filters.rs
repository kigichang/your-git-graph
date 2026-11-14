//! Filters a repository's own configuration names. Reading the uncommitted changes (the engine's
//! status, `git status`) runs `filter.<name>.clean` (or `.process`) on every file whose stat no
//! longer matches the index - a program the repository's .git/config chose. That file does not
//! come with a clone, but it does with a downloaded archive or a repository on a shared disk, so
//! merely showing such a repository would run it. Until the person allows it (for the session:
//! `Runtime::filters_allowed`), the uncommitted changes are not read and the reads say why.
//!
//! The person's own configuration (global, system) is theirs, and the values `git lfs install
//! --local` writes only run git-lfs: neither counts.

use crate::ops::{args, exec};
use crate::runtime::Runtime;

/// What `git lfs install --local` writes.
const LFS: [(&str, &str); 2] = [("filter.lfs.clean", "git-lfs clean -- %f"), ("filter.lfs.process", "git-lfs filter-process")];

/// The `filter.<name>.clean`/`.process` keys the repository's own configuration sets (its
/// .git/config, its worktree config, what they include), standard Git LFS aside. A git too old
/// to tell the scope (before 2.26) gets one entry saying so: nothing is run on a guess.
pub async fn own_filters(rt: &dyn Runtime) -> Result<Vec<String>, String> {
    let r = exec(rt, args(&["config", "--show-scope", "--includes", "--get-regexp", r"^filter\..*\.(clean|process)$"])).await?;
    match r.exit_code {
        Some(0) => Ok(own_of(&r.stdout)),
        Some(1) => Ok(vec![]), // none at all
        _ => Ok(vec![format!("(git config could not tell: {})", r.stderr.trim())]),
    }
}

/// The keys of `git config --show-scope --get-regexp` lines (`<scope>\t<key> <value>`) set by
/// the repository itself.
fn own_of(stdout: &str) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    for line in stdout.lines() {
        let Some((scope, entry)) = line.split_once('\t') else { continue };
        if scope != "local" && scope != "worktree" {
            continue;
        }
        let (key, value) = entry.split_once(' ').unwrap_or((entry, ""));
        if LFS.iter().any(|(k, v)| key.eq_ignore_ascii_case(k) && value.trim() == *v) {
            continue;
        }
        if !keys.iter().any(|k| k == key) {
            keys.push(key.to_string());
        }
    }
    keys
}

/// The filters that keep the uncommitted changes from being read: none when the person allowed
/// them for this repository, or when the repository names none.
pub async fn blocking(rt: &dyn Runtime) -> Result<Vec<String>, String> {
    if rt.filters_allowed() {
        return Ok(vec![]);
    }
    own_filters(rt).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_what_the_repository_sets_and_not_standard_lfs() {
        let out = "global\tfilter.lfs.clean git-lfs clean -- %f\n\
                   local\tfilter.lfs.clean git-lfs clean -- %f\n\
                   local\tfilter.lfs.process git-lfs filter-process\n\
                   local\tfilter.evil.clean sh -c 'x'\n\
                   worktree\tfilter.Other.process run-me\n\
                   command\tfilter.cmd.clean y\n\
                   local\tfilter.evil.clean again\n\
                   local\tfilter.lfs.clean something-else %f\n";
        assert_eq!(own_of(out), ["filter.evil.clean", "filter.Other.process", "filter.lfs.clean"]);
        assert!(own_of("").is_empty());
    }
}
