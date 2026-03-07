#!/usr/bin/env python3
"""Sample OTel data for LLM diagnosis (reduces large files to ~300KB target)."""
import json
import sys
from pathlib import Path


MAX_SPANS = 80         # keep up to 80 spans (all errors + sampled non-errors)
MAX_LOG_LINES = 120   # keep up to 120 log records
MAX_PLATFORM_LINES = 150


def flatten_spans(traces: list) -> list:
    """Flatten resourceSpans structure to list of (ts_ns, svc, name, is_error, span, resource_attrs)."""
    result = []
    for item in traces:
        for rs in item.get("resourceSpans", []):
            attrs = {a["key"]: a.get("value", {}) for a in rs.get("resource", {}).get("attributes", [])}
            svc = attrs.get("service.name", {}).get("stringValue", "unknown")
            for ss in rs.get("scopeSpans", []):
                for span in ss.get("spans", []):
                    ts = int(span.get("startTimeUnixNano", "0"))
                    status_code = span.get("status", {}).get("code", 0)
                    is_error = status_code in [2, "2", "STATUS_CODE_ERROR"]
                    result.append((ts, svc, span.get("name", ""), is_error, span, attrs))
    result.sort(key=lambda x: x[0])
    return result


def rebuild_traces(sampled: list) -> list:
    """Rebuild resourceSpans structure from sampled flat list."""
    from collections import defaultdict
    # Group by service
    by_svc = defaultdict(list)
    for ts, svc, name, is_error, span, attrs in sampled:
        by_svc[(svc, json.dumps(attrs, sort_keys=True))].append(span)

    result = []
    for (svc, attrs_json), spans in by_svc.items():
        attrs_dict = json.loads(attrs_json)
        resource_attrs = [{"key": k, "value": v} for k, v in attrs_dict.items()]
        result.append({
            "resourceSpans": [{
                "resource": {"attributes": resource_attrs},
                "scopeSpans": [{"scope": {"name": svc}, "spans": spans}]
            }]
        })
    return result


def sample_traces(traces: list, max_spans: int = MAX_SPANS) -> list:
    flat = flatten_spans(traces)
    errors = [s for s in flat if s[3]]
    non_errors = [s for s in flat if not s[3]]

    # Take all errors (up to max_spans*2//3), fill rest with evenly sampled non-errors
    max_errors = min(len(errors), max_spans * 2 // 3)
    # Sample errors evenly if too many
    if len(errors) > max_errors:
        step = len(errors) // max_errors
        errors = errors[::step][:max_errors]

    remaining = max_spans - len(errors)
    if remaining > 0 and non_errors:
        step = max(1, len(non_errors) // remaining)
        non_errors_sampled = non_errors[::step][:remaining]
    else:
        non_errors_sampled = []

    sampled = sorted(errors + non_errors_sampled, key=lambda x: x[0])
    return rebuild_traces(sampled), len(flat), len(sampled)


def sample_logs(logs: list, max_lines: int = MAX_LOG_LINES) -> tuple:
    """Sample log records, prioritizing errors/warnings."""
    all_records = []
    for item in logs:
        for rl in item.get("resourceLogs", []):
            for sl in rl.get("scopeLogs", []):
                for record in sl.get("logRecords", []):
                    sev = record.get("severityNumber", 0)
                    ts = int(record.get("timeUnixNano", "0"))
                    all_records.append((ts, sev, record, rl.get("resource", {})))

    all_records.sort(key=lambda x: x[0])
    total = len(all_records)

    # Severity: ERROR=17+, WARN=13+
    errors = [r for r in all_records if r[1] >= 17]
    warns = [r for r in all_records if 13 <= r[1] < 17]
    others = [r for r in all_records if r[1] < 13]

    max_errors = min(len(errors), max_lines // 2)
    max_warns = min(len(warns), max_lines // 4)
    max_others = max_lines - max_errors - max_warns

    def sample_list(lst, n):
        if len(lst) <= n:
            return lst
        step = len(lst) // n
        return lst[::step][:n]

    sampled = sorted(
        sample_list(errors, max_errors) +
        sample_list(warns, max_warns) +
        sample_list(others, max_others),
        key=lambda x: x[0]
    )

    # Rebuild log format
    result = []
    for ts, sev, record, resource in sampled:
        result.append({"resourceLogs": [{"resource": resource, "scopeLogs": [{"logRecords": [record]}]}]})

    return result, total, len(sampled)


def sample_platform_logs(platform_logs: list, max_lines: int = MAX_PLATFORM_LINES) -> tuple:
    """Sample platform log lines, prioritizing errors."""
    total = len(platform_logs)
    if total <= max_lines:
        return platform_logs, total, total

    errors = [l for l in platform_logs if l.get("level") in ["error", "ERROR"] or l.get("severity") in ["error", "ERROR"]]
    others = [l for l in platform_logs if l not in errors]

    max_errors = min(len(errors), max_lines // 2)
    max_others = max_lines - max_errors

    def sample_list(lst, n):
        if len(lst) <= n:
            return lst
        step = len(lst) // n
        return lst[::step][:n]

    sampled = sample_list(errors, max_errors) + sample_list(others, max_others)
    return sampled, total, len(sampled)


def sample_metrics(metrics: list, max_datapoints_per_metric: int = 30) -> tuple:
    """Aggregate metrics by name, keep evenly sampled data points per metric."""
    from collections import defaultdict

    # Flatten: {metric_name -> [(ts, dp, resource_attrs)]}
    by_name = defaultdict(list)
    total_dps = 0
    resource_for_name = {}

    for item in metrics:
        for rm in item.get("resourceMetrics", []):
            resource = rm.get("resource", {})
            for sm in rm.get("scopeMetrics", []):
                scope = sm.get("scope", {})
                for met in sm.get("metrics", []):
                    name = met.get("name", "unknown")
                    resource_for_name[name] = (resource, scope)
                    for gauge_type in ["gauge", "sum", "histogram"]:
                        dps = met.get(gauge_type, {}).get("dataPoints", [])
                        for dp in dps:
                            ts = int(dp.get("timeUnixNano", dp.get("startTimeUnixNano", "0")))
                            by_name[name].append((ts, gauge_type, met.get(gauge_type, {}), dp))
                            total_dps += 1

    # Sample each metric
    result = []
    kept_dps = 0
    for name, dps in by_name.items():
        dps.sort(key=lambda x: x[0])
        if len(dps) > max_datapoints_per_metric:
            step = max(1, len(dps) // max_datapoints_per_metric)
            dps = dps[::step][:max_datapoints_per_metric]
        kept_dps += len(dps)

        resource, scope = resource_for_name[name]
        # Group by gauge_type
        by_gauge = defaultdict(list)
        for ts, gauge_type, gauge_meta, dp in dps:
            by_gauge[gauge_type].append(dp)

        metrics_list = []
        for gauge_type, dp_list in by_gauge.items():
            gauge_meta_copy = dict(gauge_meta)
            gauge_meta_copy["dataPoints"] = dp_list
            metrics_list.append({"name": name, gauge_type: gauge_meta_copy})

        result.append({"resourceMetrics": [{"resource": resource, "scopeMetrics": [{"scope": scope, "metrics": metrics_list}]}]})

    return result, total_dps, kept_dps


def ns_to_iso(ns: int) -> str:
    """Convert nanoseconds timestamp to ISO string."""
    from datetime import datetime, timezone
    try:
        return datetime.fromtimestamp(ns / 1e9, tz=timezone.utc).strftime("%H:%M:%S.%f")[:-3]
    except Exception:
        return str(ns)


def build_compact_summary(run_dir: Path) -> str:
    """Build a compact human-readable summary of OTel data for LLM consumption."""
    lines = []

    # Platform logs (most useful, compact already)
    plogs_path = run_dir / "platform_logs.json"
    if plogs_path.exists():
        plogs = json.loads(plogs_path.read_text())
        lines.append("## PLATFORM_LOGS")
        for entry in plogs[:MAX_PLATFORM_LINES]:
            raw_ts = entry.get("timestamp", entry.get("ts", "")) or ""
            # Extract HH:MM:SS from ISO string like "2026-03-07T03:35:23.859Z"
            ts = raw_ts[11:19] if len(raw_ts) > 18 else raw_ts[:8]
            level = entry.get("level", entry.get("severity", "INFO")).upper()
            svc = entry.get("service", entry.get("source", "?"))
            msg = entry.get("message", entry.get("msg", str(entry)))
            if isinstance(msg, dict):
                msg = json.dumps(msg)
            extra = {k: v for k, v in entry.items() if k not in ("timestamp", "ts", "level", "severity", "service", "source", "message", "msg")}
            extra_str = " ".join(f"{k}={v}" for k, v in list(extra.items())[:5]) if extra else ""
            lines.append(f"[{level}] {ts} {svc}: {str(msg)[:150]}" + (f" | {extra_str}" if extra_str else ""))
        lines.append("")

    # Traces
    traces_path = run_dir / "otel_traces.json"
    if traces_path.exists():
        traces = json.loads(traces_path.read_text())
        flat = flatten_spans(traces)
        lines.append(f"## TRACES ({len(flat)} total, showing sampled below)")
        errors = [s for s in flat if s[3]]
        non_err = [s for s in flat if not s[3]]
        max_e = min(len(errors), MAX_SPANS * 2 // 3)
        max_ne = MAX_SPANS - max_e
        step_e = max(1, len(errors) // max_e) if max_e > 0 else 1
        step_ne = max(1, len(non_err) // max_ne) if max_ne > 0 else 1
        sampled = sorted(errors[::step_e][:max_e] + non_err[::step_ne][:max_ne], key=lambda x: x[0])
        for ts, svc, name, is_err, span, _ in sampled:
            ts_str = ns_to_iso(ts)
            end_ts = int(span.get("endTimeUnixNano", ts))
            dur_ms = (end_ts - ts) // 1_000_000
            status = "ERR" if is_err else "ok"
            attrs = {a["key"]: list(a.get("value", {}).values())[0] if a.get("value") else "" for a in span.get("attributes", [])}
            key_attrs = {k: v for k, v in attrs.items() if k in ("http.status_code", "error.type", "db.statement", "http.url", "rpc.method")}
            attr_str = " ".join(f"{k}={v}" for k, v in list(key_attrs.items())[:3])
            events = span.get("events", [])
            ev_str = f" events=[{','.join(e.get('name','?') for e in events[:2])}]" if events else ""
            lines.append(f"{ts_str} {svc} {name} {dur_ms}ms [{status}]{ev_str}" + (f" {attr_str}" if attr_str else ""))
        lines.append("")

    # Logs
    logs_path = run_dir / "otel_logs.json"
    if logs_path.exists():
        logs = json.loads(logs_path.read_text())
        sampled_logs, total, _ = sample_logs(logs, MAX_LOG_LINES)
        lines.append(f"## OTEL_LOGS ({total} total, showing sampled below)")
        for item in sampled_logs:
            for rl in item.get("resourceLogs", []):
                svc_attrs = {a["key"]: list(a.get("value", {}).values())[0] for a in rl.get("resource", {}).get("attributes", [])}
                svc = svc_attrs.get("service.name", "?")
                for sl in rl.get("scopeLogs", []):
                    for rec in sl.get("logRecords", []):
                        ts = ns_to_iso(int(rec.get("timeUnixNano", "0")))
                        sev = rec.get("severityText", str(rec.get("severityNumber", "")))
                        body = rec.get("body", {}).get("stringValue", rec.get("body", ""))
                        if isinstance(body, dict):
                            body = json.dumps(body)
                        lines.append(f"{ts} [{sev}] {svc}: {str(body)[:150]}")
        lines.append("")

    # Metrics (aggregated)
    metrics_path = run_dir / "otel_metrics.json"
    if metrics_path.exists():
        metrics = json.loads(metrics_path.read_text())
        from collections import defaultdict
        by_name = defaultdict(list)
        for item in metrics:
            for rm in item.get("resourceMetrics", []):
                for sm in rm.get("scopeMetrics", []):
                    for met in sm.get("metrics", []):
                        name = met.get("name", "?")
                        for gauge_type in ["gauge", "sum", "histogram"]:
                            dps = met.get(gauge_type, {}).get("dataPoints", [])
                            for dp in dps:
                                ts = int(dp.get("timeUnixNano", dp.get("startTimeUnixNano", "0")))
                                val = dp.get("asDouble", dp.get("asInt", "?"))
                                by_name[name].append((ts, val))
        lines.append("## METRICS (sampled time series)")
        for name, series in sorted(by_name.items()):
            series.sort(key=lambda x: x[0])
            step = max(1, len(series) // 20)
            sampled_series = series[::step][:20]
            vals = [f"{ns_to_iso(ts)}={v}" for ts, v in sampled_series]
            lines.append(f"  {name}: {', '.join(vals)}")
        lines.append("")

    return "\n".join(lines)


def main():
    if len(sys.argv) < 2:
        print("Usage: sample_for_diagnosis.py <run_dir> [output_dir]", file=sys.stderr)
        sys.exit(1)

    run_dir = Path(sys.argv[1])
    out_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else run_dir / "sampled"
    out_dir.mkdir(parents=True, exist_ok=True)

    stats = {}

    # Sample traces
    traces_path = run_dir / "otel_traces.json"
    if traces_path.exists():
        traces = json.loads(traces_path.read_text())
        sampled_traces, total, kept = sample_traces(traces)
        (out_dir / "otel_traces.json").write_text(json.dumps(sampled_traces, indent=2))
        stats["traces"] = {"total_spans": total, "kept_spans": kept, "ratio": f"{kept}/{total}"}

    # Sample logs
    logs_path = run_dir / "otel_logs.json"
    if logs_path.exists():
        logs = json.loads(logs_path.read_text())
        sampled_logs, total, kept = sample_logs(logs)
        (out_dir / "otel_logs.json").write_text(json.dumps(sampled_logs, indent=2))
        stats["logs"] = {"total_records": total, "kept_records": kept, "ratio": f"{kept}/{total}"}

    # Sample metrics
    metrics_path = run_dir / "otel_metrics.json"
    if metrics_path.exists():
        metrics = json.loads(metrics_path.read_text())
        sampled_metrics, total, kept = sample_metrics(metrics)
        (out_dir / "otel_metrics.json").write_text(json.dumps(sampled_metrics, indent=2))
        stats["metrics"] = {"total": total, "kept": kept, "ratio": f"{kept}/{total}"}

    # Sample platform logs
    plogs_path = run_dir / "platform_logs.json"
    if plogs_path.exists():
        plogs = json.loads(plogs_path.read_text())
        sampled_plogs, total, kept = sample_platform_logs(plogs)
        (out_dir / "platform_logs.json").write_text(json.dumps(sampled_plogs, indent=2))
        stats["platform_logs"] = {"total": total, "kept": kept, "ratio": f"{kept}/{total}"}

    # Copy scenario.probe.json and ground_truth.json but update paths
    for fname in ("ground_truth.json", "events.json"):
        src = run_dir / fname
        if src.exists():
            (out_dir / fname).write_text(src.read_text())

    # Create sampled scenario.probe.json
    probe_path = run_dir / "scenario.probe.json"
    if probe_path.exists():
        probe = json.loads(probe_path.read_text())
        (out_dir / "scenario.probe.json").write_text(json.dumps(probe, indent=2))

    # Build compact text summary for LLM
    compact = build_compact_summary(out_dir)
    (out_dir / "compact_summary.txt").write_text(compact)
    compact_kb = len(compact) // 1024

    print(json.dumps({"sampling_stats": stats, "output_dir": str(out_dir), "compact_kb": compact_kb}, indent=2))


if __name__ == "__main__":
    main()
