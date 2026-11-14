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
    // -z: a value may hold a newline (`\n` in the file), and the shell runs every line of it.
    let r = exec(rt, args(&["config", "-z", "--show-scope", "--includes", "--get-regexp", r"^filter\..*\.(clean|process)$"])).await?;
    match r.exit_code {
        Some(0) => Ok(own_of(&r.stdout)),
        Some(1) => Ok(vec![]), // none at all
        _ => Ok(vec![format!("(git config could not tell: {})", r.stderr.trim())]),
    }
}

/// The keys of `git config -z --show-scope --get-regexp` output (`<scope>\0<key>\n<value>\0`,
/// or `<scope>\0<key>\0` for a key without a value) set by the repository itself.
fn own_of(stdout: &str) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    let mut fields = stdout.split('\0');
    while let (Some(scope), Some(entry)) = (fields.next(), fields.next()) {
        if scope != "local" && scope != "worktree" {
            continue;
        }
        let (key, value) = entry.split_once('\n').unwrap_or((entry, ""));
        // The whole value: a first line like Git LFS's followed by others is not Git LFS.
        if LFS.iter().any(|(k, v)| key.eq_ignore_ascii_case(k) && value == *v) {
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
        let out = "global\0filter.lfs.clean\ngit-lfs clean -- %f\0\
                   local\0filter.lfs.clean\ngit-lfs clean -- %f\0\
                   local\0filter.lfs.process\ngit-lfs filter-process\0\
                   local\0filter.evil.clean\nsh -c 'x'\0\
                   worktree\0filter.Other.process\nrun-me\0\
                   command\0filter.cmd.clean\ny\0\
                   local\0filter.evil.clean\nagain\0\
                   local\0filter.bare.clean\0";
        assert_eq!(own_of(out), ["filter.evil.clean", "filter.Other.process", "filter.bare.clean"]);
        assert!(own_of("").is_empty());
        // Git LFS's value with another line after it: the shell runs that line too.
        assert_eq!(own_of("local\0filter.lfs.clean\ngit-lfs clean -- %f\ntouch /tmp/x\0"), ["filter.lfs.clean"]);
    }
}
