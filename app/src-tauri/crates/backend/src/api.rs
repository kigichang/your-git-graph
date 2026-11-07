//! The requests the front end makes of a repository, and their answers, as types: the app's
//! commands take and return these, and so does the remote helper (wire op `read`). The
//! TypeScript side is generated from them (`cargo test` writes web/src/lib/api/generated/).

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
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub enum ReadRequest {
    Commits { options: LoadOptions },
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct CommitStash {
    pub selector: String,
    pub base_hash: String,
    pub untracked_files_hash: Option<String>,
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
    Commits { commits: Vec<Commit>, head: Option<String>, more: bool, layout: Layout, timing: Timing },
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EngineCommits {
    commits: Vec<Commit>,
    head: Option<String>,
    more_commits_available: bool,
}

/// Answer `request` for the local repository at `repo`.
pub fn read(repo: &str, request: ReadRequest) -> Result<ReadResponse, String> {
    match request {
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
            let data: EngineCommits = serde_json::from_value(engine_call(repo, "loadCommits", params)?).map_err(|e| format!("loadCommits: {e}"))?;
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?}");
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

    #[test]
    fn commits_come_with_their_layout_and_the_uncommitted_row_on_top() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        git(p, &["init", "-q", "-b", "main"]);
        std::fs::write(p.join("a"), "1").unwrap();
        git(p, &["add", "a"]);
        git(p, &["commit", "-q", "-m", "one"]);
        git(p, &["checkout", "-q", "-b", "side"]);
        std::fs::write(p.join("b"), "2").unwrap();
        git(p, &["add", "b"]);
        git(p, &["commit", "-q", "-m", "two"]);
        git(p, &["checkout", "-q", "main"]);
        std::fs::write(p.join("c"), "3").unwrap();
        git(p, &["add", "c"]);
        git(p, &["commit", "-q", "-m", "three"]);
        git(p, &["merge", "-q", "--no-ff", "-m", "merge", "side"]);
        std::fs::write(p.join("a"), "changed").unwrap();

        let repo = p.to_str().unwrap();
        let ReadResponse::Commits { commits, head, more, layout, timing } = read(repo, ReadRequest::Commits { options: options(300) }).unwrap();
        assert_eq!(commits.len(), 4);
        assert_eq!(commits[0].message, "merge");
        assert_eq!(commits[0].parents.len(), 2);
        assert_eq!(commits[0].heads, ["main"]);
        assert_eq!(head.as_deref(), Some(commits[0].hash.as_str()));
        assert!(!more);
        assert_eq!(layout.node_lane.len(), 4);
        assert_eq!(layout.lanes, 2);
        assert_eq!(layout.node_lane, [0, 0, 1, 0]);
        assert!(timing.engine_ms > 0.0);

        let mut with_changes = options(300);
        with_changes.show_uncommitted = true;
        let ReadResponse::Commits { commits, layout, .. } = read(repo, ReadRequest::Commits { options: with_changes }).unwrap();
        assert_eq!(commits[0].hash, UNCOMMITTED);
        assert_eq!(commits[0].parents, [commits[1].hash.clone()]);
        assert_eq!(layout.node_lane, [0, 0, 0, 1, 0]);

        // A page: the missing parent runs on (more to load) - no dangling edge.
        let ReadResponse::Commits { commits, more, layout, .. } = read(repo, ReadRequest::Commits { options: options(2) }).unwrap();
        assert_eq!(commits.len(), 2);
        assert!(more);
        assert!(layout.dangling.is_empty());
        assert!(layout.spans.chunks(graph::SPAN).any(|s| s[1] == 2), "a line runs off the bottom");
        assert_eq!(layout.lanes, 2);

        assert!(read("/nonexistent", ReadRequest::Commits { options: options(1) }).is_err());
    }

    #[test]
    fn the_request_types_round_trip_as_tagged_json() {
        let req = ReadRequest::Commits { options: options(10) };
        let text = serde_json::to_string(&req).unwrap();
        assert!(text.starts_with("{\"kind\":\"commits\",\"options\":{\"maxCommits\":10"), "{text}");
        assert_eq!(serde_json::from_str::<ReadRequest>(&text).unwrap(), req);
        assert_eq!(serde_json::to_string(&CommitOrder::AuthorDate).unwrap(), "\"author-date\"");
    }
}
