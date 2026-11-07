//! Commits only the reflogs still mention (setting `commits.includeReflog`): an amended or
//! rebased commit, what a reset left behind. The engine reads no reflogs and declines such a
//! load, so its usual list is completed here: git names the commits reachable from reflog
//! entries but from none of the refs the list shows, and each is put into the list before its
//! parents, near its date.

use std::collections::{HashMap, HashSet};

use crate::api::{Commit, LoadOptions, UNCOMMITTED};
use crate::runtime::{GitOpts, Runtime};

const UNIT: char = '\u{1f}';

/// Add to `commits` (the engine's list for `options`, in its order, with committer dates) the
/// commits only reflogs mention; `more`: the list is a page, and older ones come with the next.
/// Returns how many were added. Not for a branch filter: the reflogs belong to all of them.
pub async fn add(rt: &dyn Runtime, options: &LoadOptions, commits: &mut Vec<Commit>, more: bool) -> Result<usize, String> {
    let found = reflog_only(rt, options).await?;
    let shown: HashSet<&str> = commits.iter().map(|c| c.hash.as_str()).collect();
    // A page ends at its oldest commit: older ones arrive with the next page.
    let cutoff = if more { commits.iter().filter(|c| c.hash != UNCOMMITTED && c.stash.is_none()).map(|c| c.date).min() } else { None };
    let authors = options.authors.as_ref().filter(|a| !a.is_empty());
    let extra: Vec<Commit> = found
        .into_iter()
        .filter(|c| !shown.contains(c.hash.as_str()))
        .filter(|c| cutoff.is_none_or(|t| c.date >= t))
        .filter(|c| authors.is_none_or(|a| a.contains(&c.author)))
        .collect();
    let added = extra.len();
    merge(commits, extra);
    Ok(added)
}

/// The commits git reaches from reflog entries and not from the shown refs, children first;
/// the stash's own commits (its entries, their index and untracked parts) left out - the list
/// shows the stashes as rows of their own.
async fn reflog_only(rt: &dyn Runtime, options: &LoadOptions) -> Result<Vec<Commit>, String> {
    let stash = rt.git(["log", "-g", "--format=%H %P", "refs/stash", "--"].map(String::from).to_vec(), GitOpts::default()).await?;
    let mut stash_commits: HashSet<String> = HashSet::new();
    if stash.exit_code == Some(0) {
        for line in stash.stdout.lines() {
            let mut hashes = line.split(' ');
            if let Some(entry) = hashes.next() {
                stash_commits.insert(entry.to_string());
            }
            hashes.next(); // the commit it was made on: an ordinary commit
            stash_commits.extend(hashes.map(String::from));
        }
    }

    let mut args: Vec<String> = ["log", "--reflog", "--date-order", "--no-show-signature"].map(String::from).to_vec();
    args.push(format!("--format=%H{UNIT}%P{UNIT}%an{UNIT}%ae{UNIT}%ct{UNIT}%s"));
    if options.first_parent_only {
        args.push("--first-parent".into());
    }
    args.extend(["--not", "--branches", "--tags"].map(String::from));
    if options.show_remote_branches {
        args.extend(options.hide_remotes.iter().map(|r| format!("--exclude=refs/remotes/{r}/*")));
        args.push("--remotes".into());
    }
    args.push("HEAD".into());
    if !options.filter_paths.is_empty() {
        args.push("--".into());
        args.extend(options.filter_paths.iter().cloned());
    }
    let out = rt.git(args, GitOpts::default()).await?;
    if out.exit_code != Some(0) {
        return Err(format!("git log --reflog: {}", out.stderr.trim()));
    }
    Ok(out.stdout.lines().filter_map(parse).filter(|c| !stash_commits.contains(&c.hash)).collect())
}

fn parse(line: &str) -> Option<Commit> {
    let mut f = line.split(UNIT);
    let (hash, parents, author, email, date, message) = (f.next()?, f.next()?, f.next()?, f.next()?, f.next()?, f.next().unwrap_or(""));
    Some(Commit {
        hash: hash.to_string(),
        parents: parents.split(' ').filter(|p| !p.is_empty()).map(String::from).collect(),
        author: author.to_string(),
        email: email.to_string(),
        date: date.parse().ok()?,
        message: message.to_string(),
        heads: vec![],
        tags: vec![],
        remotes: vec![],
        stash: None,
    })
}

/// Put `extra` (children before parents) into `list`: each before the first commit of the list
/// older than it, but never after one of its parents - in the list, or one of `extra` placed
/// before it. The list's own order is kept; the uncommitted row stays on top.
fn merge(list: &mut Vec<Commit>, extra: Vec<Commit>) {
    if extra.is_empty() {
        return;
    }
    let index: HashMap<&str, usize> = list.iter().enumerate().map(|(i, c)| (c.hash.as_str(), i)).collect();
    let top = usize::from(list.first().is_some_and(|c| c.hash == UNCOMMITTED));
    // Where each goes, as "before list[i]": parents first (extra is children first).
    let mut before: HashMap<&str, usize> = HashMap::new();
    for c in extra.iter().rev() {
        // The list is newest first (by date, or near enough): the first one older than `c`.
        let by_date = top + list[top..].partition_point(|l| l.date >= c.date);
        let parents = c.parents.iter().filter_map(|p| index.get(p.as_str()).or_else(|| before.get(p.as_str())).copied());
        before.insert(c.hash.as_str(), parents.fold(by_date, usize::min).max(top));
    }
    // Ties keep extra's order, children first.
    let mut placed: Vec<(usize, usize)> = extra.iter().enumerate().map(|(n, c)| (before[c.hash.as_str()], n)).collect();
    placed.sort();
    let mut extra: Vec<Option<Commit>> = extra.into_iter().map(Some).collect();
    let old = std::mem::take(list);
    list.reserve(old.len() + placed.len());
    let mut next = placed.into_iter().peekable();
    for (i, commit) in old.into_iter().enumerate() {
        while let Some(&(_, n)) = next.peek().filter(|(at, _)| *at == i) {
            list.extend(extra[n].take());
            next.next();
        }
        list.push(commit);
    }
    for (_, n) in next {
        list.extend(extra[n].take());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(hash: &str, parents: &[&str], date: i64) -> Commit {
        Commit {
            hash: hash.into(),
            parents: parents.iter().map(|p| p.to_string()).collect(),
            author: String::new(),
            email: String::new(),
            date,
            message: String::new(),
            heads: vec![],
            tags: vec![],
            remotes: vec![],
            stash: None,
        }
    }
    fn order(list: &[Commit]) -> Vec<&str> {
        list.iter().map(|c| c.hash.as_str()).collect()
    }

    #[test]
    fn each_goes_by_its_date_but_before_its_parents() {
        // a(30) - b(20) - d(10); reflog-only: x(25) on b, y(40) on x (a child, newer than all).
        let mut list = vec![c(UNCOMMITTED, &["a"], 99), c("a", &["b"], 30), c("b", &["d"], 20), c("d", &[], 10)];
        merge(&mut list, vec![c("y", &["x"], 40), c("x", &["b"], 25)]);
        assert_eq!(order(&list), [UNCOMMITTED, "y", "a", "x", "b", "d"], "the uncommitted row stays on top");

        // A clock gone wrong: z claims to be older than its parent b, yet comes before it.
        let mut list = vec![c("a", &["b"], 30), c("b", &["d"], 20), c("d", &[], 10)];
        merge(&mut list, vec![c("z", &["b"], 5)]);
        assert_eq!(order(&list), ["a", "z", "b", "d"]);

        // Older than everything, on a parent not in the list (beyond the page): at the end.
        let mut list = vec![c("a", &["b"], 30)];
        merge(&mut list, vec![c("old", &["gone"], 1)]);
        assert_eq!(order(&list), ["a", "old"]);
    }
}
