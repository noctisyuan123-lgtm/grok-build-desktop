//! Live Grok session context-occupancy metrics.
//!
//! Reads only under `~/.grok/sessions` (never free-form frontend paths):
//!   - `<session>/signals.json` — authoritative occupancy totals
//!   - `<session>/system_prompt.txt` — system prompt text (estimate)
//!   - `<session>/prompt_context.json` — `agents_md_files[].content` (rules estimate)
//!   - `<session>/chat_history.jsonl` — current conversation text (estimate)
//!   - `~/.grok/models_cache.json` — context_window / auto_compact_threshold
//!
//! Category breakdowns are **approximate** (no official local Grok 4.5 tokenizer).
//! When `contextTokensUsed` is known, the four breakdown buckets are clamped/scaled
//! so they are non-negative and sum **exactly** to that total. Residual mass
//! (tool schemas, skills, MCP, subagents, protocol overhead, estimation error)
//! lands in `toolsRuntime` — those are never invented as separate persisted totals.
//!
//! The frontend supplies only an app-approved cwd and a validated UUID session id.
//! Symlinks are refused; missing or partial side files degrade gracefully.

use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

/// UUID shape used by Grok session ids (v4/v7 hex form).
const SESSION_ID_RE: &str =
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/// Approximate category breakdown of context occupancy.
///
/// When present, the four fields are non-negative and sum exactly to
/// `context_tokens_used`. Values are estimates except for the residual
/// `tools_runtime` bucket (total minus the other three estimates).
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsageBreakdown {
    pub system_prompt: u64,
    pub rules: u64,
    pub conversation: u64,
    /// Residual: tool schemas / skills / MCP / subagents / protocol / estimate error.
    pub tools_runtime: u64,
}

/// Authoritative occupancy fields from `signals.json` plus model-cache
/// supplements and an optional approximate breakdown. All metric fields are
/// optional so version-skewed or partially-written files still deserialize.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionContextMetrics {
    /// True when a signals file was found and at least one occupancy field parsed.
    pub available: bool,
    pub session_id: String,
    pub context_tokens_used: Option<u64>,
    pub context_window_tokens: Option<u64>,
    /// Percent 0–100 when known (prefer used/window; else signals' integer field).
    pub context_window_usage: Option<f64>,
    pub compaction_count: Option<u64>,
    pub total_tokens_before_compaction: Option<u64>,
    pub turn_count: Option<u64>,
    pub primary_model_id: Option<String>,
    pub auto_compact_threshold_percent: Option<u32>,
    /// Approximate category split; `None` when no authoritative total is known.
    pub breakdown: Option<ContextUsageBreakdown>,
    /// Always `true` when `breakdown` is present — category values are estimates.
    pub breakdown_approximate: bool,
    /// Human-readable reason when metrics are unavailable (never a stack trace).
    pub detail: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SignalsFile {
    context_tokens_used: Option<u64>,
    context_window_tokens: Option<u64>,
    /// Grok currently writes an integer percent; accept float for skew tolerance.
    context_window_usage: Option<serde_json::Value>,
    compaction_count: Option<u64>,
    total_tokens_before_compaction: Option<u64>,
    turn_count: Option<u64>,
    primary_model_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ModelsCacheFile {
    models: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ModelInfoBlob {
    info: Option<ModelInfoFields>,
    // Some cache shapes nest under the model key directly.
    context_window: Option<u64>,
    auto_compact_threshold_percent: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ModelInfoFields {
    context_window: Option<u64>,
    auto_compact_threshold_percent: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct PromptContextFile {
    agents_md_files: Option<Vec<AgentsMdEntry>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct AgentsMdEntry {
    content: Option<String>,
}

/// Resolve `GROK_HOME` or `~/.grok`.
pub fn grok_home_dir() -> PathBuf {
    env::var_os("GROK_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|h| PathBuf::from(h).join(".grok")))
        .unwrap_or_else(|| PathBuf::from(".grok"))
}

/// Percent-encode a cwd the same way Grok CLI does for session directories
/// (`urllib.parse.quote(path, safe='')` — unreserved chars stay literal).
pub fn percent_encode_cwd(cwd: &str) -> String {
    let mut out = String::with_capacity(cwd.len() * 3);
    for &b in cwd.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{b:02X}"));
            }
        }
    }
    out
}

/// Strict UUID validation — rejects path traversal and free-form strings.
pub fn validate_session_id(session_id: &str) -> Result<String, String> {
    let id = session_id.trim();
    if id.is_empty() {
        return Err("session id is required".into());
    }
    if id.len() != 36 {
        return Err("invalid session id".into());
    }
    // Manual check avoids a full regex crate; matches UUID hex form.
    let bytes = id.as_bytes();
    let is_hex = |i: usize| matches!(bytes[i], b'0'..=b'9' | b'a'..=b'f' | b'A'..=b'F');
    let groups = [8usize, 4, 4, 4, 12];
    let mut pos = 0usize;
    for (gi, &len) in groups.iter().enumerate() {
        for _ in 0..len {
            if pos >= bytes.len() || !is_hex(pos) {
                return Err("invalid session id".into());
            }
            pos += 1;
        }
        if gi + 1 < groups.len() {
            if pos >= bytes.len() || bytes[pos] != b'-' {
                return Err("invalid session id".into());
            }
            pos += 1;
        }
    }
    if pos != bytes.len() {
        return Err("invalid session id".into());
    }
    // Silence unused constant warning when kept as documentation of the shape.
    let _ = SESSION_ID_RE;
    Ok(id.to_string())
}

/// Build the absolute session directory under the Grok sessions tree.
/// Ensures the resolved path stays inside `~/.grok/sessions`.
pub fn session_dir_for(cwd: &str, session_id: &str, home: &Path) -> Result<PathBuf, String> {
    let cwd = cwd.trim();
    if cwd.is_empty() {
        return Err("cwd is required".into());
    }
    if cwd.contains('\0') {
        return Err("invalid cwd".into());
    }
    let id = validate_session_id(session_id)?;
    let encoded = percent_encode_cwd(cwd);
    // Encoded cwd must be a single safe path segment. `.` / `..` stay literal
    // under percent-encoding (unreserved), and would escape `sessions/` via
    // Path::join — reject them explicitly. Slashes should never remain after
    // encoding; treat them as fatal if they somehow appear.
    if encoded.is_empty() || encoded == "." || encoded == ".." {
        return Err("invalid cwd".into());
    }
    if encoded.contains('/') || encoded.contains('\\') {
        return Err("invalid cwd".into());
    }
    let sessions = home.join("sessions");
    let path = sessions.join(&encoded).join(&id);

    // Component-wise containment: no CurDir/ParentDir, and path under sessions.
    for component in path.components() {
        use std::path::Component;
        if matches!(component, Component::ParentDir | Component::CurDir) {
            return Err("session path escaped sessions directory".into());
        }
    }
    if !path.starts_with(&sessions) {
        return Err("session path escaped sessions directory".into());
    }
    Ok(path)
}

/// Build the absolute signals.json path under the Grok sessions tree.
pub fn signals_path_for(cwd: &str, session_id: &str, home: &Path) -> Result<PathBuf, String> {
    Ok(session_dir_for(cwd, session_id, home)?.join("signals.json"))
}

fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_file())
        .unwrap_or(false)
}

fn is_regular_dir(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_dir())
        .unwrap_or(false)
}

/// Locate a UUID-scoped session directory without accepting a frontend path.
/// Prefer the current cwd, then scan only the immediate Grok session buckets.
fn locate_session_dir(cwd: &str, session_id: &str, home: &Path) -> Result<Option<PathBuf>, String> {
    let id = validate_session_id(session_id)?;
    if !cwd.trim().is_empty() {
        let direct = session_dir_for(cwd, &id, home)?;
        let signals = direct.join("signals.json");
        if is_regular_file(&signals) {
            return Ok(Some(direct));
        }
    }

    let sessions = home.join("sessions");
    let Ok(entries) = fs::read_dir(&sessions) else {
        return Ok(None);
    };
    let mut matches: Vec<(SystemTime, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let Ok(meta) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        // Refuse symlink buckets; only real directories.
        if !meta.file_type().is_dir() {
            continue;
        }
        let candidate_dir = entry.path().join(&id);
        if !is_regular_dir(&candidate_dir) {
            continue;
        }
        let candidate = candidate_dir.join("signals.json");
        let Ok(file_meta) = fs::symlink_metadata(&candidate) else {
            continue;
        };
        if !file_meta.file_type().is_file() {
            continue;
        }
        matches.push((
            file_meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            candidate_dir,
        ));
    }
    matches.sort_by_key(|(modified, _)| *modified);
    Ok(matches.pop().map(|(_, path)| path))
}

#[cfg(test)]
fn locate_signals_path(
    cwd: &str,
    session_id: &str,
    home: &Path,
) -> Result<Option<PathBuf>, String> {
    Ok(locate_session_dir(cwd, session_id, home)?.map(|d| d.join("signals.json")))
}

fn json_number_as_u64(v: &serde_json::Value) -> Option<u64> {
    match v {
        serde_json::Value::Number(n) => n
            .as_u64()
            .or_else(|| n.as_f64().map(|f| f.max(0.0).floor() as u64)),
        serde_json::Value::String(s) => s
            .trim()
            .parse::<f64>()
            .ok()
            .map(|f| f.max(0.0).floor() as u64),
        _ => None,
    }
}

fn json_number_as_f64(v: &serde_json::Value) -> Option<f64> {
    match v {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn parse_usage_percent(raw: Option<serde_json::Value>) -> Option<f64> {
    let v = raw?;
    let n = json_number_as_f64(&v)?;
    if n.is_finite() && n >= 0.0 {
        Some(n.min(100.0))
    } else {
        None
    }
}

/// Compute display percent: prefer used/window when both positive.
pub fn compute_usage_percent(
    used: Option<u64>,
    window: Option<u64>,
    signals_usage: Option<f64>,
) -> Option<f64> {
    if let (Some(u), Some(w)) = (used, window) {
        if w > 0 {
            return Some(((u as f64) * 100.0 / (w as f64)).clamp(0.0, 100.0));
        }
    }
    signals_usage
}

fn read_model_limits(home: &Path, model_id: &str) -> (Option<u64>, Option<u32>) {
    let path = home.join("models_cache.json");
    let Ok(raw) = fs::read_to_string(&path) else {
        return (None, None);
    };
    let Ok(cache) = serde_json::from_str::<ModelsCacheFile>(&raw) else {
        return (None, None);
    };
    let Some(models) = cache.models else {
        return (None, None);
    };
    let Some(entry) = models.get(model_id) else {
        return (None, None);
    };
    // Prefer nested `info`, fall back to flat fields on the model object.
    if let Ok(blob) = serde_json::from_value::<ModelInfoBlob>(entry.clone()) {
        if let Some(info) = blob.info {
            return (
                info.context_window.filter(|&w| w > 0),
                info.auto_compact_threshold_percent,
            );
        }
        return (
            blob.context_window.filter(|&w| w > 0),
            blob.auto_compact_threshold_percent,
        );
    }
    // Last resort: dig with Value API for version skew.
    let window = entry
        .pointer("/info/context_window")
        .or_else(|| entry.get("context_window"))
        .and_then(json_number_as_u64)
        .filter(|&w| w > 0);
    let threshold = entry
        .pointer("/info/auto_compact_threshold_percent")
        .or_else(|| entry.get("auto_compact_threshold_percent"))
        .and_then(json_number_as_u64)
        .map(|n| n as u32);
    (window, threshold)
}

// ── Token estimation (approximate; not a real tokenizer) ───────────────────

/// True for CJK ideographs, kana, and Hangul — denser token-per-char than Latin.
fn is_cjk_dense(ch: char) -> bool {
    matches!(
        ch,
        '\u{1100}'..='\u{11FF}'   // Hangul Jamo
        | '\u{3040}'..='\u{30FF}' // Hiragana + Katakana
        | '\u{3130}'..='\u{318F}' // Hangul Compatibility Jamo
        | '\u{3400}'..='\u{4DBF}' // CJK Ext A
        | '\u{4E00}'..='\u{9FFF}' // CJK Unified
        | '\u{A960}'..='\u{A97F}' // Hangul Jamo Extended-A
        | '\u{AC00}'..='\u{D7AF}' // Hangul Syllables
        | '\u{D7B0}'..='\u{D7FF}' // Hangul Jamo Extended-B
        | '\u{F900}'..='\u{FAFF}' // CJK Compatibility Ideographs
        | '\u{FF65}'..='\u{FF9F}' // Halfwidth Katakana
        | '\u{20000}'..='\u{2A6DF}' // CJK Ext B
        | '\u{2A700}'..='\u{2B73F}'
        | '\u{2B740}'..='\u{2B81F}'
        | '\u{2B820}'..='\u{2CEAF}'
        | '\u{2CEB0}'..='\u{2EBEF}'
        | '\u{30000}'..='\u{3134F}'
    )
}

/// Unicode-aware heuristic token estimate for mixed English / CJK text.
///
/// **Not** a Grok 4.5 tokenizer (none is available locally). Documented weights:
/// - CJK-dense scalar values ≈ **1.0** token each
/// - Other non-whitespace ≈ **0.25** token each (≈ 4 Latin chars / token)
/// - Whitespace ignored as separators
///
/// Result is `ceil(weight sum)`, never using raw UTF-8 `bytes / 4`.
pub fn estimate_tokens(text: &str) -> u64 {
    if text.is_empty() {
        return 0;
    }
    let mut weight = 0.0f64;
    for ch in text.chars() {
        if ch.is_whitespace() {
            continue;
        }
        if is_cjk_dense(ch) {
            weight += 1.0;
        } else {
            weight += 0.25;
        }
    }
    if weight <= 0.0 {
        return 0;
    }
    weight.ceil() as u64
}

/// Read a regular file's text; missing/symlink/error → empty (graceful).
fn read_regular_text(path: &Path) -> String {
    if !is_regular_file(path) {
        return String::new();
    }
    fs::read_to_string(path).unwrap_or_default()
}

fn estimate_system_prompt(session_dir: &Path) -> u64 {
    let text = read_regular_text(&session_dir.join("system_prompt.txt"));
    estimate_tokens(&text)
}

fn estimate_rules(session_dir: &Path) -> u64 {
    let path = session_dir.join("prompt_context.json");
    if !is_regular_file(&path) {
        return 0;
    }
    let Ok(raw) = fs::read_to_string(&path) else {
        return 0;
    };
    let Ok(ctx) = serde_json::from_str::<PromptContextFile>(&raw) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in ctx.agents_md_files.unwrap_or_default() {
        if let Some(content) = entry.content {
            total = total.saturating_add(estimate_tokens(&content));
        }
    }
    total
}

/// Collect display text from a JSON value (string, text parts, nested).
fn collect_text_value(value: &serde_json::Value, out: &mut String) {
    match value {
        serde_json::Value::String(s) => {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(s);
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_text_value(item, out);
            }
        }
        serde_json::Value::Object(map) => {
            // Prefer explicit text/content/summary_text fields over dumping keys/ids.
            if let Some(t) = map.get("text").and_then(|v| v.as_str()) {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(t);
                return;
            }
            if let Some(t) = map.get("summary_text").and_then(|v| v.as_str()) {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(t);
                return;
            }
            if let Some(content) = map.get("content") {
                collect_text_value(content, out);
                return;
            }
            if let Some(args) = map.get("arguments") {
                // Tool-call argument payloads (string or object).
                match args {
                    serde_json::Value::String(s) => {
                        if !out.is_empty() {
                            out.push('\n');
                        }
                        out.push_str(s);
                    }
                    other => collect_text_value(other, out),
                }
            }
            if let Some(name) = map.get("name").and_then(|v| v.as_str()) {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(name);
            }
        }
        _ => {}
    }
}

/// Extract countable conversation text from one chat_history.jsonl record.
/// Skips `type=system` (already counted via system_prompt.txt) and metadata IDs /
/// `encrypted_content`. Includes visible reasoning summaries and tool call/result text.
fn conversation_text_from_item(item: &serde_json::Value) -> String {
    let Some(obj) = item.as_object() else {
        return String::new();
    };
    let ty = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
    // System prompt is double-counted if included — always exclude.
    if ty.eq_ignore_ascii_case("system") {
        return String::new();
    }

    let mut out = String::new();

    match ty {
        "reasoning" => {
            // Visible summaries only — never encrypted_content or id.
            if let Some(summary) = obj.get("summary") {
                collect_text_value(summary, &mut out);
            }
        }
        "user" | "assistant" | "tool_result" | "tool-result" | "tool_call" | "tool-call" => {
            if let Some(content) = obj.get("content") {
                collect_text_value(content, &mut out);
            }
            // Assistant-embedded tool calls (name + arguments; skip call ids).
            if let Some(calls) = obj.get("tool_calls") {
                if let Some(arr) = calls.as_array() {
                    for call in arr {
                        if let Some(name) = call.get("name").and_then(|v| v.as_str()) {
                            if !out.is_empty() {
                                out.push('\n');
                            }
                            out.push_str(name);
                        }
                        if let Some(args) = call.get("arguments") {
                            match args {
                                serde_json::Value::String(s) => {
                                    if !out.is_empty() {
                                        out.push('\n');
                                    }
                                    out.push_str(s);
                                }
                                other => collect_text_value(other, &mut out),
                            }
                        }
                    }
                }
            }
        }
        "backend_tool_call" => {
            if let Some(kind) = obj.get("kind").and_then(|v| v.as_str()) {
                out.push_str(kind);
            }
        }
        _ => {
            // Unknown types: only count a top-level content string if present.
            if let Some(content) = obj.get("content") {
                collect_text_value(content, &mut out);
            }
        }
    }

    out
}

fn estimate_conversation(session_dir: &Path) -> u64 {
    let path = session_dir.join("chat_history.jsonl");
    if !is_regular_file(&path) {
        return 0;
    }
    let Ok(raw) = fs::read_to_string(&path) else {
        return 0;
    };
    let mut total = 0u64;
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(item) = serde_json::from_str::<serde_json::Value>(line) else {
            // Malformed / partial mid-flush lines are skipped.
            continue;
        };
        let text = conversation_text_from_item(&item);
        total = total.saturating_add(estimate_tokens(&text));
    }
    total
}

/// Clamp/scale the three estimated categories so they never exceed `total`,
/// then assign the residual to `tools_runtime`. Exact integer sum invariant.
pub fn assemble_breakdown(
    system_prompt: u64,
    rules: u64,
    conversation: u64,
    total: u64,
) -> ContextUsageBreakdown {
    let sum3 = system_prompt
        .saturating_add(rules)
        .saturating_add(conversation);

    if sum3 == 0 {
        return ContextUsageBreakdown {
            system_prompt: 0,
            rules: 0,
            conversation: 0,
            tools_runtime: total,
        };
    }

    if sum3 <= total {
        return ContextUsageBreakdown {
            system_prompt,
            rules,
            conversation,
            tools_runtime: total - sum3,
        };
    }

    // Proportional floor + largest-remainder so the three sum exactly to total.
    let parts = [system_prompt, rules, conversation];
    let mut floors = [0u64; 3];
    let mut fracs: [(f64, usize); 3] = [(0.0, 0); 3];
    let mut assigned = 0u64;
    for (i, &p) in parts.iter().enumerate() {
        let exact = (p as f64) * (total as f64) / (sum3 as f64);
        let floor = exact.floor() as u64;
        floors[i] = floor;
        assigned = assigned.saturating_add(floor);
        fracs[i] = (exact - floor as f64, i);
    }
    let mut leftover = total.saturating_sub(assigned);
    fracs.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    for (_, idx) in fracs {
        if leftover == 0 {
            break;
        }
        floors[idx] = floors[idx].saturating_add(1);
        leftover -= 1;
    }

    ContextUsageBreakdown {
        system_prompt: floors[0],
        rules: floors[1],
        conversation: floors[2],
        tools_runtime: 0,
    }
}

fn load_breakdown(session_dir: &Path, total: u64) -> ContextUsageBreakdown {
    let system_prompt = estimate_system_prompt(session_dir);
    let rules = estimate_rules(session_dir);
    let conversation = estimate_conversation(session_dir);
    assemble_breakdown(system_prompt, rules, conversation, total)
}

/// Load context metrics for a session. Never panics on bad JSON.
pub fn load_session_context_metrics(
    cwd: &str,
    session_id: &str,
    home: &Path,
) -> Result<SessionContextMetrics, String> {
    let id = validate_session_id(session_id)?;
    let Some(session_dir) = locate_session_dir(cwd, &id, home)? else {
        return Ok(SessionContextMetrics {
            available: false,
            session_id: id,
            detail: Some("No signals file for this session yet".into()),
            ..Default::default()
        });
    };
    let path = session_dir.join("signals.json");

    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            return Ok(SessionContextMetrics {
                available: false,
                session_id: id,
                detail: Some(format!("Could not read signals: {e}")),
                ..Default::default()
            });
        }
    };

    if raw.trim().is_empty() {
        return Ok(SessionContextMetrics {
            available: false,
            session_id: id,
            detail: Some("Signals file is empty".into()),
            ..Default::default()
        });
    }

    let signals: SignalsFile = match serde_json::from_str(&raw) {
        Ok(s) => s,
        Err(e) => {
            // Partially-written mid-flush: surface unavailable, not a hard error.
            return Ok(SessionContextMetrics {
                available: false,
                session_id: id,
                detail: Some(format!("Signals not ready: {e}")),
                ..Default::default()
            });
        }
    };

    let used = signals.context_tokens_used;
    let mut window = signals.context_window_tokens.filter(|&w| w > 0);
    let signals_usage = parse_usage_percent(signals.context_window_usage);
    let model_id = signals
        .primary_model_id
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let mut auto_compact = None;
    if let Some(ref mid) = model_id {
        let (cache_window, cache_threshold) = read_model_limits(home, mid);
        if window.is_none() {
            window = cache_window;
        }
        auto_compact = cache_threshold;
    }

    let usage = compute_usage_percent(used, window, signals_usage);

    let (breakdown, breakdown_approximate) = match used {
        Some(total) => (Some(load_breakdown(&session_dir, total)), true),
        None => (None, false),
    };

    let has_any = used.is_some()
        || window.is_some()
        || usage.is_some()
        || signals.turn_count.is_some()
        || signals.compaction_count.is_some()
        || model_id.is_some();

    Ok(SessionContextMetrics {
        available: has_any,
        session_id: id,
        context_tokens_used: used,
        context_window_tokens: window,
        context_window_usage: usage,
        compaction_count: signals.compaction_count,
        total_tokens_before_compaction: signals.total_tokens_before_compaction,
        turn_count: signals.turn_count,
        primary_model_id: model_id,
        auto_compact_threshold_percent: auto_compact,
        breakdown,
        breakdown_approximate,
        detail: if has_any {
            None
        } else {
            Some("Signals file had no context fields".into())
        },
    })
}

/// Tauri command: read live context occupancy for the active Grok session.
#[tauri::command]
pub fn get_session_context_metrics(
    cwd: String,
    session_id: String,
) -> Result<SessionContextMetrics, String> {
    load_session_context_metrics(&cwd, &session_id, &grok_home_dir())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_home(label: &str) -> PathBuf {
        let path = env::temp_dir().join(format!(
            "grok-desktop-ctx-{}-{}-{}",
            label,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(path.join("sessions")).expect("mkdir");
        path
    }

    fn session_fixture(home: &Path, cwd: &str, sid: &str) -> PathBuf {
        let dir = home
            .join("sessions")
            .join(percent_encode_cwd(cwd))
            .join(sid);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn validates_uuid_session_ids() {
        assert!(validate_session_id("019fe74c-9daf-7b03-9387-36b35cf1eb63").is_ok());
        assert!(validate_session_id("550e8400-e29b-41d4-a716-446655440000").is_ok());
        assert!(validate_session_id("../etc/passwd").is_err());
        assert!(validate_session_id("not-a-uuid").is_err());
        assert!(validate_session_id("").is_err());
        assert!(validate_session_id("019fe74c-9daf-7b03-9387-36b35cf1eb6").is_err()); // short
        assert!(validate_session_id("019fe74c9daf7b03938736b35cf1eb63").is_err()); // no dashes
        assert!(validate_session_id("gggge74c-9daf-7b03-9387-36b35cf1eb63").is_err());
    }

    #[test]
    fn percent_encodes_cwd_like_grok_cli() {
        assert_eq!(
            percent_encode_cwd("/Users/untitled/Documents/GitHub/grok-build-desktop"),
            "%2FUsers%2Funtitled%2FDocuments%2FGitHub%2Fgrok-build-desktop"
        );
        assert_eq!(percent_encode_cwd("/tmp/foo"), "%2Ftmp%2Ffoo");
        // Unreserved stay literal
        assert_eq!(percent_encode_cwd("a-b_c.d~e"), "a-b_c.d~e");
    }

    #[test]
    fn signals_path_stays_under_sessions() {
        let home = PathBuf::from("/tmp/fake-grok-home");
        let path = signals_path_for(
            "/Users/untitled/proj",
            "019fe74c-9daf-7b03-9387-36b35cf1eb63",
            &home,
        )
        .expect("path");
        assert!(path.starts_with(home.join("sessions")));
        assert!(path.ends_with("signals.json"));
        assert!(signals_path_for("", "019fe74c-9daf-7b03-9387-36b35cf1eb63", &home).is_err());
        assert!(signals_path_for("/x", "../secret", &home).is_err());
        // Raw `.` / `..` stay unencoded and must not escape sessions/.
        assert!(signals_path_for("..", "019fe74c-9daf-7b03-9387-36b35cf1eb63", &home).is_err());
        assert!(signals_path_for(".", "019fe74c-9daf-7b03-9387-36b35cf1eb63", &home).is_err());
        // Slash-containing cwds encode to a single segment (safe join).
        let nested = signals_path_for(
            "/tmp/foo/../bar",
            "019fe74c-9daf-7b03-9387-36b35cf1eb63",
            &home,
        )
        .expect("encoded slash cwd is one segment");
        assert!(nested.starts_with(home.join("sessions")));
        assert!(!nested
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir)));
    }

    #[test]
    fn locates_session_by_uuid_when_cwd_is_missing() {
        let home = temp_home("lookup");
        let sid = "019fe74c-9daf-7b03-9387-36b35cf1eb63";
        let path = home
            .join("sessions")
            .join(percent_encode_cwd("/Users/untitled/project"))
            .join(sid)
            .join("signals.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"contextTokensUsed":25000,"contextWindowTokens":500000}"#,
        )
        .unwrap();

        assert_eq!(
            locate_signals_path("", sid, &home).unwrap(),
            Some(path.clone())
        );
        let metrics = load_session_context_metrics("", sid, &home).unwrap();
        assert!(metrics.available);
        assert_eq!(metrics.context_window_usage, Some(5.0));
        assert!(metrics.breakdown.is_some());
        assert!(metrics.breakdown_approximate);
        let bd = metrics.breakdown.unwrap();
        assert_eq!(
            bd.system_prompt + bd.rules + bd.conversation + bd.tools_runtime,
            25_000
        );
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn compute_percent_prefers_used_over_window() {
        let p = compute_usage_percent(Some(25_000), Some(500_000), Some(3.0)).unwrap();
        assert!((p - 5.0).abs() < 0.01);
        // Fall back to signals usage when window missing
        assert_eq!(
            compute_usage_percent(Some(100), None, Some(12.0)),
            Some(12.0)
        );
        assert_eq!(compute_usage_percent(None, None, None), None);
    }

    #[test]
    fn loads_full_signals_and_model_cache() {
        let home = temp_home("full");
        let cwd = "/Users/untitled/proj";
        let sid = "019fe74c-9daf-7b03-9387-36b35cf1eb63";
        let dir = session_fixture(&home, cwd, sid);
        fs::write(
            dir.join("signals.json"),
            r#"{
              "turnCount": 4,
              "compactionCount": 1,
              "totalTokensBeforeCompaction": 420000,
              "contextWindowUsage": 12,
              "contextTokensUsed": 60000,
              "contextWindowTokens": 500000,
              "primaryModelId": "grok-4.5"
            }"#,
        )
        .unwrap();
        fs::write(
            home.join("models_cache.json"),
            r#"{
              "models": {
                "grok-4.5": {
                  "info": {
                    "context_window": 500000,
                    "auto_compact_threshold_percent": 80
                  }
                }
              }
            }"#,
        )
        .unwrap();

        let m = load_session_context_metrics(cwd, sid, &home).expect("load");
        assert!(m.available);
        assert_eq!(m.context_tokens_used, Some(60_000));
        assert_eq!(m.context_window_tokens, Some(500_000));
        assert!((m.context_window_usage.unwrap() - 12.0).abs() < 0.01);
        assert_eq!(m.turn_count, Some(4));
        assert_eq!(m.compaction_count, Some(1));
        assert_eq!(m.total_tokens_before_compaction, Some(420_000));
        assert_eq!(m.primary_model_id.as_deref(), Some("grok-4.5"));
        assert_eq!(m.auto_compact_threshold_percent, Some(80));
        assert!(m.breakdown_approximate);
        let bd = m.breakdown.expect("breakdown");
        assert_eq!(
            bd.system_prompt + bd.rules + bd.conversation + bd.tools_runtime,
            60_000
        );
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn missing_signals_returns_unavailable_not_error() {
        let home = temp_home("missing");
        let m =
            load_session_context_metrics("/no/such", "019fe74c-9daf-7b03-9387-36b35cf1eb63", &home)
                .expect("ok");
        assert!(!m.available);
        assert!(m.detail.is_some());
        assert!(m.breakdown.is_none());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn partial_and_corrupt_json_are_tolerated() {
        let home = temp_home("partial");
        let cwd = "/tmp/x";
        let sid = "550e8400-e29b-41d4-a716-446655440000";
        let dir = session_fixture(&home, cwd, sid);

        // Truncated JSON mid-write
        fs::write(dir.join("signals.json"), r#"{"contextTokensUsed": 1"#).unwrap();
        let bad = load_session_context_metrics(cwd, sid, &home).expect("ok");
        assert!(!bad.available);

        // Partial but valid — only some fields
        fs::write(
            dir.join("signals.json"),
            r#"{"contextTokensUsed": 1234, "primaryModelId": "grok-4.5"}"#,
        )
        .unwrap();
        // Cache supplies window + threshold
        fs::write(
            home.join("models_cache.json"),
            r#"{"models":{"grok-4.5":{"info":{"context_window":500000,"auto_compact_threshold_percent":80}}}}"#,
        )
        .unwrap();
        let partial = load_session_context_metrics(cwd, sid, &home).expect("ok");
        assert!(partial.available);
        assert_eq!(partial.context_tokens_used, Some(1234));
        assert_eq!(partial.context_window_tokens, Some(500_000));
        assert_eq!(partial.auto_compact_threshold_percent, Some(80));
        assert!(partial.breakdown.is_some());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn empty_file_is_unavailable() {
        let home = temp_home("empty");
        let cwd = "/tmp/y";
        let sid = "550e8400-e29b-41d4-a716-446655440000";
        let dir = session_fixture(&home, cwd, sid);
        fs::write(dir.join("signals.json"), "   ").unwrap();
        let m = load_session_context_metrics(cwd, sid, &home).expect("ok");
        assert!(!m.available);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn estimate_tokens_mixed_unicode_not_utf8_bytes() {
        // Pure ASCII: 4 non-ws chars → 1 token
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcdefgh"), 2);
        // Whitespace alone is zero
        assert_eq!(estimate_tokens("   \n\t"), 0);
        // CJK: each ideograph ≈ 1 token (not bytes/4 which would undercount)
        assert_eq!(estimate_tokens("你好"), 2);
        assert_eq!(estimate_tokens("こんにちは"), 5);
        // Mixed: "Hi你好" → H,i = 0.5 + 2 CJK = 2.5 → ceil 3
        assert_eq!(estimate_tokens("Hi你好"), 3);
        // Must differ from naive UTF-8 bytes/4 for CJK (你好 is 6 bytes → 2 with ceil bytes/4,
        // same here; longer CJK string exposes the difference vs Latin weighting).
        let cjk = "中文测试文本内容";
        let by_heuristic = estimate_tokens(cjk);
        let by_bytes = (cjk.len() as f64 / 4.0).ceil() as u64;
        // 8 CJK chars → heuristic 8; UTF-8 is 24 bytes → bytes/4 = 6
        assert_eq!(by_heuristic, 8);
        assert_eq!(by_bytes, 6);
        assert_ne!(by_heuristic, by_bytes);
    }

    #[test]
    fn assemble_breakdown_exact_sum_invariant() {
        let bd = assemble_breakdown(100, 200, 300, 1000);
        assert_eq!(bd.system_prompt, 100);
        assert_eq!(bd.rules, 200);
        assert_eq!(bd.conversation, 300);
        assert_eq!(bd.tools_runtime, 400);
        assert_eq!(
            bd.system_prompt + bd.rules + bd.conversation + bd.tools_runtime,
            1000
        );

        // Over-estimate: scale down, residual zero
        let over = assemble_breakdown(500, 500, 500, 100);
        assert_eq!(
            over.system_prompt + over.rules + over.conversation + over.tools_runtime,
            100
        );
        assert_eq!(over.tools_runtime, 0);

        // Empty estimates → all residual
        let empty = assemble_breakdown(0, 0, 0, 42);
        assert_eq!(empty.tools_runtime, 42);
        assert_eq!(empty.system_prompt + empty.rules + empty.conversation, 0);

        // Zero total
        let z = assemble_breakdown(10, 20, 30, 0);
        assert_eq!(
            z.system_prompt + z.rules + z.conversation + z.tools_runtime,
            0
        );
    }

    #[test]
    fn conversation_excludes_system_and_encrypted() {
        let home = temp_home("sys-excl");
        let cwd = "/tmp/sys";
        let sid = "550e8400-e29b-41d4-a716-446655440000";
        let dir = session_fixture(&home, cwd, sid);

        // System prompt file is the system-prompt source.
        fs::write(
            dir.join("system_prompt.txt"),
            "You are Grok. System only content for estimate.",
        )
        .unwrap();
        fs::write(
            dir.join("prompt_context.json"),
            r#"{"agents_md_files":[{"file_name":"AGENTS.md","content":"Rule one. Rule two."}]}"#,
        )
        .unwrap();
        // chat_history includes a large type=system entry that must NOT be counted
        // in conversation (would double-count with system_prompt.txt).
        let history = r#"
{"type":"system","content":"You are Grok. System only content for estimate. EXTRA PADDING THAT MUST NOT COUNT IN CONVERSATION CATEGORY BECAUSE IT IS SYSTEM TYPE."}
{"type":"user","content":[{"type":"text","text":"Hello world from user"}]}
{"type":"reasoning","id":"rs-1","summary":[{"type":"summary_text","text":"Thinking about hello"}],"encrypted_content":"AAAA_ENCRYPTED_BLOB_SHOULD_NOT_COUNT_XXXXXXXXXXXXXXXX","status":"completed"}
{"type":"assistant","content":"Hi there","tool_calls":[{"id":"call-1","name":"read_file","arguments":"{\"path\":\"a.rs\"}"}]}
{"type":"tool_result","tool_call_id":"call-1","content":"fn main() {}"}
{"type":"not-json
"#;
        fs::write(dir.join("chat_history.jsonl"), history).unwrap();
        fs::write(
            dir.join("signals.json"),
            r#"{"contextTokensUsed":5000,"contextWindowTokens":500000}"#,
        )
        .unwrap();

        let m = load_session_context_metrics(cwd, sid, &home).expect("ok");
        assert!(m.available);
        assert!(m.breakdown_approximate);
        let bd = m.breakdown.expect("bd");
        assert_eq!(
            bd.system_prompt + bd.rules + bd.conversation + bd.tools_runtime,
            5000
        );
        assert!(bd.system_prompt > 0);
        assert!(bd.rules > 0);
        assert!(bd.conversation > 0);

        // Conversation estimate alone must be far smaller than if system line were included.
        let conv_only = estimate_conversation(&dir);
        let system_line = estimate_tokens(
            "You are Grok. System only content for estimate. EXTRA PADDING THAT MUST NOT COUNT IN CONVERSATION CATEGORY BECAUSE IT IS SYSTEM TYPE.",
        );
        assert!(
            conv_only < system_line,
            "conversation {conv_only} should exclude system line (~{system_line})"
        );
        // Encrypted blob must not inflate conversation.
        let encrypted_est =
            estimate_tokens("AAAA_ENCRYPTED_BLOB_SHOULD_NOT_COUNT_XXXXXXXXXXXXXXXX");
        assert!(
            conv_only < encrypted_est + 20,
            "encrypted_content must not be counted"
        );

        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn malformed_partial_jsonl_and_missing_side_files() {
        let home = temp_home("partial-jsonl");
        let cwd = "/tmp/pj";
        let sid = "550e8400-e29b-41d4-a716-446655440000";
        let dir = session_fixture(&home, cwd, sid);
        fs::write(
            dir.join("signals.json"),
            r#"{"contextTokensUsed":1000,"contextWindowTokens":500000}"#,
        )
        .unwrap();
        // No system_prompt.txt, corrupt prompt_context, partial JSONL
        fs::write(dir.join("prompt_context.json"), r#"{"agents_md_files":"#).unwrap();
        fs::write(
            dir.join("chat_history.jsonl"),
            "{\"type\":\"user\",\"content\":\"ok line\"}\n{broken\n{\"type\":\"assistant\",\"content\":\"fine\"}\n",
        )
        .unwrap();

        let m = load_session_context_metrics(cwd, sid, &home).expect("ok");
        assert!(m.available);
        let bd = m.breakdown.expect("bd");
        assert_eq!(
            bd.system_prompt + bd.rules + bd.conversation + bd.tools_runtime,
            1000
        );
        assert_eq!(bd.system_prompt, 0);
        assert_eq!(bd.rules, 0);
        assert!(bd.conversation > 0);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn refuses_symlink_signals_file() {
        let home = temp_home("symlink");
        let cwd = "/tmp/sym";
        let sid = "550e8400-e29b-41d4-a716-446655440000";
        let dir = session_fixture(&home, cwd, sid);
        let real = home.join("outside-signals.json");
        fs::write(
            &real,
            r#"{"contextTokensUsed":99,"contextWindowTokens":100}"#,
        )
        .unwrap();
        // Symlink at signals.json must be refused (not treated as a regular file).
        symlink(&real, dir.join("signals.json")).expect("symlink");

        let located = locate_signals_path(cwd, sid, &home).unwrap();
        assert!(located.is_none(), "symlink signals must not be located");
        let m = load_session_context_metrics(cwd, sid, &home).expect("ok");
        assert!(!m.available);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn refuses_symlink_side_files_for_estimates() {
        let home = temp_home("symlink-side");
        let cwd = "/tmp/sym2";
        let sid = "550e8400-e29b-41d4-a716-446655440000";
        let dir = session_fixture(&home, cwd, sid);
        fs::write(
            dir.join("signals.json"),
            r#"{"contextTokensUsed":200,"contextWindowTokens":500000}"#,
        )
        .unwrap();
        let outside = home.join("leaked-prompt.txt");
        fs::write(
            &outside,
            "SECRET SYSTEM PROMPT THAT SHOULD BE IGNORED AS SYMLINK",
        )
        .unwrap();
        symlink(&outside, dir.join("system_prompt.txt")).expect("symlink");

        let m = load_session_context_metrics(cwd, sid, &home).expect("ok");
        let bd = m.breakdown.expect("bd");
        assert_eq!(bd.system_prompt, 0, "symlink system_prompt must be ignored");
        assert_eq!(
            bd.system_prompt + bd.rules + bd.conversation + bd.tools_runtime,
            200
        );
        let _ = fs::remove_dir_all(home);
    }
}
