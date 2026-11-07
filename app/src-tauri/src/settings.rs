//! The settings as the front end reads and changes them: settings.json (state.rs keeps the
//! file) through the schema of `gg_backend::settings`. Reading moves the first version's keys
//! to today's once; writing takes one key at a time and tells every window.

use gg_backend::settings::{migrate, Ignored, Settings};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use ts_rs::TS;

use crate::state;

/// What `settings_get` answers: the settings, and the keys of the file that were not taken.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../web/src/lib/api/generated/")]
pub struct SettingsView {
    pub settings: Settings,
    pub ignored: Vec<Ignored>,
}

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
    let mut settings = Settings::default();
    if !value.is_null() {
        settings.apply(&key, &value).map_err(|expected| format!("{key}: expected {expected}"))?;
    } else if settings.value_of(&key).is_none() {
        return Err(format!("{key}: not a setting of this app"));
    }
    let file = state::settings_file(&app)?;
    state::write_setting(&file, &key, if value.is_null() { None } else { Some(value) })?;
    let _ = app.emit("settings-changed", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
