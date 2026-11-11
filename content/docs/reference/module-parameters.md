---
weight: 530
title: "Module parameters"
description: "cetrafs kernel module parameters: defaults, meaning, and which ones are safe in production."
toc: true
---

Set at load time, for example in `/etc/modprobe.d/cetrafs.conf`:

```text
options cetrafs stale_secs=150
```

Parameters marked writable can also be changed at runtime under `/sys/module/cetrafs/parameters/`. A change there affects **new** mounts; for a mount that already exists, use its [`controls`](/docs/reference/procfs/#controls-writable) file.

{{< callout type="warning" >}}
Most module parameters are **not bounds-checked**, because the test suites use them to compress timing. Since 0.9.5 `stale_secs` and `hb_interval_secs` are clamped, but to a wider range than is safe in production. Keep them within the limits of the `controls` file, which *is* bounds-checked; use it to experiment on a live cluster.
{{< /callout >}}

## Operator parameters

| Parameter | Default | Meaning |
|---|---|---|
| `stale_secs` | 120 | Seconds a peer may be silent before it is treated as dead. The default for every mount. Since 0.9.5 a mount clamps it to 3–86400 s and to at least 3 × `hb_interval_secs`; keep production values within 15–240 s. |
| `hb_interval_secs` | 15 | Seconds between heartbeats. The default for every mount. Since 0.9.5 a mount clamps it to 1–3600 s; keep production values within 5–30 s. |
| `auto_defrag` | 1 | Background defragmentation, the default for every mount (`controls` overrides it per mount) |
| `auto_defrag_min_pct` | 200 | Fragmentation threshold: a file's extent count as a percentage of the minimum for its size |
| `auto_defrag_min_extents` | 4 | Files with fewer extents than this are never auto-defragmented |
| `auto_defrag_quiet_secs` | 10 | Seconds the background defragmenter leaves alone a file it has just declined, however many extents it gains meanwhile. Since 0.9.4. |
| `scrub` | on | Background reclaim of leaked data blocks (marked allocated, referenced by nothing) |
| `scrub_interval_secs` | 1800 | Seconds between scrub cycles |
| `scrub_gap_secs` | 15 | Gap between the scrubber's two confirming passes. Must be longer than any allocation's commit window. |
| `alloc_run_blocks` | 256 | Blocks reserved ahead of need for each allocation run (1 MiB). `0` disables it. |
| `alloc_run_max_blocks` | 4096 | The largest run a file that keeps writing sequentially grows to (16 MiB). Since 0.9.3. |
| `dio_fill_holes` | 1 | An `O_DIRECT` write into a hole or preallocated space stays direct. `0` brings back the pre-0.9.4 path, a buffered write plus a synchronous flush. See [Performance](/docs/concepts/performance/#direct-writes-into-holes). Since 0.9.4. |
| `node_uuid` | (unset) | Load-time only. This machine's node identity, as a UUID, in place of the one derived from DMI. Set it on machines that share a DMI UUID: cloned VMs, or boards with placeholder firmware. See [the Node Registry](/docs/concepts/coordination/#the-node-registry). Since 0.9.3. |
| `caw_probe` | (unset) | Load-time only, and only a diagnostic: normal use doesn't need it, because each mount detects CAW itself. A device to probe for compare-and-write capability; the result goes to `dmesg` and nothing is mounted. |

## Internal tuning

Leave these at their defaults unless a developer asks you to change them.

| Parameter | Default | Meaning |
|---|---|---|
| `bg_sweep_min_secs` | 30 | Minimum seconds between refreshes of other nodes' Block Group descriptors when `info` or `statfs` is read |
| `pf_drain_min_ms` | 500 | Minimum milliseconds between on-demand pending-free drains |
| `pf_full_backoff_ms` | 1000 | Milliseconds to skip scanning a pending-free queue already found full. `0` always scans. |
| `own_claim_resweep_secs` | 600 | Seconds after an unclean re-attach before this node sweeps its own claims again, clearing any on files nothing here uses. `0` turns it off. Since 0.9.5. |

## Test-only parameters

The module also has fault-injection and test parameters, including `cas_selftest`, `cas_stress`, `journal_skip_consume`, `journal_ignore_guard`, `journal_ignore_torn`, `idx_range_ignore`, `pf_force_foreign`, `pf_force_queue_full`, `mount_fail_at`, `fence_skip_precheck`, and parameters whose names start with `force_` or `nocaw_`. **Never set these on a production system.** Some of them disable the safety checks described in this documentation. Since 0.9.4, setting one is logged and taints the kernel.
