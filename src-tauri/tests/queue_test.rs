use grok_desktop_lib::runs::db::{Db, RunState};
use grok_desktop_lib::runs::event::GrokEvent;
use grok_desktop_lib::runs::queue::{
    keep_utf8_tail, QueueMessageKind, RunQueue, STDERR_TAIL_MAX_BYTES,
};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

fn fake_grok_path() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop();
    // Windows cannot exec a shell script; use the batch twin (which also
    // matches production, where the grok CLI is an npm .cmd shim).
    if cfg!(windows) {
        p.push("scripts/fake-grok.cmd");
    } else {
        p.push("scripts/fake-grok.sh");
    }
    p
}

async fn collect_until_done(
    rx: &mut tokio::sync::broadcast::Receiver<grok_desktop_lib::runs::queue::QueueMessage>,
    min_done: usize,
    max_wait: Duration,
) -> Vec<grok_desktop_lib::runs::queue::QueueMessage> {
    let mut events = Vec::new();
    let deadline = tokio::time::Instant::now() + max_wait;
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
            Ok(Ok(msg)) => events.push(msg),
            _ => {
                let done = events
                    .iter()
                    .filter(|m| {
                        matches!(
                            m.kind,
                            QueueMessageKind::StateChanged {
                                state: RunState::Done,
                                ..
                            }
                        )
                    })
                    .count();
                if done >= min_done {
                    break;
                }
            }
        }
    }
    events
}

#[tokio::test]
async fn enqueue_runs_serial_and_emits_events() {
    let db = Db::open_memory().await.unwrap();
    let (q, mut rx) = RunQueue::new(db, fake_grok_path()).await;
    let q = Arc::new(q);
    q.clone().spawn_worker();

    let (_id1, pos1) = q
        .enqueue("p1".into(), "/tmp".into(), vec!["--ok".into()], None, None)
        .await
        .unwrap();
    let (_id2, pos2) = q
        .enqueue("p2".into(), "/tmp".into(), vec!["--ok".into()], None, None)
        .await
        .unwrap();
    assert_eq!(pos1, 0);
    // Same default lane: second is behind the first.
    assert_eq!(pos2, 1);

    let events = collect_until_done(&mut rx, 2, Duration::from_secs(5)).await;

    let done_count = events
        .iter()
        .filter(|m| {
            matches!(
                m.kind,
                QueueMessageKind::StateChanged {
                    state: RunState::Done,
                    ..
                }
            )
        })
        .count();
    assert_eq!(
        done_count,
        2,
        "expected 2 Done state events, got {} (events: {:?})",
        done_count,
        events.len()
    );
}

/// Independent UI sessions (lanes) must start concurrently: a long run on
/// lane A must not leave lane B waiting as "queued".
#[tokio::test]
async fn different_lanes_begin_before_first_slow_run_completes() {
    let db = Db::open_memory().await.unwrap();
    let (q, mut rx) = RunQueue::new(db, fake_grok_path()).await;
    let q = Arc::new(q);
    q.clone().spawn_worker();

    let (slow_id, pos_a) = q
        .enqueue(
            "slow".into(),
            "/tmp".into(),
            vec!["--slow".into()],
            None,
            Some("lane-a".into()),
        )
        .await
        .unwrap();
    let (fast_id, pos_b) = q
        .enqueue(
            "fast".into(),
            "/tmp".into(),
            vec!["--ok".into()],
            None,
            Some("lane-b".into()),
        )
        .await
        .unwrap();
    assert_eq!(pos_a, 0);
    // Different lane is idle → runs next (position 0), not queued behind A.
    assert_eq!(pos_b, 0);

    let mut saw_fast_running = false;
    let mut saw_slow_running = false;
    let mut fast_done_before_slow = false;
    let mut slow_done = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(150), rx.recv()).await {
            Ok(Ok(msg)) => {
                if let QueueMessageKind::StateChanged {
                    state: RunState::Running,
                    ..
                } = &msg.kind
                {
                    if msg.run_id == fast_id {
                        saw_fast_running = true;
                    }
                    if msg.run_id == slow_id {
                        saw_slow_running = true;
                    }
                    // Both must have started while the slow run is still in flight.
                    if saw_fast_running && saw_slow_running && !slow_done {
                        // concurrency observed
                    }
                }
                if let QueueMessageKind::StateChanged {
                    state: RunState::Done,
                    ..
                } = &msg.kind
                {
                    if msg.run_id == fast_id && !slow_done {
                        fast_done_before_slow = true;
                    }
                    if msg.run_id == slow_id {
                        slow_done = true;
                    }
                }
                if fast_done_before_slow && slow_done {
                    break;
                }
            }
            _ => {
                if fast_done_before_slow && slow_done {
                    break;
                }
            }
        }
    }

    assert!(
        saw_fast_running && saw_slow_running,
        "both lanes must enter Running (fast={saw_fast_running}, slow={saw_slow_running})"
    );
    assert!(
        fast_done_before_slow,
        "fast lane must finish while slow lane is still running"
    );
    assert!(slow_done, "slow lane should eventually finish");
}

/// Same UI session lane must serialize: second run stays queued until first ends.
#[tokio::test]
async fn same_lane_serializes_runs() {
    let db = Db::open_memory().await.unwrap();
    let (q, mut rx) = RunQueue::new(db, fake_grok_path()).await;
    let q = Arc::new(q);
    q.clone().spawn_worker();

    let (first, pos1) = q
        .enqueue(
            "first".into(),
            "/tmp".into(),
            vec!["--slow".into()],
            None,
            Some("lane-s".into()),
        )
        .await
        .unwrap();
    let (second, pos2) = q
        .enqueue(
            "second".into(),
            "/tmp".into(),
            vec!["--ok".into()],
            None,
            Some("lane-s".into()),
        )
        .await
        .unwrap();
    assert_eq!(pos1, 0);
    assert_eq!(pos2, 1, "same lane must report queued behind active run");

    let mut first_done_at: Option<tokio::time::Instant> = None;
    let mut second_running_at: Option<tokio::time::Instant> = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(150), rx.recv()).await {
            Ok(Ok(msg)) => {
                if matches!(
                    msg.kind,
                    QueueMessageKind::StateChanged {
                        state: RunState::Done,
                        ..
                    }
                ) && msg.run_id == first
                {
                    first_done_at = Some(tokio::time::Instant::now());
                }
                if matches!(
                    msg.kind,
                    QueueMessageKind::StateChanged {
                        state: RunState::Running,
                        ..
                    }
                ) && msg.run_id == second
                {
                    second_running_at = Some(tokio::time::Instant::now());
                }
                if first_done_at.is_some() && second_running_at.is_some() {
                    // Wait a bit more for second Done if needed.
                    if matches!(
                        msg.kind,
                        QueueMessageKind::StateChanged {
                            state: RunState::Done,
                            ..
                        }
                    ) && msg.run_id == second
                    {
                        break;
                    }
                }
            }
            _ => {
                if first_done_at.is_some() && second_running_at.is_some() {
                    // second may still be finishing
                }
            }
        }
        if let (Some(fd), Some(sr)) = (first_done_at, second_running_at) {
            // If second started after first done, we're good; collect rest.
            if sr >= fd {
                let _ = collect_until_done(&mut rx, 0, Duration::from_secs(2)).await;
                break;
            }
        }
    }

    let fd = first_done_at.expect("first run must complete");
    let sr = second_running_at.expect("second run must start");
    assert!(
        sr >= fd || sr.duration_since(fd) < Duration::from_millis(1) || fd <= sr,
        "second must not start before first finishes on the same lane"
    );
    // Strict: second Running only after first Done (allow tiny race on clock).
    assert!(
        !sr.checked_duration_since(fd).is_none() || sr >= fd,
        "same-lane second must wait for first"
    );
    // Clearer assertion:
    assert!(
        sr >= fd,
        "second Running ({sr:?}) must be at/after first Done ({fd:?})"
    );
}

/// Cancelling one concurrent run must not cancel or block another lane.
#[tokio::test]
async fn cancel_one_concurrent_run_does_not_block_other_lane() {
    let db = Db::open_memory().await.unwrap();
    let (q, mut rx) = RunQueue::new(db, fake_grok_path()).await;
    let q = Arc::new(q);
    q.clone().spawn_worker();

    let (hang_id, _) = q
        .enqueue(
            "hang".into(),
            "/tmp".into(),
            vec!["--hang".into()],
            None,
            Some("lane-hang".into()),
        )
        .await
        .unwrap();
    let (ok_id, _) = q
        .enqueue(
            "ok".into(),
            "/tmp".into(),
            vec!["--ok".into()],
            None,
            Some("lane-ok".into()),
        )
        .await
        .unwrap();

    // Wait until both are running (or ok finishes) so hang is definitely active.
    let mut hang_running = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(100), rx.recv()).await {
            Ok(Ok(msg)) => {
                if matches!(
                    msg.kind,
                    QueueMessageKind::StateChanged {
                        state: RunState::Running,
                        ..
                    }
                ) && msg.run_id == hang_id
                {
                    hang_running = true;
                    break;
                }
            }
            _ => {}
        }
    }
    assert!(hang_running, "hang run should be active before cancel");

    assert!(q.cancel(&hang_id).await.unwrap());

    let mut hang_cancelled = false;
    let mut ok_done = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(150), rx.recv()).await {
            Ok(Ok(msg)) => {
                if matches!(
                    msg.kind,
                    QueueMessageKind::StateChanged {
                        state: RunState::Cancelled,
                        ..
                    }
                ) && msg.run_id == hang_id
                {
                    hang_cancelled = true;
                }
                if matches!(
                    msg.kind,
                    QueueMessageKind::StateChanged {
                        state: RunState::Done,
                        ..
                    }
                ) && msg.run_id == ok_id
                {
                    ok_done = true;
                }
                if hang_cancelled && ok_done {
                    break;
                }
            }
            _ => {}
        }
    }

    assert!(hang_cancelled, "target run must be cancelled");
    assert!(ok_done, "other lane must still complete successfully");
}

/// A same-lane follow-up must wait for its parent and resume that exact session.
#[tokio::test]
async fn continuation_gets_exact_parent_session() {
    let db = Db::open_memory().await.unwrap();
    let (q, mut rx) = RunQueue::new(db, fake_grok_path()).await;
    let q = Arc::new(q);
    q.clone().spawn_worker();

    let (parent_id, _) = q
        .enqueue(
            "parent".into(),
            "/tmp".into(),
            vec!["--ok".into()],
            None,
            Some("lane-c".into()),
        )
        .await
        .unwrap();
    // Enqueue child while parent is still the active lane head.
    let (child_id, pos) = q
        .enqueue(
            "child".into(),
            "/tmp".into(),
            vec!["--ok".into()],
            Some(parent_id.clone()),
            Some("lane-c".into()),
        )
        .await
        .unwrap();
    assert_eq!(pos, 1, "follow-up must queue behind parent on same lane");

    let mut parent_session: Option<String> = None;
    let mut child_resume_text: Option<String> = None;
    let mut child_done = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(6);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(150), rx.recv()).await {
            Ok(Ok(msg)) => {
                if msg.run_id == parent_id {
                    if let QueueMessageKind::Event {
                        event: GrokEvent::End { session_id, .. },
                        ..
                    } = &msg.kind
                    {
                        parent_session = Some(session_id.clone());
                    }
                }
                if msg.run_id == child_id {
                    if let QueueMessageKind::Event {
                        event: GrokEvent::Text { data },
                        ..
                    } = &msg.kind
                    {
                        if data.starts_with("resume:") {
                            child_resume_text = Some(data.clone());
                        }
                    }
                    if matches!(
                        msg.kind,
                        QueueMessageKind::StateChanged {
                            state: RunState::Done,
                            ..
                        }
                    ) {
                        child_done = true;
                        break;
                    }
                }
            }
            _ => {
                if child_done {
                    break;
                }
            }
        }
    }

    assert!(child_done, "child follow-up must complete");
    let session = parent_session.expect("parent must emit a session id");
    assert_eq!(session, "sess-1");
    assert_eq!(
        child_resume_text.as_deref(),
        Some("resume:sess-1"),
        "child must be launched with --resume of the exact parent session"
    );
}

#[test]
fn stderr_tail_truncation_cuts_on_char_boundary() {
    // 1 ASCII byte + 2000 three-byte '€' chars = 6001 bytes. The naive cut at
    // `len - 4096` = 1905 lands INSIDE a '€' (char boundaries after the prefix
    // sit at 1 + 3k, and 1905 is not of that form) — the old byte-slice
    // truncation panicked here and silently killed the stderr-drain task.
    let mut tail = format!("x{}", "€".repeat(2000));
    assert!(!tail.is_char_boundary(tail.len() - STDERR_TAIL_MAX_BYTES));

    keep_utf8_tail(&mut tail, STDERR_TAIL_MAX_BYTES);

    assert!(tail.len() <= STDERR_TAIL_MAX_BYTES);
    // A true suffix: nothing but whole '€' chars survive the cut.
    assert!(!tail.is_empty());
    assert!(tail.chars().all(|c| c == '€'));
}

#[test]
fn stderr_tail_truncation_keeps_the_end_of_ascii_input() {
    let mut tail = "a".repeat(5000);
    tail.push_str("END");
    keep_utf8_tail(&mut tail, 100);
    assert_eq!(tail.len(), 100);
    assert!(tail.ends_with("END"));
}

#[test]
fn stderr_tail_truncation_leaves_short_strings_untouched() {
    let mut tail = String::from("short error");
    keep_utf8_tail(&mut tail, STDERR_TAIL_MAX_BYTES);
    assert_eq!(tail, "short error");
}

#[tokio::test]
async fn cancel_queued_marks_cancelled_without_running() {
    let db = Db::open_memory().await.unwrap();
    let (q, mut rx) = RunQueue::new(db.clone(), fake_grok_path()).await;
    let q = Arc::new(q);
    // Do NOT spawn worker — we want to inspect waiting queue state directly.

    let (id, _) = q
        .enqueue("p".into(), "/tmp".into(), vec!["--ok".into()], None, None)
        .await
        .unwrap();
    let cancelled = q.cancel(&id).await.unwrap();
    assert!(cancelled);

    let rec = db.fetch_run(&id).await.unwrap().unwrap();
    assert!(matches!(rec.state, RunState::Cancelled));

    let mut saw_terminal = false;
    for _ in 0..3 {
        let msg = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
            .await
            .unwrap()
            .unwrap();
        if matches!(
            msg.kind,
            QueueMessageKind::StateChanged {
                state: RunState::Cancelled,
                ..
            }
        ) {
            saw_terminal = true;
            break;
        }
    }
    assert!(saw_terminal, "queued cancellation must reach the frontend");
}

#[tokio::test]
async fn clear_waiting_emits_a_terminal_state_for_every_run() {
    let db = Db::open_memory().await.unwrap();
    let (q, mut rx) = RunQueue::new(db, fake_grok_path()).await;
    let q = Arc::new(q);
    let (first, _) = q
        .enqueue(
            "first".into(),
            "/tmp".into(),
            vec!["--ok".into()],
            None,
            None,
        )
        .await
        .unwrap();
    let (second, _) = q
        .enqueue(
            "second".into(),
            "/tmp".into(),
            vec!["--ok".into()],
            None,
            None,
        )
        .await
        .unwrap();

    assert_eq!(q.clear_waiting().await.unwrap(), 2);

    let mut terminal_ids = std::collections::HashSet::new();
    for _ in 0..8 {
        let Ok(Ok(msg)) =
            tokio::time::timeout(std::time::Duration::from_millis(200), rx.recv()).await
        else {
            break;
        };
        if matches!(
            msg.kind,
            QueueMessageKind::StateChanged {
                state: RunState::Cancelled,
                ..
            }
        ) {
            terminal_ids.insert(msg.run_id);
        }
    }
    assert_eq!(
        terminal_ids,
        std::collections::HashSet::from([first, second])
    );
}
