//! Grok CLI `/usage` (ACP `_x.ai/billing`) — credit usage for the Settings page.
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use super::process::default_proxy_env;

const BILLING_TIMEOUT: Duration = Duration::from_secs(25);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CliUsage {
    pub ok: bool,
    pub error: Option<String>,
    pub credit_usage_percent: Option<f64>,
    pub period_type: Option<String>,
    pub period_start: Option<String>,
    pub period_end: Option<String>,
    pub on_demand_cap: Option<f64>,
    pub on_demand_used: Option<f64>,
    pub prepaid_balance: Option<f64>,
    pub unified_billing: bool,
    pub subscription_tier: Option<String>,
}

impl CliUsage {
    pub fn fail(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(message.into()),
            credit_usage_percent: None,
            period_type: None,
            period_start: None,
            period_end: None,
            on_demand_cap: None,
            on_demand_used: None,
            prepaid_balance: None,
            unified_billing: false,
            subscription_tier: None,
        }
    }
}

pub fn fetch_cli_billing(program: &str, path_env: &str) -> CliUsage {
    if !Path::new(program).is_file() {
        return CliUsage::fail(format!("grok CLI not found at {program}"));
    }

    let mut command = Command::new(program);
    command
        .args(["agent", "--no-leader", "stdio"])
        .env("PATH", path_env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in default_proxy_env() {
        command.env(key, value);
    }
    if let Ok(home) = std::env::var("HOME") {
        command.current_dir(home);
    }
    #[cfg(unix)]
    unsafe {
        command.pre_exec(|| {
            nix::unistd::setpgid(nix::unistd::Pid::from_raw(0), nix::unistd::Pid::from_raw(0))
                .map_err(std::io::Error::other)?;
            Ok(())
        });
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return CliUsage::fail(format!(
                "Couldn't start grok CLI ({error}). Check that grok is installed."
            ))
        }
    };
    let pgid = child.id() as i32;
    let stdin = match child.stdin.take() {
        Some(stdin) => Arc::new(Mutex::new(stdin)),
        None => {
            terminate(&mut child, pgid);
            return CliUsage::fail("Grok CLI stdin unavailable");
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate(&mut child, pgid);
            return CliUsage::fail("Grok CLI stdout unavailable");
        }
    };
    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || {
            for _ in BufReader::new(stderr).lines() {}
        });
    }

    let (tx, rx) = mpsc::channel::<Value>();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(message) = serde_json::from_str::<Value>(trimmed) {
                if tx.send(message).is_err() {
                    break;
                }
            }
        }
    });

    let deadline = Instant::now() + BILLING_TIMEOUT;
    let init = match rpc(
        &stdin,
        &rx,
        1,
        "initialize",
        json!({
            "protocolVersion": 1,
            "clientCapabilities": {
                "fs": { "readTextFile": false, "writeTextFile": false },
                "terminal": false
            },
            "clientInfo": { "name": "grok-build-desktop", "version": env!("CARGO_PKG_VERSION") }
        }),
        deadline,
    ) {
        Ok(value) => value,
        Err(error) => {
            terminate(&mut child, pgid);
            return CliUsage::fail(error);
        }
    };
    if init.get("error").is_some() {
        terminate(&mut child, pgid);
        return CliUsage::fail(format!("initialize: {}", init["error"]));
    }

    let billing = match rpc(
        &stdin,
        &rx,
        2,
        "_x.ai/billing",
        json!({}),
        deadline,
    ) {
        Ok(value) => value,
        Err(error) => {
            terminate(&mut child, pgid);
            return CliUsage::fail(error);
        }
    };
    terminate(&mut child, pgid);

    if let Some(error) = billing.get("error") {
        return CliUsage::fail(format!("_x.ai/billing: {error}"));
    }
    parse_billing_result(billing.get("result").unwrap_or(&Value::Null))
}

pub fn parse_billing_result(result: &Value) -> CliUsage {
    let config = result.get("config").unwrap_or(result);
    if config.is_null() {
        return CliUsage::fail("Grok CLI returned empty billing data");
    }
    let period = config.get("currentPeriod").cloned().unwrap_or(Value::Null);
    let period_start = string_field(&period, "start")
        .or_else(|| string_field(config, "billingPeriodStart"));
    let period_end =
        string_field(&period, "end").or_else(|| string_field(config, "billingPeriodEnd"));
    CliUsage {
        ok: true,
        error: None,
        credit_usage_percent: json_f64(config.get("creditUsagePercent").unwrap_or(&Value::Null)),
        period_type: string_field(&period, "type")
            .map(|raw| period_kind(&raw))
            .or_else(|| string_field(config, "periodType").map(|raw| period_kind(&raw))),
        period_start,
        period_end,
        on_demand_cap: money_val(config.get("onDemandCap")),
        on_demand_used: money_val(config.get("onDemandUsed")),
        prepaid_balance: money_val(config.get("prepaidBalance")),
        unified_billing: config
            .get("isUnifiedBillingUser")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        subscription_tier: string_field(result, "subscription_tier")
            .or_else(|| string_field(result, "subscriptionTier"))
            .or_else(|| string_field(config, "subscription_tier")),
    }
}

fn period_kind(raw: &str) -> String {
    let upper = raw.trim().to_ascii_uppercase();
    if upper.contains("MONTH") {
        "monthly".into()
    } else if upper.contains("WEEK") {
        "weekly".into()
    } else {
        raw.trim().to_ascii_lowercase()
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn json_f64(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_i64().map(|n| n as f64))
        .or_else(|| value.as_u64().map(|n| n as f64))
}

fn money_val(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    json_f64(value).or_else(|| value.get("val").and_then(json_f64))
}

fn rpc(
    stdin: &Arc<Mutex<impl Write>>,
    rx: &mpsc::Receiver<Value>,
    id: u64,
    method: &str,
    params: Value,
    deadline: Instant,
) -> Result<Value, String> {
    let payload = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    {
        let mut writer = stdin
            .lock()
            .map_err(|_| "Grok CLI stdin lock failed".to_string())?;
        writer
            .write_all(format!("{payload}\n").as_bytes())
            .map_err(|error| format!("Couldn't write {method}: {error}"))?;
        writer
            .flush()
            .map_err(|error| format!("Couldn't flush {method}: {error}"))?;
    }
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(format!("Timed out waiting for {method}"));
        }
        let message = rx
            .recv_timeout(remaining)
            .map_err(|_| format!("Timed out waiting for {method}"))?;
        if message.get("method").is_some() && message.get("id").is_some() {
            let reply = json!({
                "jsonrpc": "2.0",
                "id": message.get("id").cloned().unwrap_or(Value::Null),
                "result": {}
            });
            if let Ok(mut writer) = stdin.lock() {
                let _ = writer.write_all(format!("{reply}\n").as_bytes());
                let _ = writer.flush();
            }
            continue;
        }
        if rpc_id(&message) == Some(id) {
            return Ok(message);
        }
    }
}

fn rpc_id(message: &Value) -> Option<u64> {
    message.get("id").and_then(|id| {
        id.as_u64()
            .or_else(|| id.as_i64().map(|n| n as u64))
            .or_else(|| id.as_str().and_then(|s| s.parse().ok()))
    })
}

fn terminate(child: &mut std::process::Child, pgid: i32) {
    #[cfg(unix)]
    {
        if pgid > 0 {
            let _ = nix::sys::signal::killpg(
                nix::unistd::Pid::from_raw(pgid),
                nix::sys::signal::Signal::SIGTERM,
            );
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_weekly_unified_billing_snapshot() {
        let result = json!({
            "config": {
                "creditUsagePercent": 66.0,
                "currentPeriod": {
                    "type": "USAGE_PERIOD_TYPE_WEEKLY",
                    "start": "2026-08-25T09:58:55.164008+00:00",
                    "end": "2026-09-01T09:58:55.164008+00:00"
                },
                "onDemandCap": { "val": 0 },
                "onDemandUsed": { "val": 0 },
                "prepaidBalance": { "val": 12.5 },
                "isUnifiedBillingUser": true,
                "billingPeriodStart": "2026-08-25T09:58:55.164008+00:00",
                "billingPeriodEnd": "2026-09-01T09:58:55.164008+00:00"
            },
            "subscription_tier": "SuperGrok"
        });
        let usage = parse_billing_result(&result);
        assert!(usage.ok);
        assert_eq!(usage.credit_usage_percent, Some(66.0));
        assert_eq!(usage.period_type.as_deref(), Some("weekly"));
        assert_eq!(usage.subscription_tier.as_deref(), Some("SuperGrok"));
        assert_eq!(usage.prepaid_balance, Some(12.5));
        assert!(usage.unified_billing);
        assert_eq!(usage.on_demand_cap, Some(0.0));
    }

    #[test]
    fn period_kind_maps_monthly() {
        assert_eq!(period_kind("USAGE_PERIOD_TYPE_MONTHLY"), "monthly");
    }
}
