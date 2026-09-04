//! Persistent ACP host for the first-party Grok Core surface.
//!
//! The renderer keeps speaking the existing run-event protocol; this module
//! replaces the one-shot `grok --output-format streaming-json` process with a
//! long-lived `grok agent stdio` child and translates ACP notifications at the
//! Tauri boundary. Keeping the adapter here makes a future in-process
//! `xai-grok-shell` host a backend swap instead of another UI rewrite.

use super::event::GrokEvent;
use super::process;
use super::queue::{QueueMessage, QueueMessageKind};
use chrono::Utc;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{broadcast, watch, Mutex};
use tokio::time::{timeout, Duration};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreConfig {
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub always_approve: bool,
    pub permission_mode: Option<String>,
    pub experimental_memory: bool,
    pub web_search_disabled: bool,
    pub subagents_disabled: bool,
    pub review_only: bool,
    pub rules: Option<String>,
    pub resume_session_id: Option<String>,
    pub share_session: bool,
    pub fork_session: bool,
    pub prompt_blocks: Option<Vec<Value>>,
}

impl CoreConfig {
    pub fn from_legacy_args(args: &[String]) -> Self {
        let mut out = Self {
            model: None,
            reasoning_effort: None,
            always_approve: false,
            permission_mode: None,
            experimental_memory: false,
            web_search_disabled: false,
            subagents_disabled: false,
            review_only: false,
            rules: None,
            resume_session_id: None,
            share_session: false,
            fork_session: false,
            prompt_blocks: None,
        };
        let mut i = 0;
        while i < args.len() {
            let value = args.get(i + 1).cloned();
            match args[i].as_str() {
                "--model" => out.model = value,
                "--effort" | "--reasoning-effort" => {
                    out.reasoning_effort = value.map(|effort| {
                        if effort == "max" {
                            "xhigh".to_string()
                        } else {
                            effort
                        }
                    })
                }
                "--resume" => out.resume_session_id = value,
                "--share-session" => out.share_session = true,
                "--fork-session" => out.fork_session = true,
                "--prompt-json" => {
                    out.prompt_blocks = value.and_then(|raw| serde_json::from_str(&raw).ok())
                }
                "--always-approve" => out.always_approve = true,
                "--permission-mode" => out.permission_mode = value,
                "--experimental-memory" => out.experimental_memory = true,
                "--disable-web-search" => out.web_search_disabled = true,
                "--no-subagents" => out.subagents_disabled = true,
                "--rules" => {
                    out.review_only = value
                        .as_deref()
                        .is_some_and(|rules| rules.contains("Stay read-only"));
                    out.rules = value;
                }
                _ => {}
            }
            i += if matches!(
                args[i].as_str(),
                "--model"
                    | "--effort"
                    | "--reasoning-effort"
                    | "--resume"
                    | "--rules"
                    | "--prompt-json"
                    | "--permission-mode"
            ) {
                2
            } else {
                1
            };
        }
        out
    }

    fn launch_args(&self) -> Vec<String> {
        // These are top-level Grok options, so they must be placed before the
        // `agent` subcommand. Passing them after `agent` is rejected by grok
        // 1.0.4, even though the Desktop run builder emits them alongside the
        // other legacy options.
        let mut args = Vec::new();
        if self.experimental_memory {
            args.push("--experimental-memory".to_string());
        }
        if self.web_search_disabled {
            args.push("--disable-web-search".to_string());
        }
        if self.subagents_disabled {
            args.push("--no-subagents".to_string());
        }
        args.push("agent".to_string());
        if let Some(model) = &self.model {
            args.extend(["--model".to_string(), model.clone()]);
        }
        if let Some(effort) = &self.reasoning_effort {
            args.extend(["--reasoning-effort".to_string(), effort.clone()]);
        }
        if let Some(permission_mode) = &self.permission_mode {
            args.extend(["--permission-mode".to_string(), permission_mode.clone()]);
        }
        if self.always_approve {
            args.push("--always-approve".to_string());
        }
        // Isolated agent by default. Live `/cli` turns join the Desktop
        // leader so TUI and Desktop write one in-memory session.
        if self.uses_shared_leader() {
            args.push("--leader".to_string());
            args.extend([
                "--leader-socket".to_string(),
                desktop_leader_socket().to_string_lossy().into_owned(),
            ]);
        } else {
            args.push("--no-leader".to_string());
        }
        args.push("stdio".to_string());
        args
    }

    fn uses_shared_leader(&self) -> bool {
        self.share_session && self.resume_session_id.is_some() && !self.fork_session
    }

    pub(crate) fn launch_key(&self, binary: &Path) -> String {
        format!("{}\0{}", binary.display(), self.launch_args().join("\0"))
    }
}

pub fn should_use_acp(binary: &Path) -> bool {
    match std::env::var("GROK_DESKTOP_RUNTIME").as_deref() {
        Ok("legacy") => false,
        Ok("acp") => true,
        _ => binary.file_stem().is_some_and(|name| name == "grok"),
    }
}

/// Unix socket for the Desktop↔CLI shared grok leader.
/// Override with `GROK_DESKTOP_LEADER_SOCKET` (tests / multiple installs).
pub fn desktop_leader_socket() -> PathBuf {
    if let Ok(path) = std::env::var("GROK_DESKTOP_LEADER_SOCKET") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".grok-desktop")
        .join("leader.sock")
}

pub fn desktop_leader_socket_ready() -> bool {
    let path = desktop_leader_socket();
    #[cfg(unix)]
    {
        std::os::unix::net::UnixStream::connect(path).is_ok()
    }
    #[cfg(not(unix))]
    {
        path.exists()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewindResult {
    pub rewound: bool,
    pub kept_prompt_index: Option<u64>,
}

/// Last prompt to keep when dropping the newest user turn.
/// One rewind point cannot be executed (ACP rejects `-1`).
pub fn last_kept_prompt_index(points: &Value) -> Option<u64> {
    kept_prompt_index_for_undo(points, None).ok().flatten()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RewindTargetError {
    PreviewNotFound,
    AmbiguousPreview { matches: usize },
    NewerPrompts { count: usize },
}

impl std::fmt::Display for RewindTargetError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PreviewNotFound => write!(
                formatter,
                "the undone Desktop prompt did not safely match a rewind point"
            ),
            Self::AmbiguousPreview { matches } => write!(
                formatter,
                "the undone Desktop prompt matched {matches} rewind points; refusing an ambiguous rewind"
            ),
            Self::NewerPrompts { count } => write!(
                formatter,
                "{count} newer prompt(s) follow the undone Desktop prompt; refusing to truncate them"
            ),
        }
    }
}

/// Prefer the rewind point that matches the Desktop-undone user text.
/// Blindly dropping the newest grok prompt undoes a later CLI turn instead.
pub fn kept_prompt_index_for_undo(
    points: &Value,
    undone_preview: Option<&str>,
) -> Result<Option<u64>, RewindTargetError> {
    let Some(points) = points.get("rewind_points").and_then(Value::as_array) else {
        return Ok(None);
    };
    if points.is_empty() {
        return Ok(None);
    }
    let drop_at = match undone_preview
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        None => points.len() - 1,
        Some(undone) => {
            let matches = points
                .iter()
                .enumerate()
                .filter_map(|(index, point)| {
                    point
                        .get("prompt_preview")
                        .and_then(Value::as_str)
                        .filter(|preview| previews_match(preview, undone))
                        .map(|_| index)
                })
                .collect::<Vec<_>>();
            match matches.as_slice() {
                [index] => *index,
                [] => return Err(RewindTargetError::PreviewNotFound),
                _ => {
                    return Err(RewindTargetError::AmbiguousPreview {
                        matches: matches.len(),
                    })
                }
            }
        }
    };
    if drop_at + 1 < points.len() {
        return Err(RewindTargetError::NewerPrompts {
            count: points.len() - drop_at - 1,
        });
    }
    if drop_at == 0 {
        return Ok(None);
    }
    Ok(points[drop_at - 1]
        .get("prompt_index")
        .and_then(Value::as_u64))
}

fn previews_match(preview: &str, undone: &str) -> bool {
    let preview = preview.trim();
    let undone = undone.trim();
    if preview.is_empty() || undone.is_empty() {
        return false;
    }
    // Grok labels this field `prompt_preview` and may truncate a long prompt.
    // Accept only a prefix relationship (never a middle substring), then let
    // the caller require that exactly one rewind point matches.
    preview == undone || undone.starts_with(preview)
}

fn reject_unloaded_shared_session(
    config: &CoreConfig,
    session_id: &str,
    load_error: &str,
) -> Result<(), String> {
    if config.uses_shared_leader() {
        return Err(format!(
            "session/load failed for shared session {session_id}; refusing to prompt an unbound ACP client: {load_error}"
        ));
    }
    Ok(())
}

/// Truncate the grok session to drop the undone user turn (conversation only).
pub async fn rewind_last_user_turn(
    binary: &Path,
    cwd: &Path,
    session_id: &str,
    undone_preview: Option<&str>,
) -> Result<RewindResult, String> {
    rewind_last_user_turn_with_share(
        binary,
        cwd,
        session_id,
        undone_preview,
        desktop_leader_socket_ready(),
    )
    .await
}

/// Rewind a session while explicitly controlling whether the ACP client may
/// attach to the shared CLI leader. Undo stops Desktop's own TUI first, so the
/// safe path is an unshared client; if that cannot load/rewind the old head,
/// the caller can fall back to a fresh replay session.
pub async fn rewind_last_user_turn_with_share(
    binary: &Path,
    cwd: &Path,
    session_id: &str,
    undone_preview: Option<&str>,
    share: bool,
) -> Result<RewindResult, String> {
    let config = CoreConfig {
        model: None,
        reasoning_effort: None,
        always_approve: false,
        permission_mode: None,
        experimental_memory: false,
        web_search_disabled: false,
        subagents_disabled: false,
        review_only: false,
        rules: None,
        resume_session_id: Some(session_id.to_string()),
        share_session: share,
        fork_session: false,
        prompt_blocks: None,
    };
    let mut host = AcpHost::connect(binary, cwd, &config).await?;
    host.rewind_last_user_turn(cwd, session_id, &config, undone_preview)
        .await
}

/// Create a durable replacement head after Undo.
///
/// Grok 1.0 can list rewind points for a loaded session while still refusing
/// `_x.ai/rewind/execute`.  In that case Desktop must not resume the old head:
/// it creates a fresh session whose system rules contain only the conversation
/// that remains visible after Undo.  The old session is left untouched.
pub async fn create_rebased_session(
    binary: &Path,
    cwd: &Path,
    replay_rules: Option<&str>,
) -> Result<String, String> {
    let config = CoreConfig {
        model: None,
        reasoning_effort: None,
        always_approve: false,
        permission_mode: None,
        experimental_memory: false,
        web_search_disabled: false,
        subagents_disabled: false,
        review_only: false,
        rules: replay_rules
            .map(str::trim)
            .filter(|rules| !rules.is_empty())
            .map(str::to_string),
        resume_session_id: None,
        share_session: false,
        fork_session: false,
        prompt_blocks: None,
    };
    let mut host = AcpHost::connect(binary, cwd, &config).await?;
    let resolved_cwd = if cwd.is_absolute() && cwd.is_dir() {
        cwd.to_path_buf()
    } else {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/"))
    };
    let session_id = host
        .new_session(&resolved_cwd.to_string_lossy(), &config)
        .await?;
    host.shutdown().await;
    Ok(session_id)
}

pub struct AcpCancelHandle {
    stdin: Arc<Mutex<ChildStdin>>,
    session_id: Arc<Mutex<Option<String>>>,
    cancelled: AtomicBool,
}

impl AcpCancelHandle {
    pub async fn prepare_for_turn(&self) {
        self.cancelled.store(false, Ordering::Release);
        *self.session_id.lock().await = None;
    }

    async fn set_session_id(&self, session_id: String) {
        *self.session_id.lock().await = Some(session_id.clone());
        if self.cancelled.load(Ordering::Acquire) {
            let _ = self.send_cancel(&session_id).await;
        }
    }

    pub async fn cancel(&self) {
        if self.cancelled.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Some(session_id) = self.session_id.lock().await.clone() {
            let _ = self.send_cancel(&session_id).await;
        }
    }

    async fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub async fn session_id(&self) -> Option<String> {
        self.session_id.lock().await.clone()
    }

    async fn send_cancel(&self, session_id: &str) -> Result<(), String> {
        let mut encoded = serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": { "sessionId": session_id },
        }))
        .map_err(|error| error.to_string())?;
        encoded.push(b'\n');
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(&encoded)
            .await
            .map_err(|error| format!("Grok Core ACP cancel failed: {error}"))?;
        stdin.flush().await.map_err(|error| error.to_string())
    }
}

pub struct AcpHost {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    lines: Lines<BufReader<ChildStdout>>,
    next_id: u64,
    pgid: i32,
    launch_key: String,
    loaded_sessions: HashSet<String>,
    cancel_handle: Arc<AcpCancelHandle>,
    /// Background task id -> the run that started it. A host can be reused by
    /// a later turn while an earlier turn's monitor is still pending, so this
    /// ownership must not be represented by one host-global boolean/set.
    pending_background: HashMap<String, String>,
    watch_labels: HashMap<String, String>,
    watching_run_id: Option<String>,
    watching_emitted: bool,
    watch_started_at: Option<i64>,
}

pub struct TurnResult {
    pub session_id: String,
    pub stop_reason: String,
    pub request_id: String,
}

impl AcpHost {
    pub async fn connect(binary: &Path, cwd: &Path, config: &CoreConfig) -> Result<Self, String> {
        if !binary.is_file() {
            return Err(format!("grok binary not found at {:?}", binary));
        }
        // The legacy runner already removes a dead auth lock before spawn.
        // ACP launches the child directly, so it must perform the same
        // cleanup or a killed older Grok can leave this host blocked before
        // it emits initialize/session responses.
        #[cfg(unix)]
        process::cleanup_stale_grok_lock();
        let resolved_cwd = if cwd.is_dir() {
            cwd.to_path_buf()
        } else {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."))
        };
        let mut command = Command::new(binary);
        command
            .args(config.launch_args())
            .current_dir(resolved_cwd)
            .envs(process::default_proxy_env())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        unsafe {
            command.pre_exec(|| {
                nix::unistd::setpgid(nix::unistd::Pid::from_raw(0), nix::unistd::Pid::from_raw(0))
                    .map_err(io::Error::other)
            });
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("failed to start Grok Core ACP host: {e}"))?;
        let pgid = child
            .id()
            .ok_or_else(|| "Grok Core exited before startup".to_string())?
            as i32;
        let stdin = child.stdin.take().ok_or("Grok Core stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("Grok Core stdout unavailable")?;
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if std::env::var("GROK_DESKTOP_QUIET_GROK_STDERR").as_deref() != Ok("1") {
                        eprintln!("[grok core] {line}");
                    }
                }
            });
        }
        let stdin = Arc::new(Mutex::new(stdin));
        let cancel_handle = Arc::new(AcpCancelHandle {
            stdin: stdin.clone(),
            session_id: Arc::new(Mutex::new(None)),
            cancelled: AtomicBool::new(false),
        });
        let mut host = Self {
            child,
            stdin,
            lines: BufReader::new(stdout).lines(),
            next_id: 1,
            pgid,
            launch_key: config.launch_key(binary),
            loaded_sessions: HashSet::new(),
            cancel_handle,
            pending_background: HashMap::new(),
            watch_labels: HashMap::new(),
            watching_run_id: None,
            watching_emitted: false,
            watch_started_at: None,
        };
        host.request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
                "clientInfo": { "name": "grok-build-desktop", "version": env!("CARGO_PKG_VERSION") }
            }),
            None,
        )
        .await?;
        Ok(host)
    }

    pub fn matches(&mut self, binary: &Path, config: &CoreConfig) -> bool {
        self.launch_key == config.launch_key(binary)
            && self.child.try_wait().ok().flatten().is_none()
    }

    pub fn pgid(&self) -> i32 {
        self.pgid
    }

    pub fn cancel_handle(&self) -> Arc<AcpCancelHandle> {
        self.cancel_handle.clone()
    }

    /// Create an empty session while the UI is idle so the first prompt does
    /// not pay the session/new round-trip. The caller only uses this for a
    /// lane that has no existing conversation head.
    pub async fn prewarm_session(&mut self, cwd: &Path, config: &CoreConfig) -> Result<String, String> {
        let resolved_cwd = if cwd.is_absolute() && cwd.is_dir() {
            cwd.to_path_buf()
        } else {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/"))
        };
        self.new_session(&resolved_cwd.to_string_lossy(), config).await
    }

    /// Stop this ACP client and wait for it to release/flush its session.
    /// `/cli` handoff and shared-session rewind must not race a Drop-triggered
    /// background termination with the next `session/load`.
    pub async fn shutdown(&mut self) {
        #[cfg(unix)]
        {
            let _ = nix::sys::signal::killpg(
                nix::unistd::Pid::from_raw(self.pgid),
                nix::sys::signal::Signal::SIGTERM,
            );
        }
        #[cfg(not(unix))]
        {
            let _ = self.child.start_kill();
        }
        if timeout(Duration::from_secs(2), self.child.wait())
            .await
            .is_err()
        {
            let _ = self.child.start_kill();
            let _ = timeout(Duration::from_secs(1), self.child.wait()).await;
        }
    }

    async fn rewind_last_user_turn(
        &mut self,
        cwd: &Path,
        session_id: &str,
        config: &CoreConfig,
        undone_preview: Option<&str>,
    ) -> Result<RewindResult, String> {
        let resolved_cwd = if cwd.is_absolute() && cwd.is_dir() {
            cwd.to_path_buf()
        } else {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/"))
        };
        let cwd = resolved_cwd.to_string_lossy();
        // On the shared leader the TUI already holds this session. A second
        // session/load replays the transcript into the pager and the next
        // assistant turn often renders blank. Ask for points first; load only
        // if this client cannot see the session.
        let mut points = self
            .request(
                "_x.ai/rewind/points",
                json!({ "sessionId": session_id }),
                None,
            )
            .await;
        if points.is_err() {
            match self
                .request(
                    "session/load",
                    session_open_params(&cwd, config, Some(session_id)),
                    None,
                )
                .await
            {
                Ok(_) => {}
                Err(error) if config.uses_shared_leader() => {
                    return Err(format!(
                        "session/load failed for shared session {session_id}; refusing rewind from an unbound ACP client: {error}"
                    ));
                }
                Err(error) => return Err(error),
            }
            points = self
                .request(
                    "_x.ai/rewind/points",
                    json!({ "sessionId": session_id }),
                    None,
                )
                .await;
        }
        let points = points?;
        let Some(target) = kept_prompt_index_for_undo(&points, undone_preview)
            .map_err(|error| format!("cannot safely target rewind: {error}"))?
        else {
            return Ok(RewindResult {
                rewound: false,
                kept_prompt_index: None,
            });
        };
        let execute_params = json!({
            "sessionId": session_id,
            "targetPromptIndex": target,
            "conversationOnly": true,
            "conversation_only": true
        });
        let mut result = self
            .request("_x.ai/rewind/execute", execute_params.clone(), None)
            .await?;
        // A second client on the leader can list points without load, but
        // execute then returns success:false and the TUI context is unchanged.
        if result.get("success").and_then(Value::as_bool) == Some(false) {
            match self
                .request(
                    "session/load",
                    session_open_params(&cwd, config, Some(session_id)),
                    None,
                )
                .await
            {
                Ok(_) => {
                    result = self
                        .request("_x.ai/rewind/execute", execute_params, None)
                        .await?;
                }
                Err(error) => return Err(error),
            }
        }
        if result.get("success").and_then(Value::as_bool) == Some(false) {
            let detail = result
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("rewind failed");
            return Err(detail.to_string());
        }
        Ok(RewindResult {
            rewound: true,
            kept_prompt_index: Some(target),
        })
    }

    pub async fn run_turn(
        &mut self,
        run_id: &str,
        prompt: &str,
        cwd: &Path,
        config: &CoreConfig,
        tx: &broadcast::Sender<QueueMessage>,
        prewarmed_session_id: Option<&str>,
    ) -> Result<TurnResult, String> {
        // The chat surface is allowed to enqueue with an empty repository
        // path. ACP requires an absolute cwd for every session operation, so
        // use the same safe fallback as process startup instead of forwarding
        // an empty/relative path and failing session/new with -32602.
        let resolved_cwd = if cwd.is_absolute() && cwd.is_dir() {
            cwd.to_path_buf()
        } else {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/"))
        };
        let cwd = resolved_cwd.to_string_lossy();
        let session_id = if let Some(id) = prewarmed_session_id {
            id.to_string()
        } else if let Some(id) = &config.resume_session_id {
            if self.loaded_sessions.contains(id) {
                id.clone()
            } else {
                match self
                    .request(
                        "session/load",
                        session_open_params(&cwd, config, Some(id)),
                        None,
                    )
                    .await
                {
                    Ok(result) => {
                        let loaded = result
                            .get("sessionId")
                            .and_then(Value::as_str)
                            .unwrap_or(id)
                            .to_string();
                        self.loaded_sessions.insert(loaded.clone());
                        loaded
                    }
                    Err(error) => {
                        reject_unloaded_shared_session(config, id, &error)?;
                        eprintln!(
                            "[grok core] session/load failed; creating a new session: {error}"
                        );
                        self.new_session(&cwd, config).await?
                    }
                }
            }
        } else {
            self.new_session(&cwd, config).await?
        };

        self.cancel_handle.set_session_id(session_id.clone()).await;
        if self.cancel_handle.is_cancelled().await {
            return Err("user cancelled".into());
        }

        let prompt_blocks = content_blocks(prompt, config);
        let mut prompt_params = json!({
            "sessionId": session_id,
            "prompt": prompt_blocks
        });
        if let Some(rules) = config
            .rules
            .as_deref()
            .filter(|rules| !rules.trim().is_empty())
        {
            // Per-turn policy (Plan / undo replay) stays in `_meta`, never
            // as a User content block — that leaked into the CLI transcript.
            prompt_params["_meta"] = json!({ "rules": rules });
        }
        let result = self
            .request("session/prompt", prompt_params, Some((run_id, tx, config)))
            .await?;
        Ok(TurnResult {
            session_id,
            stop_reason: result
                .get("stopReason")
                .and_then(Value::as_str)
                .unwrap_or("EndTurn")
                .to_string(),
            request_id: result
                .get("requestId")
                .and_then(Value::as_str)
                .unwrap_or("acp")
                .to_string(),
        })
    }

    async fn new_session(&mut self, cwd: &str, config: &CoreConfig) -> Result<String, String> {
        let result = self
            .request("session/new", session_open_params(cwd, config, None), None)
            .await?;
        let session_id = result
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "session/new returned no sessionId".to_string())?;
        self.loaded_sessions.insert(session_id.clone());
        Ok(session_id)
    }

    async fn request(
        &mut self,
        method: &str,
        params: Value,
        live: Option<(&str, &broadcast::Sender<QueueMessage>, &CoreConfig)>,
    ) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.write(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await?;
        loop {
            // A prompt can legitimately spend more than 420 seconds inside a
            // tool or background task without producing an ACP line. An idle
            // stdout timer here would kill a live turn and report it as a
            // transport failure. Control/handshake requests retain a bound;
            // an active prompt ends when ACP replies, the child exits, or the
            // user cancels the run through the process group.
            let line = if !uses_idle_timeout(method) {
                self.lines
                    .next_line()
                    .await
                    .map_err(|e| format!("Grok Core ACP read failed: {e}"))?
            } else {
                timeout(Duration::from_secs(420), self.lines.next_line())
                    .await
                    .map_err(|_| format!("Grok Core ACP timed out waiting for {method}"))?
                    .map_err(|e| format!("Grok Core ACP read failed: {e}"))?
            };
            let line = line.ok_or_else(|| "Grok Core ACP stream closed".to_string())?;
            let message: Value = match serde_json::from_str(&line) {
                Ok(message) => message,
                Err(_) => continue,
            };
            if message.get("id").and_then(Value::as_u64) == Some(id)
                && message.get("method").is_none()
            {
                if let Some(error) = message.get("error") {
                    return Err(format!("{method}: {error}"));
                }
                return Ok(message.get("result").cloned().unwrap_or(Value::Null));
            }
            if message.get("id").is_some() && message.get("method").is_some() {
                self.answer_client_request(&message, live.map(|(_, _, config)| config))
                    .await?;
            } else if let Some((run_id, tx, _)) = live {
                self.track_background(&message, Some(run_id), Some(tx));
                emit_notification(run_id, tx, &message);
            }
        }
    }

    async fn answer_client_request(
        &mut self,
        message: &Value,
        config: Option<&CoreConfig>,
    ) -> Result<(), String> {
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        if method == "session/request_permission" {
            let options = message
                .pointer("/params/options")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let may_approve = config.is_some_and(|c| c.always_approve);
            let review_only = config.is_some_and(|c| c.review_only);
            let cancel_requested = self.cancel_handle.is_cancelled().await;
            let result = permission_result(&options, may_approve, review_only, cancel_requested);
            self.write(&json!({ "jsonrpc": "2.0", "id": id, "result": result }))
                .await
        } else {
            self.write(&json!({
                "jsonrpc": "2.0", "id": id,
                "error": { "code": -32601, "message": format!("unsupported ACP client request: {method}") }
            }))
            .await
        }
    }

    async fn write(&self, value: &Value) -> Result<(), String> {
        let mut encoded = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        encoded.push(b'\n');
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(&encoded)
            .await
            .map_err(|e| format!("Grok Core ACP write failed: {e}"))?;
        stdin.flush().await.map_err(|e| e.to_string())
    }

    pub fn begin_idle_watch(&mut self, run_id: &str, tx: &broadcast::Sender<QueueMessage>) {
        self.watching_run_id = Some(run_id.to_string());
        self.watching_emitted = false;
        self.watch_started_at = None;
        self.sync_watching(tx, false);
    }

    pub fn end_idle_watch(&mut self, tx: &broadcast::Sender<QueueMessage>) {
        self.emit_watch_state(tx, false);
        self.watching_run_id = None;
        self.watch_started_at = None;
    }

    fn track_background(
        &mut self,
        message: &Value,
        owner_run_id: Option<&str>,
        tx: Option<&broadcast::Sender<QueueMessage>>,
    ) {
        match background_task_delta(message) {
            Some(BackgroundDelta::Started { id, label }) => {
                let Some(owner_run_id) = owner_run_id else {
                    return;
                };
                self.pending_background
                    .insert(id, owner_run_id.to_string());
                if let Some(label) = label.filter(|value| !value.is_empty()) {
                    self.watch_labels
                        .insert(owner_run_id.to_string(), label);
                }
            }
            Some(BackgroundDelta::Finished { id }) => {
                let Some(owner_run_id) = self.pending_background.remove(&id) else {
                    return;
                };
                if !self.has_pending_background(&owner_run_id) {
                    self.watch_labels.remove(&owner_run_id);
                    if self.watching_run_id.as_deref() == Some(owner_run_id.as_str()) {
                        if let Some(tx) = tx {
                            self.emit_watch_state(tx, false);
                        }
                    }
                }
            }
            None => {}
        }
    }

    fn has_pending_background(&self, run_id: &str) -> bool {
        has_pending_background_for(&self.pending_background, run_id)
    }

    fn emit_watch_state(&mut self, tx: &broadcast::Sender<QueueMessage>, active: bool) {
        let Some(run_id) = self.watching_run_id.clone() else {
            return;
        };
        if self.watching_emitted == active {
            return;
        }
        self.watching_emitted = active;
        if active {
            if self.watch_started_at.is_none() {
                self.watch_started_at = Some(Utc::now().timestamp_millis());
            }
        } else {
            self.watch_started_at = None;
        }
        let label = self.watch_labels.get(&run_id).cloned();
        let _ = tx.send(QueueMessage {
            run_id,
            kind: QueueMessageKind::Watching {
                active,
                started_at: self.watch_started_at,
                label,
            },
        });
    }

    fn sync_watching(&mut self, tx: &broadcast::Sender<QueueMessage>, wakeup_active: bool) {
        let active = self
            .watching_run_id
            .as_deref()
            .is_some_and(|run_id| !wakeup_active && self.has_pending_background(run_id));
        self.emit_watch_state(tx, active);
    }

    /// Keep draining ACP stdout after `session/prompt` returns so monitor /
    /// background-task wakeups become their own run instead of sitting in the
    /// pipe until the next user prompt steals them.
    pub async fn watch_idle(
        &mut self,
        tx: &broadcast::Sender<QueueMessage>,
        mut stop: watch::Receiver<bool>,
        config: &CoreConfig,
        lane_id: &str,
    ) -> Result<(), String> {
        let mut wakeup_run: Option<String> = None;
        let mut wakeup_session: Option<String> = None;
        loop {
            let stop_requested = *stop.borrow();
            if stop_requested && wakeup_run.is_none() {
                self.drain_idle_buffered(tx, config, lane_id, &mut wakeup_run, &mut wakeup_session)
                    .await?;
                if wakeup_run.is_none() {
                    return Ok(());
                }
            }
            tokio::select! {
                biased;
                changed = stop.changed() => {
                    if changed.is_err() {
                        return Ok(());
                    }
                }
                line = self.lines.next_line() => {
                    let line = line
                        .map_err(|e| format!("Grok Core ACP read failed: {e}"))?
                        .ok_or_else(|| "Grok Core ACP stream closed".to_string())?;
                    self.dispatch_idle_line(
                        &line,
                        tx,
                        config,
                        lane_id,
                        &mut wakeup_run,
                        &mut wakeup_session,
                    )
                    .await?;
                    if *stop.borrow() && wakeup_run.is_none() {
                        return Ok(());
                    }
                }
            }
        }
    }

    async fn drain_idle_buffered(
        &mut self,
        tx: &broadcast::Sender<QueueMessage>,
        config: &CoreConfig,
        lane_id: &str,
        wakeup_run: &mut Option<String>,
        wakeup_session: &mut Option<String>,
    ) -> Result<(), String> {
        loop {
            match timeout(Duration::from_millis(50), self.lines.next_line()).await {
                Ok(Ok(Some(line))) => {
                    self.dispatch_idle_line(
                        &line,
                        tx,
                        config,
                        lane_id,
                        wakeup_run,
                        wakeup_session,
                    )
                    .await?;
                }
                _ => return Ok(()),
            }
        }
    }

    async fn dispatch_idle_line(
        &mut self,
        line: &str,
        tx: &broadcast::Sender<QueueMessage>,
        config: &CoreConfig,
        lane_id: &str,
        wakeup_run: &mut Option<String>,
        wakeup_session: &mut Option<String>,
    ) -> Result<(), String> {
        let message: Value = match serde_json::from_str(line) {
            Ok(message) => message,
            Err(_) => return Ok(()),
        };
        if message.get("id").is_some() && message.get("method").is_some() {
            return self.answer_client_request(&message, Some(config)).await;
        }
        if message.get("id").is_some() && message.get("method").is_none() {
            return Ok(());
        }
        let owner_run_id = wakeup_run
            .as_deref()
            .map(str::to_string)
            .or_else(|| self.watching_run_id.clone());
        self.track_background(&message, owner_run_id.as_deref(), Some(tx));
        let action = idle_notification_action(&message);
        match action {
            IdleNotificationAction::Ignore => {
                if let Some(run_id) = wakeup_run.as_deref() {
                    emit_notification(run_id, tx, &message);
                }
            }
            action @ (IdleNotificationAction::HideAndEnsureRun
            | IdleNotificationAction::EnsureRun) => {
                let hide = action == IdleNotificationAction::HideAndEnsureRun;
                let session_id = notification_session_id(&message);
                if let Some(session_id) = session_id.clone() {
                    *wakeup_session = Some(session_id);
                }
                let run_id = match wakeup_run.as_ref() {
                    Some(id) => id.clone(),
                    None => {
                        let id = Uuid::now_v7().to_string();
                        let now = Utc::now().timestamp_millis();
                        let _ = tx.send(QueueMessage {
                            run_id: id.clone(),
                            kind: QueueMessageKind::WakeupRun {
                                session_id: wakeup_session.clone(),
                                lane_id: lane_id.to_string(),
                            },
                        });
                        let _ = tx.send(QueueMessage {
                            run_id: id.clone(),
                            kind: QueueMessageKind::StateChanged {
                                state: super::db::RunState::Running,
                                started_at: Some(now),
                                ended_at: None,
                                error: None,
                            },
                        });
                        *wakeup_run = Some(id.clone());
                        id
                    }
                };
                if !hide {
                    emit_notification(&run_id, tx, &message);
                }
            }
            IdleNotificationAction::EndRun => {
                if let Some(run_id) = wakeup_run.take() {
                    let session_id = notification_session_id(&message)
                        .or_else(|| wakeup_session.clone())
                        .unwrap_or_default();
                    let event = GrokEvent::End {
                        stop_reason: "EndTurn".into(),
                        session_id: session_id.clone(),
                        request_id: "wakeup".into(),
                    };
                    let raw = serde_json::to_value(&event).unwrap_or(Value::Null);
                    let _ = tx.send(QueueMessage {
                        run_id: run_id.clone(),
                        kind: QueueMessageKind::Event {
                            event,
                            raw,
                            session_id: Some(session_id),
                        },
                    });
                    let _ = tx.send(QueueMessage {
                        run_id,
                        kind: QueueMessageKind::StateChanged {
                            state: super::db::RunState::Done,
                            started_at: None,
                            ended_at: Some(Utc::now().timestamp_millis()),
                            error: None,
                        },
                    });
                }
            }
        }
        self.sync_watching(tx, wakeup_run.is_some());
        Ok(())
    }
}

fn has_pending_background_for(pending: &HashMap<String, String>, run_id: &str) -> bool {
    pending.values().any(|owner| owner == run_id)
}

fn uses_idle_timeout(method: &str) -> bool {
    method != "session/prompt"
}

fn permission_result(
    options: &[Value],
    may_approve: bool,
    review_only: bool,
    cancel_requested: bool,
) -> Value {
    let find_option = |needle: &str| {
        options.iter().find(|option| {
            let label = format!(
                "{} {}",
                option.get("name").and_then(Value::as_str).unwrap_or(""),
                option.get("kind").and_then(Value::as_str).unwrap_or("")
            )
            .to_lowercase();
            label.contains(needle)
        })
    };
    let chosen = if cancel_requested {
        find_option("cancel")
    } else if review_only {
        find_option("deny").or_else(|| find_option("reject"))
    } else if may_approve {
        find_option("always")
            .or_else(|| find_option("approve"))
            .or_else(|| find_option("allow"))
    } else {
        // Desktop has no interactive permission sheet in the ACP path. Patch
        // is therefore a bounded approval: choose a one-shot option for each
        // protected request, while Autopilot may choose the broader allow
        // option exposed by the server.
        find_option("once")
            .or_else(|| find_option("allow"))
            .or_else(|| find_option("approve"))
    };
    chosen
        .and_then(|option| option.get("optionId").or_else(|| option.get("option_id")))
        .cloned()
        .map(|option_id| json!({ "outcome": { "outcome": "selected", "optionId": option_id } }))
        .unwrap_or_else(|| json!({ "outcome": { "outcome": "cancelled" } }))
}

/// ACP `session/new` and `session/load` identity params.
///
/// Desktop `--rules` must travel as `_meta.rules` (system prompt). Putting them
/// in `session/prompt` text makes a visible User turn; Grok CLI then shows that
/// dump when `/cli` resumes the shared session.
fn session_open_params(cwd: &str, config: &CoreConfig, session_id: Option<&str>) -> Value {
    let mut params = json!({ "cwd": cwd, "mcpServers": [] });
    if let Some(session_id) = session_id {
        params["sessionId"] = json!(session_id);
    }
    if let Some(rules) = config
        .rules
        .as_deref()
        .filter(|rules| !rules.trim().is_empty())
    {
        params["_meta"] = json!({ "rules": rules });
    }
    params
}

fn content_blocks(prompt: &str, config: &CoreConfig) -> Vec<Value> {
    config
        .prompt_blocks
        .clone()
        .unwrap_or_else(|| vec![json!({ "type": "text", "text": prompt })])
}

impl Drop for AcpHost {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            let _ = nix::sys::signal::killpg(
                nix::unistd::Pid::from_raw(self.pgid),
                nix::sys::signal::Signal::SIGTERM,
            );
        }
        let _ = self.child.start_kill();
    }
}

fn emit_notification(run_id: &str, tx: &broadcast::Sender<QueueMessage>, message: &Value) {
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    if method != "session/update"
        && method != "_x.ai/session/update"
        && method != "x.ai/session_notification"
        && method != "_x.ai/session_notification"
    {
        return;
    }
    let update = message
        .pointer("/params/update")
        .cloned()
        .unwrap_or_else(|| message.get("params").cloned().unwrap_or(Value::Null));
    // ACP puts the session identity on the notification envelope, not inside
    // the update payload. Preserve it so the renderer can keep child-agent
    // thought/respond/tool traffic out of the parent transcript.
    let session_id = message
        .pointer("/params/sessionId")
        .or_else(|| message.pointer("/params/session_id"))
        .or_else(|| update.get("sessionId"))
        .or_else(|| update.get("session_id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let kind = update
        .get("sessionUpdate")
        .or_else(|| update.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let event = match kind {
        "agent_message_chunk" => GrokEvent::Text {
            data: update
                .pointer("/content/text")
                .or_else(|| update.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        },
        "agent_thought_chunk" => GrokEvent::Thought {
            data: update
                .pointer("/content/text")
                .or_else(|| update.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        },
        _ => GrokEvent::Unknown,
    };
    let _ = tx.send(QueueMessage {
        run_id: run_id.to_string(),
        kind: QueueMessageKind::Event {
            event,
            raw: update,
            session_id,
        },
    });
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdleNotificationAction {
    Ignore,
    HideAndEnsureRun,
    EnsureRun,
    EndRun,
}

fn notification_update(message: &Value) -> &Value {
    message
        .pointer("/params/update")
        .or_else(|| message.get("params"))
        .unwrap_or(message)
}

fn notification_method(message: &Value) -> &str {
    message.get("method").and_then(Value::as_str).unwrap_or("")
}

fn is_session_notification_method(method: &str) -> bool {
    matches!(
        method,
        "session/update"
            | "_x.ai/session/update"
            | "x.ai/session_notification"
            | "_x.ai/session_notification"
            | "x.ai/task_backgrounded"
            | "_x.ai/task_backgrounded"
            | "x.ai/task_completed"
            | "_x.ai/task_completed"
    )
}

fn notification_kind<'a>(message: &'a Value, update: &'a Value) -> &'a str {
    match notification_method(message) {
        "x.ai/task_backgrounded" | "_x.ai/task_backgrounded" => "task_backgrounded",
        "x.ai/task_completed" | "_x.ai/task_completed" => "task_completed",
        _ => update
            .get("sessionUpdate")
            .or_else(|| update.get("type"))
            .and_then(Value::as_str)
            .unwrap_or(""),
    }
}

fn notification_session_id(message: &Value) -> Option<String> {
    let update = notification_update(message);
    message
        .pointer("/params/sessionId")
        .or_else(|| message.pointer("/params/session_id"))
        .or_else(|| update.get("sessionId"))
        .or_else(|| update.get("session_id"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn hidden_synthetic_user(update: &Value) -> bool {
    let hide = update
        .pointer("/content/_meta/hideFromScrollback")
        .or_else(|| update.pointer("/_meta/hideFromScrollback"))
        .and_then(Value::as_bool)
        == Some(true);
    if hide {
        return true;
    }
    let text = update
        .pointer("/content/text")
        .or_else(|| update.get("text"))
        .and_then(Value::as_str)
        .unwrap_or("");
    text.contains("<system-reminder>") && !text.contains("<user_query")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackgroundDelta {
    Started { id: String, label: Option<String> },
    Finished { id: String },
}

fn background_task_id(update: &Value) -> Option<String> {
    let value = update
        .get("task_id")
        .or_else(|| update.get("taskId"))
        .or_else(|| update.pointer("/task_snapshot/task_id"))
        .or_else(|| update.pointer("/task_snapshot/taskId"));
    match value {
        Some(Value::String(value)) if !value.trim().is_empty() => Some(value.clone()),
        Some(Value::Number(value)) => Some(value.to_string()),
        _ => None,
    }
}

fn background_task_label(update: &Value) -> Option<String> {
    update
        .get("monitor_description")
        .or_else(|| update.get("monitorDescription"))
        .or_else(|| update.get("description"))
        .or_else(|| update.pointer("/task_snapshot/description"))
        .or_else(|| update.pointer("/task_snapshot/monitor_description"))
        .or_else(|| update.pointer("/task_snapshot/monitorDescription"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub fn background_task_delta(message: &Value) -> Option<BackgroundDelta> {
    if !is_session_notification_method(notification_method(message)) {
        return None;
    }
    let update = notification_update(message);
    let kind = notification_kind(message, update);
    match kind {
        "task_backgrounded" => Some(BackgroundDelta::Started {
            id: background_task_id(update)?,
            label: background_task_label(update),
        }),
        "task_completed" => Some(BackgroundDelta::Finished {
            id: background_task_id(update)?,
        }),
        _ => None,
    }
}

/// Classify an ACP notification that arrived while no session/prompt is open.
pub fn idle_notification_action(message: &Value) -> IdleNotificationAction {
    if !is_session_notification_method(notification_method(message)) {
        return IdleNotificationAction::Ignore;
    }
    let update = notification_update(message);
    let kind = notification_kind(message, update);
    match kind {
        "turn_completed" => IdleNotificationAction::EndRun,
        "task_completed"
            if update
                .get("will_wake")
                .or_else(|| update.get("willWake"))
                .and_then(Value::as_bool)
                == Some(true) =>
        {
            IdleNotificationAction::EnsureRun
        }
        "user_message_chunk" if hidden_synthetic_user(update) => {
            IdleNotificationAction::HideAndEnsureRun
        }
        "agent_thought_chunk" | "agent_message_chunk" | "tool_call" | "tool_call_update" => {
            IdleNotificationAction::EnsureRun
        }
        _ => IdleNotificationAction::Ignore,
    }
}

pub async fn stop_process_group(pgid: i32) {
    process::kill_group(pgid).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_wait_does_not_use_idle_transport_timeout() {
        // Long-running tools can leave ACP stdout quiet while the prompt is
        // still live. The request must remain cancellable, not time out here.
        assert!(!uses_idle_timeout("session/prompt"));
        assert!(uses_idle_timeout("initialize"));
        assert!(uses_idle_timeout("session/load"));
    }

    #[test]
    fn background_tasks_stay_owned_by_their_original_run() {
        let pending = HashMap::from([
            ("task-a".to_string(), "run-a".to_string()),
            ("task-b".to_string(), "run-b".to_string()),
        ]);
        assert!(has_pending_background_for(&pending, "run-a"));
        assert!(has_pending_background_for(&pending, "run-b"));
        assert!(!has_pending_background_for(&pending, "run-c"));
    }

    #[test]
    fn converts_legacy_run_flags_to_core_config() {
        let args = vec![
            "--model".into(),
            "grok-build".into(),
            "--reasoning-effort".into(),
            "xhigh".into(),
            "--resume".into(),
            "session-1".into(),
            "--permission-mode".into(),
            "plan".into(),
            "--always-approve".into(),
        ];
        let config = CoreConfig::from_legacy_args(&args);
        assert_eq!(config.model.as_deref(), Some("grok-build"));
        assert_eq!(config.reasoning_effort.as_deref(), Some("xhigh"));
        assert_eq!(config.resume_session_id.as_deref(), Some("session-1"));
        assert_eq!(config.permission_mode.as_deref(), Some("plan"));
        assert!(config.always_approve);
        assert!(!config.share_session);
        assert!(config.prompt_blocks.is_none());
        assert!(config.launch_args().contains(&"--no-leader".to_string()));
    }

    #[test]
    fn forwards_experimental_memory_before_agent_subcommand() {
        let enabled = CoreConfig::from_legacy_args(&["--experimental-memory".into()]);
        let launch = enabled.launch_args();
        assert!(enabled.experimental_memory);
        assert_eq!(
            launch.first().map(String::as_str),
            Some("--experimental-memory")
        );
        assert_eq!(launch.get(1).map(String::as_str), Some("agent"));

        let disabled = CoreConfig::from_legacy_args(&[]);
        assert!(!disabled.experimental_memory);
        assert_eq!(
            disabled.launch_args().first().map(String::as_str),
            Some("agent")
        );
    }

    #[test]
    fn forwards_tool_disables_before_agent_subcommand() {
        let config =
            CoreConfig::from_legacy_args(&["--disable-web-search".into(), "--no-subagents".into()]);
        assert!(config.web_search_disabled);
        assert!(config.subagents_disabled);

        let launch = config.launch_args();
        let agent = launch
            .iter()
            .position(|arg| arg == "agent")
            .expect("agent subcommand");
        assert!(launch
            .iter()
            .position(|arg| arg == "--disable-web-search")
            .is_some_and(|index| index < agent));
        assert!(launch
            .iter()
            .position(|arg| arg == "--no-subagents")
            .is_some_and(|index| index < agent));

        let defaults = CoreConfig::from_legacy_args(&[]).launch_args();
        assert!(!defaults.contains(&"--disable-web-search".to_string()));
        assert!(!defaults.contains(&"--no-subagents".to_string()));
    }

    #[test]
    fn last_kept_prompt_is_the_second_newest_rewind_point() {
        let points = json!({
            "rewind_points": [
                { "prompt_index": 0 },
                { "prompt_index": 1 },
                { "prompt_index": 2 }
            ]
        });
        assert_eq!(last_kept_prompt_index(&points), Some(1));
        assert_eq!(
            last_kept_prompt_index(&json!({ "rewind_points": [{ "prompt_index": 0 }] })),
            None
        );
        assert_eq!(
            last_kept_prompt_index(&json!({ "rewind_points": [] })),
            None
        );
        let labeled = json!({
            "rewind_points": [
                { "prompt_index": 0, "prompt_preview": "hello" },
                { "prompt_index": 1, "prompt_preview": "from desktop" },
                { "prompt_index": 2, "prompt_preview": "from CLI" }
            ]
        });
        assert_eq!(
            kept_prompt_index_for_undo(&labeled, Some("from desktop")),
            Err(RewindTargetError::NewerPrompts { count: 1 })
        );
    }

    #[test]
    fn rewind_preview_matching_accepts_unique_truncation_but_rejects_unsafe_matches() {
        let non_prefix = json!({
            "rewind_points": [
                { "prompt_index": 0, "prompt_preview": "setup" },
                { "prompt_index": 1, "prompt_preview": "deploy production" }
            ]
        });
        assert_eq!(
            kept_prompt_index_for_undo(&non_prefix, Some("please deploy production now")),
            Err(RewindTargetError::PreviewNotFound)
        );

        let truncated = json!({
            "rewind_points": [
                { "prompt_index": 0, "prompt_preview": "setup" },
                { "prompt_index": 1, "prompt_preview": "deploy production" }
            ]
        });
        assert_eq!(
            kept_prompt_index_for_undo(
                &truncated,
                Some("deploy production after the final smoke test")
            ),
            Ok(Some(0))
        );

        let duplicate = json!({
            "rewind_points": [
                { "prompt_index": 0, "prompt_preview": "continue" },
                { "prompt_index": 1, "prompt_preview": "continue" },
                { "prompt_index": 2, "prompt_preview": "from CLI" }
            ]
        });
        assert_eq!(
            kept_prompt_index_for_undo(&duplicate, Some("continue")),
            Err(RewindTargetError::AmbiguousPreview { matches: 2 })
        );
    }

    #[test]
    fn shared_session_load_failure_is_not_treated_as_an_attachment() {
        let config = CoreConfig::from_legacy_args(&[
            "--resume".into(),
            "live-session".into(),
            "--share-session".into(),
        ]);
        let error = reject_unloaded_shared_session(&config, "live-session", "not loaded")
            .expect_err("shared session must fail closed");
        assert!(error.contains("session/load failed for shared session live-session"));
        assert!(error.contains("refusing to prompt an unbound ACP client"));

        let isolated =
            CoreConfig::from_legacy_args(&["--resume".into(), "isolated-session".into()]);
        assert_eq!(
            reject_unloaded_shared_session(&isolated, "isolated-session", "not found"),
            Ok(())
        );
    }

    #[test]
    fn live_share_joins_the_desktop_leader_instead_of_forking() {
        let args = vec![
            "--resume".into(),
            "live-session".into(),
            "--share-session".into(),
        ];
        let config = CoreConfig::from_legacy_args(&args);
        assert!(config.uses_shared_leader());
        let launch = config.launch_args();
        assert!(launch.contains(&"--leader".to_string()));
        assert!(!launch.contains(&"--no-leader".to_string()));
        let socket = desktop_leader_socket().to_string_lossy().into_owned();
        assert!(launch.contains(&socket));
    }

    #[test]
    fn keeps_multimodal_prompt_blocks_for_acp() {
        let args = vec![
            "--prompt-json".into(),
            r#"[{"type":"text","text":"look"},{"type":"image","data":"AA==","mimeType":"image/png"}]"#.into(),
        ];
        let config = CoreConfig::from_legacy_args(&args);
        let blocks = config.prompt_blocks.expect("prompt blocks");
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[1]["type"], "image");
    }

    #[test]
    fn puts_rules_on_session_meta_not_the_user_prompt() {
        let args = vec![
            "--rules".into(),
            "Stay read-only: inspect but do not edit files.".into(),
        ];
        let config = CoreConfig::from_legacy_args(&args);
        assert!(config.review_only);
        let blocks = content_blocks("review this repo", &config);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["text"], "review this repo");
        let params = session_open_params("/tmp/proj", &config, None);
        assert_eq!(
            params["_meta"]["rules"],
            "Stay read-only: inspect but do not edit files."
        );
        let loaded = session_open_params("/tmp/proj", &config, Some("sess-1"));
        assert_eq!(loaded["sessionId"], "sess-1");
        assert_eq!(loaded["_meta"]["rules"], params["_meta"]["rules"]);
    }

    #[test]
    fn desktop_permission_modes_select_distinct_acp_outcomes() {
        let options = vec![
            json!({ "optionId": "deny", "name": "Deny", "kind": "reject" }),
            json!({ "optionId": "once", "name": "Allow once", "kind": "allow_once" }),
            json!({ "optionId": "always", "name": "Allow always", "kind": "allow_always" }),
        ];
        assert_eq!(
            permission_result(&options, false, true, false)["outcome"]["optionId"],
            "deny"
        );
        assert_eq!(
            permission_result(&options, false, false, false)["outcome"]["optionId"],
            "once"
        );
        assert_eq!(
            permission_result(&options, true, false, false)["outcome"]["optionId"],
            "always"
        );
        assert_eq!(
            permission_result(&options, false, false, true)["outcome"]["outcome"],
            "cancelled"
        );
    }

    #[tokio::test]
    async fn maps_acp_text_and_keeps_tool_payloads() {
        let (tx, mut rx) = broadcast::channel(4);
        emit_notification(
            "run-1",
            &tx,
            &json!({
                "method": "session/update",
                "params": { "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "hello" }
                }}
            }),
        );
        let text = rx.recv().await.expect("text event");
        assert!(matches!(
            text.kind,
            QueueMessageKind::Event { event: GrokEvent::Text { ref data }, .. } if data == "hello"
        ));

        emit_notification(
            "run-1",
            &tx,
            &json!({
                "method": "session/update",
                "params": { "update": {
                    "sessionUpdate": "agent_thought_chunk",
                    "content": { "type": "text", "text": "considering" }
                }}
            }),
        );
        let thought = rx.recv().await.expect("thought event");
        assert!(matches!(
            thought.kind,
            QueueMessageKind::Event { event: GrokEvent::Thought { ref data }, .. }
                if data == "considering"
        ));

        emit_notification(
            "run-1",
            &tx,
            &json!({
                "method": "session/update",
                "params": { "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "tool-1",
                    "title": "Read"
                }}
            }),
        );
        let tool = rx.recv().await.expect("tool event");
        assert!(matches!(
            tool.kind,
            QueueMessageKind::Event { event: GrokEvent::Unknown, ref raw, .. }
                if raw.get("toolCallId").and_then(Value::as_str) == Some("tool-1")
        ));
    }

    #[test]
    fn idle_wakeup_hides_synthetic_user_and_ends_on_turn_completed() {
        let hidden = json!({
            "method": "session/update",
            "params": {
                "sessionId": "sess",
                "update": {
                    "sessionUpdate": "user_message_chunk",
                    "content": {
                        "type": "text",
                        "text": "<system-reminder>\nBackground task completed.\n</system-reminder>",
                        "_meta": { "hideFromScrollback": true, "promptIndex": 7 }
                    }
                }
            }
        });
        assert_eq!(
            idle_notification_action(&hidden),
            IdleNotificationAction::HideAndEnsureRun
        );

        let will_wake = json!({
            "method": "_x.ai/session/update",
            "params": {
                "update": {
                    "sessionUpdate": "task_completed",
                    "will_wake": true
                }
            }
        });
        assert_eq!(
            idle_notification_action(&will_wake),
            IdleNotificationAction::EnsureRun
        );

        let assistant = json!({
            "method": "session/update",
            "params": {
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "齐了" }
                }
            }
        });
        assert_eq!(
            idle_notification_action(&assistant),
            IdleNotificationAction::EnsureRun
        );

        let done = json!({
            "method": "_x.ai/session/update",
            "params": {
                "update": { "sessionUpdate": "turn_completed", "stop_reason": "end_turn" }
            }
        });
        assert_eq!(idle_notification_action(&done), IdleNotificationAction::EndRun);

        let visible_user = json!({
            "method": "session/update",
            "params": {
                "update": {
                    "sessionUpdate": "user_message_chunk",
                    "content": { "type": "text", "text": "如何了" }
                }
            }
        });
        assert_eq!(
            idle_notification_action(&visible_user),
            IdleNotificationAction::Ignore
        );

        let backgrounded = json!({
            "method": "_x.ai/session/update",
            "params": {
                "update": {
                    "sessionUpdate": "task_backgrounded",
                    "task_id": "mon-1",
                    "monitor_description": "Watch sleep 15"
                }
            }
        });
        assert_eq!(
            background_task_delta(&backgrounded),
            Some(BackgroundDelta::Started {
                id: "mon-1".into(),
                label: Some("Watch sleep 15".into()),
            })
        );
        let finished = json!({
            "method": "_x.ai/session/update",
            "params": {
                "update": {
                    "sessionUpdate": "task_completed",
                    "task_snapshot": { "task_id": "mon-1" }
                }
            }
        });
        assert_eq!(
            background_task_delta(&finished),
            Some(BackgroundDelta::Finished { id: "mon-1".into() })
        );

        // Grok 1.0 emits the background lifecycle on dedicated x.ai methods,
        // rather than as a sessionUpdate tag. Accept the camelCase payload
        // used by that wire shape as well.
        let dedicated_backgrounded = json!({
            "method": "x.ai/task_backgrounded",
            "params": {
                "sessionId": "sess",
                "taskId": 42,
                "monitorDescription": "Watch build"
            }
        });
        assert_eq!(
            background_task_delta(&dedicated_backgrounded),
            Some(BackgroundDelta::Started {
                id: "42".into(),
                label: Some("Watch build".into()),
            })
        );
        let dedicated_completed = json!({
            "method": "x.ai/task_completed",
            "params": { "sessionId": "sess", "taskId": 42, "willWake": true }
        });
        assert_eq!(
            background_task_delta(&dedicated_completed),
            Some(BackgroundDelta::Finished { id: "42".into() })
        );
        assert_eq!(
            idle_notification_action(&dedicated_completed),
            IdleNotificationAction::EnsureRun
        );
    }
}
