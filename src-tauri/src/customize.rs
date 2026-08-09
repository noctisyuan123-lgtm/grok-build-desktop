use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    env, fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_CUSTOMIZATION_BYTES: usize = 1_000_000;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CustomizeKind {
    Rule,
    Command,
    Skill,
    Agent,
    Hook,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CustomizeScope {
    User,
    Workspace,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomizeEntry {
    kind: CustomizeKind,
    scope: CustomizeScope,
    name: String,
    path: String,
    content: String,
    enabled: bool,
    modified_at: u64,
}

fn grok_home() -> Result<PathBuf, String> {
    env::var_os("GROK_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".grok")))
        .ok_or_else(|| "Could not resolve the Grok home directory".to_string())
}

fn safe_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty()
        || name.len() > 64
        || name == "."
        || name == ".."
        || !name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err(
            "Names may contain only letters, numbers, hyphens, and underscores (max 64)"
                .to_string(),
        );
    }
    Ok(name.to_string())
}

fn scope_root(scope: CustomizeScope, cwd: Option<&str>) -> Result<PathBuf, String> {
    match scope {
        CustomizeScope::User => grok_home(),
        CustomizeScope::Workspace => {
            let cwd = cwd
                .map(str::trim)
                .filter(|cwd| !cwd.is_empty())
                .ok_or_else(|| {
                    "Choose a project folder before using Workspace scope".to_string()
                })?;
            let root = PathBuf::from(cwd);
            if !root.is_dir() {
                return Err(format!(
                    "Workspace folder does not exist: {}",
                    root.display()
                ));
            }
            Ok(root.join(".grok"))
        }
    }
}

fn kind_dir(kind: CustomizeKind) -> &'static str {
    match kind {
        CustomizeKind::Rule => "rules",
        CustomizeKind::Command => "commands",
        CustomizeKind::Skill => "skills",
        CustomizeKind::Agent => "agents",
        CustomizeKind::Hook => "hooks",
    }
}

fn extension(kind: CustomizeKind) -> &'static str {
    match kind {
        CustomizeKind::Hook => "json",
        _ => "md",
    }
}

fn entry_path(
    kind: CustomizeKind,
    scope: CustomizeScope,
    name: &str,
    cwd: Option<&str>,
    enabled: bool,
) -> Result<PathBuf, String> {
    let name = safe_name(name)?;
    let base = scope_root(scope, cwd)?.join(kind_dir(kind));
    let file = match kind {
        CustomizeKind::Skill => base.join(name).join(if enabled {
            "SKILL.md"
        } else {
            "SKILL.md.disabled"
        }),
        _ => base.join(format!(
            "{name}.{}{}",
            extension(kind),
            if enabled { "" } else { ".disabled" }
        )),
    };
    Ok(file)
}

fn reject_symlink_path(root: &Path, path: &Path) -> Result<(), String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Customization path escaped its managed root".to_string())?;
    let mut current = root.to_path_buf();
    if let Ok(metadata) = fs::symlink_metadata(&current) {
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "Refusing to manage a customization through a symlink: {}",
                current.display()
            ));
        }
    }
    for component in relative.components() {
        current.push(component.as_os_str());
        if let Ok(metadata) = fs::symlink_metadata(&current) {
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "Refusing to manage a customization through a symlink: {}",
                    current.display()
                ));
            }
        }
    }
    Ok(())
}

fn validate_content(kind: CustomizeKind, content: &str) -> Result<(), String> {
    if content.as_bytes().len() > MAX_CUSTOMIZATION_BYTES {
        return Err("Customization files must be smaller than 1 MB".to_string());
    }
    if content.trim().is_empty() {
        return Err("Content cannot be empty".to_string());
    }
    if kind == CustomizeKind::Hook {
        let value: Value = serde_json::from_str(content)
            .map_err(|error| format!("Hook JSON is invalid: {error}"))?;
        if !value.is_object() || value.get("hooks").is_none() {
            return Err("Hook JSON must be an object containing a `hooks` field".to_string());
        }
    }
    Ok(())
}

fn modified_at(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn push_entry(
    entries: &mut Vec<CustomizeEntry>,
    kind: CustomizeKind,
    scope: CustomizeScope,
    name: String,
    path: PathBuf,
    enabled: bool,
) {
    let Ok(content) = fs::read_to_string(&path) else {
        return;
    };
    entries.push(CustomizeEntry {
        kind,
        scope,
        name,
        path: path.to_string_lossy().to_string(),
        content,
        enabled,
        modified_at: modified_at(&path),
    });
}

#[tauri::command]
pub fn list_customizations(
    kind: CustomizeKind,
    scope: CustomizeScope,
    cwd: Option<String>,
) -> Result<Vec<CustomizeEntry>, String> {
    let base = scope_root(scope, cwd.as_deref())?.join(kind_dir(kind));
    let mut entries = Vec::new();
    let Ok(read_dir) = fs::read_dir(&base) else {
        return Ok(entries);
    };

    for item in read_dir.flatten() {
        if item
            .file_type()
            .map(|kind| kind.is_symlink())
            .unwrap_or(true)
        {
            continue;
        }
        let path = item.path();
        if kind == CustomizeKind::Skill {
            if !path.is_dir() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            let enabled_path = path.join("SKILL.md");
            let disabled_path = path.join("SKILL.md.disabled");
            if enabled_path.is_file() {
                push_entry(
                    &mut entries,
                    kind,
                    scope,
                    name.to_string(),
                    enabled_path,
                    true,
                );
            } else if disabled_path.is_file() {
                push_entry(
                    &mut entries,
                    kind,
                    scope,
                    name.to_string(),
                    disabled_path,
                    false,
                );
            }
            continue;
        }

        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let enabled_suffix = format!(".{}", extension(kind));
        let disabled_suffix = format!(".{}.disabled", extension(kind));
        if let Some(name) = file_name.strip_suffix(&disabled_suffix) {
            push_entry(&mut entries, kind, scope, name.to_string(), path, false);
        } else if let Some(name) = file_name.strip_suffix(&enabled_suffix) {
            push_entry(&mut entries, kind, scope, name.to_string(), path, true);
        }
    }
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(entries)
}

#[tauri::command]
pub fn save_customization(
    kind: CustomizeKind,
    scope: CustomizeScope,
    name: String,
    content: String,
    enabled: bool,
    cwd: Option<String>,
) -> Result<CustomizeEntry, String> {
    validate_content(kind, &content)?;
    let name = safe_name(&name)?;
    let root = scope_root(scope, cwd.as_deref())?;
    let target = entry_path(kind, scope, &name, cwd.as_deref(), enabled)?;
    let alternate = entry_path(kind, scope, &name, cwd.as_deref(), !enabled)?;
    reject_symlink_path(&root, &target)?;
    reject_symlink_path(&root, &alternate)?;
    let parent = target
        .parent()
        .ok_or_else(|| "Customization path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("Could not create directory: {error}"))?;
    let tmp = target.with_extension(format!(
        "{}.tmp-{}",
        target
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("file"),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    fs::write(&tmp, &content).map_err(|error| format!("Could not write file: {error}"))?;
    fs::rename(&tmp, &target).map_err(|error| format!("Could not save file: {error}"))?;
    if alternate.exists() {
        fs::remove_file(&alternate)
            .map_err(|error| format!("Could not remove stale alternate file: {error}"))?;
    }
    Ok(CustomizeEntry {
        kind,
        scope,
        name,
        path: target.to_string_lossy().to_string(),
        content,
        enabled,
        modified_at: modified_at(&target),
    })
}

#[tauri::command]
pub fn set_customization_enabled(
    kind: CustomizeKind,
    scope: CustomizeScope,
    name: String,
    enabled: bool,
    cwd: Option<String>,
) -> Result<(), String> {
    let root = scope_root(scope, cwd.as_deref())?;
    let source = entry_path(kind, scope, &name, cwd.as_deref(), !enabled)?;
    let target = entry_path(kind, scope, &name, cwd.as_deref(), enabled)?;
    reject_symlink_path(&root, &source)?;
    reject_symlink_path(&root, &target)?;
    if !source.is_file() {
        return Err(format!("Customization not found: {}", source.display()));
    }
    if target.exists() {
        return Err(format!("Target already exists: {}", target.display()));
    }
    fs::rename(source, target).map_err(|error| format!("Could not change status: {error}"))
}

#[tauri::command]
pub fn delete_customization(
    kind: CustomizeKind,
    scope: CustomizeScope,
    name: String,
    cwd: Option<String>,
) -> Result<(), String> {
    let root = scope_root(scope, cwd.as_deref())?;
    let enabled = entry_path(kind, scope, &name, cwd.as_deref(), true)?;
    let disabled = entry_path(kind, scope, &name, cwd.as_deref(), false)?;
    reject_symlink_path(&root, &enabled)?;
    reject_symlink_path(&root, &disabled)?;
    if kind == CustomizeKind::Skill {
        let directory = enabled
            .parent()
            .ok_or_else(|| "Skill path has no parent".to_string())?;
        if directory.is_dir() {
            fs::remove_dir_all(directory)
                .map_err(|error| format!("Could not delete skill package: {error}"))?;
        }
        return Ok(());
    }
    for path in [enabled, disabled] {
        if path.is_file() {
            fs::remove_file(path).map_err(|error| format!("Could not delete file: {error}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_workspace(label: &str) -> PathBuf {
        let path = env::temp_dir().join(format!(
            "grok-desktop-customize-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&path).expect("create test workspace");
        path
    }

    #[test]
    fn workspace_customizations_round_trip_and_toggle() {
        let workspace = test_workspace("roundtrip");
        let cwd = workspace.to_string_lossy().to_string();
        let saved = save_customization(
            CustomizeKind::Rule,
            CustomizeScope::Workspace,
            "typescript".into(),
            "# TypeScript\n\nUse strict mode.\n".into(),
            true,
            Some(cwd.clone()),
        )
        .expect("save rule");
        assert!(saved.path.ends_with(".grok/rules/typescript.md"));

        let listed = list_customizations(
            CustomizeKind::Rule,
            CustomizeScope::Workspace,
            Some(cwd.clone()),
        )
        .expect("list rules");
        assert_eq!(listed.len(), 1);
        assert!(listed[0].enabled);

        set_customization_enabled(
            CustomizeKind::Rule,
            CustomizeScope::Workspace,
            "typescript".into(),
            false,
            Some(cwd.clone()),
        )
        .expect("disable rule");
        let disabled = list_customizations(
            CustomizeKind::Rule,
            CustomizeScope::Workspace,
            Some(cwd.clone()),
        )
        .expect("list disabled rule");
        assert!(!disabled[0].enabled);

        delete_customization(
            CustomizeKind::Rule,
            CustomizeScope::Workspace,
            "typescript".into(),
            Some(cwd.clone()),
        )
        .expect("delete rule");
        assert!(
            list_customizations(CustomizeKind::Rule, CustomizeScope::Workspace, Some(cwd))
                .expect("list after delete")
                .is_empty()
        );
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn hook_json_is_validated_before_write() {
        let workspace = test_workspace("hook-validation");
        let result = save_customization(
            CustomizeKind::Hook,
            CustomizeScope::Workspace,
            "broken".into(),
            "{ not-json }".into(),
            true,
            Some(workspace.to_string_lossy().to_string()),
        );
        assert!(result.unwrap_err().contains("Hook JSON is invalid"));
        assert!(!workspace.join(".grok/hooks/broken.json").exists());
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn names_cannot_escape_the_managed_roots() {
        assert!(safe_name("../outside").is_err());
        assert!(safe_name("nested/name").is_err());
        assert!(safe_name("valid-name_2").is_ok());
    }
}
