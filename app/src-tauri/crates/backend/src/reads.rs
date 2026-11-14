//! The reads the engine does not offer, through the git CLI: what is in progress, the reflog,
//! the worktrees, the repository's configuration, ahead/behind.

use std::collections::BTreeMap;
use std::path::Path;

use crate::api::{Author, BranchConfig, LocalAndGlobal, OperationKind, OperationProgress, ReadRequest, ReadResponse, ReflogEntry, RemoteConfig, RepoConfig, Worktree};
use crate::ops::{args, error_of, exec};
use crate::runtime::Runtime;

const UNIT: char = '\x1f';

pub async fn read_git(rt: &dyn Runtime, request: ReadRequest) -> Result<ReadResponse, String> {
    match request {
        ReadRequest::OperationState => {
            let marker = crate::repo::operation_state(Path::new(rt.repo()));
            let operation = match marker.kind {
                None => None,
                Some("merge") => Some(OperationKind::Merge),
                Some("rebase") => Some(OperationKind::Rebase),
                Some("cherry-pick") => Some(OperationKind::CherryPick),
                Some("revert") => Some(OperationKind::Revert),
                Some(_) => None,
            };
            let mut conflicted_files = Vec::new();
            if operation.is_some() {
                // The index alone: `git diff` would run the clean filters a repository's config
                // names, on a read nobody asked for. An entry: `<mode> <hash> <stage>\t<path>`.
                let r = exec(rt, args(&["ls-files", "--unmerged", "-z"])).await?;
                if r.exit_code == Some(0) {
                    for f in r.stdout.split('\0').filter_map(|entry| entry.split_once('\t')).map(|(_, path)| path) {
                        if !conflicted_files.iter().any(|x| x == f) {
                            conflicted_files.push(f.to_string());
                        }
                    }
                }
            }
            // Exit 1: the index differs from HEAD (fixup and squash commit what is staged).
            let staged = exec(rt, args(&["diff", "--cached", "--quiet", "--no-ext-diff"])).await?.exit_code == Some(1);
            Ok(ReadResponse::OperationState {
                operation,
                progress: marker.progress.map(|p| OperationProgress { step: p.step, total: p.total }),
                conflicted_files,
                staged,
            })
        }
        ReadRequest::Reflog { reference, limit } => {
            crate::ops::unsafe_arg([reference.as_str()])?;
            let format = format!("--format=%H{UNIT}%h{UNIT}%gD{UNIT}%gs");
            let r = exec(rt, args(&["reflog", "show", "--date=unix", &format, "-n", &limit.saturating_add(1).to_string(), &reference, "--"])).await?;
            if let Some(e) = error_of(&r) {
                return Err(e);
            }
            let rows: Vec<Vec<&str>> = r.stdout.lines().filter(|l| !l.is_empty()).map(|l| l.split(UNIT).collect()).collect();
            let shown = &rows[..rows.len().min(limit as usize)];
            // Dangling = reachable from no ref: what `<hashes> --not --all` still lists.
            let mut hashes: Vec<String> = Vec::new();
            for row in shown {
                if let Some(h) = row.first() {
                    if !hashes.iter().any(|x| x == h) {
                        hashes.push(h.to_string());
                    }
                }
            }
            let unreachable: Vec<String> = if hashes.is_empty() {
                vec![]
            } else {
                let mut v = args(&["rev-list"]);
                v.extend(hashes.iter().cloned());
                v.extend(args(&["--not", "--all"]));
                exec(rt, v).await?.stdout.lines().filter(|l| !l.is_empty()).map(String::from).collect()
            };
            let entries = shown
                .iter()
                .enumerate()
                .map(|(i, row)| {
                    let get = |n: usize| row.get(n).copied().unwrap_or("");
                    let date = get(2).rsplit_once("@{").and_then(|(_, rest)| rest.trim_end_matches('}').parse::<i64>().ok()).unwrap_or(0);
                    ReflogEntry {
                        hash: get(0).to_string(),
                        abbrev: get(1).to_string(),
                        selector: format!("{reference}@{{{i}}}"),
                        date,
                        message: get(3).to_string(),
                        dangling: unreachable.iter().any(|h| h == get(0)),
                    }
                })
                .collect();
            Ok(ReadResponse::Reflog { entries, more: rows.len() > limit as usize })
        }
        ReadRequest::WorktreeList => {
            let r = exec(rt, args(&["worktree", "list", "--porcelain"])).await?;
            if let Some(e) = error_of(&r) {
                return Err(e);
            }
            let mut worktrees = Vec::new();
            for block in r.stdout.split("\n\n") {
                let lines: Vec<&str> = block.lines().filter(|l| !l.is_empty()).collect();
                let Some(first) = lines.first() else { continue };
                if !first.starts_with("worktree ") {
                    continue;
                }
                let value = |prefix: &str| lines.iter().find(|l| **l == prefix || l.starts_with(&format!("{prefix} "))).map(|l| l[prefix.len()..].trim().to_string());
                let is_main = worktrees.is_empty();
                worktrees.push(Worktree {
                    path: value("worktree").unwrap_or_default(),
                    hash: value("HEAD").unwrap_or_default(),
                    branch: value("branch").map(|b| b.trim_start_matches("refs/heads/").to_string()),
                    detached: value("detached").is_some(),
                    locked: value("locked").is_some(),
                    prunable: value("prunable").is_some(),
                    is_main,
                });
            }
            Ok(ReadResponse::Worktrees { worktrees })
        }
        ReadRequest::RepoConfig => {
            let local = config_entries(rt, "--local").await?;
            let global = config_entries(rt, "--global").await?;
            let last_of = |entries: &[(String, String)], key: &str| entries.iter().filter(|(k, _)| k.eq_ignore_ascii_case(key)).last().map(|(_, v)| v.clone());
            let effective = |key: &str| last_of(&local, key).or_else(|| last_of(&global, key));
            let mut remotes: Vec<RemoteConfig> = Vec::new();
            let mut branches: BTreeMap<String, BranchConfig> = BTreeMap::new();
            for (key, value) in &local {
                let lower = key.to_ascii_lowercase();
                if let Some(rest) = lower.strip_prefix("remote.") {
                    if let Some((_, field)) = rest.rsplit_once('.') {
                        if field == "url" || field == "pushurl" {
                            let name = &key["remote.".len()..key.len() - field.len() - 1];
                            let entry = match remotes.iter_mut().find(|r| r.name == name) {
                                Some(e) => e,
                                None => {
                                    remotes.push(RemoteConfig { name: name.to_string(), url: None, push_url: None });
                                    remotes.last_mut().unwrap()
                                }
                            };
                            if field == "url" {
                                entry.url = Some(value.clone());
                            } else {
                                entry.push_url = Some(value.clone());
                            }
                        }
                    }
                } else if let Some(rest) = lower.strip_prefix("branch.") {
                    if let Some((_, field)) = rest.rsplit_once('.') {
                        if field == "remote" || field == "pushremote" {
                            let name = &key["branch.".len()..key.len() - field.len() - 1];
                            let entry = branches.entry(name.to_string()).or_insert(BranchConfig { remote: None, push_remote: None });
                            if field == "remote" {
                                entry.remote = Some(value.clone());
                            } else {
                                entry.push_remote = Some(value.clone());
                            }
                        }
                    }
                }
            }
            let authors: Vec<Author> = rt.engine("authors", serde_json::Value::Null).ok().and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
            Ok(ReadResponse::RepoConfig {
                config: RepoConfig {
                    remotes,
                    branches,
                    user_name: LocalAndGlobal { local: last_of(&local, "user.name"), global: last_of(&global, "user.name") },
                    user_email: LocalAndGlobal { local: last_of(&local, "user.email"), global: last_of(&global, "user.email") },
                    push_default: effective("remote.pushdefault"),
                    diff_tool: effective("diff.tool"),
                    gui_diff_tool: effective("diff.guitool"),
                    authors,
                },
            })
        }
        ReadRequest::AheadBehind => {
            let r = exec(rt, args(&["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])).await?;
            if r.exit_code != Some(0) {
                return Ok(ReadResponse::AheadBehind { ahead: None, behind: None });
            }
            let mut parts = r.stdout.split_whitespace().map(|n| n.parse::<u32>().ok());
            let (behind, ahead) = (parts.next().flatten(), parts.next().flatten());
            Ok(ReadResponse::AheadBehind { ahead, behind })
        }
        other => Err(format!("{} is not a CLI read", serde_json::to_string(&other).unwrap_or_default())),
    }
}

/// `git config --list -z` of one file → `(key, value)` pairs in file order (an absent file: none).
async fn config_entries(rt: &dyn Runtime, location: &str) -> Result<Vec<(String, String)>, String> {
    let r = exec(rt, args(&["config", location, "--list", "-z"])).await?;
    if r.exit_code != Some(0) {
        return Ok(vec![]);
    }
    Ok(r.stdout
        .split('\0')
        .filter(|e| !e.is_empty())
        .map(|entry| match entry.split_once('\n') {
            Some((k, v)) => (k.to_string(), v.to_string()),
            None => (entry.to_string(), String::new()),
        })
        .collect())
}
