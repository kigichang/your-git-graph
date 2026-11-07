//! settings.json: the settings' shape, their defaults, what values they take, and the move
//! from the keys the first version of the app used. The file is a flat JSON object of dotted
//! keys (`"graph.rowHeight": 24`) that can be edited by hand; unknown keys are kept and
//! reported, invalid values are reported and the default used.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use ts_rs::TS;

use crate::api::{Author, CommitOrder};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub enum Language {
    #[default]
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "en")]
    En,
    #[serde(rename = "zh-TW")]
    ZhTw,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub enum GraphStyle {
    #[default]
    Rounded,
    Angular,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub enum DateType {
    #[default]
    Author,
    Commit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub enum DateFormat {
    #[default]
    DateTime,
    Date,
    IsoDateTime,
    IsoDate,
    Relative,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub enum DetailsLocation {
    #[default]
    Bottom,
    Inline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub enum FileView {
    #[default]
    Tree,
    List,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct GraphSettings {
    pub style: GraphStyle,
    pub row_height: u32,
    pub font_size: u32,
    pub colours: Vec<String>,
    pub combine_local_and_remote_labels: bool,
    pub sticky_header: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct CommitsSettings {
    pub initial_load: u32,
    pub load_more: u32,
    pub load_more_automatically: bool,
    pub order: CommitOrder,
    pub show_uncommitted: bool,
    pub show_untracked: bool,
    pub include_reflog: bool,
    pub date_type: DateType,
    pub date_format: DateFormat,
    pub markdown: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct RepositorySettings {
    pub show_remote_branches: bool,
    pub show_remote_heads: bool,
    pub fetch_and_prune: bool,
    pub fetch_and_prune_tags: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct DetailsSettings {
    pub location: DetailsLocation,
    pub file_view: FileView,
    pub compact_folders: bool,
    pub auto_center: bool,
}

/// Every setting, as the app uses them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct Settings {
    pub language: Language,
    pub graph: GraphSettings,
    pub commits: CommitsSettings,
    pub repository: RepositorySettings,
    pub details: DetailsSettings,
    /// The dialogs' defaults, by `<dialog>.<field>` (their fields are defined with the dialogs).
    #[ts(type = "Record<string, unknown>")]
    pub dialogs: BTreeMap<String, Value>,
    pub authors: Vec<Author>,
    pub plantuml_jar: Option<String>,
    pub log_enabled: bool,
}

/// The lanes' colours until the settings say otherwise.
pub const DEFAULT_COLOURS: [&str; 8] = ["#2f80ed", "#eb5757", "#27ae60", "#d9a400", "#9b51e0", "#1aa39a", "#f2994a", "#e0409a"];

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            language: Language::Auto,
            graph: GraphSettings {
                style: GraphStyle::Rounded,
                row_height: 24,
                font_size: 13,
                colours: DEFAULT_COLOURS.iter().map(|c| c.to_string()).collect(),
                combine_local_and_remote_labels: true,
                sticky_header: true,
            },
            commits: CommitsSettings {
                initial_load: 300,
                load_more: 100,
                load_more_automatically: true,
                order: CommitOrder::Date,
                show_uncommitted: true,
                show_untracked: true,
                include_reflog: false,
                date_type: DateType::Author,
                date_format: DateFormat::DateTime,
                markdown: true,
            },
            repository: RepositorySettings { show_remote_branches: true, show_remote_heads: true, fetch_and_prune: false, fetch_and_prune_tags: false },
            details: DetailsSettings { location: DetailsLocation::Bottom, file_view: FileView::Tree, compact_folders: true, auto_center: true },
            dialogs: BTreeMap::new(),
            authors: Vec::new(),
            plantuml_jar: None,
            log_enabled: false,
        }
    }
}

/// A key of settings.json that was not taken, and why.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct Ignored {
    pub key: String,
    pub reason: String,
}

fn int(value: &Value, min: u32, max: u32) -> Result<u32, String> {
    match value.as_u64() {
        Some(n) if n >= min as u64 && n <= max as u64 => Ok(n as u32),
        _ => Err(format!("an integer from {min} to {max}")),
    }
}

fn bool(value: &Value) -> Result<bool, String> {
    value.as_bool().ok_or_else(|| "true or false".to_string())
}

fn enumerated<T: serde::de::DeserializeOwned>(value: &Value, expected: &str) -> Result<T, String> {
    serde_json::from_value(value.clone()).map_err(|_| format!("one of {expected}"))
}

impl Settings {
    /// Set one setting from its JSON value; the error says what the value should have been.
    pub fn apply(&mut self, key: &str, value: &Value) -> Result<(), String> {
        match key {
            "language" => self.language = enumerated(value, "\"auto\", \"en\", \"zh-TW\"")?,
            "graph.style" => self.graph.style = enumerated(value, "\"rounded\", \"angular\"")?,
            "graph.rowHeight" => self.graph.row_height = int(value, 16, 48)?,
            "graph.fontSize" => self.graph.font_size = int(value, 8, 24)?,
            "graph.colours" => {
                let colours: Vec<String> = enumerated(value, "a list of CSS colours")?;
                if colours.is_empty() {
                    return Err("a list of at least one CSS colour".into());
                }
                self.graph.colours = colours;
            }
            "graph.combineLocalAndRemoteLabels" => self.graph.combine_local_and_remote_labels = bool(value)?,
            "graph.stickyHeader" => self.graph.sticky_header = bool(value)?,
            "commits.initialLoad" => self.commits.initial_load = int(value, 1, 100_000)?,
            "commits.loadMore" => self.commits.load_more = int(value, 1, 100_000)?,
            "commits.loadMoreAutomatically" => self.commits.load_more_automatically = bool(value)?,
            "commits.order" => self.commits.order = enumerated(value, "\"date\", \"author-date\", \"topo\"")?,
            "commits.showUncommitted" => self.commits.show_uncommitted = bool(value)?,
            "commits.showUntracked" => self.commits.show_untracked = bool(value)?,
            "commits.includeReflog" => self.commits.include_reflog = bool(value)?,
            "commits.dateType" => self.commits.date_type = enumerated(value, "\"author\", \"commit\"")?,
            "commits.dateFormat" => self.commits.date_format = enumerated(value, "\"date-time\", \"date\", \"iso-date-time\", \"iso-date\", \"relative\"")?,
            "commits.markdown" => self.commits.markdown = bool(value)?,
            "repository.showRemoteBranches" => self.repository.show_remote_branches = bool(value)?,
            "repository.showRemoteHeads" => self.repository.show_remote_heads = bool(value)?,
            "repository.fetchAndPrune" => self.repository.fetch_and_prune = bool(value)?,
            "repository.fetchAndPruneTags" => self.repository.fetch_and_prune_tags = bool(value)?,
            "details.location" => self.details.location = enumerated(value, "\"bottom\", \"inline\"")?,
            "details.fileView" => self.details.file_view = enumerated(value, "\"tree\", \"list\"")?,
            "details.compactFolders" => self.details.compact_folders = bool(value)?,
            "details.autoCenter" => self.details.auto_center = bool(value)?,
            "authors" => {
                let authors: Vec<Author> = enumerated(value, "a list of { \"name\", \"email\" }")?;
                if authors.iter().any(|a| a.name.trim().is_empty() || a.email.trim().is_empty()) {
                    return Err("a list of { \"name\", \"email\" }, neither empty".into());
                }
                self.authors = authors;
            }
            "plantuml.jar" => {
                self.plantuml_jar = match value {
                    Value::Null => None,
                    Value::String(s) if !s.trim().is_empty() => Some(s.clone()),
                    _ => return Err("the path of plantuml.jar".into()),
                }
            }
            "log.enabled" => self.log_enabled = bool(value)?,
            _ => match key.strip_prefix("dialogs.") {
                Some(field) if field.split('.').count() == 2 && field.split('.').all(|p| !p.is_empty()) => {
                    self.dialogs.insert(field.to_string(), value.clone());
                }
                _ => return Err("not a setting of this app".into()),
            },
        }
        Ok(())
    }

    /// The settings of a settings.json object: the defaults, with every valid key applied;
    /// the keys that were not taken come back with their reasons.
    pub fn from_entries(entries: &Map<String, Value>) -> (Settings, Vec<Ignored>) {
        let mut settings = Settings::default();
        let mut ignored = Vec::new();
        for (key, value) in entries {
            if let Err(reason) = settings.apply(key, value) {
                let reason = if reason == "not a setting of this app" { reason } else { format!("expected {reason}") };
                ignored.push(Ignored { key: key.clone(), reason });
            }
        }
        (settings, ignored)
    }

    /// The JSON value a key has in `self` (to write a changed one back), or `None` for a key
    /// that is not a setting.
    pub fn value_of(&self, key: &str) -> Option<Value> {
        let whole = serde_json::to_value(self).ok()?;
        match key {
            "language" | "authors" => whole.get(key).cloned(),
            "plantuml.jar" => Some(whole.get("plantumlJar").cloned().unwrap_or(Value::Null)),
            "log.enabled" => whole.get("logEnabled").cloned(),
            _ => {
                if let Some(field) = key.strip_prefix("dialogs.") {
                    return self.dialogs.get(field).cloned();
                }
                let (group, field) = key.split_once('.')?;
                whole.get(group)?.get(field).cloned()
            }
        }
    }
}

/* ---------- The first version's keys ---------- */

/// A key of the first version's settings.json: where it went, and how its value reads now.
struct Legacy {
    old: &'static str,
    new: Option<&'static str>,
    value: fn(&Value) -> Option<Value>,
}

fn same(v: &Value) -> Option<Value> {
    Some(v.clone())
}
fn named(v: &Value, pairs: &[(&str, &str)]) -> Option<Value> {
    let s = v.as_str()?;
    pairs.iter().find(|(from, _)| *from == s).map(|(_, to)| json!(to))
}

fn legacy_keys() -> Vec<Legacy> {
    fn keep(old: &'static str, new: &'static str) -> Legacy {
        Legacy { old, new: Some(new), value: same }
    }
    fn gone(old: &'static str) -> Legacy {
        Legacy { old, new: None, value: same }
    }
    vec![
        Legacy {
            old: "interfaceLanguage",
            new: Some("language"),
            value: |v| match v.as_str()? {
                "auto" => Some(json!("auto")),
                "en" => Some(json!("en")),
                "zh-tw" | "zh-cn" => Some(json!("zh-TW")),
                _ => None,
            },
        },
        Legacy { old: "date.type", new: Some("commits.dateType"), value: |v| named(v, &[("Author Date", "author"), ("Commit Date", "commit")]) },
        Legacy {
            old: "date.format",
            new: Some("commits.dateFormat"),
            value: |v| {
                named(v, &[("Date & Time", "date-time"), ("Date Only", "date"), ("ISO Date & Time", "iso-date-time"), ("ISO Date Only", "iso-date"), ("Relative", "relative")])
            },
        },
        keep("referenceLabels.combineLocalAndRemoteBranchLabels", "graph.combineLocalAndRemoteLabels"),
        keep("stickyHeader", "graph.stickyHeader"),
        keep("markdown", "commits.markdown"),
        gone("mobileAdaptation"),
        keep("enableLog", "log.enabled"),
        keep("repository.commits.initialLoad", "commits.initialLoad"),
        keep("repository.commits.loadMore", "commits.loadMore"),
        keep("repository.commits.order", "commits.order"),
        keep("repository.commits.loadMoreAutomatically", "commits.loadMoreAutomatically"),
        gone("repository.commits.fetchAvatars"),
        keep("repository.showUncommittedChanges", "commits.showUncommitted"),
        keep("repository.showUntrackedFiles", "commits.showUntracked"),
        gone("repository.trackRemoteTags"),
        gone("pullRequests.enabled"),
        keep("commitDetailsView.autoCenter", "details.autoCenter"),
        keep("commitDetailsView.fileView.fileTree.compactFolders", "details.compactFolders"),
        Legacy { old: "commitDetailsView.fileView.type", new: Some("details.fileView"), value: |v| named(v, &[("File Tree", "tree"), ("File List", "list")]) },
        Legacy { old: "commitDetailsView.location", new: Some("details.location"), value: |v| named(v, &[("Inline", "inline"), ("Docked to Bottom", "bottom")]) },
        keep("dialog.addTag.pushToRemote", "dialogs.addTag.pushToRemote"),
        Legacy { old: "dialog.addTag.type", new: Some("dialogs.addTag.type"), value: |v| named(v, &[("Annotated", "annotated"), ("Lightweight", "lightweight")]) },
        keep("dialog.applyStash.reinstateIndex", "dialogs.applyStash.reinstateIndex"),
        keep("dialog.cherryPick.noCommit", "dialogs.cherryPick.noCommit"),
        keep("dialog.cherryPick.recordOrigin", "dialogs.cherryPick.recordOrigin"),
        keep("dialog.createBranch.checkOut", "dialogs.createBranch.checkout"),
        keep("dialog.deleteBranch.forceDelete", "dialogs.deleteBranch.force"),
        keep("dialog.fetchIntoLocalBranch.forceFetch", "dialogs.fetchIntoLocalBranch.force"),
        keep("dialog.fetchRemote.prune", "dialogs.fetch.prune"),
        keep("dialog.fetchRemote.pruneTags", "dialogs.fetch.pruneTags"),
        Legacy {
            old: "dialog.general.referenceInputSpaceSubstitution",
            new: Some("dialogs.general.spaceSubstitution"),
            value: |v| named(v, &[("None", "none"), ("Hyphen", "hyphen"), ("Underscore", "underscore")]),
        },
        keep("dialog.merge.noCommit", "dialogs.merge.noCommit"),
        keep("dialog.merge.noFastForward", "dialogs.merge.noFastForward"),
        keep("dialog.merge.squashCommits", "dialogs.merge.squash"),
        keep("dialog.popStash.reinstateIndex", "dialogs.popStash.reinstateIndex"),
        keep("dialog.pullBranch.noFastForward", "dialogs.pull.noFastForward"),
        keep("dialog.pullBranch.squashCommits", "dialogs.pull.squash"),
        keep("dialog.rebase.ignoreDate", "dialogs.rebase.ignoreDate"),
        keep("dialog.rebase.launchInteractiveRebase", "dialogs.rebase.interactive"),
        keep("dialog.rebase.autosquash", "dialogs.rebase.autosquash"),
        Legacy { old: "dialog.resetCurrentBranchToCommit.mode", new: Some("dialogs.reset.mode"), value: |v| named(v, &[("Soft", "soft"), ("Mixed", "mixed"), ("Hard", "hard")]) },
        Legacy { old: "dialog.resetUncommittedChanges.mode", new: Some("dialogs.resetUncommitted.mode"), value: |v| named(v, &[("Mixed", "mixed"), ("Hard", "hard")]) },
        keep("dialog.stashUncommittedChanges.includeUntracked", "dialogs.stash.includeUntracked"),
        keep("markdownPreview.plantumlJar", "plantuml.jar"),
        keep("commitAuthors", "authors"),
    ]
}

/// Move the first version's keys to today's: the changes to make to the file, as
/// `(key, value)` with `None` for a key to remove. A new key that is already set is left as
/// it is (the old one is still removed); an old value that has no equivalent is dropped.
pub fn migrate(entries: &Map<String, Value>) -> Vec<(String, Option<Value>)> {
    let mut changes = Vec::new();
    for legacy in legacy_keys() {
        let Some(old) = entries.get(legacy.old) else { continue };
        changes.push((legacy.old.to_string(), None));
        if let Some(new) = legacy.new {
            if entries.contains_key(new) {
                continue;
            }
            if let Some(value) = (legacy.value)(old) {
                changes.push((new.to_string(), Some(value)));
            }
        }
    }
    changes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entries(text: &str) -> Map<String, Value> {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn defaults_valid_values_and_what_is_refused() {
        let (settings, ignored) = Settings::from_entries(&entries("{}"));
        assert_eq!(settings, Settings::default());
        assert!(ignored.is_empty());

        let (settings, ignored) = Settings::from_entries(&entries(
            r#"{ "graph.rowHeight": 30, "commits.order": "topo", "language": "zh-TW", "details.location": "inline",
                 "dialogs.createBranch.checkout": true, "authors": [{ "name": "A", "email": "a@x" }], "plantuml.jar": "/p.jar",
                 "graph.rowHeight2": 1, "commits.initialLoad": 0, "graph.style": "square", "authors2": 1, "plantuml.jar2": "" }"#,
        ));
        assert_eq!(settings.graph.row_height, 30);
        assert_eq!(settings.commits.order, CommitOrder::Topo);
        assert_eq!(settings.language, Language::ZhTw);
        assert_eq!(settings.details.location, DetailsLocation::Inline);
        assert_eq!(settings.dialogs.get("createBranch.checkout"), Some(&json!(true)));
        assert_eq!(settings.authors, [Author { name: "A".into(), email: "a@x".into() }]);
        assert_eq!(settings.plantuml_jar.as_deref(), Some("/p.jar"));
        let keys: Vec<&str> = ignored.iter().map(|i| i.key.as_str()).collect();
        assert_eq!(keys, ["authors2", "commits.initialLoad", "graph.rowHeight2", "graph.style", "plantuml.jar2"]);
        assert_eq!(ignored[1].reason, "expected an integer from 1 to 100000");
        assert_eq!(ignored[3].reason, "expected one of \"rounded\", \"angular\"");
        assert_eq!(ignored[0].reason, "not a setting of this app");

        let mut s = Settings::default();
        assert!(s.apply("graph.colours", &json!([])).is_err());
        assert!(s.apply("dialogs.x", &json!(1)).is_err(), "a dialog key is <dialog>.<field>");
        assert!(s.apply("dialogs..y", &json!(1)).is_err());
        s.apply("plantuml.jar", &Value::Null).unwrap();
        assert_eq!(s.plantuml_jar, None);
    }

    #[test]
    fn a_value_reads_back_by_its_key() {
        let mut s = Settings::default();
        s.apply("commits.dateFormat", &json!("iso-date")).unwrap();
        s.apply("dialogs.merge.squash", &json!(true)).unwrap();
        assert_eq!(s.value_of("commits.dateFormat"), Some(json!("iso-date")));
        assert_eq!(s.value_of("graph.rowHeight"), Some(json!(24)));
        assert_eq!(s.value_of("language"), Some(json!("auto")));
        assert_eq!(s.value_of("plantuml.jar"), Some(Value::Null));
        assert_eq!(s.value_of("log.enabled"), Some(json!(false)));
        assert_eq!(s.value_of("dialogs.merge.squash"), Some(json!(true)));
        assert_eq!(s.value_of("dialogs.merge.other"), None);
        assert_eq!(s.value_of("nothing"), None);
    }

    #[test]
    fn the_first_versions_keys_move_to_todays() {
        let old = entries(
            r#"{ "interfaceLanguage": "zh-cn", "date.type": "Commit Date", "date.format": "ISO Date Only", "stickyHeader": false,
                 "repository.commits.initialLoad": 500, "repository.commits.fetchAvatars": true, "pullRequests.enabled": true,
                 "commitDetailsView.location": "Inline", "dialog.resetCurrentBranchToCommit.mode": "Hard",
                 "dialog.general.referenceInputSpaceSubstitution": "Hyphen", "dialog.createBranch.checkOut": true,
                 "markdownPreview.plantumlJar": "/p.jar", "commitAuthors": [{ "name": "A", "email": "a@x" }],
                 "graph.rowHeight": 20, "commits.order": "topo", "repository.commits.order": "date", "unknown": 1 }"#,
        );
        let changes = migrate(&old);
        let removed: Vec<&str> = changes.iter().filter(|(_, v)| v.is_none()).map(|(k, _)| k.as_str()).collect();
        let added: BTreeMap<&str, &Value> = changes.iter().filter_map(|(k, v)| v.as_ref().map(|v| (k.as_str(), v))).collect();
        assert_eq!(
            removed,
            [
                "interfaceLanguage", "date.type", "date.format", "stickyHeader", "repository.commits.initialLoad",
                "repository.commits.order", "repository.commits.fetchAvatars", "pullRequests.enabled", "commitDetailsView.location",
                "dialog.createBranch.checkOut", "dialog.general.referenceInputSpaceSubstitution", "dialog.resetCurrentBranchToCommit.mode",
                "markdownPreview.plantumlJar", "commitAuthors"
            ]
        );
        assert_eq!(added["language"], &json!("zh-TW"));
        assert_eq!(added["commits.dateType"], &json!("commit"));
        assert_eq!(added["commits.dateFormat"], &json!("iso-date"));
        assert_eq!(added["graph.stickyHeader"], &json!(false));
        assert_eq!(added["commits.initialLoad"], &json!(500));
        assert_eq!(added["details.location"], &json!("inline"));
        assert_eq!(added["dialogs.reset.mode"], &json!("hard"));
        assert_eq!(added["dialogs.general.spaceSubstitution"], &json!("hyphen"));
        assert_eq!(added["dialogs.createBranch.checkout"], &json!(true));
        assert_eq!(added["plantuml.jar"], &json!("/p.jar"));
        assert_eq!(added["authors"], &json!([{ "name": "A", "email": "a@x" }]));
        assert!(!added.contains_key("commits.order"), "today's key already set: kept");
        // A key with the same name in both versions is left alone.
        assert!(migrate(&entries(r#"{ "graph.rowHeight": 20, "unknown": 1 }"#)).is_empty());
        // Applying the changes gives a file today's reader takes whole.
        let mut file = old.clone();
        for (key, value) in changes {
            match value {
                Some(v) => file.insert(key, v),
                None => file.remove(&key),
            };
        }
        let (settings, ignored) = Settings::from_entries(&file);
        assert_eq!(settings.language, Language::ZhTw);
        assert_eq!(settings.commits.initial_load, 500);
        assert_eq!(ignored.iter().map(|i| i.key.as_str()).collect::<Vec<_>>(), ["unknown"]);
    }
}
