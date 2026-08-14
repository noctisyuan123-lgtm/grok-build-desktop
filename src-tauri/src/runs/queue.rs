use super::core::{self, AcpHost, CoreConfig};
use super::db::{Db, RunRecord, RunState};
use super::event::GrokEvent;
use super::parser::parse_line;
use super::process;
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::AsyncBufReadExt;
use tokio::sync::{broadcast, Mutex, Notify};

/// Capacity of the broadcast channel that fans queue messages out to consumers
/// (the Tauri event forwarder and any future subscribers). Large enough to
/// absorb a burst of streaming-json events without lag.
const BROADCAST_CAPACITY: usize = 1024;

/// How much of grok's stderr we keep for error reporting on a non-zero exit.
pub const STDERR_TAIL_MAX_BYTES: usize = 4096;

/// Lane id used when the UI does not supply one (legacy callers / tests).
/// All such runs share one serial lane.
pub const DEFAULT_LANE_ID: &str = "";

/// Truncate `tail` in place so at most `max_bytes` bytes of its END remain.
/// The cut is moved forward to the next `char` boundary: grok's stderr is
/// arbitrary text (log lines can contain non-ASCII), and a naive byte slice at
/// `len - max_bytes` would panic mid-character and silently kill the
/// stderr-drain task.
pub fn keep_utf8_tail(tail: &mut String, max_bytes: usize) {
    if tail.len() <= max_bytes {
        return;
    }
    let mut cut = tail.len() - max_bytes;
    while !tail.is_char_boundary(cut) {
        cut += 1;
    }
    tail.drain(..cut);
}

#[derive(Debug, Clone, Serialize)]
pub struct QueueMessage {
    pub run_id: String,
    pub kind: QueueMessageKind,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum QueueMessageKind {
    Event {
        event: GrokEvent,
        /// Raw JSON line as emitted by `grok --output-format streaming-json`.
        /// Carried alongside the strongly-typed `event` so the frontend can
        /// recognize new event types (tool_use, subagent_*, etc.) without a
        /// Rust round-trip every time grok extends its protocol.
        raw: serde_json::Value,
    },
    StateChanged {
        state: RunState,
        started_at: Option<i64>,
        ended_at: Option<i64>,
        error: Option<String>,
    },
    QueueChanged,
}

/// One concurrent execution slot, keyed by UI session lane.
struct ActiveSlot {
    run_id: String,
    pgid: Option<i32>,
}

struct PrewarmedSession {
    key: String,
    id: String,
}

pub struct RunQueue {
    pub db: Db,
    inner: Arc<Mutex<Inner>>,
    notify: Arc<Notify>,
    pub tx: broadcast::Sender<QueueMessage>,
    /// Per-lane ACP hosts. A host is *taken* out of the map for the duration
    /// of a turn so concurrent lanes never share a mutex across a turn.
    acp_hosts: Arc<Mutex<HashMap<String, AcpHost>>>,
    prewarmed_sessions: Arc<Mutex<HashMap<String, PrewarmedSession>>>,
}

struct Inner {
    waiting: VecDeque<RunRecord>,
    /// lane_id → currently executing run on that lane.
    active_lanes: HashMap<String, ActiveSlot>,
    cancelled: HashSet<String>,
    /// Follow-up run -> parent run, supplied by the UI session that owns it.
    /// This is deliberately run-scoped rather than cwd-global: different UI
    /// sessions may share a directory without sharing a conversation head.
    parent_runs: HashMap<String, String>,
    /// Session heads emitted by completed runs. A queued child resolves its
    /// parent's head immediately before launch, after the parent has ended.
    completed_sessions: HashMap<String, String>,
    grok_path: PathBuf,
}

impl RunQueue {
    pub async fn new(db: Db, grok_path: PathBuf) -> (Self, broadcast::Receiver<QueueMessage>) {
        // On startup: cancel any Running rows (subprocess died with the previous app).
        let _ = db.cancel_orphans("app restarted").await;
        // Recover Queued rows into memory (do not auto-start — banner handles resume).
        let queued = db.list_by_state(RunState::Queued).await.unwrap_or_default();

        let mut parent_runs = HashMap::new();
        for rec in &queued {
            if let Some(parent) = &rec.parent_run_id {
                parent_runs.insert(rec.id.clone(), parent.clone());
            }
        }

        let inner = Inner {
            waiting: VecDeque::from(queued),
            active_lanes: HashMap::new(),
            cancelled: HashSet::new(),
            parent_runs,
            completed_sessions: HashMap::new(),
            grok_path,
        };
        let (tx, rx) = broadcast::channel(BROADCAST_CAPACITY);
        let queue = Self {
            db,
            inner: Arc::new(Mutex::new(inner)),
            notify: Arc::new(Notify::new()),
            tx,
            acp_hosts: Arc::new(Mutex::new(HashMap::new())),
            prewarmed_sessions: Arc::new(Mutex::new(HashMap::new())),
        };
        (queue, rx)
    }

    /// Subscribe a fresh receiver to the queue's broadcast channel.
    /// Used to attach additional consumers after the
    /// queue is already running. Each receiver gets every event from the
    /// moment of subscription; previously emitted events are not replayed.
    pub fn subscribe(&self) -> broadcast::Receiver<QueueMessage> {
        self.tx.subscribe()
    }

    /// Stop and reap ACP children so `/cli` or rewind can load the same
    /// session only after the previous client has released and flushed it.
    pub async fn evict_acp_hosts(&self) {
        let hosts = {
            let mut hosts = self.acp_hosts.lock().await;
            hosts.drain().map(|(_, host)| host).collect::<Vec<_>>()
        };
        for mut host in hosts {
            host.shutdown().await;
        }
    }

    /// Start and initialize the lane's persistent ACP host ahead of the first
    /// prompt. The map lock deliberately stays held while connecting so a
    /// send racing with the prewarm cannot start a second host for the lane.
    pub async fn prewarm(
        &self,
        lane_id: String,
        cwd: String,
        args: Vec<String>,
    ) -> Result<bool, String> {
        let grok_path = self.inner.lock().await.grok_path.clone();
        if !core::should_use_acp(&grok_path) {
            return Ok(false);
        }
        let config = CoreConfig::from_legacy_args(&args);
        let resolved_cwd = std::path::PathBuf::from(cwd);
        let mut hosts = self.acp_hosts.lock().await;
        if hosts
            .get_mut(&lane_id)
            .is_some_and(|host| host.matches(&grok_path, &config))
        {
            return Ok(true);
        }
        // Drop a stale host before replacing it with the requested config.
        let _ = hosts.remove(&lane_id);
        let mut host = AcpHost::connect(&grok_path, &resolved_cwd, &config).await?;
        if config.resume_session_id.is_none() {
            let id = host.prewarm_session(&resolved_cwd, &config).await?;
            self.prewarmed_sessions.lock().await.insert(
                lane_id.clone(),
                PrewarmedSession {
                    key: prewarm_session_key(&resolved_cwd, &config),
                    id,
                },
            );
        }
        hosts.insert(lane_id, host);
        Ok(true)
    }

    pub async fn enqueue(
        &self,
        prompt: String,
        cwd: String,
        args: Vec<String>,
        parent_run_id: Option<String>,
        lane_id: Option<String>,
    ) -> Result<(String, usize), sqlx::Error> {
        let id = uuid::Uuid::now_v7().to_string();
        let args_json = serde_json::to_string(&args).unwrap_or_else(|_| "[]".into());
        let now = chrono::Utc::now().timestamp_millis();
        let lane = lane_id.unwrap_or_else(|| DEFAULT_LANE_ID.to_string());
        let rec = RunRecord {
            id: id.clone(),
            prompt,
            cwd,
            args_json,
            state: RunState::Queued,
            enqueued_at: now,
            started_at: None,
            ended_at: None,
            stop_reason: None,
            error: None,
            lane_id: lane.clone(),
            parent_run_id: parent_run_id.clone(),
        };
        self.db.insert_run(&rec).await?;

        let position;
        {
            let mut inner = self.inner.lock().await;
            // Lane-local depth: runs already waiting on this lane plus the
            // active run on this lane (if any). Other lanes do not inflate
            // "you're next" for this session.
            let ahead_waiting = inner.waiting.iter().filter(|r| r.lane_id == lane).count();
            let lane_busy = inner.active_lanes.contains_key(&lane);
            position = ahead_waiting + usize::from(lane_busy);
            inner.waiting.push_back(rec);
            if let Some(parent_id) = parent_run_id {
                inner.parent_runs.insert(id.clone(), parent_id);
            }
        }

        let _ = self.tx.send(QueueMessage {
            run_id: id.clone(),
            kind: QueueMessageKind::QueueChanged,
        });
        self.notify.notify_one();
        Ok((id, position))
    }

    pub async fn cancel(&self, run_id: &str) -> Result<bool, sqlx::Error> {
        let mut inner = self.inner.lock().await;
        // If in waiting queue: remove. (No `cancelled` mark needed — once out
        // of `waiting` the worker can never pop it, and stale marks would
        // grow the set for the process lifetime.)
        if let Some(pos) = inner.waiting.iter().position(|r| r.id == run_id) {
            inner.waiting.remove(pos);
            drop(inner);
            self.db
                .update_state(
                    run_id,
                    RunState::Cancelled,
                    None,
                    Some(chrono::Utc::now().timestamp_millis()),
                    None,
                    Some("user cancelled".into()),
                )
                .await?;
            let _ = self.tx.send(QueueMessage {
                run_id: run_id.into(),
                kind: QueueMessageKind::StateChanged {
                    state: RunState::Cancelled,
                    started_at: None,
                    ended_at: Some(chrono::Utc::now().timestamp_millis()),
                    error: Some("user cancelled".into()),
                },
            });
            let _ = self.tx.send(QueueMessage {
                run_id: run_id.into(),
                kind: QueueMessageKind::QueueChanged,
            });
            return Ok(true);
        }
        // If active on any lane: mark cancelled and kill that run's group only.
        let pgid = inner
            .active_lanes
            .values()
            .find(|slot| slot.run_id == run_id)
            .and_then(|slot| slot.pgid);
        if pgid.is_some()
            || inner
                .active_lanes
                .values()
                .any(|slot| slot.run_id == run_id)
        {
            inner.cancelled.insert(run_id.into());
            drop(inner);
            if let Some(p) = pgid {
                process::kill_group(p).await;
            }
            return Ok(true);
        }
        Ok(false)
    }

    pub async fn clear_waiting(&self) -> Result<u64, sqlx::Error> {
        let mut inner = self.inner.lock().await;
        let drained: Vec<String> = inner.waiting.drain(..).map(|r| r.id).collect();
        drop(inner);
        let now = chrono::Utc::now().timestamp_millis();
        for id in &drained {
            self.db
                .update_state(
                    id,
                    RunState::Cancelled,
                    None,
                    Some(now),
                    None,
                    Some("queue cleared".into()),
                )
                .await?;
            // QueueChanged only describes the remaining queue. Emit a terminal
            // state for every drained run as well, otherwise its optimistic
            // assistant message stays in `streaming` forever in the UI.
            let _ = self.tx.send(QueueMessage {
                run_id: id.clone(),
                kind: QueueMessageKind::StateChanged {
                    state: RunState::Cancelled,
                    started_at: None,
                    ended_at: Some(now),
                    error: Some("queue cleared".into()),
                },
            });
        }
        if !drained.is_empty() {
            let _ = self.tx.send(QueueMessage {
                run_id: drained[0].clone(),
                kind: QueueMessageKind::QueueChanged,
            });
        }
        Ok(drained.len() as u64)
    }

    /// Snapshot of concurrent actives + waiting records.
    /// `active_ids` lists every run currently executing (one per busy lane).
    pub async fn snapshot(&self) -> (Vec<String>, Vec<RunRecord>) {
        let inner = self.inner.lock().await;
        let mut active_ids: Vec<String> = inner
            .active_lanes
            .values()
            .map(|slot| slot.run_id.clone())
            .collect();
        active_ids.sort();
        (active_ids, inner.waiting.iter().cloned().collect())
    }

    pub async fn pending_count(&self) -> usize {
        self.inner.lock().await.waiting.len()
    }

    pub async fn cancel_all_pending(&self) -> Result<u64, sqlx::Error> {
        self.clear_waiting().await
    }

    /// Spawn the worker loop as a long-running tokio task. Returns immediately.
    ///
    /// The worker drains every lane that is idle and has a waiting head, then
    /// waits for the next notify. Each run is spawned as its own task so other
    /// lanes are never blocked behind a long turn.
    pub fn spawn_worker(self: Arc<Self>) {
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                me.notify.notified().await;
                me.drain_runnable().await;
            }
        });
    }

    /// Drain every currently runnable record into its own task.
    async fn drain_runnable(self: &Arc<Self>) {
        while let Some(rec) = self.pop_next_runnable().await {
            let me = Arc::clone(self);
            tokio::spawn(async move {
                me.run_one(rec).await;
            });
        }
    }

    /// Pop the next record whose lane is idle (and not cancelled). Skipped
    /// cancelled rows are finalized under the same lock that would publish
    /// `active`, so a cancel between pop and spawn cannot leave a zombie.
    async fn pop_next_runnable(&self) -> Option<RunRecord> {
        loop {
            let skipped_id;
            {
                let mut inner = self.inner.lock().await;
                let Some(idx) = inner
                    .waiting
                    .iter()
                    .position(|r| !inner.active_lanes.contains_key(&r.lane_id))
                else {
                    return None;
                };
                let rec = inner.waiting.remove(idx).expect("index from position");
                if inner.cancelled.remove(&rec.id) {
                    skipped_id = rec.id;
                } else {
                    inner.active_lanes.insert(
                        rec.lane_id.clone(),
                        ActiveSlot {
                            run_id: rec.id.clone(),
                            pgid: None,
                        },
                    );
                    return Some(rec);
                }
            }
            self.finalize(
                &skipped_id,
                RunState::Cancelled,
                Some("user cancelled".into()),
            )
            .await;
        }
    }

    async fn run_one(self: &Arc<Self>, rec: RunRecord) {
        let started_at = chrono::Utc::now().timestamp_millis();
        let _ = self
            .db
            .update_state(
                &rec.id,
                RunState::Running,
                Some(started_at),
                None,
                None,
                None,
            )
            .await;
        // Emit QueueChanged BEFORE StateChanged so the frontend's active set
        // flips to include rec.id before any text events arrive. The
        // QueueChanged that fires from enqueue() can race with pop and
        // capture a stale snapshot — emitting again here guarantees the
        // post-pop snapshot is the one the frontend ends up with.
        let _ = self.tx.send(QueueMessage {
            run_id: rec.id.clone(),
            kind: QueueMessageKind::QueueChanged,
        });
        let _ = self.tx.send(QueueMessage {
            run_id: rec.id.clone(),
            kind: QueueMessageKind::StateChanged {
                state: RunState::Running,
                started_at: Some(started_at),
                ended_at: None,
                error: None,
            },
        });

        let mut args: Vec<String> = serde_json::from_str(&rec.args_json).unwrap_or_default();
        // The frontend may enqueue a same-session follow-up while its parent
        // is still running. Resolve the parent's ACP session id here, not via
        // CLI `-c` (ACP ignores that flag and it could select another UI
        // session sharing the cwd).
        let parent_session = {
            let inner = self.inner.lock().await;
            inner
                .parent_runs
                .get(&rec.id)
                .and_then(|parent| inner.completed_sessions.get(parent))
                .cloned()
        };
        if let Some(session_id) = parent_session {
            args.push("--resume".to_string());
            args.push(session_id);
        }
        let grok_path = self.inner.lock().await.grok_path.clone();
        let cwd = std::path::PathBuf::from(&rec.cwd);

        if core::should_use_acp(&grok_path) {
            self.run_one_core(&rec, &args, &grok_path, &cwd).await;
            return;
        }

        let spawn_result = process::spawn(&grok_path, &args, &cwd);
        match spawn_result {
            Err(e) => {
                self.finalize(
                    &rec.id,
                    RunState::Failed,
                    Some(format!("spawn failed: {e}")),
                )
                .await;
            }
            Ok(mut spawned) => {
                let cancel_requested = {
                    let mut inner = self.inner.lock().await;
                    if let Some(slot) = inner.active_lanes.get_mut(&rec.lane_id) {
                        if slot.run_id == rec.id {
                            slot.pgid = Some(spawned.pgid);
                        }
                    }
                    // A cancel may have landed between pop and spawn — its
                    // pgid read saw None, so nothing was killed.
                    // Honor it now that the pgid exists.
                    inner.cancelled.contains(&rec.id)
                };
                if cancel_requested {
                    process::kill_group(spawned.pgid).await;
                }
                // Drain stderr in a background task. Without this, when grok
                // produces > 64 KB of stderr (tracing logs, debug noise) the
                // pipe fills and grok BLOCKS on stderr write, which makes
                // stdout silent and trips our no-output watchdog (420s by
                // default, see `no_output_secs` below) — even though grok is
                // alive and would have produced text just fine.
                // Keep the tail of stderr so a non-zero exit can report grok's
                // ACTUAL error (e.g. "invalid reasoning effort: max") instead of
                // a useless generic "likely a crash".
                let stderr_tail = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
                if let Some(stderr) = spawned.child.stderr.take() {
                    use tokio::io::{AsyncBufReadExt, BufReader};
                    let tail = stderr_tail.clone();
                    tokio::spawn(async move {
                        let mut reader = BufReader::new(stderr);
                        let mut line = String::new();
                        loop {
                            line.clear();
                            match reader.read_line(&mut line).await {
                                Ok(0) | Err(_) => break,
                                Ok(_) => {
                                    if let Ok(mut t) = tail.lock() {
                                        t.push_str(&line);
                                        keep_utf8_tail(&mut t, STDERR_TAIL_MAX_BYTES);
                                    }
                                    // Surface unfiltered stderr to the host
                                    // process — useful when diagnosing grok
                                    // misbehavior. Set
                                    // GROK_DESKTOP_QUIET_GROK_STDERR=1 to
                                    // suppress.
                                    if std::env::var("GROK_DESKTOP_QUIET_GROK_STDERR")
                                        .ok()
                                        .as_deref()
                                        != Some("1")
                                    {
                                        eprint!("[grok stderr] {line}");
                                    }
                                }
                            }
                        }
                    });
                }
                let mut reader = match process::read_stdout_lines(&mut spawned.child) {
                    Ok(reader) => reader,
                    Err(e) => {
                        process::kill_group(spawned.pgid).await;
                        self.finalize(
                            &rec.id,
                            RunState::Failed,
                            Some(format!("stdout unavailable: {e}")),
                        )
                        .await;
                        return;
                    }
                };
                let mut line = String::new();
                let mut consecutive_fail = 0u32;

                // No-output timeout: how long we'll wait between stdout lines
                // before assuming grok is wedged. The timer resets on EVERY
                // line, so a grok that's actively thinking (streaming-json emits
                // `thought` events continuously) never trips it. It only fires
                // when grok is TRULY silent — e.g. blocked on a macOS permission
                // prompt, or wedged. `--effort max` + plan mode can stay silent
                // a while before the first event, so the default is generous.
                // Tunable via env var so power users can tighten it.
                let no_output_secs: u64 = std::env::var("GROK_DESKTOP_NO_OUTPUT_TIMEOUT_SECS")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(420);
                loop {
                    line.clear();
                    let read_fut = reader.read_line(&mut line);
                    let outcome = tokio::time::timeout(
                        std::time::Duration::from_secs(no_output_secs),
                        read_fut,
                    )
                    .await;
                    match outcome {
                        Err(_) => {
                            // N seconds with zero output and not exited → wedged.
                            // Usually a macOS permission prompt waiting offscreen
                            // (grant/deny it), or genuinely stuck. Make the error
                            // actionable instead of a bare "timeout".
                            process::kill_group(spawned.pgid).await;
                            self.finalize(
                                &rec.id,
                                RunState::Failed,
                                Some(format!(
                                    "no output for {no_output_secs}s — grok went silent. \
                                     Check for a macOS permission prompt, or lower Effort/Reasoning.",
                                )),
                            )
                            .await;
                            return;
                        }
                        Ok(Ok(0)) => break,
                        Ok(Ok(_)) => {
                            let trimmed = line.trim_end_matches(['\r', '\n']).to_string();
                            if trimmed.is_empty() {
                                continue;
                            }
                            // Parse the line twice: once into the typed
                            // GrokEvent enum (for existing Thought/Text/End
                            // consumers), once as raw JSON Value (so the
                            // frontend can introspect tool/subagent events
                            // without us touching Rust for every new type).
                            let raw_value: serde_json::Value =
                                serde_json::from_str(&trimmed).unwrap_or(serde_json::Value::Null);
                            match parse_line(&trimmed) {
                                Ok(ev) => {
                                    consecutive_fail = 0;
                                    if let GrokEvent::End { session_id, .. } = &ev {
                                        self.inner
                                            .lock()
                                            .await
                                            .completed_sessions
                                            .insert(rec.id.clone(), session_id.clone());
                                    }
                                    let _ = self.tx.send(QueueMessage {
                                        run_id: rec.id.clone(),
                                        kind: QueueMessageKind::Event {
                                            event: ev,
                                            raw: raw_value,
                                        },
                                    });
                                }
                                Err(_) => {
                                    consecutive_fail += 1;
                                    if consecutive_fail > 5 {
                                        process::kill_group(spawned.pgid).await;
                                        self.finalize(
                                            &rec.id,
                                            RunState::Failed,
                                            Some("too many parse failures".into()),
                                        )
                                        .await;
                                        return;
                                    }
                                }
                            }
                        }
                        Ok(Err(e)) => {
                            self.finalize(
                                &rec.id,
                                RunState::Failed,
                                Some(format!("stdout read error: {e}")),
                            )
                            .await;
                            return;
                        }
                    }
                }
                // Wait exit — bounded. Every other stall path has a watchdog;
                // without one here a grok that closes stdout but never exits
                // would leave the run Running forever and wedge the lane.
                let mut forced_exit = false;
                let status = match tokio::time::timeout(
                    std::time::Duration::from_secs(30),
                    spawned.child.wait(),
                )
                .await
                {
                    Ok(status) => status,
                    Err(_) => {
                        forced_exit = true;
                        process::kill_group(spawned.pgid).await;
                        // kill_group escalates TERM→KILL, so this reap returns
                        // promptly.
                        spawned.child.wait().await
                    }
                };
                let cancelled = self.inner.lock().await.cancelled.contains(&rec.id);
                let (final_state, fail_err) = if cancelled {
                    (RunState::Cancelled, None)
                } else {
                    match status {
                        Ok(s) if s.success() => (RunState::Done, None),
                        Ok(_) if forced_exit => (
                            RunState::Failed,
                            Some(
                                "grok did not exit after closing its output stream; terminated"
                                    .to_string(),
                            ),
                        ),
                        // grok exited non-zero. Surface the code/signal so the
                        // failure isn't a bare "error" — grok 0.2.x sometimes
                        // crashes mid-run, and a clear message tells the user
                        // it's the CLI (and that retrying usually works).
                        Ok(s) => {
                            // Pull grok's real error off the stderr tail (last
                            // non-empty line) so the message is actionable.
                            let detail = stderr_tail
                                .lock()
                                .ok()
                                .and_then(|t| {
                                    // Prefer clap's "error: …" line; else the last
                                    // meaningful (non-Usage) line.
                                    t.lines()
                                        .map(str::trim)
                                        .find(|l| l.starts_with("error:"))
                                        .map(str::to_string)
                                        .or_else(|| {
                                            t.lines()
                                                .rev()
                                                .map(str::trim)
                                                .find(|l| {
                                                    !l.is_empty()
                                                        && !l.starts_with("For more information")
                                                        && !l.starts_with("Usage:")
                                                })
                                                .map(str::to_string)
                                        })
                                })
                                .map(|l| format!(" — {l}"))
                                .unwrap_or_else(|| {
                                    " — likely a grok CLI crash, try again".to_string()
                                });
                            let msg = match s.code() {
                                Some(c) => format!("grok exited with code {c}{detail}"),
                                None => format!("grok was terminated by a signal{detail}"),
                            };
                            (RunState::Failed, Some(msg))
                        }
                        Err(e) => (
                            RunState::Failed,
                            Some(format!("could not wait on grok: {e}")),
                        ),
                    }
                };
                self.finalize(&rec.id, final_state, fail_err).await;
            }
        }
    }

    pub fn notify_worker(&self) {
        self.notify.notify_one();
    }

    async fn run_one_core(
        self: &Arc<Self>,
        rec: &RunRecord,
        args: &[String],
        grok_path: &std::path::Path,
        cwd: &std::path::Path,
    ) {
        let config = CoreConfig::from_legacy_args(args);
        // Take any existing host for this lane out of the pool so other lanes
        // never wait on a shared turn mutex. Concurrent lanes each own a host.
        let mut host = {
            let mut hosts = self.acp_hosts.lock().await;
            let reuse = hosts
                .get_mut(&rec.lane_id)
                .is_some_and(|h| h.matches(grok_path, &config));
            if reuse {
                hosts.remove(&rec.lane_id)
            } else {
                // Drop a stale host for this lane (if any) so its child is
                // cleaned up via AcpHost::Drop before we connect a new one.
                let _ = hosts.remove(&rec.lane_id);
                None
            }
        };
        if host.is_none() {
            match AcpHost::connect(grok_path, cwd, &config).await {
                Ok(h) => host = Some(h),
                Err(error) => {
                    self.finalize(&rec.id, RunState::Failed, Some(error)).await;
                    return;
                }
            }
        }
        let mut host = host.expect("ACP host initialized");
        let prewarmed_session_id = if config.resume_session_id.is_none() {
            let key = prewarm_session_key(cwd, &config);
            self.prewarmed_sessions
                .lock()
                .await
                .remove(&rec.lane_id)
                .filter(|warm| warm.key == key)
                .map(|warm| warm.id)
        } else {
            None
        };
        {
            let mut inner = self.inner.lock().await;
            if let Some(slot) = inner.active_lanes.get_mut(&rec.lane_id) {
                if slot.run_id == rec.id {
                    slot.pgid = Some(host.pgid());
                }
            }
        }
        let result = host
            .run_turn(
                &rec.id,
                &rec.prompt,
                cwd,
                &config,
                &self.tx,
                prewarmed_session_id.as_deref(),
            )
            .await;
        let cancelled = self.inner.lock().await.cancelled.contains(&rec.id);
        match result {
            Ok(turn) if !cancelled => {
                self.inner
                    .lock()
                    .await
                    .completed_sessions
                    .insert(rec.id.clone(), turn.session_id.clone());
                let event = GrokEvent::End {
                    stop_reason: turn.stop_reason,
                    session_id: turn.session_id,
                    request_id: turn.request_id,
                };
                let raw = serde_json::to_value(&event).unwrap_or(serde_json::Value::Null);
                let _ = self.tx.send(QueueMessage {
                    run_id: rec.id.clone(),
                    kind: QueueMessageKind::Event { event, raw },
                });
                // Return host to the lane pool for the next serial turn.
                self.acp_hosts
                    .lock()
                    .await
                    .insert(rec.lane_id.clone(), host);
                self.finalize(&rec.id, RunState::Done, None).await;
            }
            Ok(_) => {
                // Cancelled mid-turn: drop host so the child is killed.
                drop(host);
                self.finalize(&rec.id, RunState::Cancelled, None).await;
            }
            Err(error) => {
                drop(host);
                let state = if cancelled {
                    RunState::Cancelled
                } else {
                    RunState::Failed
                };
                self.finalize(&rec.id, state, (!cancelled).then_some(error))
                    .await;
            }
        }
    }

    async fn finalize(&self, id: &str, state: RunState, error: Option<String>) {
        let now = chrono::Utc::now().timestamp_millis();
        let _ = self
            .db
            .update_state(id, state, None, Some(now), None, error.clone())
            .await;
        {
            let mut inner = self.inner.lock().await;
            // Prune the cancel mark so the set doesn't grow for the process
            // lifetime (and a recycled id could never be mis-skipped).
            inner.cancelled.remove(id);
            let lane_to_clear = inner
                .active_lanes
                .iter()
                .find(|(_, slot)| slot.run_id == id)
                .map(|(lane, _)| lane.clone());
            if let Some(lane) = lane_to_clear {
                inner.active_lanes.remove(&lane);
            }
            // Parent edges only matter while the child is waiting to launch.
            inner.parent_runs.remove(id);
        }
        let _ = self.tx.send(QueueMessage {
            run_id: id.into(),
            kind: QueueMessageKind::StateChanged {
                state,
                started_at: None,
                ended_at: Some(now),
                error,
            },
        });
        let _ = self.tx.send(QueueMessage {
            run_id: id.into(),
            kind: QueueMessageKind::QueueChanged,
        });
        // Wake worker so another waiting run on this (or any) idle lane can start.
        self.notify.notify_one();
    }
}

fn prewarm_session_key(cwd: &std::path::Path, config: &CoreConfig) -> String {
    format!(
        "{}\0{}",
        cwd.to_string_lossy(),
        config.rules.as_deref().unwrap_or_default()
    )
}
