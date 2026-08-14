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
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::broadcast;
use tokio::time::{timeout, Duration};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreConfig {
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub always_approve: bool,
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
            ) {
                2
            } else {
                1
            };
        }
        out
    }

    fn launch_args(&self) -> Vec<String> {
        let mut args = vec!["agent".to_string()];
        if let Some(model) = &self.model {
            args.extend(["--model".to_string(), model.clone()]);
        }
        if let Some(effort) = &self.reasoning_effort {
            args.extend(["--reasoning-effort".to_string(), effort.clone()]);
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

    fn launch_key(&self, binary: &Path) -> String {
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
    let share = desktop_leader_socket_ready();
    let config = CoreConfig {
        model: None,
        reasoning_effort: None,
        always_approve: false,
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

pub struct AcpHost {
    child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    next_id: u64,
    pgid: i32,
    launch_key: String,
    loaded_sessions: HashSet<String>,
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
        let mut host = Self {
            child,
            stdin,
            lines: BufReader::new(stdout).lines(),
            next_id: 1,
            pgid,
            launch_key: config.launch_key(binary),
            loaded_sessions: HashSet::new(),
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
            let line = timeout(Duration::from_secs(420), self.lines.next_line())
                .await
                .map_err(|_| format!("Grok Core ACP timed out waiting for {method}"))?
                .map_err(|e| format!("Grok Core ACP read failed: {e}"))?
                .ok_or_else(|| "Grok Core ACP stream closed".to_string())?;
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
            let result = permission_result(&options, may_approve);
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

    async fn write(&mut self, value: &Value) -> Result<(), String> {
        let mut encoded = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        encoded.push(b'\n');
        self.stdin
            .write_all(&encoded)
            .await
            .map_err(|e| format!("Grok Core ACP write failed: {e}"))?;
        self.stdin.flush().await.map_err(|e| e.to_string())
    }
}

fn permission_result(options: &[Value], may_approve: bool) -> Value {
    let chosen = options.iter().find(|option| {
        let label = format!(
            "{} {}",
            option.get("name").and_then(Value::as_str).unwrap_or(""),
            option.get("kind").and_then(Value::as_str).unwrap_or("")
        )
        .to_lowercase();
        if may_approve {
            label.contains("allow") || label.contains("approve") || label.contains("once")
        } else {
            label.contains("deny") || label.contains("reject") || label.contains("cancel")
        }
    });
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
        kind: QueueMessageKind::Event { event, raw: update },
    });
}

pub async fn stop_process_group(pgid: i32) {
    process::kill_group(pgid).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_legacy_run_flags_to_core_config() {
        let args = vec![
            "--model".into(),
            "grok-build".into(),
            "--reasoning-effort".into(),
            "xhigh".into(),
            "--resume".into(),
            "session-1".into(),
            "--always-approve".into(),
        ];
        let config = CoreConfig::from_legacy_args(&args);
        assert_eq!(config.model.as_deref(), Some("grok-build"));
        assert_eq!(config.reasoning_effort.as_deref(), Some("xhigh"));
        assert_eq!(config.resume_session_id.as_deref(), Some("session-1"));
        assert!(config.always_approve);
        assert!(!config.share_session);
        assert!(config.prompt_blocks.is_none());
        assert!(config.launch_args().contains(&"--no-leader".to_string()));
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
    fn only_auto_mode_approves_protected_acp_actions() {
        let options = vec![
            json!({ "optionId": "deny", "name": "Deny", "kind": "reject" }),
            json!({ "optionId": "once", "name": "Allow once", "kind": "allow_once" }),
        ];
        assert_eq!(
            permission_result(&options, false)["outcome"]["optionId"],
            "deny"
        );
        assert_eq!(
            permission_result(&options, true)["outcome"]["optionId"],
            "once"
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
            QueueMessageKind::Event { event: GrokEvent::Unknown, ref raw }
                if raw.get("toolCallId").and_then(Value::as_str) == Some("tool-1")
        ));
    }
}
