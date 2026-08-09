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
        args.extend(["--no-leader".to_string(), "stdio".to_string()]);
        args
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

    pub async fn run_turn(
        &mut self,
        run_id: &str,
        prompt: &str,
        cwd: &Path,
        config: &CoreConfig,
        tx: &broadcast::Sender<QueueMessage>,
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
        let session_id = if let Some(id) = &config.resume_session_id {
            if self.loaded_sessions.contains(id) {
                id.clone()
            } else {
                match self
                    .request(
                        "session/load",
                        json!({ "sessionId": id, "cwd": cwd, "mcpServers": [] }),
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
                        eprintln!(
                            "[grok core] session/load failed; creating a new session: {error}"
                        );
                        self.new_session(&cwd).await?
                    }
                }
            }
        } else {
            self.new_session(&cwd).await?
        };

        let prompt_blocks = content_blocks(prompt, config);
        let result = self
            .request(
                "session/prompt",
                json!({
                    "sessionId": session_id,
                    "prompt": prompt_blocks
                }),
                Some((run_id, tx, config)),
            )
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

    async fn new_session(&mut self, cwd: &str) -> Result<String, String> {
        let result = self
            .request("session/new", json!({ "cwd": cwd, "mcpServers": [] }), None)
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

fn content_blocks(prompt: &str, config: &CoreConfig) -> Vec<Value> {
    let mut blocks = config
        .prompt_blocks
        .clone()
        .unwrap_or_else(|| vec![json!({ "type": "text", "text": prompt })]);
    // `grok agent stdio` does not accept the legacy CLI's --rules flag.
    // Carry the policy/rules into ACP as a separate instruction block so
    // Plan is behaviorally distinct from Default instead of being a label
    // attached to the same backend configuration.
    if let Some(rules) = config
        .rules
        .as_deref()
        .filter(|rules| !rules.trim().is_empty())
    {
        blocks.insert(
            0,
            json!({
                "type": "text",
                "text": format!("Grok Desktop instructions for this turn:\n{rules}")
            }),
        );
    }
    blocks
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
        assert!(config.prompt_blocks.is_none());
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
    fn carries_read_only_rules_into_the_acp_prompt() {
        let args = vec![
            "--rules".into(),
            "Stay read-only: inspect but do not edit files.".into(),
        ];
        let config = CoreConfig::from_legacy_args(&args);
        assert!(config.review_only);
        let blocks = content_blocks("review this repo", &config);
        assert_eq!(blocks.len(), 2);
        assert!(blocks[0]["text"]
            .as_str()
            .unwrap()
            .contains("Stay read-only"));
        assert_eq!(blocks[1]["text"], "review this repo");
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
