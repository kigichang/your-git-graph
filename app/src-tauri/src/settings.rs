//! The settings as the front end reads and changes them: settings.json (state.rs keeps the
//! file) through the schema of `gg_backend::settings`. Reading moves the first version's keys
//! to today's once; writing takes one key at a time and tells every window.

use gg_backend::settings::{migrate, Settings, SettingsView};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::state;

/// The settings of the file at `file`, after moving the first version's keys (written back).
pub fn load(file: &std::path::Path) -> Result<SettingsView, String> {
    let mut entries = state::read_settings(file)?;
    let changes = migrate(&entries);
    for (key, value) in &changes {
        state::write_setting(file, key, value.clone())?;
        match value {
            Some(v) => entries.insert(key.clone(), v.clone()),
            None => entries.remove(key),
        };
    }
    let (settings, ignored) = Settings::from_entries(&entries);
    Ok(SettingsView { settings, ignored })
}

#[tauri::command]
pub fn settings_get(app: AppHandle) -> Result<SettingsView, String> {
    load(&state::settings_file(&app)?)
}

/// Set one setting (`null` resets it to the default): refused with the value expected when it
/// is not valid; otherwise written and announced (`settings-changed`).
#[tauri::command]
pub fn settings_set(app: AppHandle, key: String, value: Value) -> Result<(), String> {
    check(&key, &value)?;
    let file = state::settings_file(&app)?;
    state::write_setting(&file, &key, if value.is_null() { None } else { Some(value) })?;
    let _ = app.emit("settings-changed", ());
    Ok(())
}

/// Whether `key` may be set to `value` (`null`: reset to its default).
fn check(key: &str, value: &Value) -> Result<(), String> {
    let mut settings = Settings::default();
    if !value.is_null() {
        return settings.apply(key, value).map_err(|expected| format!("{key}: expected {expected}"));
    }
    // A dialog's default has no value until one is set (the defaults hold none): it is a
    // setting when its key is shaped like one, which `apply` knows.
    let known = settings.value_of(key).is_some() || (key.starts_with("dialogs.") && settings.apply(key, value).is_ok());
    if known { Ok(()) } else { Err(format!("{key}: not a setting of this app")) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn what_may_be_set_and_reset() {
        assert!(check("graph.rowHeight", &json!(30)).is_ok());
        assert!(check("graph.rowHeight", &json!(999)).unwrap_err().contains("expected"));
        assert!(check("graph.rowHeight", &Value::Null).is_ok(), "back to the default");
        assert!(check("dialogs.merge.squash", &json!(true)).is_ok());
        assert!(check("dialogs.merge.squash", &Value::Null).is_ok(), "a dialog's default can be reset too");
        for unknown in ["nothing", "dialogs.merge", "dialogs..x", "graph.nothing"] {
            assert!(check(unknown, &Value::Null).unwrap_err().contains("not a setting"), "{unknown}");
        }
    }

    #[test]
    fn loading_moves_the_old_keys_and_keeps_what_it_cannot_read() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        std::fs::write(&file, r#"{ "stickyHeader": false, "repository.commits.initialLoad": 50, "graph.rowHeight": 99, "x": 1 }"#).unwrap();
        let view = load(&file).unwrap();
        assert!(!view.settings.graph.sticky_header);
        assert_eq!(view.settings.commits.initial_load, 50);
        assert_eq!(view.settings.graph.row_height, 24, "99 is out of range: the default");
        assert_eq!(view.ignored.iter().map(|i| i.key.as_str()).collect::<Vec<_>>(), ["graph.rowHeight", "x"]);
        let written = state::read_settings(&file).unwrap();
        assert_eq!(written.get("graph.stickyHeader"), Some(&json!(false)));
        assert!(!written.contains_key("stickyHeader"));
        assert_eq!(written.get("x"), Some(&json!(1)));
        assert!(load(&std::path::PathBuf::from("/nonexistent/dir/settings.json")).is_ok(), "no file: the defaults");
    }
}
