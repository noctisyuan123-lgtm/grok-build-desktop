use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use std::path::Path;
use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RunState {
    Queued,
    Running,
    Done,
    Cancelled,
    Failed,
}

/// Delivery policy for a prompt submitted while another turn is active.
///
/// `Queue` waits until the current turn is completely finished. `Interrupt`
/// cancels the supplied parent turn before taking the lane. The external ACP
/// integration does not expose a reliable mid-turn steering primitive, so
/// legacy `steer` values are normalized to `Queue` when loaded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RunDelivery {
    Queue,
    Interrupt,
}

impl RunDelivery {
    pub fn as_str(&self) -> &'static str {
        match self {
            RunDelivery::Queue => "queue",
            RunDelivery::Interrupt => "interrupt",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "interrupt" => Self::Interrupt,
            _ => Self::Queue,
        }
    }
}

impl RunState {
    pub fn as_str(&self) -> &'static str {
        match self {
            RunState::Queued => "Queued",
            RunState::Running => "Running",
            RunState::Done => "Done",
            RunState::Cancelled => "Cancelled",
            RunState::Failed => "Failed",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "Queued" => Self::Queued,
            "Running" => Self::Running,
            "Done" => Self::Done,
            "Cancelled" => Self::Cancelled,
            "Failed" => Self::Failed,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyUsage {
    pub completed: i64,
    pub failed: i64,
    pub cancelled: i64,
    pub duration_ms: i64,
    pub since: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BillingSnapshot {
    pub sampled_at: i64,
    pub remaining_percent: i32,
    pub period_start: Option<String>,
    pub period_end: Option<String>,
}

const BILLING_ANCHOR_MS: i64 = 15 * 60 * 1000;
const BILLING_RETENTION_MS: i64 = 90 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone)]
pub struct RunRecord {
    pub id: String,
    pub prompt: String,
    pub cwd: String,
    pub args_json: String,
    pub state: RunState,
    pub enqueued_at: i64,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub stop_reason: Option<String>,
    pub error: Option<String>,
    /// UI session / tab lane. Independent lanes run concurrently; same lane
    /// stays serial (including parent → follow-up ordering).
    pub lane_id: String,
    /// Exact parent run whose ACP session this follow-up should resume.
    pub parent_run_id: Option<String>,
    /// Follow-up delivery policy for this prompt.
    pub delivery: RunDelivery,
}

#[derive(Clone)]
pub struct Db {
    pool: SqlitePool,
}

/// Raw `runs` row as selected by `fetch_run`/`list_by_state`, in column order.
type RunRow = (
    String,         // id
    String,         // prompt
    String,         // cwd
    String,         // args_json
    String,         // state
    i64,            // enqueued_at
    Option<i64>,    // started_at
    Option<i64>,    // ended_at
    Option<String>, // stop_reason
    Option<String>, // error
    String,         // lane_id
    Option<String>, // parent_run_id
    String,         // delivery
);

fn run_record(row: RunRow) -> RunRecord {
    let (id, prompt, cwd, args_json, state, eq, st, en, sr, err, lane_id, parent_run_id, delivery) =
        row;
    RunRecord {
        id,
        prompt,
        cwd,
        args_json,
        state: RunState::parse(&state).unwrap_or(RunState::Failed),
        enqueued_at: eq,
        started_at: st,
        ended_at: en,
        stop_reason: sr,
        error: err,
        lane_id,
        parent_run_id,
        delivery: RunDelivery::parse(&delivery),
    }
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    cwd TEXT NOT NULL,
    args_json TEXT NOT NULL,
    state TEXT NOT NULL,
    enqueued_at INTEGER NOT NULL,
    started_at INTEGER,
    ended_at INTEGER,
    stop_reason TEXT,
    error TEXT,
    lane_id TEXT NOT NULL DEFAULT '',
    parent_run_id TEXT,
    delivery TEXT NOT NULL DEFAULT 'queue'
);
CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state);
CREATE INDEX IF NOT EXISTS idx_runs_enqueued_at ON runs(enqueued_at);
CREATE TABLE IF NOT EXISTS billing_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sampled_at INTEGER NOT NULL,
    remaining_percent INTEGER NOT NULL,
    period_start TEXT,
    period_end TEXT,
    is_anchor INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_billing_snapshots_period
    ON billing_snapshots(period_start, sampled_at);
CREATE TABLE IF NOT EXISTS lane_heads (
    lane_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
"#;

/// Columns added after the initial schema. Applied with ALTER TABLE so
/// existing installs keep their rows.
const MIGRATIONS: &[&str] = &[
    "ALTER TABLE runs ADD COLUMN lane_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE runs ADD COLUMN parent_run_id TEXT",
    "ALTER TABLE runs ADD COLUMN delivery TEXT NOT NULL DEFAULT 'queue'",
];

/// Execute every `;`-delimited DDL statement in `schema` against the given
/// pool. sqlx::query() prepares a single statement at a time, so the CREATE
/// INDEX bodies in a multi-line SCHEMA string would silently be ignored if
/// passed to a single query(). This helper avoids that footgun. Shared with
/// the prompt-library store (prompts/mod.rs), which bootstraps the same way.
pub(crate) async fn run_schema(pool: &SqlitePool, schema: &str) -> Result<(), sqlx::Error> {
    for stmt in schema.split(';') {
        let trimmed = stmt.trim();
        if !trimmed.is_empty() {
            sqlx::query(trimmed).execute(pool).await?;
        }
    }
    Ok(())
}

async fn apply_migrations(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    for stmt in MIGRATIONS {
        // Duplicate column name is expected on fresh schemas that already
        // include the column in CREATE TABLE, and on re-open of migrated DBs.
        if let Err(err) = sqlx::query(stmt).execute(pool).await {
            let msg = err.to_string();
            if !msg.contains("duplicate column") {
                return Err(err);
            }
        }
    }
    Ok(())
}

impl Db {
    pub async fn open_memory() -> Result<Self, sqlx::Error> {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(SqliteConnectOptions::from_str("sqlite::memory:")?)
            .await?;
        run_schema(&pool, SCHEMA).await?;
        apply_migrations(&pool).await?;
        Ok(Self { pool })
    }

    pub async fn open_at(path: &Path) -> Result<Self, sqlx::Error> {
        let opts = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            // Force WAL off and single-conn so DDL definitely persists to the
            // file. Without this, sqlx-pooled connections + the lazy CREATE
            // sequence can leave a 0-byte file on first run.
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Delete)
            .synchronous(sqlx::sqlite::SqliteSynchronous::Normal);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await?;
        run_schema(&pool, SCHEMA).await?;
        apply_migrations(&pool).await?;
        Ok(Self { pool })
    }

    pub async fn insert_run(&self, r: &RunRecord) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO runs (id, prompt, cwd, args_json, state, enqueued_at, started_at, ended_at, stop_reason, error, lane_id, parent_run_id, delivery)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&r.id).bind(&r.prompt).bind(&r.cwd).bind(&r.args_json)
        .bind(r.state.as_str())
        .bind(r.enqueued_at).bind(r.started_at).bind(r.ended_at)
        .bind(&r.stop_reason).bind(&r.error)
        .bind(&r.lane_id).bind(&r.parent_run_id).bind(r.delivery.as_str())
        .execute(&self.pool).await?;
        Ok(())
    }

    pub async fn update_state(
        &self,
        id: &str,
        state: RunState,
        started_at: Option<i64>,
        ended_at: Option<i64>,
        stop_reason: Option<String>,
        error: Option<String>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE runs SET state = ?, started_at = COALESCE(?, started_at),
             ended_at = COALESCE(?, ended_at), stop_reason = COALESCE(?, stop_reason),
             error = COALESCE(?, error) WHERE id = ?",
        )
        .bind(state.as_str())
        .bind(started_at)
        .bind(ended_at)
        .bind(stop_reason)
        .bind(error)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn fetch_run(&self, id: &str) -> Result<Option<RunRecord>, sqlx::Error> {
        let row: Option<RunRow> =
            sqlx::query_as(
                "SELECT id, prompt, cwd, args_json, state, enqueued_at, started_at, ended_at, stop_reason, error, lane_id, parent_run_id, delivery FROM runs WHERE id = ?"
            )
            .bind(id)
            .fetch_optional(&self.pool).await?;
        Ok(row.map(run_record))
    }

    pub async fn list_by_state(&self, state: RunState) -> Result<Vec<RunRecord>, sqlx::Error> {
        let rows: Vec<RunRow> =
            sqlx::query_as(
                "SELECT id, prompt, cwd, args_json, state, enqueued_at, started_at, ended_at, stop_reason, error, lane_id, parent_run_id, delivery
                 FROM runs WHERE state = ? ORDER BY enqueued_at ASC"
            )
            .bind(state.as_str())
            .fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(run_record).collect())
    }

    /// Counts finished runs in the trailing window, plus summed run duration.
    pub async fn weekly_usage(&self, window_ms: i64) -> Result<WeeklyUsage, sqlx::Error> {
        let since = chrono::Utc::now().timestamp_millis() - window_ms;
        let rows: Vec<(String, i64, i64)> = sqlx::query_as(
            "SELECT state, COUNT(*), COALESCE(SUM(CASE
                WHEN started_at IS NOT NULL AND ended_at IS NOT NULL AND ended_at >= started_at
                THEN ended_at - started_at ELSE 0 END), 0)
             FROM runs
             WHERE COALESCE(ended_at, enqueued_at) >= ?
             GROUP BY state",
        )
        .bind(since)
        .fetch_all(&self.pool)
        .await?;
        let mut usage = WeeklyUsage {
            completed: 0,
            failed: 0,
            cancelled: 0,
            duration_ms: 0,
            since,
        };
        for (state, count, duration_ms) in rows {
            usage.duration_ms += duration_ms;
            match state.as_str() {
                "Done" => usage.completed = count,
                "Failed" => usage.failed = count,
                "Cancelled" => usage.cancelled = count,
                _ => {}
            }
        }
        Ok(usage)
    }

    /// Delete finished runs older than `retention_ms`. Returns count deleted.
    pub async fn vacuum(&self, retention_ms: i64) -> Result<u64, sqlx::Error> {
        let cutoff = chrono::Utc::now().timestamp_millis() - retention_ms;
        let result = sqlx::query(
            "DELETE FROM runs WHERE state IN ('Done','Cancelled','Failed') AND COALESCE(ended_at, enqueued_at) < ?"
        )
        .bind(cutoff)
        .execute(&self.pool).await?;
        Ok(result.rows_affected())
    }

    /// On startup: change any Running rows to Cancelled (subprocess is dead).
    pub async fn cancel_orphans(&self, reason: &str) -> Result<u64, sqlx::Error> {
        let now = chrono::Utc::now().timestamp_millis();
        let result = sqlx::query(
            "UPDATE runs SET state = 'Cancelled', ended_at = ?, error = ? WHERE state = 'Running'",
        )
        .bind(now)
        .bind(reason)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }

    pub async fn latest_billing_snapshot(&self) -> Result<Option<BillingSnapshot>, sqlx::Error> {
        sqlx::query_as::<_, (i64, i32, Option<String>, Option<String>)>(
            "SELECT sampled_at, remaining_percent, period_start, period_end
             FROM billing_snapshots
             ORDER BY sampled_at DESC, id DESC
             LIMIT 1",
        )
        .fetch_optional(&self.pool)
        .await
        .map(|row| {
            row.map(
                |(sampled_at, remaining_percent, period_start, period_end)| BillingSnapshot {
                    sampled_at,
                    remaining_percent,
                    period_start,
                    period_end,
                },
            )
        })
    }

    /// Records a remaining-quota sample when the value changed, the billing
    /// cycle changed, or 15 minutes have passed since the last row.
    pub async fn record_billing_snapshot(
        &self,
        remaining_percent: i32,
        period_start: Option<&str>,
        period_end: Option<&str>,
        now_ms: i64,
    ) -> Result<bool, sqlx::Error> {
        let remaining_percent = remaining_percent.clamp(0, 100);
        let previous = self.latest_billing_snapshot().await?;
        let (should_insert, is_anchor) = match previous {
            None => (true, false),
            Some(prev) => {
                let new_cycle = prev.period_start.as_deref() != period_start;
                let changed = prev.remaining_percent != remaining_percent;
                let due = now_ms.saturating_sub(prev.sampled_at) >= BILLING_ANCHOR_MS;
                (new_cycle || changed || due, !new_cycle && !changed && due)
            }
        };
        if !should_insert {
            return Ok(false);
        }
        sqlx::query(
            "INSERT INTO billing_snapshots (sampled_at, remaining_percent, period_start, period_end, is_anchor)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(now_ms)
        .bind(remaining_percent)
        .bind(period_start)
        .bind(period_end)
        .bind(if is_anchor { 1 } else { 0 })
        .execute(&self.pool)
        .await?;
        let cutoff = now_ms.saturating_sub(BILLING_RETENTION_MS);
        sqlx::query("DELETE FROM billing_snapshots WHERE sampled_at < ?")
            .bind(cutoff)
            .execute(&self.pool)
            .await?;
        Ok(true)
    }

    pub async fn list_billing_snapshots(
        &self,
        period_start: Option<&str>,
    ) -> Result<Vec<BillingSnapshot>, sqlx::Error> {
        let Some(period_start) = period_start else {
            return Ok(Vec::new());
        };
        let rows: Vec<(i64, i32, Option<String>, Option<String>)> = sqlx::query_as(
            "SELECT sampled_at, remaining_percent, period_start, period_end
             FROM billing_snapshots
             WHERE period_start = ?
             ORDER BY sampled_at ASC, id ASC",
        )
        .bind(period_start)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(
                |(sampled_at, remaining_percent, period_start, period_end)| BillingSnapshot {
                    sampled_at,
                    remaining_percent,
                    period_start,
                    period_end,
                },
            )
            .collect())
    }

    /// Persist the authoritative ACP session identity for a UI lane/tab.
    pub async fn upsert_lane_head(&self, lane_id: &str, session_id: &str) -> Result<(), sqlx::Error> {
        if lane_id.is_empty() || session_id.is_empty() {
            return Ok(());
        }
        let now = chrono::Utc::now().timestamp_millis();
        sqlx::query(
            "INSERT INTO lane_heads (lane_id, session_id, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(lane_id) DO UPDATE SET
               session_id = excluded.session_id,
               updated_at = excluded.updated_at",
        )
        .bind(lane_id)
        .bind(session_id)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_lane_head(&self, lane_id: &str) -> Result<Option<String>, sqlx::Error> {
        if lane_id.is_empty() {
            return Ok(None);
        }
        sqlx::query_as::<_, (String,)>(
            "SELECT session_id FROM lane_heads WHERE lane_id = ?",
        )
        .bind(lane_id)
        .fetch_optional(&self.pool)
        .await
        .map(|row| row.map(|(session_id,)| session_id))
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn lane_heads_round_trip() {
        let db = Db::open_memory().await.expect("open memory db");
        assert_eq!(db.get_lane_head("tab_a").await.unwrap(), None);
        db.upsert_lane_head("tab_a", "sess-1").await.unwrap();
        assert_eq!(
            db.get_lane_head("tab_a").await.unwrap().as_deref(),
            Some("sess-1")
        );
        db.upsert_lane_head("tab_a", "sess-2").await.unwrap();
        assert_eq!(
            db.get_lane_head("tab_a").await.unwrap().as_deref(),
            Some("sess-2")
        );
        // Empty lane ids are ignored (legacy default lane).
        db.upsert_lane_head("", "sess-x").await.unwrap();
        assert_eq!(db.get_lane_head("").await.unwrap(), None);
    }
}
