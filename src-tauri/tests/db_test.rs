use chrono::Utc;
use grok_desktop_lib::runs::db::{Db, RunDelivery, RunRecord, RunState};

#[tokio::test]
async fn insert_and_fetch_run() {
    let db = Db::open_memory().await.expect("open memory db");
    let id = "01900000-0000-7000-8000-000000000001".to_string();

    let rec = RunRecord {
        id: id.clone(),
        prompt: "hello".into(),
        cwd: "/tmp".into(),
        args_json: "[]".into(),
        state: RunState::Queued,
        enqueued_at: Utc::now().timestamp_millis(),
        started_at: None,
        ended_at: None,
        stop_reason: None,
        error: None,
        lane_id: "tab-a".into(),
        parent_run_id: None,
        delivery: RunDelivery::Queue,
    };

    db.insert_run(&rec).await.expect("insert");
    let got = db.fetch_run(&id).await.expect("fetch").expect("not none");
    assert_eq!(got.prompt, "hello");
    assert_eq!(got.lane_id, "tab-a");
    assert_eq!(got.delivery, RunDelivery::Queue);
    assert!(matches!(got.state, RunState::Queued));
}

#[tokio::test]
async fn update_state_persists() {
    let db = Db::open_memory().await.unwrap();
    let id = "01900000-0000-7000-8000-000000000002".to_string();
    let rec = RunRecord {
        id: id.clone(),
        prompt: "p".into(),
        cwd: "/tmp".into(),
        args_json: "[]".into(),
        state: RunState::Queued,
        enqueued_at: Utc::now().timestamp_millis(),
        started_at: None,
        ended_at: None,
        stop_reason: None,
        error: None,
        lane_id: String::new(),
        parent_run_id: Some("parent-1".into()),
        delivery: RunDelivery::Queue,
    };
    db.insert_run(&rec).await.unwrap();

    db.update_state(
        &id,
        RunState::Running,
        Some(Utc::now().timestamp_millis()),
        None,
        None,
        None,
    )
    .await
    .unwrap();

    let got = db.fetch_run(&id).await.unwrap().unwrap();
    assert!(matches!(got.state, RunState::Running));
    assert!(got.started_at.is_some());
    assert_eq!(got.parent_run_id.as_deref(), Some("parent-1"));
    assert_eq!(got.delivery, RunDelivery::Queue);
}

#[test]
fn legacy_steer_delivery_is_normalized_to_queue() {
    assert_eq!(RunDelivery::parse("steer"), RunDelivery::Queue);
}

#[tokio::test]
async fn vacuum_drops_old_finished_runs() {
    let db = Db::open_memory().await.unwrap();
    let week_ms = 7 * 24 * 60 * 60 * 1000;
    let old = Utc::now().timestamp_millis() - week_ms - 1000;
    let new = Utc::now().timestamp_millis();

    for (id, ended) in [("old", old), ("new", new)] {
        db.insert_run(&RunRecord {
            id: id.into(),
            prompt: "p".into(),
            cwd: "/tmp".into(),
            args_json: "[]".into(),
            state: RunState::Done,
            enqueued_at: ended,
            started_at: Some(ended),
            ended_at: Some(ended),
            stop_reason: Some("EndTurn".into()),
            error: None,
            lane_id: String::new(),
            parent_run_id: None,
            delivery: RunDelivery::Queue,
        })
        .await
        .unwrap();
    }

    let removed = db.vacuum(week_ms).await.unwrap();
    assert_eq!(removed, 1);
    assert!(db.fetch_run("old").await.unwrap().is_none());
    assert!(db.fetch_run("new").await.unwrap().is_some());
}

#[tokio::test]
async fn weekly_usage_counts_recent_finished_runs() {
    let db = Db::open_memory().await.unwrap();
    let now = Utc::now().timestamp_millis();
    let week_ms = 7 * 24 * 60 * 60 * 1000;
    db.insert_run(&RunRecord {
        id: "done".into(),
        prompt: "p".into(),
        cwd: "/tmp".into(),
        args_json: "[]".into(),
        state: RunState::Done,
        enqueued_at: now - 60_000,
        started_at: Some(now - 60_000),
        ended_at: Some(now - 10_000),
        stop_reason: Some("EndTurn".into()),
        error: None,
        lane_id: String::new(),
        parent_run_id: None,
        delivery: RunDelivery::Queue,
    })
    .await
    .unwrap();
    db.insert_run(&RunRecord {
        id: "fail".into(),
        prompt: "p".into(),
        cwd: "/tmp".into(),
        args_json: "[]".into(),
        state: RunState::Failed,
        enqueued_at: now - 30_000,
        started_at: Some(now - 30_000),
        ended_at: Some(now - 20_000),
        stop_reason: None,
        error: Some("boom".into()),
        lane_id: String::new(),
        parent_run_id: None,
        delivery: RunDelivery::Queue,
    })
    .await
    .unwrap();
    db.insert_run(&RunRecord {
        id: "old".into(),
        prompt: "p".into(),
        cwd: "/tmp".into(),
        args_json: "[]".into(),
        state: RunState::Done,
        enqueued_at: now - week_ms - 5_000,
        started_at: Some(now - week_ms - 5_000),
        ended_at: Some(now - week_ms - 4_000),
        stop_reason: Some("EndTurn".into()),
        error: None,
        lane_id: String::new(),
        parent_run_id: None,
        delivery: RunDelivery::Queue,
    })
    .await
    .unwrap();

    let usage = db.weekly_usage(week_ms).await.unwrap();
    assert_eq!(usage.completed, 1);
    assert_eq!(usage.failed, 1);
    assert_eq!(usage.cancelled, 0);
    assert_eq!(usage.duration_ms, 50_000 + 10_000);
}

#[tokio::test]
async fn billing_snapshots_record_changes_and_15_minute_anchors() {
    let db = Db::open_memory().await.unwrap();
    let start = "2026-09-08T00:06:00Z";
    let end = "2026-09-15T00:06:00Z";
    let t0 = 1_778_000_000_000;

    assert!(db
        .record_billing_snapshot(68, Some(start), Some(end), t0)
        .await
        .unwrap());
    assert!(!db
        .record_billing_snapshot(68, Some(start), Some(end), t0 + 60_000)
        .await
        .unwrap());
    assert!(db
        .record_billing_snapshot(60, Some(start), Some(end), t0 + 120_000)
        .await
        .unwrap());
    assert!(db
        .record_billing_snapshot(60, Some(start), Some(end), t0 + 15 * 60 * 1000 + 120_000)
        .await
        .unwrap());

    let next_start = "2026-09-15T00:06:00Z";
    assert!(db
        .record_billing_snapshot(
            100,
            Some(next_start),
            Some("2026-09-22T00:06:00Z"),
            t0 + 16 * 60 * 1000,
        )
        .await
        .unwrap());

    let current = db.list_billing_snapshots(Some(start)).await.unwrap();
    assert_eq!(current.len(), 3);
    assert_eq!(
        current
            .iter()
            .map(|row| row.remaining_percent)
            .collect::<Vec<_>>(),
        vec![68, 60, 60]
    );
    let next = db.list_billing_snapshots(Some(next_start)).await.unwrap();
    assert_eq!(next.len(), 1);
    assert_eq!(next[0].remaining_percent, 100);
}
