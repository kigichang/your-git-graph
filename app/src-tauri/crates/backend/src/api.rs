//! The requests the front end makes of a repository, and their answers, as types: the app's
//! commands take and return these, and so does the remote helper (wire op `read`). The
//! TypeScript side is generated from them (`cargo test` writes web/src/lib/api/generated/).
//!
//! The reads here are answered by the engine. Those that need the git CLI (the reflog, the
//! worktrees, conflict prediction, the repository's configuration) come with the runtime that
//! runs git (M3).

use std::collections::BTreeMap;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use ts_rs::TS;

use crate::graph::{self, Layout, Row};

/// The hash of the row that stands for the uncommitted changes.
pub const UNCOMMITTED: &str = "*";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub enum CommitOrder {
    #[default]
    Date,
    AuthorDate,
    Topo,
}

/// What to load into the graph.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct LoadOptions {
    pub max_commits: u32,
    /// The branches to show (`None`: all), as the branch filter names them.
    pub branches: Option<Vec<String>>,
    pub authors: Option<Vec<String>>,
    pub filter_paths: Vec<String>,
    pub order: CommitOrder,
    pub first_parent_only: bool,
    pub show_tags: bool,
    pub show_remote_branches: bool,
    pub show_remote_heads: bool,
    pub hide_remotes: Vec<String>,
    pub show_uncommitted: bool,
    pub show_untracked: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct CommitStash {
    pub selector: String,
    pub base_hash: String,
    pub untracked_files_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub enum ReadRequest {
    /// The branches, remotes, stashes and tags, and the checked-out branch.
    RepoInfo { show_remote_branches: bool, show_remote_heads: bool, hide_remotes: Vec<String>, show_stashes: bool },
    Commits { options: LoadOptions },
    CommitDetails { hash: String },
    StashDetails { hash: String, stash: CommitStash },
    UncommittedDetails,
    /// The files that differ between two revisions (`to` may be [`UNCOMMITTED`]).
    Compare { from: String, to: String },
    /// The `+n −m` of files between `from` (`None`: the empty tree) and `to`.
    LineCounts { from: Option<String>, to: String, paths: Vec<String> },
    TagDetails { name: String },
    /// How many commits of the graph come before `hash` (to scroll to one that is not loaded).
    CountCommitsBefore { hash: String, branches: Option<Vec<String>>, show_remote_branches: bool },
    Authors,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct CommitTag {
    pub name: String,
    pub annotated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct CommitRemote {
    pub name: String,
    /// `None` when the ref's remote is not one of the repository's remotes.
    pub remote: Option<String>,
}

/// One row of the graph, as the engine describes it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct Commit {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    /// Seconds since the Unix epoch.
    #[ts(type = "number")]
    pub date: i64,
    /// The subject (first line of the message).
    pub message: String,
    pub heads: Vec<String>,
    pub tags: Vec<CommitTag>,
    pub remotes: Vec<CommitRemote>,
    pub stash: Option<CommitStash>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct Stash {
    pub hash: String,
    pub base_hash: String,
    pub untracked_files_hash: Option<String>,
    pub selector: String,
    pub author: String,
    pub email: String,
    #[ts(type = "number")]
    pub date: i64,
    pub message: String,
}

/// Added, modified, deleted, renamed, untracked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub enum FileStatus {
    A,
    M,
    D,
    R,
    U,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct FileChange {
    pub old_path: String,
    pub new_path: String,
    pub status: FileStatus,
    /// `None` until counted (see [`ReadRequest::LineCounts`]), and for a binary file.
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct Details {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub author_email: String,
    #[ts(type = "number")]
    pub author_date: i64,
    pub committer: String,
    pub committer_email: String,
    #[ts(type = "number")]
    pub committer_date: i64,
    /// The whole message, subject included.
    pub body: String,
    pub files: Vec<FileChange>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct LineCounts {
    /// Both `None` for a binary file.
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct TagDetails {
    /// The tag object of an annotated tag; the commit of a lightweight one.
    pub hash: String,
    pub tagger: String,
    pub tagger_email: String,
    #[ts(type = "number")]
    pub tagger_date: i64,
    pub message: String,
    pub annotated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct Author {
    pub name: String,
    pub email: String,
}

/// How long the parts of a read took, for the performance gate.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct Timing {
    pub engine_ms: f64,
    pub layout_ms: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub enum ReadResponse {
    RepoInfo { branches: Vec<String>, head: Option<String>, remotes: Vec<String>, stashes: Vec<Stash>, tags: Vec<String> },
    Commits { commits: Vec<Commit>, head: Option<String>, more: bool, layout: Layout, timing: Timing },
    Details { details: Details },
    Compare { files: Vec<FileChange> },
    LineCounts { counts: BTreeMap<String, LineCounts> },
    TagDetails { details: TagDetails },
    Count {
        #[ts(type = "number")]
        count: u64,
    },
    Authors { authors: Vec<Author> },
}

/// The engine's answer to one call, or its in-band failure (`{"error": "Kind: message"}`).
pub fn engine_call(repo: &str, method: &str, params: Value) -> Result<Value, String> {
    let request = json!({ "method": method, "params": params }).to_string();
    let answer: Value = serde_json::from_str(&crate::engine(repo, &request)).map_err(|e| format!("The engine's answer is not JSON: {e}"))?;
    match answer.as_object() {
        Some(fields) if fields.len() == 1 => match fields.get("error") {
            Some(Value::String(message)) => Err(message.clone()),
            _ => Ok(answer),
        },
        _ => Ok(answer),
    }
}

fn engine_typed<T: serde::de::DeserializeOwned>(repo: &str, method: &str, params: Value) -> Result<T, String> {
    serde_json::from_value(engine_call(repo, method, params)?).map_err(|e| format!("{method}: {e}"))
}

/* ---------- The engine's shapes, where they differ from ours ---------- */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EngineCommits {
    commits: Vec<Commit>,
    head: Option<String>,
    more_commits_available: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EngineRepoInfo {
    branches: Vec<String>,
    head: Option<String>,
    remotes: Vec<String>,
    stashes: Vec<Stash>,
    tags: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EngineFileChange {
    old_file_path: String,
    new_file_path: String,
    #[serde(rename = "type")]
    status: FileStatus,
    additions: Option<u32>,
    deletions: Option<u32>,
}

impl From<EngineFileChange> for FileChange {
    fn from(f: EngineFileChange) -> FileChange {
        FileChange { old_path: f.old_file_path, new_path: f.new_file_path, status: f.status, additions: f.additions, deletions: f.deletions }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EngineDetails {
    hash: String,
    parents: Vec<String>,
    author: String,
    author_email: String,
    author_date: i64,
    committer: String,
    committer_email: String,
    committer_date: i64,
    body: String,
    file_changes: Vec<EngineFileChange>,
}

impl From<EngineDetails> for Details {
    fn from(d: EngineDetails) -> Details {
        Details {
            hash: d.hash,
            parents: d.parents,
            author: d.author,
            author_email: d.author_email,
            author_date: d.author_date,
            committer: d.committer,
            committer_email: d.committer_email,
            committer_date: d.committer_date,
            body: d.body,
            files: d.file_changes.into_iter().map(FileChange::from).collect(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EngineTagDetails {
    hash: String,
    tagger_name: String,
    tagger_email: String,
    tagger_date: i64,
    message: String,
}

/// Answer `request` for the local repository at `repo`.
pub fn read(repo: &str, request: ReadRequest) -> Result<ReadResponse, String> {
    match request {
        ReadRequest::RepoInfo { show_remote_branches, show_remote_heads, hide_remotes, show_stashes } => {
            let info: EngineRepoInfo = engine_typed(
                repo,
                "loadRepoInfo",
                json!({ "showRemoteBranches": show_remote_branches, "showRemoteHeads": show_remote_heads, "hideRemotes": hide_remotes,
                    "showChangeRefs": false, "showStashes": show_stashes }),
            )?;
            Ok(ReadResponse::RepoInfo { branches: info.branches, head: info.head, remotes: info.remotes, stashes: info.stashes, tags: info.tags })
        }
        ReadRequest::Commits { options: o } => {
            let started = Instant::now();
            let params = json!({
                "branches": o.branches, "authors": o.authors, "maxCommits": o.max_commits,
                "showTags": o.show_tags, "showRemoteBranches": o.show_remote_branches, "showRemoteHeads": o.show_remote_heads,
                "deferRemoteRefs": false, "includeCommitsMentionedByReflogs": false,
                "onlyFollowFirstParent": o.first_parent_only, "commitOrdering": o.order,
                "remotes": [], "hideRemotes": o.hide_remotes, "gerritRefs": null, "gerritShowChangeRefs": false,
                "filterPaths": o.filter_paths, "deferUncommittedChanges": false,
                "showUncommittedChanges": o.show_uncommitted, "showUntrackedFiles": o.show_untracked,
                "showCommitsOnlyReferencedByTags": true, "useMailmap": false
            });
            let data: EngineCommits = engine_typed(repo, "loadCommits", params)?;
            let engine_ms = started.elapsed().as_secs_f64() * 1000.0;
            let started = Instant::now();
            let rows: Vec<Row> = data.commits.iter().map(|c| Row { hash: &c.hash, parents: &c.parents }).collect();
            // A filtered history (by author or path) leaves parents out for good: let those fade.
            let filtered = o.authors.as_ref().is_some_and(|a| !a.is_empty()) || !o.filter_paths.is_empty();
            let layout = graph::layout(&rows, data.more_commits_available && !filtered);
            let layout_ms = started.elapsed().as_secs_f64() * 1000.0;
            Ok(ReadResponse::Commits {
                commits: data.commits,
                head: data.head,
                more: data.more_commits_available,
                layout,
                timing: Timing { engine_ms, layout_ms },
            })
        }
        ReadRequest::CommitDetails { hash } => {
            let d: EngineDetails = engine_typed(repo, "loadCommitDetails", json!({ "hash": hash }))?;
            Ok(ReadResponse::Details { details: d.into() })
        }
        ReadRequest::StashDetails { hash, stash } => {
            let d: EngineDetails = engine_typed(repo, "loadStashDetails", json!({ "hash": hash, "stash": stash }))?;
            Ok(ReadResponse::Details { details: d.into() })
        }
        ReadRequest::UncommittedDetails => {
            let d: EngineDetails = engine_typed(repo, "loadUncommittedDetails", Value::Null)?;
            Ok(ReadResponse::Details { details: d.into() })
        }
        ReadRequest::Compare { from, to } => {
            let to = if to == UNCOMMITTED { String::new() } else { to };
            let files: Vec<EngineFileChange> = engine_typed(repo, "compareCommits", json!({ "from": from, "to": to }))?;
            Ok(ReadResponse::Compare { files: files.into_iter().map(FileChange::from).collect() })
        }
        ReadRequest::LineCounts { from, to, paths } => {
            let counts: BTreeMap<String, LineCounts> = engine_typed(repo, "loadLineCounts", json!({ "from": from, "to": to, "paths": paths }))?;
            Ok(ReadResponse::LineCounts { counts })
        }
        ReadRequest::TagDetails { name } => {
            let t: EngineTagDetails = engine_typed(repo, "loadTagDetails", json!({ "tagName": name }))?;
            // A lightweight tag has no tagger of its own: the engine leaves the name empty.
            let annotated = !t.tagger_name.is_empty() || !t.tagger_email.is_empty();
            Ok(ReadResponse::TagDetails {
                details: TagDetails { hash: t.hash, tagger: t.tagger_name, tagger_email: t.tagger_email, tagger_date: t.tagger_date, message: t.message, annotated },
            })
        }
        ReadRequest::CountCommitsBefore { hash, branches, show_remote_branches } => {
            let count: u64 = engine_typed(
                repo,
                "countCommitsBefore",
                json!({ "branches": branches, "hash": hash, "showRemoteBranches": show_remote_branches, "includeReflogs": false }),
            )?;
            Ok(ReadResponse::Count { count })
        }
        ReadRequest::Authors => {
            let authors: Vec<Author> = engine_typed(repo, "authors", Value::Null)?;
            Ok(ReadResponse::Authors { authors })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    fn options(max: u32) -> LoadOptions {
        LoadOptions {
            max_commits: max,
            branches: None,
            authors: None,
            filter_paths: vec![],
            order: CommitOrder::Date,
            first_parent_only: false,
            show_tags: true,
            show_remote_branches: true,
            show_remote_heads: true,
            hide_remotes: vec![],
            show_uncommitted: false,
            show_untracked: false,
        }
    }

    /// main: one — three — merge(side: two); a tag on "one"; a stash; an uncommitted change.
    fn repository() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        git(p, &["init", "-q", "-b", "main"]);
        std::fs::write(p.join("a"), "1\n").unwrap();
        git(p, &["add", "a"]);
        git(p, &["commit", "-q", "-m", "one"]);
        git(p, &["tag", "-a", "-m", "the first", "v1"]);
        git(p, &["tag", "light"]);
        git(p, &["checkout", "-q", "-b", "side"]);
        std::fs::write(p.join("b"), "2\n").unwrap();
        git(p, &["add", "b"]);
        git(p, &["commit", "-q", "-m", "two"]);
        git(p, &["checkout", "-q", "main"]);
        std::fs::write(p.join("c"), "3\n3\n").unwrap();
        git(p, &["add", "c"]);
        git(p, &["commit", "-q", "-m", "three\n\nwith a body"]);
        git(p, &["merge", "-q", "--no-ff", "-m", "merge", "side"]);
        std::fs::write(p.join("a"), "stashed\n").unwrap();
        git(p, &["stash", "push", "-q", "-m", "kept"]);
        std::fs::write(p.join("a"), "changed\n").unwrap();
        std::fs::write(p.join("new"), "untracked\n").unwrap();
        dir
    }

    #[test]
    fn commits_come_with_their_layout_and_the_uncommitted_row_on_top() {
        let dir = repository();
        let repo = dir.path().to_str().unwrap();
        let ReadResponse::Commits { commits, head, more, layout, timing } = read(repo, ReadRequest::Commits { options: options(300) }).unwrap() else { panic!() };
        assert_eq!(commits.iter().map(|c| c.message.as_str()).collect::<Vec<_>>(), ["On main: kept", "merge", "three", "two", "one"]);
        assert!(commits[0].stash.is_some(), "the stash is a row");
        assert_eq!(commits[1].parents.len(), 2);
        assert_eq!(commits[1].heads, ["main"]);
        assert_eq!(commits[4].tags.iter().map(|t| (t.name.as_str(), t.annotated)).collect::<Vec<_>>(), [("light", false), ("v1", true)]);
        assert_eq!(head.as_deref(), Some(commits[1].hash.as_str()));
        assert!(!more);
        assert_eq!(layout.node_lane.len(), 5);
        assert!(timing.engine_ms > 0.0);

        let mut with_changes = options(300);
        with_changes.show_uncommitted = true;
        with_changes.show_untracked = true;
        let ReadResponse::Commits { commits, .. } = read(repo, ReadRequest::Commits { options: with_changes }).unwrap() else { panic!() };
        assert_eq!(commits[0].hash, UNCOMMITTED);
        assert_eq!(commits[0].parents, [head.unwrap()]);

        // A page: the missing parent runs on (more to load) - no dangling edge.
        let ReadResponse::Commits { commits, more, layout, .. } = read(repo, ReadRequest::Commits { options: options(2) }).unwrap() else { panic!() };
        assert_eq!(commits.len(), 3, "two commits and the stash on top");
        assert!(more);
        assert!(layout.dangling.is_empty());
        assert!(layout.spans.chunks(graph::SPAN).any(|s| s[1] == 2), "a line runs off the bottom");

        assert!(read("/nonexistent", ReadRequest::Commits { options: options(1) }).is_err());
    }

    #[test]
    fn the_other_reads() {
        let dir = repository();
        let p = dir.path();
        let repo = p.to_str().unwrap();
        let head = git(p, &["rev-parse", "HEAD"]);
        let three = git(p, &["rev-parse", "HEAD^1"]);

        let ReadResponse::RepoInfo { branches, head: current, remotes, stashes, tags } =
            read(repo, ReadRequest::RepoInfo { show_remote_branches: true, show_remote_heads: false, hide_remotes: vec![], show_stashes: true }).unwrap()
        else { panic!() };
        assert_eq!(branches, ["main", "side"]);
        assert_eq!(current.as_deref(), Some("main"));
        assert!(remotes.is_empty());
        assert_eq!(stashes.len(), 1);
        assert_eq!(stashes[0].message, "On main: kept");
        assert_eq!(tags, ["light", "v1"]);

        let ReadResponse::Details { details } = read(repo, ReadRequest::CommitDetails { hash: three.clone() }).unwrap() else { panic!() };
        assert_eq!(details.body, "three\n\nwith a body");
        assert_eq!(details.author, "t");
        assert_eq!(details.files.len(), 1);
        assert_eq!((details.files[0].new_path.as_str(), details.files[0].status), ("c", FileStatus::A));
        assert_eq!(details.files[0].additions, None, "counted separately");

        let ReadResponse::LineCounts { counts } =
            read(repo, ReadRequest::LineCounts { from: Some(details.parents[0].clone()), to: three.clone(), paths: vec!["c".into()] }).unwrap()
        else { panic!() };
        assert_eq!(counts["c"], LineCounts { additions: Some(2), deletions: Some(0) });

        let ReadResponse::Details { details } = read(repo, ReadRequest::UncommittedDetails).unwrap() else { panic!() };
        assert_eq!(details.hash, UNCOMMITTED);
        let mut names: Vec<(String, FileStatus)> = details.files.iter().map(|f| (f.new_path.clone(), f.status)).collect();
        names.sort();
        assert_eq!(names, [("a".to_string(), FileStatus::M), ("new".to_string(), FileStatus::U)]);

        let ReadResponse::Details { details } = read(repo, ReadRequest::StashDetails {
            hash: stashes[0].hash.clone(),
            stash: CommitStash { selector: stashes[0].selector.clone(), base_hash: stashes[0].base_hash.clone(), untracked_files_hash: None },
        })
        .unwrap() else { panic!() };
        assert_eq!(details.files.iter().map(|f| f.new_path.as_str()).collect::<Vec<_>>(), ["a"]);

        let ReadResponse::Compare { files } = read(repo, ReadRequest::Compare { from: three.clone(), to: head.clone() }).unwrap() else { panic!() };
        assert_eq!(files.iter().map(|f| f.new_path.as_str()).collect::<Vec<_>>(), ["b"]);
        let ReadResponse::Compare { files } = read(repo, ReadRequest::Compare { from: head.clone(), to: UNCOMMITTED.into() }).unwrap() else { panic!() };
        assert!(files.iter().any(|f| f.new_path == "a" && f.status == FileStatus::M));

        let ReadResponse::TagDetails { details } = read(repo, ReadRequest::TagDetails { name: "v1".into() }).unwrap() else { panic!() };
        assert!(details.annotated);
        assert_eq!(details.message.trim(), "the first");
        assert_eq!(details.tagger, "t");
        let ReadResponse::TagDetails { details } = read(repo, ReadRequest::TagDetails { name: "light".into() }).unwrap() else { panic!() };
        assert!(!details.annotated);

        let ReadResponse::Count { count } = read(repo, ReadRequest::CountCommitsBefore { hash: three.clone(), branches: None, show_remote_branches: true }).unwrap() else { panic!() };
        assert_eq!(count, 2, "the stash row and the merge come before 'three'");

        let ReadResponse::Authors { authors } = read(repo, ReadRequest::Authors).unwrap() else { panic!() };
        assert_eq!(authors, [Author { name: "t".into(), email: "t@t".into() }]);
    }

    #[test]
    fn the_request_types_round_trip_as_tagged_json() {
        let req = ReadRequest::Commits { options: options(10) };
        let text = serde_json::to_string(&req).unwrap();
        assert!(text.starts_with("{\"kind\":\"commits\",\"options\":{\"maxCommits\":10"), "{text}");
        assert_eq!(serde_json::from_str::<ReadRequest>(&text).unwrap(), req);
        assert_eq!(serde_json::to_string(&CommitOrder::AuthorDate).unwrap(), "\"author-date\"");
        assert_eq!(serde_json::to_string(&ReadRequest::UncommittedDetails).unwrap(), "{\"kind\":\"uncommittedDetails\"}");
        assert_eq!(serde_json::to_string(&FileStatus::R).unwrap(), "\"R\"");
    }
}
