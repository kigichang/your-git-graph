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

/// The keys that name a program run when a changed file is hashed: a filter's, and a Git LFS
/// extension's - git-lfs, even the person's own standard one, pipes the file through every
/// `lfs.extension.<name>.clean` the repository's configuration sets.
const OWN_PROGRAMS: &str = r"^(filter\..*\.(clean|process)|lfs\.extension\..*\.clean)$";

/// How many submodules (at any depth) are looked into; past that, nothing is read on a guess.
const MAX_SUBMODULES: usize = 500;

/// The `filter.<name>.clean`/`.process` keys the repository's own configuration sets (its
/// .git/config, its worktree config, what they include), standard Git LFS aside, and its
/// `lfs.extension.<name>.clean` keys (run by that standard Git LFS); then those of
/// its checked-out submodules (`<path>: <key>`): git status and the engine look into a
/// submodule's files too, through the submodule's own configuration. A git too old to tell the
/// scope (before 2.26) gets one entry saying so: nothing is run on a guess.
pub async fn own_filters(rt: &dyn Runtime) -> Result<Vec<String>, String> {
    let mut keys = filters_in(rt, None).await?;
    let mut pending = match submodules_in(rt, None).await {
        Some(found) => found,
        None => return Ok(keys),
    };
    let mut seen = 0;
    while let Some((dir, shown)) = pending.pop() {
        seen += 1;
        if seen > MAX_SUBMODULES {
            keys.push(format!("(more than {MAX_SUBMODULES} submodules)"));
            break;
        }
        keys.extend(filters_in(rt, Some(&dir)).await?.into_iter().map(|key| format!("{shown}: {key}")));
        match submodules_in(rt, Some(&dir)).await {
            Some(found) => pending.extend(found.into_iter().map(|(d, s)| (d, format!("{shown}/{s}")))),
            None => keys.push(format!("({shown}: git could not list its submodules)")),
        }
    }
    Ok(keys)
}

/// git's arguments to run in `dir` (the repository itself when `None`).
fn in_dir(dir: Option<&str>, rest: &[&str]) -> Vec<String> {
    let mut v: Vec<String> = dir.map(|d| vec!["-C".to_string(), d.to_string()]).unwrap_or_default();
    v.extend(args(rest));
    v
}

/// The filter keys the configuration of the repository in `dir` sets itself.
async fn filters_in(rt: &dyn Runtime, dir: Option<&str>) -> Result<Vec<String>, String> {
    own_keys(rt, dir, OWN_PROGRAMS).await
}

/// The keys matching `pattern` that the repository's own configuration sets (not the person's
/// global or system one): programs a downloaded or shared repository chose.
pub async fn own_config(rt: &dyn Runtime, pattern: &str) -> Result<Vec<String>, String> {
    own_keys(rt, None, pattern).await
}

async fn own_keys(rt: &dyn Runtime, dir: Option<&str>, pattern: &str) -> Result<Vec<String>, String> {
    // -z: a value may hold a newline (`\n` in the file), and the shell runs every line of it.
    let r = exec(rt, in_dir(dir, &["config", "-z", "--show-scope", "--includes", "--get-regexp", pattern])).await?;
    match r.exit_code {
        Some(0) => Ok(own_of(&r.stdout)),
        Some(1) => Ok(vec![]), // none at all
        _ => Ok(vec![format!("(git config could not tell: {})", r.stderr.trim())]),
    }
}

/// The submodules checked out in the repository in `dir` (the repository itself when `None`):
/// where each is (to run git in) and its path there. Its index's gitlinks whose folder holds a
/// `.git`; one not checked out is an empty folder, which git would take for the repository
/// around it. `None` when git cannot list them.
async fn submodules_in(rt: &dyn Runtime, dir: Option<&str>) -> Option<Vec<(String, String)>> {
    let r = exec(rt, in_dir(dir, &["ls-files", "-z", "--stage", "--full-name"])).await.ok()?;
    if r.exit_code != Some(0) {
        return None;
    }
    let links = gitlinks(&r.stdout);
    if links.is_empty() {
        return Some(vec![]);
    }
    let root = match dir {
        Some(dir) => dir.to_string(),
        None => {
            let top = exec(rt, args(&["rev-parse", "--show-toplevel"])).await.ok()?;
            if top.exit_code != Some(0) {
                return None;
            }
            top.stdout.trim_end_matches('\n').to_string()
        }
    };
    let root = std::path::Path::new(&root);
    Some(
        links
            .into_iter()
            .filter(|path| root.join(path).join(".git").exists())
            .map(|path| (root.join(&path).display().to_string(), path))
            .collect(),
    )
}

/// The paths of the gitlinks (mode 160000) in `git ls-files -z --stage` output.
fn gitlinks(stdout: &str) -> Vec<String> {
    stdout
        .split('\0')
        .filter_map(|entry| entry.strip_prefix("160000 "))
        .filter_map(|rest| rest.split_once('\t'))
        .map(|(_, path)| path.to_string())
        .collect()
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

/// Whether an engine call (`{"method", "params"}`) reads the uncommitted changes, and so runs
/// those filters: the working tree's details, a comparison with it (`to` empty, absent or `*`),
/// a commit list that includes it.
pub fn reads_uncommitted(request: &str) -> bool {
    let Ok(request) = serde_json::from_str::<serde_json::Value>(request) else { return false };
    let params = &request["params"];
    let working_tree = |v: &serde_json::Value| v.as_str().is_none_or(|s| s.is_empty() || s == crate::api::UNCOMMITTED);
    match request["method"].as_str() {
        Some("loadUncommittedDetails") => true,
        Some("compareCommits" | "loadLineCounts") => working_tree(&params["to"]) || params["from"].as_str() == Some(crate::api::UNCOMMITTED),
        Some("loadCommits") => params["showUncommittedChanges"].as_bool() != Some(false),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_engine_calls_that_read_the_working_tree() {
        for request in [
            r#"{"method":"loadUncommittedDetails"}"#,
            r#"{"method":"compareCommits","params":{"from":"abc","to":""}}"#,
            r#"{"method":"compareCommits","params":{"from":"abc","to":"*"}}"#,
            r#"{"method":"compareCommits","params":{"from":"abc"}}"#,
            r#"{"method":"compareCommits","params":{"from":"*","to":"abc"}}"#,
            r#"{"method":"loadCommits","params":{"showUncommittedChanges":true}}"#,
        ] {
            assert!(reads_uncommitted(request), "{request}");
        }
        for request in [
            r#"{"method":"compareCommits","params":{"from":"abc","to":"def"}}"#,
            r#"{"method":"loadCommitFile","params":{"commitHash":"abc","file":"a"}}"#,
            r#"{"method":"loadCommits","params":{"showUncommittedChanges":false}}"#,
            "not json",
        ] {
            assert!(!reads_uncommitted(request), "{request}");
        }
    }

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
        assert_eq!(own_of("local\0lfs.extension.x.clean\nsh -c 'x'\0global\0lfs.extension.mine.clean\ny\0"), ["lfs.extension.x.clean"]);
        assert!(own_of("").is_empty());
        // Git LFS's value with another line after it: the shell runs that line too.
        assert_eq!(own_of("local\0filter.lfs.clean\ngit-lfs clean -- %f\ntouch /tmp/x\0"), ["filter.lfs.clean"]);
    }

    #[test]
    fn the_gitlinks_of_an_index() {
        let out = "100644 aaaa 0\ta file\0160000 bbbb 0\tsub\0160000 cccc 0\tdeep/with\ttab\0120000 dddd 0\tlink\0";
        assert_eq!(gitlinks(out), ["sub", "deep/with\ttab"]);
        assert!(gitlinks("").is_empty());
    }
}
