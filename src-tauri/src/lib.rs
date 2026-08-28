// `desktop` uses osascript so it only compiles on macOS. On other targets we
// expose a stub with the same signatures returning "unsupported" errors, so
// the Tauri command registration stays portable.
#[cfg(target_os = "macos")]
pub mod desktop;
#[cfg(not(target_os = "macos"))]
pub mod desktop {
    use serde::Serialize;
    #[derive(Debug, Clone, Serialize)]
    pub struct AppInfo {
        pub name: String,
        pub bundle_id: String,
        pub running: bool,
        pub capabilities: Vec<String>,
    }
    #[tauri::command]
    pub fn desktop_list_apps() -> Vec<AppInfo> {
        Vec::new()
    }
    #[tauri::command]
    pub fn desktop_query(_action: String) -> Result<String, String> {
        Err("desktop bridge is macOS-only".into())
    }
    #[tauri::command]
    pub fn desktop_activate(_app: String) -> Result<(), String> {
        Err("desktop bridge is macOS-only".into())
    }
}
pub mod context_metrics;
pub mod customize;
pub mod prompts;
pub mod runs;

use crate::runs::db::{Db, RunState};
use crate::runs::queue::{QueueMessage, QueueMessageKind, RunQueue};
#[cfg(target_os = "macos")]
use objc2::MainThreadMarker;
#[cfg(target_os = "macos")]
use objc2::msg_send;
#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::runtime::{AnyClass, AnyObject};
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSModalResponseOK, NSOpenPanel};
#[cfg(target_os = "macos")]
use objc2_foundation::NSString;
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, PhysicalPosition, PhysicalSize, Position, Size, WindowEvent};

const WINDOW_STATE_FILE: &str = "window-state.json";
const DEFAULT_WINDOW_WIDTH: u32 = 1120;
const DEFAULT_WINDOW_HEIGHT: u32 = 780;
const MIN_WINDOW_WIDTH: u32 = 480;
const MIN_WINDOW_HEIGHT: u32 = 600;
const DESKTOP_HANDOFF_FILE: &str = "desktop-handoff.json";

#[derive(Default)]
struct CompletionPopupState {
    serial: Arc<AtomicU64>,
    tab_id: Mutex<Option<String>>,
    /// Set when a system banner is posted while Grok is unfocused. Consumed
    /// when the main window becomes key so clicking the banner (or just
    /// returning to the app) opens the finished session.
    restore_on_focus: Mutex<Option<String>>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedWindowState {
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopHandoffRequest {
    session_id: String,
    cwd: Option<String>,
    requested_at: u128,
}

fn read_window_state(path: &Path) -> Option<PersistedWindowState> {
    let state = serde_json::from_slice::<PersistedWindowState>(&fs::read(path).ok()?).ok()?;
    if state.width < MIN_WINDOW_WIDTH || state.height < MIN_WINDOW_HEIGHT {
        return None;
    }
    Some(state)
}

fn save_window_state(path: &Path, size: PhysicalSize<u32>) {
    if size.width < MIN_WINDOW_WIDTH || size.height < MIN_WINDOW_HEIGHT {
        return;
    }
    let Ok(json) = serde_json::to_vec(&PersistedWindowState {
        width: size.width,
        height: size.height,
    }) else {
        return;
    };
    let temporary = path.with_extension("json.tmp");
    if fs::write(&temporary, json).is_ok() {
        let _ = fs::rename(temporary, path);
    }
}

struct TerminalProcess {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
struct TerminalState {
    sessions: Mutex<HashMap<String, TerminalProcess>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputPayload {
    session_id: String,
    data: String,
}

#[derive(Serialize)]
struct ToolStatus {
    id: String,
    label: String,
    command: String,
    installed: bool,
    detail: String,
}

#[derive(Deserialize, Serialize, Clone)]
struct ToolRun {
    ok: bool,
    command: String,
    cwd: String,
    exit_code: Option<i32>,
    duration_ms: u128,
    timed_out: bool,
    output: String,
    stderr: String,
}

#[derive(Deserialize, Serialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct SessionState {
    mode: Option<String>,
    drafts: serde_json::Value,
    coding_cwd: Option<String>,
    shell_command: Option<String>,
    action_policy: Option<String>,
    coding_workflow: Option<String>,
    theme_mode: Option<String>,
    last_run: Option<ToolRun>,
    history: Vec<ToolRun>,
    messages: serde_json::Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GrokAuthStatus {
    installed: bool,
    authenticated: bool,
    api_key_present: bool,
    cached_login_present: bool,
    config_present: bool,
    version: String,
    detail: String,
    login_command: String,
    device_login_command: String,
    install_command: String,
    npm_install_command: String,
    auth_path: String,
    config_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StaticPreviewFile {
    name: String,
    path: String,
    kind: String,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StaticPreview {
    available: bool,
    root: String,
    entry_path: String,
    /// URL on the `grokpreview` custom scheme the iframe should load. The
    /// document is served by `preview_scheme_response` with its own CSP, so
    /// it does not inherit the strict app CSP (about:srcdoc would).
    preview_url: String,
    files: Vec<StaticPreviewFile>,
    detail: String,
    updated_at: u128,
}

/// The one preview root the `grokpreview://` custom protocol may serve from.
/// `get_static_preview` stores the canonicalized project root plus a fresh
/// random token; the scheme handler rejects any request that does not carry
/// the current token or that resolves outside this root, so a compromised
/// renderer cannot use the scheme as an arbitrary-file oracle beyond the
/// folder the user already chose for preview.
#[derive(Default)]
struct PreviewState(Mutex<Option<RegisteredPreview>>);

struct RegisteredPreview {
    token: String,
    /// Canonicalized preview root; every served path must stay under it.
    root: PathBuf,
}

fn truncate_text(value: String) -> String {
    const MAX_CHARS: usize = 12_000;
    if value.chars().count() <= MAX_CHARS {
        return value;
    }

    let trimmed: String = value.chars().take(MAX_CHARS).collect();
    format!("{trimmed}\n\n[output truncated]")
}

fn strip_ansi_codes(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for code_ch in chars.by_ref() {
                if ('@'..='~').contains(&code_ch) {
                    break;
                }
            }
            continue;
        }
        output.push(ch);
    }

    output
}

fn is_noisy_grok_line(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.len() < 21 {
        return false;
    }
    let head: String = trimmed.chars().take(20).collect();
    let mut iter = head.chars();
    let looks_like_iso = (0..4).all(|_| iter.next().is_some_and(|c| c.is_ascii_digit()))
        && iter.next() == Some('-')
        && (0..2).all(|_| iter.next().is_some_and(|c| c.is_ascii_digit()))
        && iter.next() == Some('-')
        && (0..2).all(|_| iter.next().is_some_and(|c| c.is_ascii_digit()))
        && iter.next() == Some('T');
    if !looks_like_iso {
        return false;
    }
    let upper = trimmed.to_uppercase();
    upper.contains(" INFO ")
        || upper.contains(" DEBUG ")
        || upper.contains(" TRACE ")
        || upper.contains(" WARN ")
        || upper.contains(" ERROR ")
}

fn verbose_grok_stderr() -> bool {
    matches!(
        env::var("GROK_DESKTOP_VERBOSE_GROK_STDERR").as_deref(),
        Ok("1" | "true" | "yes" | "on")
    )
}

fn redact_env_pair(pair: &str) -> String {
    match pair.split_once('=') {
        Some((key, _)) => format!("{key}=<redacted>"),
        None => "<redacted>".to_string(),
    }
}

fn command_line(program: &str, args: &[String]) -> String {
    let mut redact_next = false;
    let mut redact_next_env = false;
    let suffix = args
        .iter()
        .map(|arg| {
            if redact_next {
                redact_next = false;
                return "<prompt>".to_string();
            }

            // `--env KEY=VALUE` pairs (grok mcp add) can carry API tokens;
            // the echoed command line is persisted (session_state.json,
            // localStorage), so never echo the value.
            if redact_next_env {
                redact_next_env = false;
                return redact_env_pair(arg);
            }

            if arg == "-p" || arg == "--single" || arg == "--prompt-json" {
                redact_next = true;
            }

            if arg == "--env" {
                redact_next_env = true;
            }

            if arg.starts_with("--single=") {
                return "--single=<prompt>".to_string();
            }

            if let Some(pair) = arg.strip_prefix("--env=") {
                return format!("--env={}", redact_env_pair(pair));
            }

            if arg.contains(' ') {
                format!("\"{}\"", arg.replace('"', "\\\""))
            } else {
                arg.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ");

    if suffix.is_empty() {
        program.to_string()
    } else {
        format!("{program} {suffix}")
    }
}

fn command_path() -> String {
    let home = env::var("HOME").unwrap_or_else(|_| "~".to_string());
    let fallback = format!(
        "{home}/.local/bin:{home}/.grok/bin:{home}/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    );
    match env::var("PATH") {
        Ok(path) if !path.trim().is_empty() => format!("{fallback}:{path}"),
        _ => fallback,
    }
}

/// Locate the grok binary for the streaming queue when GROK_DESKTOP_GROK_CMD
/// is unset. Every other surface resolves `grok` through `command_path()`
/// (which covers npm-prefix and homebrew installs — the install methods the
/// app itself recommends), so the queue must too; hardcoding
/// `~/.grok/bin/grok` broke chat for anyone who installed grok via npm or
/// brew even though the status panel said "installed / authenticated".
/// Falls back to the official installer's location.
fn default_grok_binary() -> String {
    for dir in command_path().split(':') {
        if dir.is_empty() || dir.starts_with('~') {
            continue;
        }
        let candidate = Path::new(dir).join("grok");
        if candidate.is_file() {
            return candidate.to_string_lossy().to_string();
        }
    }
    let home = env::var("HOME").unwrap_or_default();
    format!("{home}/.grok/bin/grok")
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn applescript_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn version_status(id: &str, label: &str, program: &str, args: &[&str]) -> ToolStatus {
    let output = Command::new(program)
        .args(args)
        .env("PATH", command_path())
        .output();
    match output {
        Ok(result) => {
            let stdout = String::from_utf8_lossy(&result.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&result.stderr).trim().to_string();
            ToolStatus {
                id: id.to_string(),
                label: label.to_string(),
                command: program.to_string(),
                installed: result.status.success(),
                detail: if stdout.is_empty() { stderr } else { stdout },
            }
        }
        Err(error) => ToolStatus {
            id: id.to_string(),
            label: label.to_string(),
            command: program.to_string(),
            installed: false,
            detail: error.to_string(),
        },
    }
}

fn command_timeout_secs(default_secs: u64) -> u64 {
    env::var("GROK_DESKTOP_COMMAND_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(default_secs)
}

fn grok_max_turns(default_turns: u8) -> u8 {
    env::var("GROK_DESKTOP_GROK_MAX_TURNS")
        .ok()
        .and_then(|value| value.parse::<u8>().ok())
        .filter(|value| (1..=40).contains(value))
        .unwrap_or(default_turns)
}

fn prepare_child_process(command: &mut Command) {
    #[cfg(unix)]
    unsafe {
        command.pre_exec(|| {
            // Become the leader of a new process group so we can kill
            // descendants — same pattern as runs/process.rs::spawn.
            nix::unistd::setpgid(nix::unistd::Pid::from_raw(0), nix::unistd::Pid::from_raw(0))
                .map_err(std::io::Error::other)?;
            Ok(())
        });
    }
}

fn child_pids(pid: u32) -> Vec<u32> {
    Command::new("pgrep")
        .args(["-P", &pid.to_string()])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|line| line.trim().parse::<u32>().ok())
                .collect()
        })
        .unwrap_or_default()
}

fn collect_process_tree(pid: u32, seen: &mut HashSet<u32>) {
    if !seen.insert(pid) {
        return;
    }

    for child in child_pids(pid) {
        collect_process_tree(child, seen);
    }
}

fn terminate_pid_tree(pid: u32) {
    #[cfg(unix)]
    {
        let process_group = format!("-{pid}");
        let _ = Command::new("kill")
            .args(["-TERM", &process_group])
            .status();

        let mut processes = HashSet::new();
        collect_process_tree(pid, &mut processes);
        for child_pid in processes
            .iter()
            .copied()
            .filter(|child_pid| *child_pid != pid)
        {
            let _ = Command::new("kill")
                .args(["-TERM", &child_pid.to_string()])
                .status();
        }

        thread::sleep(Duration::from_millis(250));

        let _ = Command::new("kill")
            .args(["-KILL", &process_group])
            .status();
        for child_pid in processes
            .iter()
            .copied()
            .filter(|child_pid| *child_pid != pid)
        {
            let _ = Command::new("kill")
                .args(["-KILL", &child_pid.to_string()])
                .status();
        }
    }
    #[cfg(windows)]
    {
        // Same approach as runs/process.rs kill_group: taskkill /T terminates
        // the whole tree rooted at this PID. Without this the legacy command
        // path's timeout only killed the direct child on Windows, leaking
        // grandchildren.
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .status();
    }
}

fn terminate_child_tree(child: &mut Child) {
    terminate_pid_tree(child.id());
    let _ = child.kill();
}

fn split_template_args(template: &str, prompt: &str, mode: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;

    for ch in template.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }

        match ch {
            '\\' => escaped = true,
            '"' | '\'' if quote == Some(ch) => quote = None,
            '"' | '\'' if quote.is_none() => quote = Some(ch),
            ch if ch.is_whitespace() && quote.is_none() => {
                if !current.is_empty() {
                    args.push(current.replace("{prompt}", prompt).replace("{mode}", mode));
                    current.clear();
                }
            }
            _ => current.push(ch),
        }
    }

    if !current.is_empty() {
        args.push(current.replace("{prompt}", prompt).replace("{mode}", mode));
    }

    args
}

/// Run an external process to completion, capturing stdout/stderr.
///
/// `filter_noise` enables the grok-specific tracing-log filter
/// (`is_noisy_grok_line`) — pass `true` ONLY for grok invocations. Arbitrary
/// shell commands and python scripts must see their output verbatim: a user
/// running `grep ERROR app.log` in the Terminal panel would otherwise have
/// timestamped log lines silently vanish.
fn run_external_command(
    program: &str,
    args: Vec<String>,
    cwd: Option<PathBuf>,
    timeout_secs: u64,
    filter_noise: bool,
) -> ToolRun {
    let display_command = command_line(program, &args);
    let cwd = cwd.unwrap_or_else(project_root);
    // project_root() is a compile-time path that only exists on the build
    // machine, and a saved cwd may have been deleted since. Fall back to
    // $HOME (mirroring runs/process.rs) instead of failing spawn with a
    // misleading "grok is not installed" ENOENT.
    let cwd = if cwd.is_dir() {
        cwd
    } else {
        env::var("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
    };
    let start = Instant::now();
    let mut command = Command::new(program);
    command
        .args(&args)
        .current_dir(&cwd)
        .env("PATH", command_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    prepare_child_process(&mut command);
    let spawn_result = command.spawn();

    let mut child = match spawn_result {
        Ok(child) => child,
        Err(error) => {
            return ToolRun {
                ok: false,
                command: display_command,
                cwd: cwd.to_string_lossy().to_string(),
                exit_code: None,
                duration_ms: start.elapsed().as_millis(),
                timed_out: false,
                output: String::new(),
                stderr: format!("{error}. Check that `{program}` is installed and on PATH."),
            }
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let output = Arc::new(Mutex::new(String::new()));
    let error_output = Arc::new(Mutex::new(String::new()));
    let mut reader_threads = Vec::new();

    if let Some(stdout) = stdout {
        let output = Arc::clone(&output);
        let filter = filter_noise && !verbose_grok_stderr();
        reader_threads.push(thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let cleaned = strip_ansi_codes(&line);
                if filter && is_noisy_grok_line(&cleaned) {
                    continue;
                }
                if let Ok(mut buffer) = output.lock() {
                    buffer.push_str(&cleaned);
                    buffer.push('\n');
                }
            }
        }));
    }

    if let Some(stderr) = stderr {
        let error_output = Arc::clone(&error_output);
        let filter = filter_noise && !verbose_grok_stderr();
        reader_threads.push(thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let cleaned = strip_ansi_codes(&line);
                if filter && is_noisy_grok_line(&cleaned) {
                    continue;
                }
                if let Ok(mut buffer) = error_output.lock() {
                    buffer.push_str(&cleaned);
                    buffer.push('\n');
                }
            }
        }));
    }

    let timeout = Duration::from_secs(timeout_secs);
    let mut timed_out = false;

    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() >= timeout => {
                timed_out = true;
                terminate_child_tree(&mut child);
                break;
            }
            Ok(None) => thread::sleep(Duration::from_millis(80)),
            Err(error) => {
                return ToolRun {
                    ok: false,
                    command: display_command,
                    cwd: cwd.to_string_lossy().to_string(),
                    exit_code: None,
                    duration_ms: start.elapsed().as_millis(),
                    timed_out: false,
                    output: String::new(),
                    stderr: error.to_string(),
                }
            }
        }
    }

    let wait_result = child.wait();
    for handle in reader_threads {
        let _ = handle.join();
    }

    match wait_result {
        Ok(status) => {
            let mut stderr = error_output
                .lock()
                .map(|buffer| buffer.clone())
                .unwrap_or_default();
            if timed_out {
                let timeout_note = format!("Command timed out after {timeout_secs}s.");
                stderr = if stderr.trim().is_empty() {
                    timeout_note
                } else {
                    format!("{stderr}\n{timeout_note}")
                };
            }

            ToolRun {
                ok: status.success() && !timed_out,
                command: display_command,
                cwd: cwd.to_string_lossy().to_string(),
                exit_code: status.code(),
                duration_ms: start.elapsed().as_millis(),
                timed_out,
                output: truncate_text(
                    output
                        .lock()
                        .map(|buffer| buffer.clone())
                        .unwrap_or_default(),
                ),
                stderr: truncate_text(stderr),
            }
        }
        Err(error) => ToolRun {
            ok: false,
            command: display_command,
            cwd: cwd.to_string_lossy().to_string(),
            exit_code: None,
            duration_ms: start.elapsed().as_millis(),
            timed_out,
            output: String::new(),
            stderr: error.to_string(),
        },
    }
}

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn bundled_resource_root() -> Option<PathBuf> {
    let executable = env::current_exe().ok()?;
    let contents_dir = executable.parent()?.parent()?;
    let resources_dir = contents_dir.join("Resources");
    if resources_dir.join("scripts").exists() {
        Some(resources_dir)
    } else if resources_dir.join("_up_").join("scripts").exists() {
        Some(resources_dir.join("_up_"))
    } else {
        None
    }
}

fn runtime_resource_root() -> PathBuf {
    if let Some(resource_root) = bundled_resource_root() {
        return resource_root;
    }

    let source_root = project_root();
    if source_root.join("scripts").exists() {
        source_root
    } else {
        bundled_resource_root().unwrap_or(source_root)
    }
}

fn absorbed_output_root() -> PathBuf {
    if bundled_resource_root().is_some() {
        return app_support_dir().join("absorbed");
    }

    let source_root = project_root();
    if source_root.join("scripts").exists() {
        source_root.join("absorbed")
    } else {
        app_support_dir().join("absorbed")
    }
}

fn script_path(name: &str) -> PathBuf {
    runtime_resource_root().join("scripts").join(name)
}

fn app_support_dir() -> PathBuf {
    env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("Library")
        .join("Application Support")
        .join("Grok Desktop")
}

fn session_state_path() -> PathBuf {
    app_support_dir().join("session_state.json")
}

fn attachment_asset_path(session_id: &str, asset_id: &str) -> Result<PathBuf, String> {
    let valid_component = |value: &str| {
        !value.is_empty()
            && value != "."
            && value != ".."
            && value
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    };
    if !valid_component(session_id) || !valid_component(asset_id) {
        return Err("Invalid attachment asset id.".to_string());
    }
    Ok(app_support_dir()
        .join("sessions")
        .join(session_id)
        .join("assets")
        .join(asset_id))
}

fn desktop_handoff_path() -> PathBuf {
    let home = env::var("HOME").unwrap_or_default();
    PathBuf::from(home)
        .join(".grok-desktop")
        .join(DESKTOP_HANDOFF_FILE)
}

/// Consume the one-shot request written by the CLI-side `/desktop` skill.
/// Reading and removing it in one command makes this work both when Desktop
/// is launched by the helper and when an existing Desktop window is already
/// running and polls for a new request.
#[tauri::command]
fn consume_desktop_handoff() -> Result<Option<DesktopHandoffRequest>, String> {
    let path = desktop_handoff_path();
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    let _ = fs::remove_file(&path);
    let request = serde_json::from_str::<DesktopHandoffRequest>(&raw)
        .map_err(|error| format!("parse {}: {error}", path.display()))?;
    if uuid::Uuid::parse_str(request.session_id.trim()).is_err() {
        return Err("desktop handoff contains an invalid session id".into());
    }
    if request.session_id.trim().is_empty() {
        return Err("desktop handoff contains an empty session id".into());
    }
    Ok(Some(request))
}

fn grok_home_dir() -> PathBuf {
    env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".grok")
}

// ── Grok skills ─────────────────────────────────────────────────────────────
// A skill is a folder with a SKILL.md (frontmatter name/description + body).
// grok-build discovers them from ~/.grok/skills (and ~/.claude/skills). We let
// users install a curated catalog with one click — install just writes the
// SKILL.md; grok picks it up on the next run.
fn grok_skills_dir() -> PathBuf {
    grok_home_dir().join("skills")
}

fn safe_skill_slug(slug: &str) -> Result<String, String> {
    let s = slug.trim();
    if s.is_empty()
        || s.contains('/')
        || s.contains('\\')
        || s.contains("..")
        || !s
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid skill name".into());
    }
    Ok(s.to_string())
}

#[tauri::command]
fn list_grok_skills() -> Vec<String> {
    let mut out = Vec::new();
    for base in [
        grok_skills_dir(),
        grok_home_dir().with_file_name(".claude").join("skills"),
    ] {
        if let Ok(rd) = fs::read_dir(&base) {
            for entry in rd.flatten() {
                if entry.path().join("SKILL.md").exists() {
                    if let Some(name) = entry.file_name().to_str() {
                        if !out.contains(&name.to_string()) {
                            out.push(name.to_string());
                        }
                    }
                }
            }
        }
    }
    out
}

#[tauri::command]
fn install_grok_skill(slug: String, body: String) -> Result<(), String> {
    let slug = safe_skill_slug(&slug)?;
    let dir = grok_skills_dir().join(&slug);
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir failed: {e}"))?;
    fs::write(dir.join("SKILL.md"), body).map_err(|e| format!("write failed: {e}"))?;
    Ok(())
}

#[tauri::command]
fn remove_grok_skill(slug: String) -> Result<(), String> {
    let slug = safe_skill_slug(&slug)?;
    let dir = grok_skills_dir().join(&slug);
    // Only remove a folder we'd recognise as a skill (has SKILL.md).
    if dir.join("SKILL.md").exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("remove failed: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
async fn load_session_state() -> Result<Option<SessionState>, String> {
    tauri::async_runtime::spawn_blocking(load_session_state_blocking)
        .await
        .map_err(|error| error.to_string())?
}

fn load_session_state_blocking() -> Result<Option<SessionState>, String> {
    let path = session_state_path();
    match fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str::<SessionState>(&raw) {
            Ok(state) => Ok(Some(state)),
            Err(error) => {
                // A truncated/corrupt file (crash mid-write) must not fail
                // EVERY future launch. Move it aside for inspection and report
                // once; the next launch starts clean.
                let backup = path.with_extension(format!(
                    "json.corrupt-{}",
                    chrono::Utc::now().timestamp_millis()
                ));
                let _ = fs::rename(&path, &backup);
                Err(format!(
                    "Could not parse session state (moved aside to {}): {error}",
                    backup.to_string_lossy()
                ))
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read session state: {error}")),
    }
}

#[tauri::command]
async fn save_session_state(state: SessionState) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_session_state_blocking(state))
        .await
        .map_err(|error| error.to_string())?
}

fn save_session_state_blocking(state: SessionState) -> Result<(), String> {
    let path = session_state_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create session directory: {error}"))?;
    }
    let raw = serde_json::to_string_pretty(&state)
        .map_err(|error| format!("Could not serialize session state: {error}"))?;
    // Write atomically (tmp + rename): a crash mid-`fs::write` would leave a
    // truncated JSON file and destroy the whole conversation history.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, raw).map_err(|error| format!("Could not save session state: {error}"))?;
    fs::rename(&tmp, &path).map_err(|error| format!("Could not save session state: {error}"))
}

fn preview_root(cwd: Option<String>) -> PathBuf {
    cwd.map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn html_attr_value(tag: &str, attr: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let attr_lower = attr.to_ascii_lowercase();
    let mut search_from = 0;
    while let Some(found) = lower[search_from..].find(&attr_lower) {
        let attr_pos = search_from + found;
        search_from = attr_pos + attr_lower.len();
        // The name must start at an attribute boundary (after whitespace) —
        // a bare find() would match `src` inside `data-src` or inside another
        // attribute's value — and be immediately followed by (optional
        // whitespace and) '='.
        let preceded_by_space =
            attr_pos > 0 && lower.as_bytes()[attr_pos - 1].is_ascii_whitespace();
        if !preceded_by_space {
            continue;
        }
        let after_attr = tag[attr_pos + attr.len()..].trim_start();
        let Some(after_equals) = after_attr.strip_prefix('=') else {
            continue;
        };
        let after_equals = after_equals.trim_start();
        let Some(quote) = after_equals.chars().next() else {
            continue;
        };
        if quote != '"' && quote != '\'' {
            continue;
        }
        let rest = &after_equals[quote.len_utf8()..];
        let Some(end) = rest.find(quote) else {
            continue;
        };
        return Some(rest[..end].to_string());
    }
    None
}

fn asset_path(root: &Path, canonical_root: &Path, reference: &str) -> Option<PathBuf> {
    let clean = reference.split(['?', '#']).next().unwrap_or("").trim();
    if clean.is_empty()
        || clean.starts_with('/')
        || clean.starts_with("http:")
        || clean.starts_with("https:")
        || clean.starts_with("data:")
        || clean.starts_with("blob:")
        || clean.contains('\\')
    {
        return None;
    }

    let candidate = root.join(clean);
    let canonical = candidate.canonicalize().ok()?;
    if canonical.starts_with(canonical_root) && canonical.is_file() {
        Some(canonical)
    } else {
        None
    }
}

/// Per-asset and total byte budgets for the preview inliner. Every inlined
/// asset lands in a single srcDoc string shipped over IPC, so unbounded reads
/// of project-local JS/CSS (e.g. a bundled multi-hundred-MB artifact) would
/// produce a giant payload and hang the UI. Oversized assets keep their
/// original tag (same outcome as an unreadable file) and a marker comment is
/// appended so the user can tell why the preview is partial.
const PREVIEW_ASSET_MAX_BYTES: u64 = 2 * 1024 * 1024;
const PREVIEW_TOTAL_MAX_BYTES: u64 = 5 * 1024 * 1024;

fn read_asset_within_budget(path: PathBuf, used: &mut u64, skipped: &mut bool) -> Option<String> {
    let size = fs::metadata(&path).ok()?.len();
    if size > PREVIEW_ASSET_MAX_BYTES || *used + size > PREVIEW_TOTAL_MAX_BYTES {
        *skipped = true;
        return None;
    }
    let text = fs::read_to_string(path).ok()?;
    *used += size;
    Some(text)
}

fn inline_stylesheets(
    mut html: String,
    root: &Path,
    canonical_root: &Path,
    used: &mut u64,
    skipped: &mut bool,
) -> String {
    let mut cursor = 0;
    while let Some(relative_start) = html[cursor..].to_ascii_lowercase().find("<link") {
        let start = cursor + relative_start;
        let Some(relative_end) = html[start..].find('>') else {
            break;
        };
        let end = start + relative_end + 1;
        let tag = html[start..end].to_string();
        let tag_lower = tag.to_ascii_lowercase();
        if !tag_lower.contains("stylesheet") {
            cursor = end;
            continue;
        }

        let Some(href) = html_attr_value(&tag, "href") else {
            cursor = end;
            continue;
        };
        let Some(path) = asset_path(root, canonical_root, &href) else {
            cursor = end;
            continue;
        };
        let Some(css) = read_asset_within_budget(path, used, skipped) else {
            cursor = end;
            continue;
        };
        let replacement = format!("<style>\n{}\n</style>", css.replace("</style", "<\\/style"));
        html.replace_range(start..end, &replacement);
        cursor = start + replacement.len();
    }
    html
}

fn inline_scripts(
    mut html: String,
    root: &Path,
    canonical_root: &Path,
    used: &mut u64,
    skipped: &mut bool,
) -> String {
    let mut cursor = 0;
    while let Some(relative_start) = html[cursor..].to_ascii_lowercase().find("<script") {
        let start = cursor + relative_start;
        let Some(relative_tag_end) = html[start..].find('>') else {
            break;
        };
        let tag_end = start + relative_tag_end + 1;
        let tag = html[start..tag_end].to_string();
        let Some(src) = html_attr_value(&tag, "src") else {
            cursor = tag_end;
            continue;
        };

        let html_lower_tail = html[tag_end..].to_ascii_lowercase();
        let Some(relative_close) = html_lower_tail.find("</script>") else {
            cursor = tag_end;
            continue;
        };
        let close_end = tag_end + relative_close + "</script>".len();
        let Some(path) = asset_path(root, canonical_root, &src) else {
            cursor = close_end;
            continue;
        };
        let Some(script) = read_asset_within_budget(path, used, skipped) else {
            cursor = close_end;
            continue;
        };
        let replacement = format!(
            "<script>\n{}\n</script>",
            script.replace("</script", "<\\/script")
        );
        html.replace_range(start..close_end, &replacement);
        cursor = start + replacement.len();
    }
    html
}

fn inline_static_assets(html: String, root: &Path) -> String {
    let Ok(canonical_root) = root.canonicalize() else {
        return html;
    };
    let mut used: u64 = 0;
    let mut skipped = false;
    let html = inline_stylesheets(html, root, &canonical_root, &mut used, &mut skipped);
    let mut html = inline_scripts(html, root, &canonical_root, &mut used, &mut skipped);
    if skipped {
        html.push_str(
            "\n<!-- grok-desktop preview: some local assets were too large to inline and were skipped -->",
        );
    }
    html
}

fn project_files(root: &PathBuf) -> Vec<StaticPreviewFile> {
    let mut files = fs::read_dir(root)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(Result::ok))
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_file() {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            let name = entry.file_name().to_string_lossy().to_string();
            let kind = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("file")
                .to_ascii_lowercase();
            Some(StaticPreviewFile {
                name,
                path: path.to_string_lossy().to_string(),
                kind,
                size: metadata.len(),
            })
        })
        .collect::<Vec<_>>();
    files.sort_by(|left, right| left.name.cmp(&right.name));
    files.truncate(24);
    files
}

const PREVIEW_SCHEME: &str = "grokpreview";

/// CSP attached to every response served on the preview scheme. The preview
/// document is arbitrary generated-site code, so this policy is deliberately
/// permissive (inline scripts/styles and remote subresources work, matching
/// the old srcdoc behavior); the real isolation is the sandboxed iframe
/// without allow-same-origin (opaque origin, no Tauri IPC). The header exists
/// so the document has an explicit policy of its own instead of relying on
/// inheritance, and so plugins and base-URI rewrites stay disabled.
const PREVIEW_DOCUMENT_CSP: &str = "default-src 'self' 'unsafe-inline' data: blob:; \
    script-src 'self' 'unsafe-inline' https:; \
    style-src 'self' 'unsafe-inline' https:; \
    img-src 'self' data: blob: https: http:; \
    font-src 'self' data: https:; \
    media-src 'self' data: blob:; \
    connect-src 'self' https:; \
    object-src 'none'; base-uri 'none'";

fn preview_scheme_url(token: &str) -> String {
    // Windows and Android map custom schemes onto http://{scheme}.localhost;
    // macOS/Linux WebViews load the scheme directly.
    if cfg!(any(windows, target_os = "android")) {
        format!("http://{PREVIEW_SCHEME}.localhost/{token}/index.html")
    } else {
        format!("{PREVIEW_SCHEME}://localhost/{token}/index.html")
    }
}

fn percent_decode_path(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'%' && index + 2 < bytes.len() {
            let hex = &value[index + 1..index + 3];
            if let Ok(decoded) = u8::from_str_radix(hex, 16) {
                out.push(decoded);
                index += 3;
                continue;
            }
        }
        out.push(byte);
        index += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn preview_content_type(rel: &str) -> &'static str {
    let extension = rel.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match extension.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "csv" => "text/csv; charset=utf-8",
        "xml" => "application/xml",
        "yaml" | "yml" => "application/yaml",
        "zip" => "application/zip",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "txt" | "md" => "text/plain; charset=utf-8",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

fn preview_http_response(
    status: u16,
    content_type: &str,
    body: Vec<u8>,
) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        .header("Content-Security-Policy", PREVIEW_DOCUMENT_CSP)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .body(body)
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

/// Constant-time byte comparison for the preview token. XOR-accumulates over
/// every byte so a mismatch early in the string costs the same as one at the
/// end — the comparison itself leaks nothing about how much of the token
/// matched. Length is compared first; the token's length is not a secret.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Serve one request on the preview scheme. Expected path shape:
/// `/{token}/{relative/path}` where an empty relative path means index.html.
/// Everything is validated against the single registered preview root:
/// wrong/absent token -> 404, path traversal (canonicalize + starts_with)
/// -> 404, oversized files -> 413.
fn preview_scheme_response(
    registered: Option<&RegisteredPreview>,
    request_path: &str,
) -> tauri::http::Response<Vec<u8>> {
    let Some(registered) = registered else {
        return preview_http_response(404, "text/plain", b"no preview registered".to_vec());
    };
    let mut segments = request_path.trim_start_matches('/').splitn(2, '/');
    let token = segments.next().unwrap_or("");
    if token.is_empty() || !constant_time_eq(token.as_bytes(), registered.token.as_bytes()) {
        return preview_http_response(404, "text/plain", b"unknown preview token".to_vec());
    }
    let rel = percent_decode_path(segments.next().unwrap_or(""));
    let rel = rel.trim_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };

    if rel == "index.html" {
        let entry = registered.root.join("index.html");
        return match fs::read_to_string(&entry) {
            Ok(html) => {
                let html = inline_static_assets(html, &registered.root);
                preview_http_response(200, "text/html; charset=utf-8", html.into_bytes())
            }
            Err(_) => preview_http_response(404, "text/plain", b"index.html not found".to_vec()),
        };
    }

    // Subresources (images, extra pages, media the inliner does not embed):
    // asset_path re-uses the inliner's validation — relative-only references,
    // canonicalized, and required to stay under the registered root.
    let Some(path) = asset_path(&registered.root, &registered.root, rel) else {
        return preview_http_response(404, "text/plain", b"not found".to_vec());
    };
    let size = fs::metadata(&path)
        .map(|meta| meta.len())
        .unwrap_or(u64::MAX);
    if size > PREVIEW_ASSET_MAX_BYTES {
        return preview_http_response(413, "text/plain", b"file too large for preview".to_vec());
    }
    match fs::read(&path) {
        Ok(bytes) => preview_http_response(200, preview_content_type(rel), bytes),
        Err(_) => preview_http_response(404, "text/plain", b"not found".to_vec()),
    }
}

#[tauri::command]
async fn get_static_preview(
    app: tauri::AppHandle,
    cwd: Option<String>,
) -> Result<StaticPreview, String> {
    // Touches the filesystem — off the main thread.
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<PreviewState>();
        get_static_preview_blocking(cwd, &state)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn get_static_preview_blocking(
    cwd: Option<String>,
    state: &PreviewState,
) -> Result<StaticPreview, String> {
    let root = preview_root(cwd);
    let files = project_files(&root);
    let entry = root.join("index.html");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();

    let unavailable = |detail: String, files: Vec<StaticPreviewFile>| StaticPreview {
        available: false,
        root: root.to_string_lossy().to_string(),
        entry_path: entry.to_string_lossy().to_string(),
        preview_url: String::new(),
        files,
        detail,
        updated_at: now,
    };

    if !entry.is_file() {
        return Ok(unavailable(
            "Create index.html in the selected project to enable preview.".to_string(),
            files,
        ));
    }

    let Ok(canonical_root) = root.canonicalize() else {
        return Ok(unavailable(
            "Could not resolve the project folder for preview.".to_string(),
            files,
        ));
    };

    // Register the root + a fresh token; the previous URL stops working,
    // which also makes every refresh a guaranteed iframe reload.
    let token = uuid::Uuid::now_v7().simple().to_string();
    if let Ok(mut guard) = state.0.lock() {
        *guard = Some(RegisteredPreview {
            token: token.clone(),
            root: canonical_root,
        });
    } else {
        return Ok(unavailable(
            "Preview registry is unavailable.".to_string(),
            files,
        ));
    }

    Ok(StaticPreview {
        available: true,
        root: root.to_string_lossy().to_string(),
        entry_path: entry.to_string_lossy().to_string(),
        preview_url: preview_scheme_url(&token),
        files,
        detail: "Rendering index.html in an isolated preview origin with local assets inlined."
            .to_string(),
        updated_at: now,
    })
}

fn path_has_entries(path: &PathBuf) -> bool {
    fs::read_dir(path)
        .ok()
        .and_then(|mut entries| entries.next())
        .is_some()
}

fn mode_context(mode: &str) -> &'static str {
    match mode {
        "coding" => {
            "Grok Desktop Grok Code Mode: act as a senior programming desktop assistant for professional engineers. Optimize for repository understanding, precise edits, terminal verification, and concise engineering judgment."
        }
        _ => {
            "Grok Desktop Grok Chat Mode: answer clearly, keep practical context, and hand off to Coding Mode when the task touches a repository, terminal, or code change. In every response, the first thing your text (文字) must do is clearly 吐出 (state) this core point before proceeding with the answer to the user task."
        }
    }
}

/// Durable Desktop guidance for the legacy single-command runner.
///
/// Keep this in `--rules`, not in `-p`: the latter becomes a visible User
/// transcript entry and is shown again when the shared session is resumed by
/// Grok CLI (`/cli`).
fn grok_rules(mode: &str, cwd: &Path) -> String {
    format!(
        r#"{context}

You are running inside Grok Desktop, a Grok-first desktop programming environment inspired by the best parts of Claude Desktop, but optimized for the official Grok Build CLI.

Workspace contract:
- Current working directory: {cwd}
- Treat the selected directory as the active project unless the user says otherwise.
- Read relevant files before recommending or applying code changes.
- Prefer small, reviewable changes over broad rewrites.
- Use terminal commands for verification when useful, and report the exact commands.
- Never run destructive commands or irreversible migrations unless the user explicitly asked for them.
- If credentials, private files, or risky operations appear, pause and explain the risk.

Engineering behavior:
- For simple, short, one-sentence, read-only, or exact-format tasks, answer directly and do not perform repository mapping or use the section template.
- For analysis tasks, produce a high-signal technical readout with file paths, risks, and next actions.
- For implementation tasks, state the intended change, keep edits focused, and include verification.
- For debugging tasks, distinguish evidence, hypothesis, root cause, fix, and verification.
- For reviews, prioritize correctness, regressions, tests, security, and maintainability.

Response format:
Use `1. Summary`, `2. Files / Evidence`, `3. Changes or Recommendation`, `4. Verification commands`, and `5. Next step` for normal coding tasks only. For simple tasks, obey the user's requested format exactly.
"#,
        context = mode_context(mode),
        cwd = cwd.to_string_lossy()
    )
}

fn normalized_effort(effort: Option<String>) -> String {
    match effort
        .unwrap_or_else(|| "high".to_string())
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "minimal" => "minimal".to_string(),
        "low" => "low".to_string(),
        "medium" => "medium".to_string(),
        "high" => "high".to_string(),
        "xhigh" => "xhigh".to_string(),
        "max" => "max".to_string(),
        _ => "high".to_string(),
    }
}

fn normalized_reasoning_effort(reasoning_effort: Option<String>) -> Option<String> {
    match reasoning_effort
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "" | "off" | "none" => None,
        "minimal" => Some("minimal".to_string()),
        "low" => Some("low".to_string()),
        "medium" => Some("medium".to_string()),
        "high" => Some("high".to_string()),
        // grok's --reasoning-effort has no "max"; its real maximum is "xhigh".
        // Passing "max" makes grok exit code 2, so map the UI's Max → xhigh.
        "xhigh" | "max" => Some("xhigh".to_string()),
        _ => None,
    }
}

fn normalized_model(model: Option<String>) -> String {
    let value = model.unwrap_or_else(|| "grok-build".to_string());
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_whitespace) {
        "grok-build".to_string()
    } else {
        trimmed.to_string()
    }
}

fn normalized_permission_mode(permission_mode: Option<String>) -> Option<String> {
    let value = permission_mode?;
    match value.trim() {
        "" | "default" => None,
        "acceptEdits" => Some("acceptEdits".to_string()),
        "auto" => Some("auto".to_string()),
        "dontAsk" => Some("dontAsk".to_string()),
        "plan" => Some("plan".to_string()),
        "bypassPermissions" => Some("bypassPermissions".to_string()),
        _ => None,
    }
}

/// Optional run configuration for `grok_args`. Defaults mirror the composer's
/// safe defaults: no model/effort overrides, web search and subagents on.
struct GrokRunOptions {
    model: Option<String>,
    effort: Option<String>,
    reasoning_effort: Option<String>,
    permission_mode: Option<String>,
    experimental_memory: bool,
    web_search_enabled: bool,
    subagents_enabled: bool,
}

impl Default for GrokRunOptions {
    fn default() -> Self {
        Self {
            model: None,
            effort: None,
            reasoning_effort: None,
            permission_mode: None,
            experimental_memory: false,
            web_search_enabled: true,
            subagents_enabled: true,
        }
    }
}

fn grok_args(prompt: &str, mode: &str, cwd: &Path, options: GrokRunOptions) -> Vec<String> {
    let GrokRunOptions {
        model,
        effort,
        reasoning_effort,
        permission_mode,
        experimental_memory,
        web_search_enabled,
        subagents_enabled,
    } = options;
    let user_prompt = prompt.trim().to_string();
    if let Ok(template) = env::var("GROK_DESKTOP_GROK_ARGS") {
        return split_template_args(&template, &user_prompt, mode);
    }

    let model = normalized_model(model);
    // grok 1.0 aliases `--effort` to `--reasoning-effort`. Emit one flag.
    let effort = normalized_reasoning_effort(reasoning_effort)
        .or_else(|| normalized_reasoning_effort(Some(normalized_effort(effort))));
    let mut args = vec!["--no-alt-screen".to_string(), "--model".to_string(), model];
    if let Some(effort) = effort {
        args.push("--reasoning-effort".to_string());
        args.push(effort);
    }

    if let Some(permission_mode) = normalized_permission_mode(permission_mode) {
        args.push("--permission-mode".to_string());
        args.push(permission_mode);
    }

    if experimental_memory {
        args.push("--experimental-memory".to_string());
    }

    if !web_search_enabled {
        args.push("--disable-web-search".to_string());
    }

    if !subagents_enabled {
        args.push("--no-subagents".to_string());
    }

    args.push("--rules".to_string());
    args.push(grok_rules(mode, cwd));

    args.push("--max-turns".to_string());
    args.push(grok_max_turns(12).to_string());
    args.push("-p".to_string());
    args.push(user_prompt);
    args.push("--output-format".to_string());
    args.push("plain".to_string());
    args
}

fn normalized_cwd(cwd: Option<String>) -> PathBuf {
    cwd.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(PathBuf::from(trimmed))
        }
    })
    .unwrap_or_else(project_root)
}

fn default_shell_cwd() -> PathBuf {
    env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(project_root)
}

fn collect_grok_auth_status() -> GrokAuthStatus {
    let program = env::var("GROK_DESKTOP_GROK_CMD").unwrap_or_else(|_| "grok".to_string());
    let version_result = Command::new(&program)
        .arg("--version")
        .env("PATH", command_path())
        .output();
    let installed = version_result
        .as_ref()
        .map(|result| result.status.success())
        .unwrap_or(false);
    let version = version_result
        .as_ref()
        .map(|result| {
            let stdout = String::from_utf8_lossy(&result.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&result.stderr).trim().to_string();
            if stdout.is_empty() {
                stderr
            } else {
                stdout
            }
        })
        .unwrap_or_default();

    let grok_home = grok_home_dir();
    let auth_dir_path = grok_home.join("auth");
    let auth_json_path = grok_home.join("auth.json");
    let config_path = grok_home.join("config.toml");
    let api_key_present = env::var("XAI_API_KEY")
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
        || env::var("GROK_CODE_XAI_API_KEY")
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
    let cached_login_present =
        (auth_dir_path.exists() && path_has_entries(&auth_dir_path)) || auth_json_path.exists();
    let config_present = config_path.exists();
    let authenticated = api_key_present || cached_login_present;
    let detail = if !installed {
        "Grok CLI is not installed or not on PATH.".to_string()
    } else if authenticated {
        if api_key_present {
            "Authenticated with an API key environment variable.".to_string()
        } else {
            "A cached Grok CLI login was found.".to_string()
        }
    } else {
        "Run `grok login`, `grok login --device-auth`, or set XAI_API_KEY.".to_string()
    };

    GrokAuthStatus {
        installed,
        authenticated,
        api_key_present,
        cached_login_present,
        config_present,
        version,
        detail,
        login_command: format!("{program} login"),
        device_login_command: format!("{program} login --device-auth"),
        install_command: "curl -fsSL https://x.ai/cli/install.sh | bash".to_string(),
        npm_install_command: "npm install -g @xai-official/grok".to_string(),
        auth_path: auth_json_path.to_string_lossy().to_string(),
        config_path: config_path.to_string_lossy().to_string(),
    }
}

#[tauri::command]
async fn get_grok_auth_status() -> GrokAuthStatus {
    tauri::async_runtime::spawn_blocking(collect_grok_auth_status)
        .await
        .unwrap_or_else(|error| GrokAuthStatus {
            installed: false,
            authenticated: false,
            api_key_present: false,
            cached_login_present: false,
            config_present: false,
            version: String::new(),
            detail: error.to_string(),
            login_command: "grok login".to_string(),
            device_login_command: "grok login --device-auth".to_string(),
            install_command: "curl -fsSL https://x.ai/cli/install.sh | bash".to_string(),
            npm_install_command: "npm install -g @xai-official/grok".to_string(),
            auth_path: String::new(),
            config_path: String::new(),
        })
}

#[tauri::command]
async fn start_grok_login(device_auth: bool, cwd: Option<String>) -> ToolRun {
    run_blocking_tool("grok login", move || {
        start_grok_login_blocking(device_auth, cwd)
    })
    .await
}

fn start_grok_login_blocking(device_auth: bool, cwd: Option<String>) -> ToolRun {
    let program = env::var("GROK_DESKTOP_GROK_CMD").unwrap_or_else(|_| "grok".to_string());
    let status = collect_grok_auth_status();
    let cwd = normalized_cwd(cwd);
    let login_args = if device_auth {
        "login --device-auth"
    } else {
        "login"
    };
    let program_for_shell = shell_quote(&program);
    let terminal_command = format!(
        "cd {cwd}; clear; echo {title}; echo; if ! command -v {program} >/dev/null 2>&1; then echo {missing}; echo {installer}; read -r -p {install_prompt}; eval {install_script}; export PATH=\"$HOME/.local/bin:$HOME/.grok/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"; hash -r; fi; echo; if command -v {program} >/dev/null 2>&1; then {program} {login_args}; else echo {still_missing}; fi; echo; echo {done}; read -n 1 -s -r -p {close_prompt}",
        cwd = shell_quote(&cwd.to_string_lossy()),
        title = shell_quote("Grok Desktop Grok setup"),
        program = program_for_shell,
        missing = shell_quote("Grok Build CLI was not found on PATH."),
        installer = shell_quote("Official installer: curl -fsSL https://x.ai/cli/install.sh | bash"),
        install_prompt = shell_quote(
            "Press Return to install the official Grok CLI, or Control-C to cancel: "
        ),
        install_script = shell_quote(&status.install_command),
        login_args = login_args,
        still_missing = shell_quote(
            "Grok still was not found. Restart Terminal or set GROK_DESKTOP_GROK_CMD to the Grok executable path."
        ),
        done = shell_quote("Return to Grok Desktop and click Refresh Grok Status."),
        close_prompt = shell_quote("Press any key to close this window."),
    );
    let script = format!(
        "tell application \"Terminal\"\nactivate\ndo script {}\nend tell",
        applescript_quote(&terminal_command)
    );

    run_external_command(
        "osascript",
        vec!["-e".to_string(), script],
        None,
        command_timeout_secs(15),
        false,
    )
}

/// Open an interactive Grok TUI, preferring iTerm, falling back to Terminal.app.
/// Optionally resumes a Desktop conversation head (`/cli` host slash).
///
/// Implementation writes a small shell script then launches a *short* shell
/// line (`bash /path/to/script`). Long one-liners inside AppleScript/`write
/// text` are unstable (quoting races, profile startup). A script path is not.
#[tauri::command]
async fn open_grok_cli(
    app: tauri::AppHandle,
    cwd: Option<String>,
    session_id: Option<String>,
) -> Result<(), String> {
    // Isolated ACP still holds the session thread. Drop it before the TUI
    // loads the same id on the shared leader, or Desktop turns stay private.
    if session_id
        .as_deref()
        .is_some_and(|id| !id.trim().is_empty())
    {
        if let Some(queue) = app.try_state::<std::sync::Arc<RunQueue>>() {
            queue.evict_acp_hosts().await;
        }
    }
    tauri::async_runtime::spawn_blocking(move || open_grok_cli_blocking(cwd, session_id))
        .await
        .map_err(|error| format!("open_grok_cli join failed: {error}"))?
}

fn open_grok_cli_blocking(cwd: Option<String>, session_id: Option<String>) -> Result<(), String> {
    // Same binary resolution as the run queue so interactive CLI finds grok
    // even when the user's login PATH is thin.
    let program = env::var("GROK_DESKTOP_GROK_CMD").unwrap_or_else(|_| default_grok_binary());
    // Empty Desktop cwd must not fall back to the app source tree for a
    // shipped .app — use $HOME like other shell helpers.
    let cwd = cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(default_shell_cwd);
    let session = session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());

    // `/desktop` lives on the CLI side, so Desktop must install the tiny
    // personal Grok skill before opening the TUI. Handling `/desktop` only in
    // the React composer made the command impossible to invoke from Grok CLI.
    ensure_desktop_handoff_skill()?;
    if let Some(session) = session.as_deref() {
        // One Desktop-owned TUI per shared session. This also prevents a
        // second `/cli` launch from orphaning the first process metadata.
        stop_desktop_grok_cli(&program, session)?;
    }
    ensure_desktop_leader(&program)?;
    let script_path = write_grok_cli_launch_script(&program, &cwd, session.as_deref())?;
    // Short, boring command — no nested quotes, no PATH soup in AppleScript.
    let launch_line = format!("exec bash {}", shell_quote(&script_path.to_string_lossy()));
    open_interactive_shell(&launch_line)
}

const DESKTOP_HANDOFF_SKILL_MARKER: &str = "<!-- grok-build-desktop-managed-skill -->";

fn desktop_handoff_skill_body() -> &'static str {
    r#"---
name: desktop
description: Switch this shared Grok session to Grok Build Desktop and keep live sync active.
user-invocable: true
disable-model-invocation: true
allowed-tools: Bash
---

<!-- grok-build-desktop-managed-skill -->

Switch this shared session back to Grok Build Desktop now.

Use Bash exactly once to run:

    bash "$HOME/.grok-desktop/open-desktop.sh"

Wait for the command result. Do not inspect or modify files and do not continue
with unrelated work. Report the helper's success or error verbatim in one short
sentence.
"#
}

fn desktop_handoff_script_body() -> &'static str {
    r#"#!/bin/bash
set -u

# Find the interactive Grok TUI that owns this tool call. The TUI command line
# contains the exact session id; using the process ancestry avoids confusing
# another unrelated Grok session running at the same time.
find_session_id() {
  local pid="${PPID:-}"
  local depth=0
  while [ -n "$pid" ] && [ "$depth" -lt 12 ]; do
    local command
    command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    case "$command" in
      *grok*--resume\ [0-9a-fA-F-][0-9a-fA-F-]*)
        printf '%s\n' "$command" | sed -nE 's/.*--resume[[:space:]]+([0-9a-fA-F-]{36}).*/\1/p'
        return 0
        ;;
    esac
    pid="$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ' || true)"
    depth=$((depth + 1))
  done

  # The CLI also maintains this small active-session index. Use it only when
  # it names exactly one live session, so a background TUI cannot be guessed.
  local active="$HOME/.grok/active_sessions.json"
  if [ -f "$active" ]; then
    local ids
    ids="$(sed -nE 's/.*"session_id"[[:space:]]*:[[:space:]]*"([0-9a-fA-F-]{36})".*/\1/p' "$active")"
    if [ "$(printf '%s\n' "$ids" | sed '/^$/d' | wc -l | tr -d ' ')" = "1" ]; then
      printf '%s\n' "$ids"
      return 0
    fi
  fi
  return 1
}

SESSION_ID="$(find_session_id || true)"
HANDOFF="$HOME/.grok-desktop/desktop-handoff.json"
if [ -n "$SESSION_ID" ]; then
  mkdir -p "$(dirname "$HANDOFF")"
  # Python supplies correct JSON escaping for arbitrary workspace paths and
  # replaces the request atomically so Desktop never reads a partial file.
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$HANDOFF" "$SESSION_ID" "$PWD" <<'PY'
import json
import os
import sys

path, session_id, cwd = sys.argv[1:]
temporary = f"{path}.tmp.{os.getpid()}"
with open(temporary, "w", encoding="utf-8") as handle:
    json.dump(
        {"sessionId": session_id, "cwd": cwd, "requestedAt": int(__import__("time").time() * 1000)},
        handle,
    )
    handle.write("\n")
os.replace(temporary, path)
PY
  else
    echo "Could not write the Desktop handoff: python3 is unavailable." >&2
    exit 1
  fi
else
  echo "Could not determine the current Grok session; opening Desktop without selecting a conversation." >&2
fi

for app in \
  "$HOME/Applications/Grok Build Desktop.app" \
  "$HOME/Desktop/Grok Build Desktop.app"
do
  if [ -d "$app" ] && open "$app" >/dev/null 2>&1; then
    if [ -n "$SESSION_ID" ]; then
      echo "Grok Build Desktop opened on session ${SESSION_ID:0:8}; live sync remains active."
    else
      echo "Grok Build Desktop focused without a selected session."
    fi
    exit 0
  fi
done
if open -b com.grok.desktop >/dev/null 2>&1; then
  if [ -n "$SESSION_ID" ]; then
    echo "Grok Build Desktop opened on session ${SESSION_ID:0:8}; live sync remains active."
  else
    echo "Grok Build Desktop focused without a selected session."
  fi
  exit 0
fi
if open -a "Grok Build Desktop" >/dev/null 2>&1; then
  if [ -n "$SESSION_ID" ]; then
    echo "Grok Build Desktop opened on session ${SESSION_ID:0:8}; live sync remains active."
  else
    echo "Grok Build Desktop focused without a selected session."
  fi
  exit 0
fi
if [ -d "/Applications/Grok Build Desktop.app" ] && \
   open "/Applications/Grok Build Desktop.app" >/dev/null 2>&1; then
  if [ -n "$SESSION_ID" ]; then
    echo "Grok Build Desktop opened on session ${SESSION_ID:0:8}; live sync remains active."
  else
    echo "Grok Build Desktop focused without a selected session."
  fi
  exit 0
fi

echo "Could not find Grok Build Desktop.app." >&2
exit 1
"#
}

/// Install the personal `/desktop` command that is consumed by Grok CLI.
///
/// A user-authored skill with the same name is never overwritten. Files with
/// our marker are safe to refresh when Desktop is upgraded.
fn ensure_desktop_handoff_skill() -> Result<(), String> {
    let home = env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    let helper_dir = PathBuf::from(&home).join(".grok-desktop");
    let skill_dir = PathBuf::from(&home)
        .join(".grok")
        .join("skills")
        .join("desktop");
    let skill_path = skill_dir.join("SKILL.md");
    let helper_path = helper_dir.join("open-desktop.sh");

    if let Ok(existing) = fs::read_to_string(&skill_path) {
        if !existing.contains(DESKTOP_HANDOFF_SKILL_MARKER) {
            return Err(format!(
                "Cannot install /desktop: {} already exists and is not managed by Grok Build Desktop",
                skill_path.display()
            ));
        }
    }

    fs::create_dir_all(&skill_dir)
        .map_err(|error| format!("mkdir {}: {error}", skill_dir.display()))?;
    fs::create_dir_all(&helper_dir)
        .map_err(|error| format!("mkdir {}: {error}", helper_dir.display()))?;
    fs::write(&skill_path, desktop_handoff_skill_body())
        .map_err(|error| format!("write {}: {error}", skill_path.display()))?;
    fs::write(&helper_path, desktop_handoff_script_body())
        .map_err(|error| format!("write {}: {error}", helper_path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&helper_path)
            .map_err(|error| format!("stat {}: {error}", helper_path.display()))?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&helper_path, perms)
            .map_err(|error| format!("chmod {}: {error}", helper_path.display()))?;
    }
    Ok(())
}

fn leader_socket_ready(path: &Path) -> bool {
    #[cfg(unix)]
    {
        std::os::unix::net::UnixStream::connect(path).is_ok()
    }
    #[cfg(not(unix))]
    {
        path.exists()
    }
}

/// Start (or reuse) the Desktop↔CLI grok leader. TUI and live ACP turns
/// connect here so both write one in-memory session.
fn ensure_desktop_leader(program: &str) -> Result<(), String> {
    let socket = crate::runs::core::desktop_leader_socket();
    if let Some(parent) = socket.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("mkdir {}: {error}", parent.display()))?;
    }
    if socket.exists() && !leader_socket_ready(&socket) {
        let _ = fs::remove_file(&socket);
    }
    if leader_socket_ready(&socket) {
        return Ok(());
    }

    let log_path = socket.with_file_name("leader.log");
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("open {}: {error}", log_path.display()))?;
    let log_err = log
        .try_clone()
        .map_err(|error| format!("clone leader.log: {error}"))?;
    let socket_arg = socket.to_string_lossy().into_owned();
    let mut command = Command::new(program);
    command
        .args([
            "agent",
            "leader",
            "--no-exit-on-disconnect",
            "--leader-socket",
            &socket_arg,
        ])
        .envs(crate::runs::process::default_proxy_env())
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    command
        .spawn()
        .map_err(|error| format!("start grok leader: {error}"))?;

    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if leader_socket_ready(&socket) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(80));
    }
    Err(format!(
        "grok leader did not come up at {}",
        socket.display()
    ))
}

/// Persist a launch script under ~/.grok-desktop/ so AppleScript only needs a path.
fn write_grok_cli_launch_script(
    program: &str,
    cwd: &Path,
    session_id: Option<&str>,
) -> Result<PathBuf, String> {
    let home = env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    let dir = PathBuf::from(&home).join(".grok-desktop");
    fs::create_dir_all(&dir).map_err(|error| format!("mkdir ~/.grok-desktop: {error}"))?;
    let script_path = dir.join("cli-launch.sh");
    let process_path = session_id.map(|session| grok_cli_process_path(&dir, session));

    let mut body = String::new();
    body.push_str("#!/bin/bash\n");
    body.push_str("# Generated by Grok Build Desktop `/cli` — do not edit.\n");
    body.push_str("set +e\n");
    body.push_str(
        "export PATH=\"$HOME/.local/bin:$HOME/.grok/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"\n",
    );
    body.push_str("hash -r 2>/dev/null || true\n");
    body.push_str(&format!(
        "cd {} || cd \"$HOME\" || true\n",
        shell_quote(&cwd.to_string_lossy())
    ));
    body.push_str("clear 2>/dev/null || true\n");
    body.push_str("echo 'Grok CLI (from Desktop · live session)'\n");
    body.push_str("echo\n");
    // Prefer the absolute binary Desktop already resolved; fall back to PATH.
    body.push_str(&format!("GROK_BIN={}\n", shell_quote(program)));
    body.push_str("if [ ! -x \"$GROK_BIN\" ]; then\n");
    body.push_str("  GROK_BIN=\"$(command -v grok 2>/dev/null || true)\"\n");
    body.push_str("fi\n");
    body.push_str("if [ -z \"$GROK_BIN\" ]; then\n");
    body.push_str(
        "  echo 'grok CLI not found. Install: curl -fsSL https://x.ai/cli/install.sh | bash'\n",
    );
    body.push_str("  echo 'Or set GROK_DESKTOP_GROK_CMD to the grok binary path.'\n");
    body.push_str("  read -n 1 -s -r -p 'Press any key to close…'\n");
    body.push_str("  exit 1\n");
    body.push_str("fi\n");
    let socket = crate::runs::core::desktop_leader_socket();
    let socket = socket.to_string_lossy();
    // Same leader socket Desktop ACP joins on `--share-session` turns.
    if let Some(session) = session_id {
        let process_path = process_path.expect("resume sessions have a process path");
        body.push_str(&format!(
            "PROCESS_META={}\n",
            shell_quote(&process_path.to_string_lossy())
        ));
        body.push_str("PROCESS_META_TMP=\"$PROCESS_META.tmp.$$\"\n");
        body.push_str("PROCESS_STARTED=\"$(ps -p \"$$\" -o lstart= 2>/dev/null)\"\n");
        body.push_str(&format!(
            "[ -n \"$PROCESS_STARTED\" ] && printf '%s\\n%s\\n%s\\n' \"$$\" {} \"$PROCESS_STARTED\" > \"$PROCESS_META_TMP\" && mv -f \"$PROCESS_META_TMP\" \"$PROCESS_META\" || {{ echo 'Could not record Desktop CLI process ownership.' >&2; exit 1; }}\n",
            shell_quote(session)
        ));
        body.push_str(&format!(
            "exec \"$GROK_BIN\" --leader --leader-socket {} --cwd {} --resume {}\n",
            shell_quote(&socket),
            shell_quote(&cwd.to_string_lossy()),
            shell_quote(session)
        ));
    } else {
        body.push_str(&format!(
            "exec \"$GROK_BIN\" --leader --leader-socket {} --cwd {}\n",
            shell_quote(&socket),
            shell_quote(&cwd.to_string_lossy())
        ));
    }

    fs::write(&script_path, body).map_err(|error| format!("write cli-launch.sh: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&script_path)
            .map_err(|error| format!("stat cli-launch.sh: {error}"))?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script_path, perms)
            .map_err(|error| format!("chmod cli-launch.sh: {error}"))?;
    }
    Ok(script_path)
}

#[derive(Debug, PartialEq, Eq)]
struct GrokCliProcessMetadata {
    pid: u32,
    session_id: String,
    started_at: String,
}

fn grok_cli_process_path(dir: &Path, session_id: &str) -> PathBuf {
    let encoded = session_id
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    dir.join(format!("cli-process-{encoded}.meta"))
}

fn parse_grok_cli_process_metadata(contents: &str) -> Option<GrokCliProcessMetadata> {
    let mut lines = contents.lines();
    let pid = lines.next()?.parse::<u32>().ok().filter(|pid| *pid > 1)?;
    let session_id = lines.next()?.to_string();
    let started_at = lines.next()?.trim().to_string();
    if session_id.is_empty() || started_at.is_empty() || lines.next().is_some() {
        return None;
    }
    Some(GrokCliProcessMetadata {
        pid,
        session_id,
        started_at,
    })
}

fn grok_cli_command_matches(command: &str, program: &str, socket: &Path, session_id: &str) -> bool {
    let args = command.split_whitespace().collect::<Vec<_>>();
    let expected_program = Path::new(program);
    let program_matches = args.first().is_some_and(|actual| {
        let actual = Path::new(actual);
        actual == expected_program
            || (expected_program.file_name().is_some()
                && actual.file_name() == expected_program.file_name())
    });
    let has_flag_value = |flag: &str, expected: &str| {
        args.windows(2)
            .any(|pair| pair[0] == flag && pair[1] == expected)
    };
    program_matches
        && args.contains(&"--leader")
        && has_flag_value("--leader-socket", &socket.to_string_lossy())
        && has_flag_value("--resume", session_id)
}

#[cfg(unix)]
fn process_command(pid: u32) -> Option<String> {
    let output = Command::new("ps")
        .args(["-ww", "-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(unix)]
fn process_started_at(pid: u32) -> Option<String> {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "lstart="])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(unix)]
fn process_is_alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .is_ok_and(|status| status.success())
}

/// Stop only a Grok TUI that Desktop itself launched for this exact session.
/// Stale or ambiguous metadata is removed without signalling its PID.
#[cfg(unix)]
fn stop_desktop_grok_cli(program: &str, session_id: &str) -> Result<(), String> {
    let home = env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    let metadata_path =
        grok_cli_process_path(&PathBuf::from(home).join(".grok-desktop"), session_id);
    let Ok(contents) = fs::read_to_string(&metadata_path) else {
        return Ok(());
    };
    let Some(metadata) = parse_grok_cli_process_metadata(&contents) else {
        let _ = fs::remove_file(&metadata_path);
        return Ok(());
    };
    if metadata.session_id != session_id {
        let _ = fs::remove_file(&metadata_path);
        return Ok(());
    }
    if process_started_at(metadata.pid).as_deref() != Some(metadata.started_at.as_str()) {
        let _ = fs::remove_file(&metadata_path);
        return Ok(());
    }
    let socket = crate::runs::core::desktop_leader_socket();
    let Some(command) = process_command(metadata.pid) else {
        let _ = fs::remove_file(&metadata_path);
        return Ok(());
    };
    if !grok_cli_command_matches(&command, program, &socket, session_id) {
        let _ = fs::remove_file(&metadata_path);
        return Ok(());
    }

    let status = Command::new("kill")
        .args(["-TERM", &metadata.pid.to_string()])
        .status()
        .map_err(|error| format!("stop Desktop Grok CLI {}: {error}", metadata.pid))?;
    if !status.success() && process_is_alive(metadata.pid) {
        return Err(format!(
            "could not stop Desktop Grok CLI process {}",
            metadata.pid
        ));
    }
    let deadline = Instant::now() + Duration::from_secs(4);
    while Instant::now() < deadline {
        if !process_is_alive(metadata.pid) {
            let _ = fs::remove_file(&metadata_path);
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }
    Err(format!(
        "Desktop Grok CLI process {} did not exit; undo was cancelled",
        metadata.pid
    ))
}

#[cfg(not(unix))]
fn stop_desktop_grok_cli(_program: &str, _session_id: &str) -> Result<(), String> {
    Ok(())
}

/// Launch a short shell line in iTerm (preferred) or Terminal.app.
///
/// Never embed long commands in AppleScript. Callers should pass something
/// like `exec bash '/Users/…/.grok-desktop/cli-launch.sh'`.
fn open_interactive_shell(command: &str) -> Result<(), String> {
    let quoted = applescript_quote(command);
    let mut errors: Vec<String> = Vec::new();

    // Keep the window returned by create window; current window can resolve to
    // an already-running CLI session when iTerm has multiple windows.
    // Never retry after an iTerm write failure: the command may already be
    // buffered there, and a retry creates exec ...exec ....
    let iterm_app = if Path::new("/Applications/iTerm-stable.app").is_dir() {
        Some("iTerm-stable")
    } else if Path::new("/Applications/iTerm2.app").is_dir() {
        Some("iTerm2")
    } else {
        None
    };
    if let Some(app) = iterm_app {
        let script = iterm_launch_script(app, &quoted);
        match Command::new("osascript").args(["-e", &script]).output() {
            Ok(output) if output.status.success() => return Ok(()),
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!(
                    "{app} could not open a new CLI window: {}",
                    stderr.trim()
                ));
            }
            Err(error) => return Err(format!("{app} could not open a new CLI window: {error}")),
        }
    }

    // Terminal.app is the fallback.
    let script = format!(
        "tell application \"Terminal\"\nactivate\ndo script {cmd}\nend tell",
        cmd = quoted,
    );
    match Command::new("osascript").args(["-e", &script]).output() {
        Ok(output) if output.status.success() => return Ok(()),
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            errors.push(format!("Terminal: {}", stderr.trim()));
        }
        Err(error) => errors.push(format!("Terminal: {error}")),
    }

    if let Ok(home) = env::var("HOME") {
        let command_file = PathBuf::from(home)
            .join(".grok-desktop")
            .join("cli-launch.command");
        let body = format!("#!/bin/bash\n{command}\n");
        if fs::write(&command_file, body).is_ok() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = fs::metadata(&command_file) {
                    let mut perms = meta.permissions();
                    perms.set_mode(0o755);
                    let _ = fs::set_permissions(&command_file, perms);
                }
            }
            if let Ok(status) = Command::new("open").arg(&command_file).status() {
                if status.success() {
                    return Ok(());
                }
            }
        }
    }

    Err(format!(
        "Could not open iTerm or Terminal.app. {}",
        errors.join(" | ")
    ))
}

fn iterm_launch_script(app: &str, quoted_command: &str) -> String {
    format!(
        "tell application \"{app}\"\n\
         activate\n\
         set newWindow to (create window with default profile)\n\
         delay 0.9\n\
         tell current session of newWindow\n\
         write text {cmd}\n\
         end tell\n\
         end tell",
        app = app,
        cmd = quoted_command,
    )
}

/// Focus / open Grok Build Desktop (`/desktop` host slash).
#[tauri::command]
async fn open_grok_desktop() -> Result<(), String> {
    let home = env::var("HOME").unwrap_or_default();
    // Prefer the current per-user install explicitly. Two bundles with the
    // same id can coexist; `open -b` may otherwise pick an older /Applications
    // copy and make a freshly installed fix appear ineffective.
    for path in [
        format!("{home}/Applications/Grok Build Desktop.app"),
        format!("{home}/Desktop/Grok Build Desktop.app"),
    ] {
        if Path::new(&path).is_dir() {
            if let Ok(status) = Command::new("open").arg(&path).status() {
                if status.success() {
                    return Ok(());
                }
            }
        }
    }
    for args in [
        vec!["-b", "com.grok.desktop"],
        // Some builds register under the product name via `open -a`.
        vec!["-a", "Grok Build Desktop"],
    ] {
        if let Ok(status) = Command::new("open").args(&args).status() {
            if status.success() {
                return Ok(());
            }
        }
    }
    let system_app = "/Applications/Grok Build Desktop.app";
    if Path::new(system_app).is_dir() {
        if let Ok(status) = Command::new("open").arg(system_app).status() {
            if status.success() {
                return Ok(());
            }
        }
    }
    Err("Could not open Grok Build Desktop (tried bundle id and Applications paths)".into())
}

static GROK_SESSION_UPDATES_PATHS: OnceLock<Mutex<HashMap<(PathBuf, String), PathBuf>>> =
    OnceLock::new();

fn find_grok_session_updates_path(
    root: &Path,
    session_id: &str,
    cached: Option<&Path>,
) -> Option<PathBuf> {
    if cached.is_some_and(Path::is_file) {
        return cached.map(Path::to_path_buf);
    }
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path().join(session_id).join("updates.jsonl");
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

fn find_grok_session_dir(session_id: &str) -> Option<PathBuf> {
    let root = grok_home_dir().join("sessions");
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let dir = entry.path().join(session_id);
        if dir.is_dir() {
            return Some(dir);
        }
    }
    None
}

fn json_content_text(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Array(values) => values
            .iter()
            .map(json_content_text)
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        serde_json::Value::Object(object) => object
            .get("text")
            .or_else(|| object.get("content"))
            .map(json_content_text)
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn user_query_text(value: &serde_json::Value) -> Option<String> {
    if value.get("type").and_then(serde_json::Value::as_str) != Some("user") {
        return None;
    }
    let raw = json_content_text(value.get("content")?);
    let start = raw.find("<user_query>")? + "<user_query>".len();
    let end = raw[start..].find("</user_query>")? + start;
    let query = raw[start..end].trim();
    (!query.is_empty()).then(|| query.to_string())
}

fn atomic_replace_text(path: &Path, text: &str) -> Result<(), String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("session.jsonl");
    let temporary = path.with_file_name(format!(
        ".{file_name}.undo-{}.tmp",
        uuid::Uuid::now_v7()
    ));
    if let Err(error) = fs::write(&temporary, text) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("write {} failed: {error}", temporary.display()));
    }
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("replace {} failed: {error}", path.display()));
    }
    Ok(())
}

fn truncate_jsonl_before_line(raw: &str, line_index: usize) -> String {
    let lines: Vec<&str> = raw.lines().collect();
    if line_index == 0 {
        return String::new();
    }
    let mut kept = lines[..line_index.min(lines.len())].join("\n");
    kept.push('\n');
    kept
}

fn truncate_rewind_points(raw: &str, target_prompt_index: u64) -> String {
    let mut kept = raw
        .lines()
        .filter(|line| {
            serde_json::from_str::<serde_json::Value>(line)
                .ok()
                .and_then(|value| value.get("prompt_index").and_then(serde_json::Value::as_u64))
                .is_none_or(|index| index < target_prompt_index)
        })
        .collect::<Vec<_>>()
        .join("\n");
    if !kept.is_empty() {
        kept.push('\n');
    }
    kept
}

/// Truncate Grok's local session files in place, preserving the session ID.
/// Returns false when the target is not the latest prompt or the file format
/// cannot be matched safely; callers must then use the ACP/rebase fallback.
fn truncate_local_grok_session(session_id: &str, undone_prompt: &str) -> Result<bool, String> {
    let Some(session_dir) = find_grok_session_dir(session_id) else {
        return Ok(false);
    };
    truncate_local_grok_session_dir(&session_dir, undone_prompt)
}

fn truncate_local_grok_session_dir(
    session_dir: &Path,
    undone_prompt: &str,
) -> Result<bool, String> {
    let chat_path = session_dir.join("chat_history.jsonl");
    if !chat_path.is_file() {
        return Ok(false);
    }
    let chat_raw = fs::read_to_string(&chat_path)
        .map_err(|error| format!("read {} failed: {error}", chat_path.display()))?;
    let mut target: Option<(usize, u64)> = None;
    let mut latest_prompt_index: Option<u64> = None;
    let mut fallback_index = 0u64;
    for (line_index, line) in chat_raw.lines().enumerate() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(query) = user_query_text(&value) else {
            continue;
        };
        let prompt_index = value
            .get("prompt_index")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(fallback_index);
        fallback_index = prompt_index + 1;
        latest_prompt_index = Some(prompt_index);
        if query == undone_prompt.trim() {
            target = Some((line_index, prompt_index));
        }
    }
    let Some((chat_cut, target_prompt_index)) = target else {
        return Ok(false);
    };
    if latest_prompt_index != Some(target_prompt_index) {
        // The selected prompt is no longer the session tail (for example a
        // hidden CLI turn arrived after it); never truncate that unseen work.
        return Ok(false);
    }

    let mut replacements = vec![(
        chat_path.clone(),
        truncate_jsonl_before_line(&chat_raw, chat_cut),
    )];
    let updates_path = session_dir.join("updates.jsonl");
    if updates_path.is_file() {
        let updates_raw = fs::read_to_string(&updates_path)
            .map_err(|error| format!("read {} failed: {error}", updates_path.display()))?;
        let update_cut = updates_raw
            .lines()
            .enumerate()
            .find_map(|(line_index, line)| {
                let value = serde_json::from_str::<serde_json::Value>(line).ok()?;
                let update = value.pointer("/params/update")?;
                if update
                    .get("sessionUpdate")
                    .and_then(serde_json::Value::as_str)
                    != Some("user_message_chunk")
                {
                    return None;
                }
                let index = update
                    .get("_meta")
                    .and_then(|meta| meta.get("promptIndex"))
                    .and_then(serde_json::Value::as_u64)?;
                (index >= target_prompt_index).then_some(line_index)
            });
        let Some(update_cut) = update_cut else {
            // Do not leave an authoritative updates log untouched while only
            // truncating chat_history; export could then resurrect the turn.
            return Ok(false);
        };
        replacements.push((
            updates_path,
            truncate_jsonl_before_line(&updates_raw, update_cut),
        ));
    }
    let rewind_points_path = session_dir.join("rewind_points.jsonl");
    if rewind_points_path.is_file() {
        let rewind_raw = fs::read_to_string(&rewind_points_path).map_err(|error| {
            format!("read {} failed: {error}", rewind_points_path.display())
        })?;
        replacements.push((
            rewind_points_path,
            truncate_rewind_points(&rewind_raw, target_prompt_index),
        ));
    }
    for (path, replacement) in replacements {
        atomic_replace_text(&path, &replacement)?;
    }
    Ok(true)
}

fn grok_session_updates_path(session_id: &str) -> Option<PathBuf> {
    let root = grok_home_dir().join("sessions");
    let key = (root.clone(), session_id.to_string());
    let cache = GROK_SESSION_UPDATES_PATHS.get_or_init(|| Mutex::new(HashMap::new()));
    let cached = cache.lock().ok().and_then(|paths| paths.get(&key).cloned());
    let resolved = find_grok_session_updates_path(&root, session_id, cached.as_deref());

    if let Ok(mut paths) = cache.lock() {
        if let Some(path) = resolved.as_ref() {
            paths.insert(key, path.clone());
        } else {
            paths.remove(&key);
        }
    }
    resolved
}

fn read_updates_jsonl(path: &Path) -> Option<String> {
    // The CLI appends this file while Desktop polls it. A snapshot can end in
    // the middle of a UTF-8 code point; lossy decoding only affects that
    // incomplete final record, which the JSONL parser already ignores. The
    // next poll rereads the complete file, also handling rewind/truncation.
    let bytes = fs::read(path).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn update_chunk_text(update: &serde_json::Value) -> String {
    update
        .pointer("/content/text")
        .or_else(|| update.get("text"))
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string()
}

fn apply_rewind_marker(turns: &mut Vec<(String, String)>, target: u64) {
    let mut user_index: Option<u64> = None;
    let mut keep = 0;
    for (index, (role, _)) in turns.iter().enumerate() {
        if role == "user" {
            user_index = Some(user_index.map(|value| value + 1).unwrap_or(0));
        }
        if user_index.is_some_and(|value| value > target) {
            break;
        }
        keep = index + 1;
    }
    turns.truncate(keep);
}

/// Rebuild chat markdown from grok's updates.jsonl (source of truth, including CLI turns).
fn turns_from_updates_jsonl(jsonl: &str) -> Vec<(String, String)> {
    let mut turns: Vec<(String, String)> = Vec::new();
    for line in jsonl.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(update) = value.pointer("/params/update") else {
            continue;
        };
        let kind = update
            .get("sessionUpdate")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        match kind {
            "rewind_marker" => {
                if let Some(target) = update
                    .get("target_prompt_index")
                    .and_then(|value| value.as_u64())
                {
                    apply_rewind_marker(&mut turns, target);
                }
            }
            "user_message_chunk" => {
                let text = update_chunk_text(update);
                if text.is_empty() {
                    continue;
                }
                if turns.last().is_some_and(|(role, _)| role == "user") {
                    turns.last_mut().unwrap().1.push_str(&text);
                } else {
                    turns.push(("user".into(), text));
                }
            }
            "agent_message_chunk" => {
                let text = update_chunk_text(update);
                if text.is_empty() {
                    continue;
                }
                if turns.last().is_some_and(|(role, _)| role == "assistant") {
                    let body = &mut turns.last_mut().unwrap().1;
                    if !body.ends_with('\n') {
                        body.push_str("\n\n");
                    }
                    body.push_str(&text);
                } else {
                    turns.push(("assistant".into(), text));
                }
            }
            _ => {}
        }
    }
    turns
}

fn transcript_from_session_updates(session_id: &str) -> Option<String> {
    let path = grok_session_updates_path(session_id)?;
    let jsonl = read_updates_jsonl(&path)?;
    let turns = turns_from_updates_jsonl(&jsonl);
    if turns.is_empty() {
        return None;
    }
    let markdown = turns
        .into_iter()
        .map(|(role, text)| {
            let heading = if role == "user" { "User" } else { "Assistant" };
            format!("## {heading}\n\n{text}")
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    Some(markdown)
}

/// Export a grok session transcript (markdown) for Desktop rehydration after CLI work.
#[tauri::command]
async fn export_grok_session(session_id: String) -> Result<String, String> {
    let session_id = session_id.trim().to_string();
    if session_id.is_empty() {
        return Err("session id required".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(markdown) = transcript_from_session_updates(&session_id) {
            if !markdown.trim().is_empty() {
                return Ok(markdown);
            }
        }
        let program = env::var("GROK_DESKTOP_GROK_CMD").unwrap_or_else(|_| default_grok_binary());
        let output = Command::new(&program)
            .args(["export", &session_id])
            .env("PATH", command_path())
            .output()
            .map_err(|error| format!("failed to run grok export: {error}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "grok export failed ({}): {}",
                output.status,
                stderr.trim()
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    })
    .await
    .map_err(|error| format!("export_grok_session join failed: {error}"))?
}

/// Rewind the active Grok context without clearing the whole session.
///
/// Prefer an in-place conversation-only rewind so all earlier turns and the
/// session identity survive. If the old ACP head cannot be loaded or rewound,
/// fall back to a new durable head seeded only with the turns still visible.
/// This makes the model-context boundary identical to the UI boundary without
/// turning every Undo into `/clear`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UndoSessionResult {
    rewound: bool,
    session_id: String,
    rebased: bool,
}

#[tauri::command]
async fn rewind_grok_session(
    app: tauri::AppHandle,
    session_id: String,
    cwd: Option<String>,
    undo_prompt: Option<String>,
    replay_context: Option<String>,
) -> Result<UndoSessionResult, String> {
    let session_id = session_id.trim().to_string();
    if session_id.is_empty() {
        return Err("session id required".into());
    }
    let program = env::var("GROK_DESKTOP_GROK_CMD").unwrap_or_else(|_| default_grok_binary());
    if let Some(queue) = app.try_state::<std::sync::Arc<RunQueue>>() {
        queue.evict_acp_hosts().await;
    }
    let stop_program = program.clone();
    let stop_session_id = session_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        stop_desktop_grok_cli(&stop_program, &stop_session_id)
    })
    .await
    .map_err(|error| format!("stop Desktop Grok CLI join failed: {error}"))??;
    let cwd = normalized_cwd(cwd);
    let undone = undo_prompt
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    // Desktop's TUI was stopped above, so rewind through an isolated ACP
    // client. This avoids trying to bind a second client to a shared leader
    // while still preserving the original session when the rewind succeeds.
    let rewind = crate::runs::core::rewind_last_user_turn_with_share(
        Path::new(&program),
        &cwd,
        &session_id,
        undone.as_deref(),
        false,
    )
    .await;
    if matches!(rewind, Ok(ref result) if result.rewound) {
        return Ok(UndoSessionResult {
            rewound: true,
            session_id,
            rebased: false,
        });
    }

    // Some Grok builds persist the usable conversation in local JSONL but do
    // not expose rewind execution through ACP. Truncate that same session's
    // chat history and rewind points before creating a new session. This keeps
    // the normal Undo path on one session and avoids session-directory growth.
    if let Some(prompt) = undone.as_deref() {
        match truncate_local_grok_session(&session_id, prompt) {
            Ok(true) => {
                return Ok(UndoSessionResult {
                    rewound: true,
                    session_id,
                    rebased: false,
                });
            }
            Ok(false) => {}
            Err(error) => eprintln!("[grok undo] local JSONL rewind failed: {error}"),
        }
    }

    // Grok may expose neither a usable JSONL checkpoint nor rewind execution,
    // or the old session may be gone. Only in that case create a replacement
    // seeded with the replay context supplied by the renderer.
    let rewind_error = rewind.err();
    let replacement = crate::runs::core::create_rebased_session(
        Path::new(&program),
        &cwd,
        replay_context.as_deref(),
    )
    .await
    .map_err(|rebase_error| match rewind_error {
        Some(rewind_error) => {
            format!("rewind failed ({rewind_error}); replacement session failed ({rebase_error})")
        }
        None => format!("replacement session failed ({rebase_error})"),
    })?;
    Ok(UndoSessionResult {
        rewound: false,
        session_id: replacement,
        rebased: true,
    })
}

fn collect_tool_statuses() -> Vec<ToolStatus> {
    let grok = env::var("GROK_DESKTOP_GROK_CMD").unwrap_or_else(|_| "grok".to_string());
    vec![version_status("grok", "Grok Build", &grok, &["--version"])]
}

/// Run a blocking ToolRun-producing body on the blocking pool. Commands
/// declared without `async` execute on the MAIN thread in Tauri 2, so a
/// long-running synchronous body (shell command, python script, dialog)
/// freezes the entire window for its duration. `command_label` names the
/// command in the error ToolRun if the blocking task itself fails to join.
async fn run_blocking_tool(
    command_label: &str,
    task: impl FnOnce() -> ToolRun + Send + 'static,
) -> ToolRun {
    match tauri::async_runtime::spawn_blocking(task).await {
        Ok(run) => run,
        Err(error) => ToolRun {
            ok: false,
            command: command_label.to_string(),
            cwd: String::new(),
            exit_code: None,
            duration_ms: 0,
            timed_out: false,
            output: String::new(),
            stderr: error.to_string(),
        },
    }
}

#[tauri::command]
async fn get_tool_statuses() -> Vec<ToolStatus> {
    tauri::async_runtime::spawn_blocking(collect_tool_statuses)
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn run_grok_task(prompt: String, mode: String, cwd: Option<String>) -> ToolRun {
    run_blocking_tool("grok", move || {
        let program = env::var("GROK_DESKTOP_GROK_CMD").unwrap_or_else(|_| "grok".to_string());
        let cwd = normalized_cwd(cwd);
        run_external_command(
            &program,
            grok_args(&prompt, &mode, &cwd, GrokRunOptions::default()),
            Some(cwd),
            command_timeout_secs(240),
            true,
        )
    })
    .await
}

/// Resolve and validate the working directory for `run_shell_command`.
/// Unlike `run_external_command`'s generic $HOME fallback, a shell command
/// must never silently execute somewhere other than the directory shown in
/// the UI — a stale or mistyped path is an error, not a redirect.
fn shell_cwd(cwd: Option<String>) -> Result<PathBuf, String> {
    // With no selected project, a user-facing terminal belongs in $HOME —
    // never in the source path baked into the packaged binary.
    let requested = cwd
        .and_then(|value| {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then(|| PathBuf::from(trimmed))
        })
        .unwrap_or_else(default_shell_cwd);
    let canonical = requested.canonicalize().map_err(|_| {
        format!(
            "Working directory {} does not exist. Pick a project folder first.",
            requested.display()
        )
    })?;
    if !canonical.is_dir() {
        return Err(format!(
            "Working directory {} is not a directory.",
            canonical.display()
        ));
    }
    Ok(canonical)
}

#[tauri::command]
async fn run_shell_command(command: String, cwd: Option<String>) -> ToolRun {
    run_blocking_tool("zsh -lc", move || {
        let trimmed = command.trim();
        if trimmed.is_empty() {
            return ToolRun {
                ok: false,
                command: "zsh -lc".to_string(),
                cwd: shell_cwd(cwd)
                    .unwrap_or_else(|_| default_shell_cwd())
                    .to_string_lossy()
                    .to_string(),
                exit_code: None,
                duration_ms: 0,
                timed_out: false,
                output: String::new(),
                stderr: "Enter a shell command first.".to_string(),
            };
        }

        let cwd = match shell_cwd(cwd) {
            Ok(cwd) => cwd,
            Err(message) => {
                return ToolRun {
                    ok: false,
                    command: command_line("zsh", &["-lc".to_string(), trimmed.to_string()]),
                    cwd: String::new(),
                    exit_code: None,
                    duration_ms: 0,
                    timed_out: false,
                    output: String::new(),
                    stderr: message,
                };
            }
        };
        run_external_command(
            "zsh",
            vec!["-lc".to_string(), trimmed.to_string()],
            Some(cwd),
            command_timeout_secs(600),
            false,
        )
    })
    .await
}

#[tauri::command]
fn start_terminal_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, TerminalState>,
    session_id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    use base64::Engine as _;
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use tauri::Emitter as _;

    let cwd = shell_cwd(cwd)?;
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Couldn't create terminal: {error}"))?;

    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut command = CommandBuilder::new(&shell);
    // Be explicit: ZLE, autosuggestions and syntax highlighting are
    // interactive-shell features. Force them on via a single combined arg
    // (some PTY layers are picky about separate short flags).
    command.arg("-il");
    command.cwd(&cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Couldn't start shell: {error}"))?;
    drop(pair.slave);
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("Couldn't read terminal: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("Couldn't write to terminal: {error}"))?;

    {
        let mut sessions = state
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if sessions.contains_key(&session_id) {
            return Err("Terminal session already exists.".to_string());
        }
        sessions.insert(
            session_id.clone(),
            TerminalProcess {
                master: pair.master,
                writer,
                child,
            },
        );
    }

    let app_for_output = app.clone();
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let payload = TerminalOutputPayload {
                        session_id: session_id.clone(),
                        data: base64::engine::general_purpose::STANDARD.encode(&buffer[..count]),
                    };
                    let _ = app_for_output.emit("grok-desktop://terminal-output", payload);
                }
            }
        }

        let terminal_state = app_for_output.state::<TerminalState>();
        let mut sessions = terminal_state
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        sessions.remove(&session_id);
        let _ = app_for_output.emit("grok-desktop://terminal-exit", session_id);
    });
    Ok(())
}

#[tauri::command]
fn write_terminal_session(
    state: tauri::State<'_, TerminalState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "Terminal session is no longer running.".to_string())?;
    session
        .writer
        .write_all(data.as_bytes())
        .and_then(|_| session.writer.flush())
        .map_err(|error| format!("Couldn't write to terminal: {error}"))
}

#[tauri::command]
fn resize_terminal_session(
    state: tauri::State<'_, TerminalState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Terminal session is no longer running.".to_string())?;
    session
        .master
        .resize(portable_pty::PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Couldn't resize terminal: {error}"))
}

#[tauri::command]
fn close_terminal_session(
    state: tauri::State<'_, TerminalState>,
    session_id: String,
) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(mut session) = sessions.remove(&session_id) {
        session
            .child
            .kill()
            .map_err(|error| format!("Couldn't close terminal: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
async fn inspect_grok_environment(cwd: Option<String>) -> ToolRun {
    let program = env::var("GROK_DESKTOP_GROK_CMD").unwrap_or_else(|_| "grok".to_string());
    let cwd = normalized_cwd(cwd);
    run_blocking_tool("grok inspect", move || {
        run_external_command(
            &program,
            vec!["inspect".to_string()],
            Some(cwd),
            command_timeout_secs(15),
            true,
        )
    })
    .await
}

#[tauri::command]
async fn list_grok_models() -> ToolRun {
    let program = env::var("GROK_DESKTOP_GROK_CMD").unwrap_or_else(|_| default_grok_binary());
    run_blocking_tool("grok models", move || {
        run_external_command(
            &program,
            vec!["models".to_string()],
            None,
            command_timeout_secs(20),
            true,
        )
    })
    .await
}

#[tauri::command]
async fn list_grok_mcp(cwd: Option<String>, json: Option<bool>) -> ToolRun {
    let program = env::var("GROK_DESKTOP_GROK_CMD").unwrap_or_else(|_| "grok".to_string());
    let cwd = normalized_cwd(cwd);
    let mut args = vec!["mcp".to_string(), "list".to_string()];
    if json.unwrap_or(false) {
        args.push("--json".to_string());
    }
    run_blocking_tool("grok mcp list", move || {
        run_external_command(&program, args, Some(cwd), command_timeout_secs(10), true)
    })
    .await
}

#[tauri::command]
async fn doctor_grok_mcp(cwd: Option<String>) -> ToolRun {
    let program = env::var("GROK_DESKTOP_GROK_CMD").unwrap_or_else(|_| "grok".to_string());
    let cwd = normalized_cwd(cwd);
    run_blocking_tool("grok mcp doctor", move || {
        run_external_command(
            &program,
            vec!["mcp".to_string(), "doctor".to_string()],
            Some(cwd),
            command_timeout_secs(30),
            true,
        )
    })
    .await
}

/// Add (or update) an MCP server using Grok 1.0's native positional syntax.
#[tauri::command]
async fn grok_mcp_add(
    name: String,
    command: Option<String>,
    args: Option<Vec<String>>,
    env_pairs: Option<Vec<String>>,
    url: Option<String>,
    transport_type: Option<String>,
    scope: Option<String>,
    cwd: Option<String>,
) -> ToolRun {
    let program = env::var("GROK_DESKTOP_GROK_CMD").unwrap_or_else(|_| "grok".to_string());
    let scope = scope.filter(|scope| matches!(scope.as_str(), "user" | "project"));
    let cwd = normalized_cwd(cwd);
    let mut argv: Vec<String> = vec!["mcp".into(), "add".into()];
    if let Some(scope) = scope {
        argv.extend(["--scope".into(), scope]);
    }
    let transport = transport_type
        .filter(|kind| matches!(kind.as_str(), "stdio" | "http" | "sse"))
        .unwrap_or_else(|| {
            if url.is_some() {
                "http".into()
            } else {
                "stdio".into()
            }
        });
    if transport != "stdio" {
        argv.extend(["--transport".into(), transport]);
    }
    if let Some(envs) = env_pairs {
        for e in envs.into_iter().filter(|e| !e.trim().is_empty()) {
            argv.extend(["--env".into(), e]);
        }
    }
    argv.push(name);
    if let Some(u) = url.filter(|u| !u.trim().is_empty()) {
        argv.push(u);
    } else if let Some(cmd) = command.filter(|value| !value.trim().is_empty()) {
        argv.push("--".into());
        argv.push(cmd);
        let home = env::var("HOME").unwrap_or_default();
        for arg in args.unwrap_or_default() {
            argv.push(if home.is_empty() {
                arg
            } else {
                arg.replace("$HOME", &home)
            });
        }
    }
    run_blocking_tool("grok mcp add", move || {
        run_external_command(&program, argv, Some(cwd), command_timeout_secs(30), true)
    })
    .await
}

/// Remove a configured MCP server: `grok mcp remove <name>`.
#[tauri::command]
async fn grok_mcp_remove(name: String, scope: Option<String>, cwd: Option<String>) -> ToolRun {
    let program = env::var("GROK_DESKTOP_GROK_CMD").unwrap_or_else(|_| "grok".to_string());
    let cwd = normalized_cwd(cwd);
    let mut args = vec!["mcp".to_string(), "remove".to_string()];
    if let Some(scope) = scope.filter(|scope| matches!(scope.as_str(), "user" | "project")) {
        args.extend(["--scope".to_string(), scope]);
    }
    args.push(name);
    run_blocking_tool("grok mcp remove", move || {
        run_external_command(&program, args, Some(cwd), command_timeout_secs(15), true)
    })
    .await
}

#[tauri::command]
async fn list_grok_plugins(cwd: Option<String>) -> ToolRun {
    let program = env::var("GROK_DESKTOP_GROK_CMD").unwrap_or_else(|_| "grok".to_string());
    let cwd = normalized_cwd(cwd);
    run_blocking_tool("grok plugin list", move || {
        run_external_command(
            &program,
            vec!["plugin".to_string(), "list".to_string()],
            Some(cwd),
            command_timeout_secs(10),
            true,
        )
    })
    .await
}

#[tauri::command]
async fn list_customize_plugins(cwd: Option<String>) -> ToolRun {
    let program = env::var("GROK_DESKTOP_GROK_CMD").unwrap_or_else(|_| "grok".to_string());
    let cwd = normalized_cwd(cwd);
    run_blocking_tool("grok plugin list --json", move || {
        run_external_command(
            &program,
            vec![
                "plugin".to_string(),
                "list".to_string(),
                "--json".to_string(),
            ],
            Some(cwd),
            command_timeout_secs(20),
            true,
        )
    })
    .await
}

#[tauri::command]
async fn grok_plugin_action(action: String, value: Option<String>, cwd: Option<String>) -> ToolRun {
    let program = env::var("GROK_DESKTOP_GROK_CMD").unwrap_or_else(|_| "grok".to_string());
    let cwd = normalized_cwd(cwd);
    let value = value.unwrap_or_default().trim().to_string();
    let args = match action.as_str() {
        "install" if !value.is_empty() => vec![
            "plugin".to_string(),
            "install".to_string(),
            "--trust".to_string(),
            value,
        ],
        "uninstall" if !value.is_empty() => vec![
            "plugin".to_string(),
            "uninstall".to_string(),
            "--confirm".to_string(),
            value,
        ],
        "enable" | "disable" | "details" if !value.is_empty() => {
            vec!["plugin".to_string(), action.clone(), value]
        }
        "update" => {
            let mut args = vec!["plugin".to_string(), "update".to_string()];
            if !value.is_empty() {
                args.push(value);
            }
            args
        }
        _ => {
            return ToolRun {
                ok: false,
                command: "grok plugin".to_string(),
                cwd: cwd.to_string_lossy().to_string(),
                exit_code: None,
                duration_ms: 0,
                timed_out: false,
                output: String::new(),
                stderr: "Unsupported plugin action or missing plugin/source name".to_string(),
            }
        }
    };
    let label = format!("grok {}", args.join(" "));
    run_blocking_tool(&label, move || {
        run_external_command(&program, args, Some(cwd), command_timeout_secs(120), true)
    })
    .await
}

#[tauri::command]
async fn grok_mcp_set_enabled(name: String, enabled: bool, cwd: Option<String>) -> ToolRun {
    let program = env::var("GROK_DESKTOP_GROK_CMD").unwrap_or_else(|_| "grok".to_string());
    let cwd = normalized_cwd(cwd);
    let action = if enabled { "enable" } else { "disable" };
    run_blocking_tool(&format!("grok mcp {action}"), move || {
        run_external_command(
            &program,
            vec!["mcp".to_string(), action.to_string(), name],
            Some(cwd),
            command_timeout_secs(20),
            true,
        )
    })
    .await
}

#[tauri::command]
async fn list_grok_sessions(cwd: Option<String>) -> ToolRun {
    let program = env::var("GROK_DESKTOP_GROK_CMD").unwrap_or_else(|_| "grok".to_string());
    let cwd = normalized_cwd(cwd);
    run_blocking_tool("grok sessions list", move || {
        run_external_command(
            &program,
            vec!["sessions".to_string(), "list".to_string()],
            Some(cwd),
            command_timeout_secs(10),
            true,
        )
    })
    .await
}

#[tauri::command]
async fn run_browser_task(task: String, max_steps: u16) -> ToolRun {
    run_blocking_tool("browser", move || {
        let python = env::var("GROK_DESKTOP_PYTHON").unwrap_or_else(|_| "python3".to_string());
        let script = script_path("browser_automation.py");
        run_external_command(
            &python,
            vec![
                script.to_string_lossy().to_string(),
                "--task".to_string(),
                task,
                "--max-steps".to_string(),
                max_steps.to_string(),
            ],
            None,
            command_timeout_secs(360),
            false,
        )
    })
    .await
}

#[tauri::command]
async fn run_absorb_repo(repo_path: String, copy_text: bool) -> ToolRun {
    run_blocking_tool("absorb", move || {
        let python = env::var("GROK_DESKTOP_PYTHON").unwrap_or_else(|_| "python3".to_string());
        let script = script_path("absorb_repo.py");
        let mut args = vec![
            script.to_string_lossy().to_string(),
            repo_path,
            "--output".to_string(),
            absorbed_output_root().to_string_lossy().to_string(),
        ];

        if copy_text {
            args.push("--copy-text".to_string());
        }

        run_external_command(&python, args, None, command_timeout_secs(360), false)
    })
    .await
}

#[tauri::command]
async fn run_doctor() -> ToolRun {
    run_blocking_tool("doctor", move || {
        let python = env::var("GROK_DESKTOP_PYTHON").unwrap_or_else(|_| "python3".to_string());
        let script = script_path("doctor.py");
        run_external_command(
            &python,
            vec![script.to_string_lossy().to_string()],
            None,
            command_timeout_secs(60),
            false,
        )
    })
    .await
}

#[tauri::command]
async fn pick_project_folder(initial: Option<String>) -> Result<Option<String>, String> {
    // The AppleScript dialog blocks until dismissed — keep it off the main
    // thread or the whole window beachballs behind the picker.
    tauri::async_runtime::spawn_blocking(move || pick_project_folder_blocking(initial))
        .await
        .map_err(|error| error.to_string())?
}

/// Opens one macOS picker that accepts both ordinary files and directories.
/// The Composer classifies the returned paths so files become multimodal
/// attachments while a directory remains explicit workspace context.
#[tauri::command]
async fn pick_attachments(
    app: tauri::AppHandle,
    _initial: Option<String>,
) -> Result<Vec<String>, String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = sender.send(pick_attachments_native());
    })
    .map_err(|error| format!("Could not open attachment picker: {error}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv()
            .map_err(|error| format!("Attachment picker did not return: {error}"))?
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(target_os = "macos")]
fn pick_attachments_native() -> Result<Vec<String>, String> {
    let marker = MainThreadMarker::new().ok_or("Attachment picker must run on the main thread.")?;
    let panel = NSOpenPanel::openPanel(marker);
    panel.setCanChooseFiles(true);
    panel.setCanChooseDirectories(true);
    panel.setAllowsMultipleSelection(true);
    if panel.runModal() != NSModalResponseOK {
        return Ok(Vec::new());
    }
    let urls = panel.URLs();
    let mut paths = Vec::with_capacity(urls.count());
    for index in 0..urls.count() {
        if let Some(path) = urls.objectAtIndex(index).path() {
            paths.push(path.to_string());
        }
    }
    Ok(paths)
}

#[cfg(not(target_os = "macos"))]
fn pick_attachments_native() -> Result<Vec<String>, String> {
    Err("The attachment picker is available only on macOS.".to_string())
}

fn pick_project_folder_blocking(initial: Option<String>) -> Result<Option<String>, String> {
    let starting_dir = initial
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .and_then(|value| {
            let candidate = PathBuf::from(&value);
            if candidate.is_dir() {
                Some(value)
            } else {
                None
            }
        });

    let default_clause = match starting_dir {
        Some(path) => format!(
            " default location (POSIX file {})",
            applescript_quote(&path)
        ),
        None => String::new(),
    };

    let script = format!(
        "try\n  set chosen to POSIX path of (choose folder with prompt \"Select project folder for Grok Desktop\"{default_clause})\n  return chosen\non error number -128\n  return \"\"\nend try"
    );

    let output = Command::new("osascript")
        .args(["-e", &script])
        .env("PATH", command_path())
        .output()
        .map_err(|error| format!("Could not launch folder picker: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            return Ok(None);
        }
        return Err(format!("Folder picker failed: {stderr}"));
    }

    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if raw.is_empty() {
        return Ok(None);
    }

    let cleaned = raw.trim_end_matches('/').to_string();
    Ok(Some(cleaned))
}

// ── New queue commands ──────────────────────────────────────────────────────

#[tauri::command]
async fn enqueue_run(
    queue: tauri::State<'_, std::sync::Arc<RunQueue>>,
    prompt: String,
    cwd: String,
    args: Vec<String>,
    parent_run_id: Option<String>,
    // UI session / tab id. Independent lanes run concurrently; same lane
    // stays serial. Omit only for legacy callers (shared default lane).
    lane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let (run_id, position) = queue
        .enqueue(prompt, cwd, args, parent_run_id, lane_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "runId": run_id, "position": position }))
}

#[tauri::command]
async fn prewarm_run(
    queue: tauri::State<'_, std::sync::Arc<RunQueue>>,
    cwd: String,
    args: Vec<String>,
    lane_id: String,
) -> Result<bool, String> {
    queue.prewarm(lane_id, cwd, args).await
}

#[tauri::command]
async fn cancel_run(
    queue: tauri::State<'_, std::sync::Arc<RunQueue>>,
    run_id: String,
) -> Result<bool, String> {
    queue.cancel(&run_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_queue(
    queue: tauri::State<'_, std::sync::Arc<RunQueue>>,
) -> Result<serde_json::Value, String> {
    let (active_ids, waiting) = queue.snapshot().await;
    Ok(serde_json::json!({
        // Backward-compat single-active field: first concurrent active, if any.
        "active": active_ids.first().cloned(),
        "activeIds": active_ids,
        "queue": waiting.iter().map(|r| serde_json::json!({
            "id": r.id, "prompt": r.prompt, "cwd": r.cwd,
            "state": r.state, "enqueuedAt": r.enqueued_at,
            "laneId": r.lane_id,
        })).collect::<Vec<_>>(),
    }))
}

#[tauri::command]
async fn clear_queue(queue: tauri::State<'_, std::sync::Arc<RunQueue>>) -> Result<u64, String> {
    queue.clear_waiting().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn resume_pending_runs(
    queue: tauri::State<'_, std::sync::Arc<RunQueue>>,
) -> Result<u64, String> {
    let count = queue.pending_count().await;
    queue.notify_worker();
    Ok(count as u64)
}

#[tauri::command]
async fn cancel_pending_runs(
    queue: tauri::State<'_, std::sync::Arc<RunQueue>>,
) -> Result<u64, String> {
    queue.cancel_all_pending().await.map_err(|e| e.to_string())
}

// ── Prompt library (D) ──────────────────────────────────────────────────────

#[tauri::command]
async fn list_prompts(
    store: tauri::State<'_, crate::prompts::PromptStore>,
) -> Result<Vec<crate::prompts::Prompt>, String> {
    store.list().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn upsert_prompt(
    store: tauri::State<'_, crate::prompts::PromptStore>,
    name: String,
    body: String,
    category: Option<String>,
    id: Option<String>,
) -> Result<crate::prompts::Prompt, String> {
    let now = chrono::Utc::now().timestamp_millis();
    let (resolved_id, created_at) = match id {
        Some(existing) if !existing.trim().is_empty() => {
            let prior = store
                .list()
                .await
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|p| p.id == existing);
            let created_at = prior.map(|p| p.created_at).unwrap_or(now);
            (existing, created_at)
        }
        _ => (uuid::Uuid::now_v7().to_string(), now),
    };
    let prompt = crate::prompts::Prompt {
        id: resolved_id,
        name: name.trim().to_string(),
        category: category.and_then(|c| {
            let trimmed = c.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        }),
        body,
        created_at,
        updated_at: now,
    };
    store.upsert(&prompt).await.map_err(|e| e.to_string())?;
    Ok(prompt)
}

#[tauri::command]
async fn delete_prompt(
    store: tauri::State<'_, crate::prompts::PromptStore>,
    id: String,
) -> Result<bool, String> {
    store.delete(&id).await.map_err(|e| e.to_string())
}

// ── @file references (B sub-project MVP) ────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub path: String,         // path relative to cwd
    pub display_name: String, // basename for the picker UI
    pub size_bytes: u64,
}

/// `.gitignore`-aware fuzzy file search rooted at `cwd`. Used by the @file
/// picker in the Composer. The query is matched against the relative path —
/// case-insensitive contiguous substring, then ranked by:
///   1. exact basename match
///   2. basename contains
///   3. path contains
/// Hard caps: scan ≤ 25_000 entries (skips the rest), return ≤ `limit`.
#[tauri::command]
async fn glob_files(cwd: String, query: String, limit: usize) -> Result<Vec<FileEntry>, String> {
    // Walks up to 25k directory entries — off the main thread.
    tauri::async_runtime::spawn_blocking(move || glob_files_blocking(cwd, query, limit))
        .await
        .map_err(|error| error.to_string())?
}

fn glob_files_blocking(cwd: String, query: String, limit: usize) -> Result<Vec<FileEntry>, String> {
    use ignore::WalkBuilder;
    let root = std::path::PathBuf::from(&cwd);
    if !root.is_dir() {
        return Err(format!("cwd is not a directory: {cwd}"));
    }
    let needle = query.trim().to_lowercase();
    let limit = limit.clamp(1, 200);

    let mut hits: Vec<(u32, FileEntry)> = Vec::new(); // (rank, entry) — lower rank = better
    let mut scanned = 0usize;
    let walker = WalkBuilder::new(&root)
        .hidden(true)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(true)
        .max_depth(Some(12))
        .build();
    for dent in walker {
        scanned += 1;
        if scanned > 25_000 {
            break;
        }
        let Ok(entry) = dent else { continue };
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let abs = entry.path();
        let Ok(rel) = abs.strip_prefix(&root) else {
            continue;
        };
        let rel_str = rel.to_string_lossy().to_string();
        let base = abs
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if base.starts_with('.') {
            continue;
        }
        let lower_rel = rel_str.to_lowercase();
        let lower_base = base.to_lowercase();
        let rank: u32 = if needle.is_empty() {
            5_000
        } else if lower_base == needle {
            0
        } else if lower_base.starts_with(&needle) {
            10
        } else if lower_base.contains(&needle) {
            100
        } else if lower_rel.contains(&needle) {
            500
        } else {
            continue;
        };
        let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
        hits.push((
            rank,
            FileEntry {
                path: rel_str,
                display_name: base,
                size_bytes,
            },
        ));
    }
    hits.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.path.cmp(&b.1.path)));
    Ok(hits.into_iter().take(limit).map(|(_, e)| e).collect())
}

/// Read a file as UTF-8 text, with a hard size cap so a 100MB file doesn't
/// blow up the IPC channel. Returns `None` if the file is binary or oversized.
#[tauri::command]
async fn read_file_safe(
    cwd: String,
    path: String,
    max_bytes: usize,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || read_file_safe_blocking(cwd, path, max_bytes))
        .await
        .map_err(|error| error.to_string())?
}

fn read_file_safe_blocking(
    cwd: String,
    path: String,
    max_bytes: usize,
) -> Result<Option<String>, String> {
    let root = std::path::PathBuf::from(&cwd);
    let candidate = root.join(&path);
    // Path traversal guard: canonicalize and verify it's still under root.
    let canon = candidate
        .canonicalize()
        .map_err(|e| format!("canonicalize failed: {e}"))?;
    let root_canon = root
        .canonicalize()
        .map_err(|e| format!("cwd canonicalize failed: {e}"))?;
    if !canon.starts_with(&root_canon) {
        return Err(format!("path escapes cwd: {path}"));
    }
    let cap = max_bytes.clamp(1, 1_000_000); // 1MB hard ceiling
    let metadata = std::fs::metadata(&canon).map_err(|e| format!("stat failed: {e}"))?;
    if metadata.len() as usize > cap {
        return Ok(None);
    }
    let bytes = std::fs::read(&canon).map_err(|e| format!("read failed: {e}"))?;
    // Heuristic binary detection: any NUL byte in the first 8KB.
    if bytes.iter().take(8192).any(|&b| b == 0) {
        return Ok(None);
    }
    match String::from_utf8(bytes) {
        Ok(s) => Ok(Some(s)),
        Err(_) => Ok(None),
    }
}

#[derive(serde::Serialize)]
struct AttachmentPayload {
    name: String,
    mime_type: String,
    size_bytes: usize,
    data_url: String,
}

/// Read a file explicitly chosen or dropped by the user for a multimodal
/// prompt. Unlike @mentions, this accepts an absolute path because Finder's
/// native drop event supplies one; the hard cap prevents oversized IPC/queue
/// payloads and directories/special files are rejected.
#[tauri::command]
async fn read_attachment(path: String, max_bytes: usize) -> Result<AttachmentPayload, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine as _;

        let candidate = std::path::PathBuf::from(&path);
        let canonical = candidate
            .canonicalize()
            .map_err(|error| format!("attachment path is not readable: {error}"))?;
        let metadata = std::fs::metadata(&canonical)
            .map_err(|error| format!("attachment metadata failed: {error}"))?;
        if !metadata.is_file() {
            return Err("Only files can be attached.".to_string());
        }
        let cap = max_bytes.clamp(1, 10 * 1024 * 1024);
        if metadata.len() as usize > cap {
            return Err("Attachment is larger than 10 MB.".to_string());
        }
        let bytes = std::fs::read(&canonical)
            .map_err(|error| format!("attachment read failed: {error}"))?;
        let name = canonical
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("attachment")
            .to_string();
        let mime_type = preview_content_type(&name)
            .split(';')
            .next()
            .unwrap_or("application/octet-stream")
            .to_string();
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Ok(AttachmentPayload {
            name,
            mime_type: mime_type.clone(),
            size_bytes: bytes.len(),
            data_url: format!("data:{mime_type};base64,{encoded}"),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Tell the renderer whether a native drag-and-drop path is a directory.
/// Finder sends paths for both files and folders; folders are kept as local
/// path context instead of being read into a file attachment payload.
#[tauri::command]
async fn path_is_directory(path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let candidate = std::path::PathBuf::from(&path);
        let canonical = candidate
            .canonicalize()
            .map_err(|error| format!("drop path is not readable: {error}"))?;
        let metadata = std::fs::metadata(&canonical)
            .map_err(|error| format!("drop path metadata failed: {error}"))?;
        Ok(metadata.is_dir())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Persist the exact bytes of a sent attachment in the active tab's session
/// assets directory. The chat transcript stores only the safe asset id and
/// display metadata, matching the Codex session shape without putting image
/// data URLs into localStorage or session_state.json.
#[tauri::command]
async fn save_attachment(
    session_id: String,
    asset_id: String,
    data_url: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine as _;

        let path = attachment_asset_path(&session_id, &asset_id)?;
        let (header, encoded) = data_url
            .split_once(',')
            .ok_or_else(|| "Attachment data is not a data URL.".to_string())?;
        if !header.ends_with(";base64") || encoded.is_empty() {
            return Err("Attachment data is not base64 encoded.".to_string());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|error| format!("Attachment data is invalid: {error}"))?;
        if bytes.len() > 10 * 1024 * 1024 {
            return Err("Attachment is larger than 10 MB.".to_string());
        }
        let parent = path
            .parent()
            .ok_or_else(|| "Attachment asset directory is invalid.".to_string())?;
        fs::create_dir_all(parent).map_err(|error| format!("Could not create assets directory: {error}"))?;
        let temporary = path.with_extension("tmp");
        fs::write(&temporary, bytes).map_err(|error| format!("Could not save attachment: {error}"))?;
        fs::rename(&temporary, &path).map_err(|error| format!("Could not finalize attachment: {error}"))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Rehydrate one attachment into a preview-friendly data URL after restart.
#[tauri::command]
async fn load_attachment(
    session_id: String,
    asset_id: String,
    mime_type: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine as _;

        let path = attachment_asset_path(&session_id, &asset_id)?;
        let metadata = fs::metadata(&path).map_err(|error| format!("Could not find attachment: {error}"))?;
        if !metadata.is_file() || metadata.len() > 10 * 1024 * 1024 {
            return Err("Attachment is not a readable file.".to_string());
        }
        let bytes = fs::read(&path).map_err(|error| format!("Could not read attachment: {error}"))?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        Ok(format!("data:{mime_type};base64,{encoded}"))
    })
    .await
    .map_err(|error| error.to_string())?
}

// ── Event forwarder ─────────────────────────────────────────────────────────

fn forward_queue_message(app: &tauri::AppHandle, msg: &QueueMessage) {
    use tauri::Emitter as _;
    match &msg.kind {
        QueueMessageKind::Event {
            event,
            raw,
            session_id,
        } => {
            let _ = app.emit(
                "grok-desktop://run-event",
                serde_json::json!({
                    "runId": msg.run_id,
                    "event": event,
                    "raw": raw,
                    "sessionId": session_id,
                }),
            );
        }
        QueueMessageKind::StateChanged {
            state,
            started_at,
            ended_at,
            error,
        } => {
            let _ = app.emit(
                "grok-desktop://run-state-changed",
                serde_json::json!({
                    "runId": msg.run_id,
                    "state": state,
                    "startedAt": started_at,
                    "endedAt": ended_at,
                    "error": error,
                }),
            );
            // JS in a covered WKWebView can be throttled; show the banner from
            // Rust so a backgrounded app still alerts when a turn finishes.
            if matches!(state, RunState::Done | RunState::Failed) {
                let app = app.clone();
                let run_id = msg.run_id.clone();
                tauri::async_runtime::spawn(async move {
                    maybe_alert_background_completion(app, run_id).await;
                });
            }
        }
        QueueMessageKind::QueueChanged => {
            let q = app.state::<std::sync::Arc<RunQueue>>().inner().clone();
            let app_cloned = app.clone();
            tauri::async_runtime::spawn(async move {
                let (active_ids, waiting) = q.snapshot().await;
                let _ = app_cloned.emit(
                    "grok-desktop://queue-changed",
                    serde_json::json!({
                        "active": active_ids.first().cloned(),
                        "activeIds": active_ids,
                        "queue": waiting.iter().map(|r| serde_json::json!({
                            "id": r.id, "prompt": r.prompt, "cwd": r.cwd,
                            "state": r.state, "enqueuedAt": r.enqueued_at,
                            "laneId": r.lane_id,
                        })).collect::<Vec<_>>(),
                    }),
                );
            });
        }
    }
}

/// Native Notification Center banner — the same mechanism Claude Code and
/// Codex use (`osascript` / `NSUserNotification`). Those banners are drawn by
/// the system, so they appear over other apps' maximized windows. A custom
/// NSWindow overlay cannot do that without becoming an NSPanel, and swapping
/// Tao's window class crashes the event loop.
#[cfg(target_os = "macos")]
fn post_system_completion_notification() {
    if post_ns_user_notification() {
        return;
    }
    if std::process::Command::new("terminal-notifier")
        .args([
            "-title",
            "Grok Build Desktop",
            "-message",
            "A response has finished.",
            "-activate",
            "com.grok.desktop",
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .is_ok()
    {
        return;
    }
    let _ = std::process::Command::new("osascript")
        .args([
            "-e",
            "display notification \"A response has finished.\" with title \"Grok Build Desktop\"",
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

#[cfg(target_os = "macos")]
fn post_ns_user_notification() -> bool {
    let Some(notif_cls) = AnyClass::get(c"NSUserNotification") else {
        return false;
    };
    let Some(center_cls) = AnyClass::get(c"NSUserNotificationCenter") else {
        return false;
    };
    let title = NSString::from_str("Grok Build Desktop");
    let body = NSString::from_str("A response has finished.");
    unsafe {
        let notification: Retained<AnyObject> = msg_send![notif_cls, new];
        let _: () = msg_send![&*notification, setTitle: &*title];
        let _: () = msg_send![&*notification, setInformativeText: &*body];
        let center: Retained<AnyObject> = msg_send![center_cls, defaultUserNotificationCenter];
        let _: () = msg_send![&*center, deliverNotification: &*notification];
    }
    true
}

#[cfg(not(target_os = "macos"))]
fn post_system_completion_notification() {}

async fn maybe_alert_background_completion(app: tauri::AppHandle, run_id: String) {
    if let Some(main) = app.get_webview_window("main") {
        if main.is_focused().unwrap_or(false) {
            return;
        }
    }
    let tab_id = {
        let queue = app.state::<std::sync::Arc<RunQueue>>();
        match queue.db.fetch_run(&run_id).await {
            Ok(Some(rec)) if !rec.lane_id.is_empty() => rec.lane_id,
            _ => run_id,
        }
    };
    let state = app.state::<CompletionPopupState>();
    let _ = present_completion_popup(&app, &state, tab_id);
}

fn present_completion_popup(
    app: &tauri::AppHandle,
    state: &CompletionPopupState,
    tab_id: String,
) -> Result<(), String> {
    use tauri::Emitter as _;
    {
        let mut current = state
            .tab_id
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *current = Some(tab_id.clone());
    }
    let main_focused = app
        .get_webview_window("main")
        .and_then(|window| window.is_focused().ok())
        .unwrap_or(false);
    if !main_focused {
        {
            let mut restore = state
                .restore_on_focus
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *restore = Some(tab_id);
        }
        post_system_completion_notification();
        return Ok(());
    }

    let popup = app
        .get_webview_window("completion-alert")
        .ok_or_else(|| "completion popup window is unavailable".to_string())?;
    let main = app.get_webview_window("main");
    let popup_for_show = popup.clone();
    app.run_on_main_thread(move || {
        if let Some(main) = main {
            if let (Ok(Some(monitor)), Ok(popup_size)) =
                (main.current_monitor(), popup_for_show.outer_size())
            {
                let work = monitor.work_area();
                let x = work.position.x + work.size.width as i32 - popup_size.width as i32 - 18;
                let y = work.position.y + 18;
                let _ = popup_for_show
                    .set_position(Position::Physical(PhysicalPosition::new(x, y)));
            }
        }
        let _ = popup_for_show.show();
    })
    .map_err(|error| error.to_string())?;
    app.emit_to("completion-alert", "grok-desktop://completion-popup", tab_id)
        .map_err(|error| error.to_string())?;

    let serial = state.serial.fetch_add(1, Ordering::SeqCst) + 1;
    let latest = state.serial.clone();
    let app_for_hide = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(6)).await;
        if latest.load(Ordering::SeqCst) == serial {
            let _ = app_for_hide.run_on_main_thread(move || {
                let _ = popup.hide();
            });
        }
    });

    Ok(())
}

#[tauri::command]
async fn show_completion_popup(
    app: tauri::AppHandle,
    state: tauri::State<'_, CompletionPopupState>,
    tab_id: String,
) -> Result<(), String> {
    present_completion_popup(&app, &state, tab_id)
}

#[tauri::command]
fn open_completion_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, CompletionPopupState>,
    tab_id: Option<String>,
) -> Result<(), String> {
    use tauri::Emitter as _;
    let tab_id = tab_id
        .filter(|id| !id.is_empty())
        .or_else(|| {
            state
                .tab_id
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
        })
        .ok_or_else(|| "no completed session to open".to_string())?;
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    let popup = app.get_webview_window("completion-alert");

    // Deliver the navigation before macOS spends time restoring and focusing
    // the main window, so the requested session is already selected when the
    // window becomes visible. Hide the banner from Rust: the popup webview
    // does not have window:allow-hide, so a JS hide() would fail the click.
    app.emit_to(
        "main",
        "grok-desktop://completion-popup-clicked",
        serde_json::json!({ "tabId": tab_id }),
    )
    .map_err(|error| error.to_string())?;

    app.run_on_main_thread(move || {
        if let Some(popup) = popup {
            let _ = popup.hide();
        }
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    })
    .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PreviewState::default())
        .manage(TerminalState::default())
        .manage(CompletionPopupState::default())
        // The static-site preview iframe loads from this scheme instead of
        // srcdoc: the served document carries its own (permissive) CSP, so
        // the app CSP can stay strict (script-src 'self') without breaking
        // the preview. Requests are token-gated and path-validated against
        // the single registered preview root.
        .register_uri_scheme_protocol(PREVIEW_SCHEME, |ctx, request| {
            let state = ctx.app_handle().state::<PreviewState>();
            let guard = state
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            preview_scheme_response(guard.as_ref(), request.uri().path())
        })
        .setup(|app| {
            // Keep the CLI-side `/desktop` helper upgrade-safe. Older
            // Desktop releases installed a helper that only focused the app;
            // refreshing the managed skill on launch upgrades it without
            // touching a user-authored skill with the same name.
            if let Err(error) = ensure_desktop_handoff_skill() {
                eprintln!("[grok-desktop] refresh /desktop handoff skipped: {error}");
            }
            let app_handle = app.handle().clone();
            let resource_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| app_support_dir());
            std::fs::create_dir_all(&resource_dir).ok();
            // Restore the user's manually resized window before showing it.
            // Starting hidden avoids the same first-frame resize flash we
            // explicitly avoid for the sidebar in the frontend.
            let window_state_path = resource_dir.join(WINDOW_STATE_FILE);
            if let Some(window) = app.get_webview_window("main") {
                if let Some(state) = read_window_state(&window_state_path) {
                    let _ = window.set_size(Size::Physical(PhysicalSize::new(state.width, state.height)));
                } else {
                    let _ = window.set_size(Size::Physical(PhysicalSize::new(
                        DEFAULT_WINDOW_WIDTH,
                        DEFAULT_WINDOW_HEIGHT,
                    )));
                }
                let state_path_for_close = window_state_path.clone();
                let window_for_close = window.clone();
                let app_for_focus = app.handle().clone();
                window.on_window_event(move |event| {
                    match event {
                        // Persist as the user drags rather than waiting for a
                        // quit event: macOS app termination can bypass a
                        // per-window CloseRequested notification.
                        WindowEvent::Resized(size) => {
                            save_window_state(&state_path_for_close, *size);
                        }
                        WindowEvent::Focused(true) => {
                            let state = app_for_focus.state::<CompletionPopupState>();
                            let tab_id = state
                                .restore_on_focus
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner())
                                .take();
                            if let Some(tab_id) = tab_id {
                                use tauri::Emitter as _;
                                let _ = app_for_focus.emit_to(
                                    "main",
                                    "grok-desktop://completion-popup-clicked",
                                    serde_json::json!({ "tabId": tab_id }),
                                );
                            }
                        }
                        WindowEvent::CloseRequested { api, .. } => {
                            // Closing the document window should keep the
                            // desktop agent alive in the background. Cmd-Q
                            // remains the explicit app-level quit path.
                            api.prevent_close();
                            if let Ok(size) = window_for_close.outer_size() {
                                save_window_state(&state_path_for_close, size);
                            }
                            let _ = window_for_close.hide();
                        }
                        _ => {}
                    }
                });
                let _ = window.show();
            }
            let db_path = resource_dir.join("runs.sqlite");

            tauri::async_runtime::block_on(async {
                // A corrupted runs.sqlite (disk full, power loss mid-write)
                // must not brick every launch: move it aside, retry with a
                // fresh file, and fall back to in-memory as a last resort.
                let db = match Db::open_at(&db_path).await {
                    Ok(db) => db,
                    Err(error) => {
                        eprintln!("[grok-desktop] open runs.sqlite failed: {error}; moving it aside");
                        let backup = resource_dir.join(format!(
                            "runs.sqlite.corrupt-{}",
                            chrono::Utc::now().timestamp_millis()
                        ));
                        let _ = std::fs::rename(&db_path, &backup);
                        match Db::open_at(&db_path).await {
                            Ok(db) => db,
                            Err(retry_error) => {
                                eprintln!("[grok-desktop] reopen failed: {retry_error}; using in-memory runs db");
                                Db::open_memory().await.expect("open in-memory runs db")
                            }
                        }
                    }
                };

                // One-shot migration: if session_state.json has a non-empty history array,
                // import as Done runs in SQLite, then clear the field.
                // ToolRun fields in JSON are snake_case: ok, command, cwd, exit_code, duration_ms, timed_out, output, stderr
                // There is no timestamp field — use current time as approximation.
                let session_path = app_support_dir().join("session_state.json");
                if let Ok(content) = std::fs::read_to_string(&session_path) {
                    if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&content) {
                        if let Some(history) = v.get("history").and_then(|h| h.as_array()).cloned() {
                            if !history.is_empty() {
                                let now_ms = chrono::Utc::now().timestamp_millis();
                                for item in &history {
                                    let id = uuid::Uuid::now_v7().to_string();
                                    let prompt = item.get("command").and_then(|p| p.as_str()).unwrap_or("").to_string();
                                    let cwd = item.get("cwd").and_then(|c| c.as_str()).unwrap_or("/").to_string();
                                    let rec = crate::runs::db::RunRecord {
                                        id,
                                        prompt,
                                        cwd,
                                        args_json: "[]".into(),
                                        state: crate::runs::db::RunState::Done,
                                        enqueued_at: now_ms,
                                        started_at: Some(now_ms),
                                        ended_at: Some(now_ms),
                                        stop_reason: Some("legacy".into()),
                                        error: None,
                                        lane_id: String::new(),
                                        parent_run_id: None,
                                    };
                                    let _ = db.insert_run(&rec).await;
                                }
                            }
                            v.as_object_mut().and_then(|o| o.remove("history"));
                            // Atomic tmp+rename, and never clobber the file
                            // with an empty string on serialization failure.
                            if let Ok(serialized) = serde_json::to_string_pretty(&v) {
                                let tmp = session_path.with_extension("json.tmp");
                                if std::fs::write(&tmp, serialized).is_ok() {
                                    let _ = std::fs::rename(&tmp, &session_path);
                                }
                            }
                        }
                    }
                }

                let grok_path = std::path::PathBuf::from(
                    std::env::var("GROK_DESKTOP_GROK_CMD")
                        .unwrap_or_else(|_| default_grok_binary()),
                );
                let (queue, mut rx) = RunQueue::new(db.clone(), grok_path).await;
                let queue = std::sync::Arc::new(queue);
                queue.clone().spawn_worker();

                // Event forwarder: queue messages → Tauri events.
                let app_for_events = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    use tokio::sync::broadcast::error::RecvError;
                    loop {
                        match rx.recv().await {
                            Ok(msg) => forward_queue_message(&app_for_events, &msg),
                            Err(RecvError::Lagged(n)) => {
                                eprintln!("[grok-desktop] tauri event forwarder lagged, dropped {n} messages");
                            }
                            Err(RecvError::Closed) => break,
                        }
                    }
                });

                // 6-hour vacuum loop.
                let db_for_vacuum = db.clone();
                tauri::async_runtime::spawn(async move {
                    let week_ms: i64 = 7 * 24 * 60 * 60 * 1000;
                    loop {
                        let _ = db_for_vacuum.vacuum(week_ms).await;
                        tokio::time::sleep(std::time::Duration::from_secs(6 * 3600)).await;
                    }
                });

                // Prompt library (D) — open store next to runs.sqlite, with
                // the same corruption-recovery path as runs.sqlite above.
                let prompts_path = resource_dir.join("prompts.sqlite");
                let prompts = match crate::prompts::PromptStore::open_at(&prompts_path).await {
                    Ok(store) => store,
                    Err(error) => {
                        eprintln!("[grok-desktop] open prompts.sqlite failed: {error}; moving it aside");
                        let backup = resource_dir.join(format!(
                            "prompts.sqlite.corrupt-{}",
                            chrono::Utc::now().timestamp_millis()
                        ));
                        let _ = std::fs::rename(&prompts_path, &backup);
                        match crate::prompts::PromptStore::open_at(&prompts_path).await {
                            Ok(store) => store,
                            Err(retry_error) => {
                                eprintln!("[grok-desktop] reopen failed: {retry_error}; using in-memory prompt store");
                                crate::prompts::PromptStore::open_memory()
                                    .await
                                    .expect("open in-memory prompt store")
                            }
                        }
                    }
                };
                app_handle.manage(prompts);

                app_handle.manage(queue);
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_tool_statuses,
            load_session_state,
            save_session_state,
            get_grok_auth_status,
            start_grok_login,
            consume_desktop_handoff,
            open_grok_cli,
            open_grok_desktop,
            export_grok_session,
            rewind_grok_session,
            run_grok_task,
            run_shell_command,
            start_terminal_session,
            write_terminal_session,
            resize_terminal_session,
            close_terminal_session,
            get_static_preview,
            inspect_grok_environment,
            list_grok_models,
            list_grok_mcp,
            doctor_grok_mcp,
            grok_mcp_add,
            grok_mcp_remove,
            list_grok_plugins,
            list_customize_plugins,
            grok_plugin_action,
            grok_mcp_set_enabled,
            list_grok_sessions,
            list_grok_skills,
            install_grok_skill,
            remove_grok_skill,
            context_metrics::get_session_context_metrics,
            customize::list_customizations,
            customize::save_customization,
            customize::set_customization_enabled,
            customize::delete_customization,
            run_browser_task,
            run_absorb_repo,
            run_doctor,
            pick_project_folder,
            pick_attachments,
            enqueue_run,
            prewarm_run,
            cancel_run,
            get_queue,
            clear_queue,
            resume_pending_runs,
            cancel_pending_runs,
            list_prompts,
            upsert_prompt,
            delete_prompt,
            glob_files,
            read_file_safe,
            read_attachment,
            path_is_directory,
            save_attachment,
            load_attachment,
            desktop::desktop_list_apps,
            desktop::desktop_query,
            desktop::desktop_activate,
            show_completion_popup,
            open_completion_session
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Clicking the Dock icon after the window was hidden should bring
            // the existing process and its session back to the foreground.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = &event {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            // App-level quit (including Cmd-Q / `tell application … to quit`)
            // does not necessarily produce a per-window CloseRequested event
            // on macOS, so persist here as the reliable final checkpoint.
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                if let Some(window) = app_handle.get_webview_window("main") {
                    if let Ok(size) = window.outer_size() {
                        let resource_dir = app_handle
                            .path()
                            .app_data_dir()
                            .unwrap_or_else(|_| app_support_dir());
                        save_window_state(&resource_dir.join(WINDOW_STATE_FILE), size);
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_process_metadata_is_strict_and_session_scoped() {
        assert_eq!(
            parse_grok_cli_process_metadata("4321\nsession-abc\nWed Aug 12 21:56:47 2026\n"),
            Some(GrokCliProcessMetadata {
                pid: 4321,
                session_id: "session-abc".into(),
                started_at: "Wed Aug 12 21:56:47 2026".into(),
            })
        );
        assert_eq!(
            parse_grok_cli_process_metadata("0\nsession-abc\nWed Aug 12 21:56:47 2026\n"),
            None
        );
        assert_eq!(
            parse_grok_cli_process_metadata("4321\n\nWed Aug 12 21:56:47 2026\n"),
            None
        );
        assert_eq!(
            parse_grok_cli_process_metadata("4321\nsession-abc\nWed Aug 12 21:56:47 2026\nextra\n"),
            None
        );
        assert_ne!(
            grok_cli_process_path(Path::new("/tmp"), "session-a"),
            grok_cli_process_path(Path::new("/tmp"), "session-b")
        );
    }

    #[test]
    fn cli_process_command_requires_desktop_leader_and_exact_session() {
        let socket = Path::new("/tmp/grok-desktop/leader.sock");
        let command = "/Users/test/.local/bin/grok --leader --leader-socket /tmp/grok-desktop/leader.sock --cwd /tmp --resume session-abc";
        assert!(grok_cli_command_matches(
            command,
            "/Users/test/.local/bin/grok",
            socket,
            "session-abc"
        ));
        assert!(!grok_cli_command_matches(
            command,
            "/Users/test/.local/bin/grok",
            socket,
            "session-other"
        ));
        assert!(!grok_cli_command_matches(
            "/Users/test/.local/bin/grok --resume session-abc",
            "/Users/test/.local/bin/grok",
            socket,
            "session-abc"
        ));
        assert!(!grok_cli_command_matches(
            "/usr/local/bin/not-grok --leader --leader-socket /tmp/grok-desktop/leader.sock --resume session-abc",
            "/Users/test/.local/bin/grok",
            socket,
            "session-abc"
        ));
    }

    #[test]
    fn updates_path_reuses_valid_cache_and_recovers_from_stale_cache() {
        let root = env::temp_dir().join(format!("grok-updates-path-test-{}", uuid::Uuid::now_v7()));
        let session_id = "session-under-test";
        let actual = root
            .join("encoded-workspace")
            .join(session_id)
            .join("updates.jsonl");
        fs::create_dir_all(actual.parent().expect("updates parent"))
            .expect("create updates parent");
        fs::write(&actual, "{}\n").expect("write updates");

        let unavailable_root = root.join("not-a-directory");
        assert_eq!(
            find_grok_session_updates_path(&unavailable_root, session_id, Some(&actual)),
            Some(actual.clone()),
            "a validated cache hit must not require scanning the sessions root"
        );
        assert_eq!(
            find_grok_session_updates_path(
                &root,
                session_id,
                Some(&root.join("stale").join("updates.jsonl")),
            ),
            Some(actual.clone()),
            "a stale cache entry must fall back to directory discovery"
        );

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn updates_reader_keeps_complete_records_during_partial_utf8_append() {
        let path = env::temp_dir().join(format!(
            "grok-updates-read-test-{}.jsonl",
            uuid::Uuid::now_v7()
        ));
        let complete = br#"{"params":{"update":{"sessionUpdate":"user_message_chunk","content":{"text":"hello"}}}}
"#;
        let mut snapshot = complete.to_vec();
        snapshot.extend_from_slice(&[b'{', b'"', 0xe2]);
        fs::write(&path, snapshot).expect("write partial updates snapshot");

        let jsonl = read_updates_jsonl(&path).expect("read updates snapshot");
        assert_eq!(
            turns_from_updates_jsonl(&jsonl),
            vec![("user".into(), "hello".into())]
        );

        fs::remove_file(path).ok();
    }

    #[test]
    fn updates_jsonl_keeps_cli_turns_and_honors_rewind_markers() {
        let jsonl = r#"
{"params":{"update":{"sessionUpdate":"user_message_chunk","content":{"text":"hello"}}}}
{"params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"hi"}}}}
{"params":{"update":{"sessionUpdate":"user_message_chunk","content":{"text":"from CLI"}}}}
{"params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"cli reply"}}}}
{"params":{"update":{"sessionUpdate":"rewind_marker","target_prompt_index":0}}}
{"params":{"update":{"sessionUpdate":"user_message_chunk","content":{"text":"after rewind"}}}}
{"params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"still here"}}}}
"#;
        let turns = turns_from_updates_jsonl(jsonl);
        assert_eq!(
            turns,
            vec![
                ("user".into(), "hello".into()),
                ("assistant".into(), "hi".into()),
                ("user".into(), "after rewind".into()),
                ("assistant".into(), "still here".into()),
            ]
        );
    }

    #[test]
    fn local_undo_matches_only_tagged_user_queries() {
        let actual_user = serde_json::json!({
            "type": "user",
            "prompt_index": 3,
            "content": [{"type": "text", "text": "<user_query>keep this</user_query>"}]
        });
        let synthetic_user = serde_json::json!({
            "type": "user",
            "content": [{"type": "text", "text": "<system-reminder>internal</system-reminder>"}]
        });
        assert_eq!(user_query_text(&actual_user).as_deref(), Some("keep this"));
        assert_eq!(user_query_text(&synthetic_user), None);
    }

    #[test]
    fn local_undo_truncation_keeps_prior_jsonl_records() {
        let raw = "system\nfirst\nsecond\n";
        assert_eq!(truncate_jsonl_before_line(raw, 2), "system\nfirst\n");
        assert_eq!(truncate_jsonl_before_line(raw, 0), "");
    }

    #[test]
    fn local_undo_truncation_removes_target_and_later_rewind_points() {
        let raw = concat!(
            r#"{"prompt_index":0}"#, "\n",
            r#"{"prompt_index":1}"#, "\n",
            r#"{"prompt_index":2}"#, "\n",
        );
        assert_eq!(
            truncate_rewind_points(raw, 2),
            concat!(r#"{"prompt_index":0}"#, "\n", r#"{"prompt_index":1}"#, "\n")
        );
    }

    #[test]
    fn local_undo_updates_all_authoritative_jsonl_files_together() {
        let session_dir =
            env::temp_dir().join(format!("grok-local-undo-{}", uuid::Uuid::now_v7()));
        fs::create_dir_all(&session_dir).expect("create session directory");
        fs::write(
            session_dir.join("chat_history.jsonl"),
            concat!(
                "{\"type\":\"system\"}\n",
                "{\"type\":\"user\",\"prompt_index\":0,\"content\":[{\"text\":\"<user_query>first</user_query>\"}]}\n",
                "{\"type\":\"assistant\",\"content\":\"first reply\"}\n",
                "{\"type\":\"user\",\"prompt_index\":1,\"content\":[{\"text\":\"<user_query>second</user_query>\"}]}\n",
                "{\"type\":\"assistant\",\"content\":\"second reply\"}\n",
            ),
        )
        .expect("write chat history");
        fs::write(
            session_dir.join("updates.jsonl"),
            concat!(
                "{\"params\":{\"update\":{\"sessionUpdate\":\"user_message_chunk\",\"content\":{\"text\":\"first\"},\"_meta\":{\"promptIndex\":0}}}}\n",
                "{\"params\":{\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"text\":\"first reply\"}}}}\n",
                "{\"params\":{\"update\":{\"sessionUpdate\":\"user_message_chunk\",\"content\":{\"text\":\"second\"},\"_meta\":{\"promptIndex\":1}}}}\n",
                "{\"params\":{\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"text\":\"second reply\"}}}}\n",
            ),
        )
        .expect("write updates");
        fs::write(
            session_dir.join("rewind_points.jsonl"),
            "{\"prompt_index\":0}\n{\"prompt_index\":1}\n",
        )
        .expect("write rewind points");

        assert!(truncate_local_grok_session_dir(&session_dir, "second").expect("undo session"));
        assert_eq!(
            fs::read_to_string(session_dir.join("chat_history.jsonl")).unwrap(),
            concat!(
                "{\"type\":\"system\"}\n",
                "{\"type\":\"user\",\"prompt_index\":0,\"content\":[{\"text\":\"<user_query>first</user_query>\"}]}\n",
                "{\"type\":\"assistant\",\"content\":\"first reply\"}\n",
            )
        );
        assert_eq!(
            fs::read_to_string(session_dir.join("updates.jsonl")).unwrap(),
            concat!(
                "{\"params\":{\"update\":{\"sessionUpdate\":\"user_message_chunk\",\"content\":{\"text\":\"first\"},\"_meta\":{\"promptIndex\":0}}}}\n",
                "{\"params\":{\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"text\":\"first reply\"}}}}\n",
            )
        );
        assert_eq!(
            fs::read_to_string(session_dir.join("rewind_points.jsonl")).unwrap(),
            "{\"prompt_index\":0}\n"
        );

        fs::remove_dir_all(session_dir).ok();
    }

    #[test]
    fn desktop_handoff_skill_exposes_bare_cli_command_and_safe_fallbacks() {
        let skill = desktop_handoff_skill_body();
        assert!(skill.contains("name: desktop"));
        assert!(skill.contains("user-invocable: true"));
        assert!(skill.contains(DESKTOP_HANDOFF_SKILL_MARKER));
        assert!(skill.contains("$HOME/.grok-desktop/open-desktop.sh"));

        let helper = desktop_handoff_script_body();
        assert!(helper.contains("open -b com.grok.desktop"));
        assert!(helper.contains("$HOME/Applications/Grok Build Desktop.app"));
        assert!(helper.contains("$HOME/Desktop/Grok Build Desktop.app"));
        assert!(helper.contains("/Applications/Grok Build Desktop.app"));

        let script = iterm_launch_script("iTerm-stable", "\"echo test\"");
        assert!(script.contains("set newWindow to (create window with default profile)"));
        assert!(script.contains("current session of newWindow"));
        assert!(!script.contains("current session of current window"));
    }

    #[test]
    fn legacy_runner_keeps_desktop_rules_out_of_visible_user_prompt() {
        let args = grok_args(
            "hello from the user",
            "coding",
            Path::new("/tmp"),
            GrokRunOptions::default(),
        );
        let prompt_index = args
            .iter()
            .position(|arg| arg == "-p")
            .expect("prompt flag");
        assert_eq!(
            args.get(prompt_index + 1).map(String::as_str),
            Some("hello from the user")
        );
        assert!(args.contains(&"--rules".to_string()));
        assert!(!args[prompt_index + 1].contains("Grok Desktop instructions"));
        assert!(!args[prompt_index + 1].contains("Workspace contract"));
    }

    #[test]
    fn window_state_round_trips_saved_size() {
        let path = env::temp_dir().join(format!("grok-window-state-{}.json", uuid::Uuid::now_v7()));
        save_window_state(&path, PhysicalSize::new(1440, 920));
        let restored = read_window_state(&path).expect("saved window state should load");
        assert_eq!((restored.width, restored.height), (1440, 920));
        fs::remove_file(path).ok();
    }

    #[test]
    fn command_line_redacts_prompt_and_env_values() {
        let args = vec![
            "mcp".to_string(),
            "add".to_string(),
            "github".to_string(),
            "--env".to_string(),
            "GITHUB_PERSONAL_ACCESS_TOKEN=ghp_secret".to_string(),
            "--env=BRAVE_API_KEY=abc123".to_string(),
            "-p".to_string(),
            "hello world".to_string(),
        ];
        let line = command_line("grok", &args);
        assert!(!line.contains("ghp_secret"), "env value leaked: {line}");
        assert!(!line.contains("abc123"), "env= value leaked: {line}");
        assert!(line.contains("--env GITHUB_PERSONAL_ACCESS_TOKEN=<redacted>"));
        assert!(line.contains("--env=BRAVE_API_KEY=<redacted>"));
        assert!(line.contains("-p <prompt>"));

        let multimodal = command_line(
            "grok",
            &[
                "--prompt-json".to_string(),
                r#"[{"type":"input_image","image_url":"data:image/png;base64,secret"}]"#
                    .to_string(),
            ],
        );
        assert!(!multimodal.contains("base64,secret"));
        assert_eq!(multimodal, "grok --prompt-json <prompt>");
    }

    #[test]
    fn command_line_keeps_ordinary_args() {
        let args = vec![
            "models".to_string(),
            "--cwd".to_string(),
            "/tmp/x".to_string(),
        ];
        assert_eq!(command_line("grok", &args), "grok models --cwd /tmp/x");
    }

    #[test]
    fn html_attr_value_ignores_prefixed_attribute_names() {
        // data-src must NOT satisfy a lookup for src.
        let tag = r#"<script data-src="lazy.js" src="app.js">"#;
        assert_eq!(html_attr_value(tag, "src").as_deref(), Some("app.js"));

        let link = r#"<link rel="stylesheet" data-href="lazy.css" href="app.css">"#;
        assert_eq!(html_attr_value(link, "href").as_deref(), Some("app.css"));

        // No real src attribute at all → None, even with a decoy.
        let decoy = r#"<script data-src="lazy.js">"#;
        assert_eq!(html_attr_value(decoy, "src"), None);
    }

    #[test]
    fn noisy_line_filter_only_targets_timestamped_log_lines() {
        assert!(is_noisy_grok_line(
            "2026-07-08T10:00:00Z  INFO grok_core: starting"
        ));
        assert!(!is_noisy_grok_line("plain command output"));
        assert!(!is_noisy_grok_line("ERROR: something broke")); // no ISO stamp
    }

    #[test]
    fn inline_static_assets_skips_oversized_assets() {
        let root = env::temp_dir().join(format!("grok-preview-test-{}", uuid::Uuid::now_v7()));
        fs::create_dir_all(&root).expect("create temp preview root");
        fs::write(root.join("small.js"), "console.log('ok');").expect("write small.js");
        fs::write(
            root.join("big.js"),
            "x".repeat((PREVIEW_ASSET_MAX_BYTES + 1) as usize),
        )
        .expect("write big.js");

        let html = concat!(
            r#"<script src="small.js"></script>"#,
            r#"<script src="big.js"></script>"#
        )
        .to_string();
        let out = inline_static_assets(html, &root);

        assert!(
            out.contains("console.log('ok');"),
            "small asset must inline"
        );
        assert!(
            out.contains(r#"src="big.js""#),
            "oversized asset must keep its tag"
        );
        assert!(
            out.contains("too large to inline"),
            "must append truncation marker"
        );

        fs::remove_dir_all(&root).ok();
    }

    fn temp_preview_root() -> PathBuf {
        let root = env::temp_dir().join(format!("grok-preview-scheme-{}", uuid::Uuid::now_v7()));
        fs::create_dir_all(&root).expect("create temp preview root");
        root
    }

    fn registered(root: &Path) -> RegisteredPreview {
        RegisteredPreview {
            token: "testtoken".to_string(),
            root: root.canonicalize().expect("canonicalize temp root"),
        }
    }

    fn header<'a>(response: &'a tauri::http::Response<Vec<u8>>, name: &str) -> Option<&'a str> {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
    }

    #[test]
    fn preview_scheme_rejects_when_nothing_registered() {
        let response = preview_scheme_response(None, "/anytoken/index.html");
        assert_eq!(response.status(), 404);
    }

    #[test]
    fn preview_scheme_rejects_wrong_token() {
        let root = temp_preview_root();
        fs::write(root.join("index.html"), "<h1>hi</h1>").expect("write index");
        let reg = registered(&root);
        let response = preview_scheme_response(Some(&reg), "/wrongtoken/index.html");
        assert_eq!(response.status(), 404);
        let response = preview_scheme_response(Some(&reg), "/index.html");
        assert_eq!(
            response.status(),
            404,
            "missing token segment must not serve"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn preview_scheme_serves_inlined_index_with_own_csp() {
        let root = temp_preview_root();
        fs::write(root.join("app.js"), "console.log('inlined');").expect("write app.js");
        fs::write(
            root.join("index.html"),
            r#"<html><body><script src="app.js"></script></body></html>"#,
        )
        .expect("write index");
        let reg = registered(&root);

        let response = preview_scheme_response(Some(&reg), "/testtoken/index.html");
        assert_eq!(response.status(), 200);
        assert_eq!(
            header(&response, "Content-Type"),
            Some("text/html; charset=utf-8")
        );
        let csp = header(&response, "Content-Security-Policy").expect("preview CSP header");
        assert!(
            csp.contains("object-src 'none'"),
            "preview CSP must pin object-src"
        );
        let body = String::from_utf8_lossy(response.body());
        assert!(
            body.contains("console.log('inlined');"),
            "local JS must be inlined"
        );

        // Bare /{token}/ and /{token} must also resolve to index.html.
        let response = preview_scheme_response(Some(&reg), "/testtoken/");
        assert_eq!(response.status(), 200);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn preview_scheme_blocks_path_traversal() {
        let root = temp_preview_root();
        fs::write(root.join("index.html"), "<h1>hi</h1>").expect("write index");
        let outside = root
            .parent()
            .expect("temp root parent")
            .join(format!("grok-preview-outside-{}", uuid::Uuid::now_v7()));
        fs::write(&outside, "secret").expect("write outside file");
        let reg = registered(&root);

        let outside_name = outside.file_name().unwrap().to_string_lossy();
        for path in [
            format!("/testtoken/../{outside_name}"),
            // URL-encoded traversal must decode and then still be rejected.
            format!("/testtoken/%2e%2e/{outside_name}"),
            "/testtoken//etc/hosts".to_string(),
            "/testtoken/..%5c..%5cwindows".to_string(),
        ] {
            let response = preview_scheme_response(Some(&reg), &path);
            assert_eq!(response.status(), 404, "must reject {path}");
            assert!(
                !String::from_utf8_lossy(response.body()).contains("secret"),
                "must not leak file content for {path}"
            );
        }

        fs::remove_file(&outside).ok();
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn preview_scheme_serves_assets_inside_root_only() {
        let root = temp_preview_root();
        fs::write(root.join("index.html"), "<h1>hi</h1>").expect("write index");
        fs::create_dir_all(root.join("img")).expect("create img dir");
        fs::write(root.join("img/logo.svg"), "<svg></svg>").expect("write svg");
        fs::write(
            root.join("big.bin"),
            vec![0_u8; (PREVIEW_ASSET_MAX_BYTES + 1) as usize],
        )
        .expect("write big.bin");
        let reg = registered(&root);

        let response = preview_scheme_response(Some(&reg), "/testtoken/img/logo.svg");
        assert_eq!(response.status(), 200);
        assert_eq!(header(&response, "Content-Type"), Some("image/svg+xml"));

        let response = preview_scheme_response(Some(&reg), "/testtoken/big.bin");
        assert_eq!(response.status(), 413, "oversized files must be refused");

        let response = preview_scheme_response(Some(&reg), "/testtoken/missing.png");
        assert_eq!(response.status(), 404);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn shell_cwd_rejects_missing_directories() {
        let missing = env::temp_dir().join(format!("grok-shell-missing-{}", uuid::Uuid::now_v7()));
        let error = shell_cwd(Some(missing.to_string_lossy().to_string()))
            .expect_err("nonexistent cwd must be rejected");
        assert!(
            error.contains("does not exist"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn shell_cwd_accepts_and_canonicalizes_real_directories() {
        let dir = env::temp_dir().join(format!("grok-shell-cwd-{}", uuid::Uuid::now_v7()));
        fs::create_dir_all(&dir).expect("create temp dir");
        let resolved = shell_cwd(Some(dir.to_string_lossy().to_string())).expect("real dir ok");
        assert!(resolved.is_dir());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn shell_cwd_defaults_to_home_instead_of_the_source_tree() {
        let home = env::var_os("HOME").map(PathBuf::from).expect("HOME is set");
        let resolved = shell_cwd(None).expect("home directory is valid");
        assert_eq!(resolved, home.canonicalize().expect("canonical home"));
    }

    #[test]
    fn preview_scheme_url_embeds_token() {
        let url = preview_scheme_url("abc123");
        assert!(
            url.contains("/abc123/index.html"),
            "url must carry the token: {url}"
        );
    }

    #[test]
    fn percent_decode_path_decodes_and_tolerates_junk() {
        assert_eq!(percent_decode_path("a%20b"), "a b");
        assert_eq!(percent_decode_path("%2e%2e"), "..");
        assert_eq!(percent_decode_path("100%"), "100%");
        assert_eq!(percent_decode_path("%zz"), "%zz");
    }
}
