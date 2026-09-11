//! OpenCode-style workspace snapshots via a per-cwd shadow git repo.
//!
//! ACP `file_snapshots` on rewind points are often empty, so Undo would only
//! rewind conversation. This module mirrors OpenCode's approach:
//!
//! - Bare repo under `~/.grok-desktop/workspace-snapshots/<cwd_hash>/git`
//!   (override root with `GROK_DESKTOP_SNAPSHOT_ROOT` for tests)
//! - `track()` before each agent turn (`git add` + `write-tree`)
//! - Associate the tree hash with session / run / prompt preview
//! - On Undo, restore only paths that changed since that tree (checkout or
//!   delete), never escaping `cwd`
//!
//! Does not touch the project's own git history.

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const PREVIEW_CHARS: usize = 240;
const DEFAULT_EXCLUDES: &[&str] = &[
    "/.git/",
    "/node_modules/",
    "/target/",
    "/dist/",
    "/build/",
    "/.venv/",
    "/__pycache__/",
    "/.DS_Store",
    "*.pyc",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnSnapshot {
    pub run_id: String,
    pub session_id: String,
    pub prompt_preview: String,
    pub tree_hash: String,
    pub cwd: String,
    pub ts_ms: u64,
}

/// Post-undo (AFTER) file contents captured so toast Redo can re-apply them.
///
/// `content: None` means the path did not exist after the turn (agent deleted
/// it); redo deletes the path again after undo restored it from the tree.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashedFile {
    pub path: String,
    pub content: Option<String>,
}

const REDO_STASH_MAX_FILE_BYTES: usize = 1_000_000;
const REDO_STASH_MAX_TOTAL_BYTES: usize = 8_000_000;

fn disabled() -> bool {
    matches!(
        std::env::var("GROK_DESKTOP_SHADOW_GIT").as_deref(),
        Ok("0") | Ok("false") | Ok("off")
    )
}

fn snapshot_root() -> PathBuf {
    if let Ok(path) = std::env::var("GROK_DESKTOP_SNAPSHOT_ROOT") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".grok-desktop")
        .join("workspace-snapshots")
}

/// Stable short key for a cwd so many projects share one parent dir cleanly.
pub fn cwd_hash(cwd: &Path) -> String {
    let raw = cwd
        .canonicalize()
        .unwrap_or_else(|_| cwd.to_path_buf())
        .to_string_lossy()
        .to_string();
    // FNV-1a 64-bit — enough uniqueness for local paths, no extra deps.
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in raw.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn store_dir(cwd: &Path) -> PathBuf {
    snapshot_root().join(cwd_hash(cwd))
}

fn git_dir(cwd: &Path) -> PathBuf {
    store_dir(cwd).join("git")
}

fn turns_path(cwd: &Path) -> PathBuf {
    store_dir(cwd).join("turns.jsonl")
}

pub fn prompt_preview(prompt: &str) -> String {
    let trimmed = prompt.trim();
    if trimmed.chars().count() <= PREVIEW_CHARS {
        return trimmed.to_string();
    }
    trimmed.chars().take(PREVIEW_CHARS).collect()
}

fn previews_match(stored: &str, undone: &str) -> bool {
    let stored = stored.trim();
    let undone = undone.trim();
    if stored.is_empty() || undone.is_empty() {
        return false;
    }
    stored == undone || undone.starts_with(stored) || stored.starts_with(undone)
}

fn run_git(cwd: &Path, git_dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-c")
        .arg("core.autocrlf=false")
        .arg("-c")
        .arg("core.longpaths=true")
        .arg("-c")
        .arg("core.symlinks=true")
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-c")
        .arg("core.quotepath=false")
        .arg(format!("--git-dir={}", git_dir.display()))
        .arg(format!("--work-tree={}", cwd.display()))
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|error| format!("git spawn failed: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "git {} failed ({}): {} {}",
            args.first().copied().unwrap_or("?"),
            output.status,
            stderr.trim(),
            stdout.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn ensure_shadow_repo(cwd: &Path) -> Result<PathBuf, String> {
    let git = git_dir(cwd);
    fs::create_dir_all(git.parent().unwrap_or(Path::new(".")))
        .map_err(|error| format!("mkdir shadow store: {error}"))?;
    if !git.join("HEAD").exists() {
        // OpenCode-style: init with GIT_DIR + GIT_WORK_TREE so the project
        // worktree never gets a `.git` file/dir of its own.
        let output = Command::new("git")
            .args(["init"])
            .env("GIT_DIR", &git)
            .env("GIT_WORK_TREE", cwd)
            .current_dir(cwd)
            .output()
            .map_err(|error| format!("git init failed: {error}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git init (shadow) failed: {}", stderr.trim()));
        }
        let _ = run_git(cwd, &git, &["config", "core.autocrlf", "false"]);
        let _ = run_git(cwd, &git, &["config", "core.longpaths", "true"]);
        let _ = run_git(cwd, &git, &["config", "core.symlinks", "true"]);
        let _ = run_git(cwd, &git, &["config", "core.fsmonitor", "false"]);
    }
    let info = git.join("info");
    fs::create_dir_all(&info).map_err(|error| format!("mkdir info: {error}"))?;
    let exclude = info.join("exclude");
    if !exclude.exists() {
        let mut body = String::new();
        for line in DEFAULT_EXCLUDES {
            body.push_str(line);
            body.push('\n');
        }
        fs::write(&exclude, body).map_err(|error| format!("write exclude: {error}"))?;
    }
    Ok(git)
}

/// Stage worktree (honoring .gitignore + shadow excludes) and return tree hash.
pub fn track(cwd: &Path) -> Result<String, String> {
    if disabled() {
        return Err("shadow git disabled".into());
    }
    if !cwd.is_dir() {
        return Err(format!("cwd is not a directory: {}", cwd.display()));
    }
    let git = ensure_shadow_repo(cwd)?;
    // `add -A` stages modifications/deletes/untracked under work-tree, respecting
    // .gitignore in the work tree and info/exclude in the shadow repo.
    run_git(cwd, &git, &["add", "-A", "--", "."])?;
    let hash = run_git(cwd, &git, &["write-tree"])?;
    if hash.is_empty() {
        return Err("write-tree returned empty hash".into());
    }
    Ok(hash)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn append_turn(cwd: &Path, entry: &TurnSnapshot) -> Result<(), String> {
    let path = turns_path(cwd);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("mkdir turns: {error}"))?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("open turns.jsonl: {error}"))?;
    let line = serde_json::to_string(entry).map_err(|error| format!("serialize turn: {error}"))?;
    writeln!(file, "{line}").map_err(|error| format!("write turns.jsonl: {error}"))?;
    Ok(())
}

/// Capture workspace tree before an agent turn and record the association.
pub fn capture_before_turn(
    cwd: &Path,
    session_id: &str,
    run_id: &str,
    prompt: &str,
) -> Result<TurnSnapshot, String> {
    let tree_hash = track(cwd)?;
    let entry = TurnSnapshot {
        run_id: run_id.to_string(),
        session_id: session_id.to_string(),
        prompt_preview: prompt_preview(prompt),
        tree_hash,
        cwd: cwd
            .canonicalize()
            .unwrap_or_else(|_| cwd.to_path_buf())
            .to_string_lossy()
            .to_string(),
        ts_ms: now_ms(),
    };
    append_turn(cwd, &entry)?;
    Ok(entry)
}

fn read_turns(cwd: &Path) -> Vec<TurnSnapshot> {
    let path = turns_path(cwd);
    let Ok(file) = File::open(path) else {
        return Vec::new();
    };
    BufReader::new(file)
        .lines()
        .filter_map(|line| line.ok())
        .filter_map(|line| serde_json::from_str(&line).ok())
        .collect()
}

/// Find the snapshot taken before the turn being undone.
pub fn find_turn_snapshot(
    cwd: &Path,
    session_id: &str,
    undone_preview: Option<&str>,
) -> Option<TurnSnapshot> {
    let turns = read_turns(cwd);
    let session_turns: Vec<_> = turns
        .into_iter()
        .filter(|t| t.session_id == session_id)
        .collect();
    if session_turns.is_empty() {
        return None;
    }
    match undone_preview.map(str::trim).filter(|t| !t.is_empty()) {
        None => session_turns.into_iter().last(),
        Some(undone) => {
            let matches: Vec<_> = session_turns
                .iter()
                .enumerate()
                .filter(|(_, t)| previews_match(&t.prompt_preview, undone))
                .collect();
            match matches.as_slice() {
                [(idx, _)] => Some(session_turns[*idx].clone()),
                [] => None,
                // Prefer the newest unique-ish match when several share a preview.
                many => many.last().map(|(idx, _)| session_turns[*idx].clone()),
            }
        }
    }
}

fn resolve_inside_cwd(cwd: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim().trim_start_matches("./");
    if rel.is_empty() || rel.starts_with('/') || rel.contains('\0') {
        return Err(format!("invalid snapshot path {rel}"));
    }
    if Path::new(rel)
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!("refusing to restore snapshot outside cwd: {rel}"));
    }
    let root = cwd
        .canonicalize()
        .map_err(|error| format!("cannot resolve cwd: {error}"))?;
    let target = root.join(rel);
    // Target may not exist yet (restore create) — check parent stays inside.
    let parent = target.parent().unwrap_or(&root);
    let parent_canon = if parent.exists() {
        parent
            .canonicalize()
            .map_err(|error| format!("cannot resolve parent: {error}"))?
    } else {
        // Walk up to an existing ancestor and join remainder.
        let mut ancestor = parent.to_path_buf();
        let mut missing = Vec::new();
        while !ancestor.exists() {
            if let Some(name) = ancestor.file_name().map(|s| s.to_os_string()) {
                missing.push(name);
                ancestor.pop();
            } else {
                break;
            }
        }
        let mut base = ancestor
            .canonicalize()
            .map_err(|error| format!("cannot resolve ancestor: {error}"))?;
        for name in missing.into_iter().rev() {
            base.push(name);
        }
        base
    };
    if !parent_canon.starts_with(&root) && parent_canon != root {
        return Err(format!("refusing to restore snapshot outside cwd: {rel}"));
    }
    Ok(target)
}

fn path_in_tree(cwd: &Path, git: &Path, tree_hash: &str, rel: &str) -> bool {
    run_git(cwd, git, &["ls-tree", "--name-only", tree_hash, "--", rel])
        .map(|out| out.lines().any(|line| line.trim() == rel))
        .unwrap_or(false)
}

/// Paths that differ between `tree_hash` and the current worktree index.
pub fn changed_paths_since(cwd: &Path, tree_hash: &str) -> Result<Vec<String>, String> {
    let git = ensure_shadow_repo(cwd)?;
    run_git(cwd, &git, &["add", "-A", "--", "."])?;
    let out = run_git(
        cwd,
        &git,
        &[
            "diff",
            "--cached",
            "--name-only",
            "--no-ext-diff",
            tree_hash,
            "--",
            ".",
        ],
    )?;
    Ok(out
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect())
}

/// Restore files changed since `tree_hash` back to that snapshot.
///
/// Returns the number of paths restored or deleted.
pub fn restore_tree(cwd: &Path, tree_hash: &str) -> Result<usize, String> {
    if disabled() {
        return Ok(0);
    }
    let git = ensure_shadow_repo(cwd)?;
    let files = changed_paths_since(cwd, tree_hash)?;
    if files.is_empty() {
        return Ok(0);
    }
    let mut restored = 0usize;
    for rel in files {
        let target = match resolve_inside_cwd(cwd, &rel) {
            Ok(path) => path,
            Err(error) => {
                eprintln!("[grok shadow-git] skip unsafe path: {error}");
                continue;
            }
        };
        if path_in_tree(cwd, &git, tree_hash, &rel) {
            match run_git(cwd, &git, &["checkout", tree_hash, "--", &rel]) {
                Ok(_) => restored += 1,
                Err(error) => {
                    eprintln!("[grok shadow-git] checkout {rel} failed: {error}");
                }
            }
        } else {
            // Created after the snapshot — remove on undo.
            match fs::remove_file(&target) {
                Ok(()) => restored += 1,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    // Try directory if it was an added empty-ish path.
                    if target.is_dir() {
                        let _ = fs::remove_dir_all(&target);
                        restored += 1;
                    } else {
                        eprintln!(
                            "[grok shadow-git] delete {} failed: {error}",
                            target.display()
                        );
                    }
                }
            }
        }
    }
    Ok(restored)
}

/// Capture AFTER contents of paths that would be restored, for toast Redo.
pub fn stash_paths_for_redo(cwd: &Path, tree_hash: &str) -> Result<Vec<StashedFile>, String> {
    let files = changed_paths_since(cwd, tree_hash)?;
    let mut out = Vec::new();
    let mut total = 0usize;
    for rel in files {
        let target = match resolve_inside_cwd(cwd, &rel) {
            Ok(path) => path,
            Err(error) => {
                eprintln!("[grok shadow-git] stash skip unsafe path: {error}");
                continue;
            }
        };
        if target.is_dir() {
            continue;
        }
        if !target.exists() {
            out.push(StashedFile {
                path: rel,
                content: None,
            });
            continue;
        }
        match fs::read(&target) {
            Ok(bytes) if bytes.len() > REDO_STASH_MAX_FILE_BYTES => {
                eprintln!(
                    "[grok shadow-git] stash skip oversized {}: {} bytes",
                    rel,
                    bytes.len()
                );
            }
            Ok(bytes) => {
                if total.saturating_add(bytes.len()) > REDO_STASH_MAX_TOTAL_BYTES {
                    eprintln!("[grok shadow-git] stash truncated at size budget");
                    break;
                }
                match String::from_utf8(bytes) {
                    Ok(content) => {
                        total += content.len();
                        out.push(StashedFile {
                            path: rel,
                            content: Some(content),
                        });
                    }
                    Err(_) => {
                        eprintln!("[grok shadow-git] stash skip binary {rel}");
                    }
                }
            }
            Err(error) => {
                eprintln!("[grok shadow-git] stash read {rel} failed: {error}");
            }
        }
    }
    Ok(out)
}

/// Look up the undone turn's pre-turn tree and restore changed files.
pub fn restore_undone_turn(
    cwd: &Path,
    session_id: &str,
    undone_preview: Option<&str>,
) -> Result<usize, String> {
    let (restored, _) = restore_undone_turn_with_redo_stash(cwd, session_id, undone_preview)?;
    Ok(restored)
}

/// Restore the undone turn and return AFTER-state stashes for Redo.
pub fn restore_undone_turn_with_redo_stash(
    cwd: &Path,
    session_id: &str,
    undone_preview: Option<&str>,
) -> Result<(usize, Vec<StashedFile>), String> {
    if disabled() {
        return Ok((0, Vec::new()));
    }
    let Some(snap) = find_turn_snapshot(cwd, session_id, undone_preview) else {
        return Ok((0, Vec::new()));
    };
    let stash = stash_paths_for_redo(cwd, &snap.tree_hash).unwrap_or_default();
    let restored = restore_tree(cwd, &snap.tree_hash)?;
    Ok((restored, stash))
}

/// Re-apply stashed AFTER contents (toast Redo). `content: None` deletes.
pub fn apply_file_stash(cwd: &Path, files: &[StashedFile]) -> Result<usize, String> {
    if files.is_empty() {
        return Ok(0);
    }
    let mut applied = 0usize;
    for file in files {
        let target = resolve_inside_cwd(cwd, &file.path)?;
        match &file.content {
            None => {
                if target.is_file() {
                    fs::remove_file(&target)
                        .map_err(|error| format!("cannot delete {}: {error}", file.path))?;
                    applied += 1;
                } else if target.is_dir() {
                    fs::remove_dir_all(&target)
                        .map_err(|error| format!("cannot delete dir {}: {error}", file.path))?;
                    applied += 1;
                }
            }
            Some(content) => {
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|error| {
                        format!("cannot create parent for {}: {error}", file.path)
                    })?;
                }
                fs::write(&target, content)
                    .map_err(|error| format!("cannot write {}: {error}", file.path))?;
                applied += 1;
            }
        }
    }
    Ok(applied)
}

/// Best-effort capture used from the hot path — never fails the turn.
pub fn capture_before_turn_best_effort(
    cwd: &Path,
    session_id: &str,
    run_id: &str,
    prompt: &str,
) {
    if disabled() {
        return;
    }
    match capture_before_turn(cwd, session_id, run_id, prompt) {
        Ok(entry) => {
            eprintln!(
                "[grok shadow-git] tracked {} for run {} (tree {})",
                entry.prompt_preview.chars().take(48).collect::<String>(),
                run_id,
                &entry.tree_hash[..entry.tree_hash.len().min(12)]
            );
        }
        Err(error) => {
            eprintln!("[grok shadow-git] capture skipped: {error}");
        }
    }
}

/// Best-effort restore used after conversation rewind.
pub fn restore_undone_turn_best_effort(
    cwd: &Path,
    session_id: &str,
    undone_preview: Option<&str>,
) {
    if disabled() {
        return;
    }
    match restore_undone_turn(cwd, session_id, undone_preview) {
        Ok(0) => {}
        Ok(count) => {
            eprintln!("[grok shadow-git] restored {count} path(s) after undo");
        }
        Err(error) => {
            eprintln!("[grok shadow-git] restore failed: {error}");
        }
    }
}

#[allow(dead_code)]
pub fn debug_status(cwd: &Path) -> serde_json::Value {
    json!({
        "disabled": disabled(),
        "root": snapshot_root().display().to_string(),
        "cwdHash": cwd_hash(cwd),
        "gitDir": git_dir(cwd).display().to_string(),
        "turns": read_turns(cwd).len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    };

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn temp_pair() -> (PathBuf, PathBuf, std::sync::MutexGuard<'static, ()>) {
        let guard = ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let base = std::env::temp_dir().join(format!(
            "grok-shadow-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            n
        ));
        let cwd = base.join("cwd");
        let root = base.join("snap-root");
        fs::create_dir_all(&cwd).unwrap();
        fs::create_dir_all(&root).unwrap();
        std::env::set_var("GROK_DESKTOP_SNAPSHOT_ROOT", &root);
        std::env::remove_var("GROK_DESKTOP_SHADOW_GIT");
        (cwd, base, guard)
    }

    #[test]
    fn track_and_restore_rewinds_edited_and_created_files() {
        let (cwd, base, _guard) = temp_pair();
        fs::write(cwd.join("keep.txt"), "stable").unwrap();
        fs::write(cwd.join("edit.txt"), "BEFORE").unwrap();

        let before = capture_before_turn(&cwd, "sess-1", "run-1", "please edit undo-probe").unwrap();
        assert!(!before.tree_hash.is_empty());

        fs::write(cwd.join("edit.txt"), "AFTER").unwrap();
        fs::write(cwd.join("created.txt"), "new").unwrap();
        fs::write(cwd.join("keep.txt"), "stable").unwrap();

        let restored = restore_undone_turn(&cwd, "sess-1", Some("please edit undo-probe")).unwrap();
        assert!(restored >= 2, "expected edit+created restore, got {restored}");
        assert_eq!(fs::read_to_string(cwd.join("edit.txt")).unwrap(), "BEFORE");
        assert!(!cwd.join("created.txt").exists());
        assert_eq!(fs::read_to_string(cwd.join("keep.txt")).unwrap(), "stable");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn restore_rejects_path_escape_candidates() {
        let (cwd, base, _guard) = temp_pair();
        fs::write(cwd.join("ok.txt"), "v1").unwrap();
        let hash = track(&cwd).unwrap();
        // Direct restore of a safe tree still works.
        fs::write(cwd.join("ok.txt"), "v2").unwrap();
        assert_eq!(restore_tree(&cwd, &hash).unwrap(), 1);
        assert_eq!(fs::read_to_string(cwd.join("ok.txt")).unwrap(), "v1");
        // resolve_inside_cwd hard-rejects escapes.
        assert!(resolve_inside_cwd(&cwd, "../outside.txt").is_err());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn respects_gitignore_for_untracked_noise() {
        let (cwd, base, _guard) = temp_pair();
        fs::write(cwd.join(".gitignore"), "noise.log\n").unwrap();
        fs::write(cwd.join("app.txt"), "v1").unwrap();
        let hash = track(&cwd).unwrap();
        fs::write(cwd.join("app.txt"), "v2").unwrap();
        fs::write(cwd.join("noise.log"), "should-not-matter").unwrap();
        let changed = changed_paths_since(&cwd, &hash).unwrap();
        assert!(
            changed.iter().any(|p| p == "app.txt"),
            "app.txt should be in patch: {changed:?}"
        );
        assert!(
            !changed.iter().any(|p| p.ends_with("noise.log")),
            "gitignored noise must not be in patch: {changed:?}"
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn find_turn_matches_prompt_preview_prefix() {
        let (cwd, base, _guard) = temp_pair();
        fs::write(cwd.join("a.txt"), "1").unwrap();
        capture_before_turn(&cwd, "s", "r1", "short").unwrap();
        let long = "please change undo-probe.txt to AFTER and leave a note";
        capture_before_turn(&cwd, "s", "r2", long).unwrap();
        let found = find_turn_snapshot(&cwd, "s", Some(long)).expect("found");
        assert_eq!(found.run_id, "r2");
        let found2 = find_turn_snapshot(&cwd, "s", Some(&long[..20])).expect("prefix");
        assert_eq!(found2.run_id, "r2");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn stash_restore_and_redo_round_trip() {
        let (cwd, base, _guard) = temp_pair();
        fs::write(cwd.join("edit.txt"), "BEFORE").unwrap();

        capture_before_turn(&cwd, "sess-1", "run-1", "round-trip undo").unwrap();
        fs::write(cwd.join("edit.txt"), "AFTER").unwrap();
        fs::write(cwd.join("created.txt"), "new").unwrap();

        let (restored, stash) =
            restore_undone_turn_with_redo_stash(&cwd, "sess-1", Some("round-trip undo")).unwrap();
        assert!(restored >= 2, "expected restore count, got {restored}");
        assert_eq!(fs::read_to_string(cwd.join("edit.txt")).unwrap(), "BEFORE");
        assert!(!cwd.join("created.txt").exists());
        assert!(
            stash.iter().any(|f| f.path == "edit.txt" && f.content.as_deref() == Some("AFTER")),
            "stash missing AFTER edit: {stash:?}"
        );
        assert!(
            stash
                .iter()
                .any(|f| f.path == "created.txt" && f.content.as_deref() == Some("new")),
            "stash missing created: {stash:?}"
        );

        let applied = apply_file_stash(&cwd, &stash).unwrap();
        assert!(applied >= 2, "expected redo apply, got {applied}");
        assert_eq!(fs::read_to_string(cwd.join("edit.txt")).unwrap(), "AFTER");
        assert_eq!(fs::read_to_string(cwd.join("created.txt")).unwrap(), "new");

        let _ = fs::remove_dir_all(&base);
    }
}
