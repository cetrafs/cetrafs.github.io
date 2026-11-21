---
weight: 530
title: "Module parameters"
description: "cetrafs kernel module parameters: defaults, bounds, which ones are meant for production, and the test-only parameters a packaged build refuses."
toc: true
---

Set at load time, for example in `/etc/modprobe.d/cetrafs.conf`:

```text
options cetrafs stale_secs=150
```

Parameters marked writable can also be changed at runtime under `/sys/module/cetrafs/parameters/`. A change there affects **new** mounts; for a mount that already exists, use its [`controls`](/docs/reference/procfs/#controls) file.

## Operator parameters

| Parameter | Default | Meaning |
|---|---|---|
| `stale_secs` | 120 | Seconds a peer may be silent before it is treated as dead. The default for every mount. At most 240, and at least 3 × `hb_interval_secs`. Keep production values within 15–240 s, the range `controls` accepts. |
| `hb_interval_secs` | 15 | Seconds between heartbeats. The default for every mount. Clamped to 1–30; keep production values within 5–30 s. |
| `auto_defrag` | 1 | Background defragmentation, the default for every mount (`controls` overrides it per mount) |
| `auto_defrag_min_pct` | 200 | Fragmentation threshold: a file's extent count as a percentage of the minimum for its size |
| `auto_defrag_min_extents` | 4 | Files with fewer extents than this are never defragmented in the background |
| `auto_defrag_quiet_secs` | 10 | Seconds the background defragmenter leaves alone a file it has just declined |
| `scrub` | on | Background reclaim of leaked data blocks (marked allocated, referenced by nothing) |
| `scrub_interval_secs` | 1800 | Seconds between scrub cycles, 1–86400 |
| `scrub_gap_secs` | 15 | Gap between the scrubber's two confirming passes, 15–3600. Must be longer than any allocation's commit window; it can't be set below 15. |
| `alloc_run_blocks` | 256 | Blocks reserved ahead of need for each allocation run (1 MiB). `0` disables it. |
| `alloc_run_max_blocks` | 4096 | The largest run a file that keeps writing sequentially grows to (16 MiB) |
| `dio_fill_holes` | 1 | An `O_DIRECT` write into a hole or preallocated space stays direct. `0` falls back to a buffered write plus a synchronous flush. See [Performance](/docs/concepts/performance/#direct-writes-into-holes). |
| `node_uuid` | (unset) | Load-time only. This machine's node identity, as a UUID, in place of the one derived from DMI. Set it on machines that share a DMI UUID: cloned VMs, or boards with placeholder firmware. A placeholder DMI UUID, or a model hash with no serial behind it, is refused as an identity, and the mount then asks for this parameter. See [the Node Registry](/docs/concepts/coordination/#the-node-registry). |
| `caw_probe` | (unset) | Load-time only, and only a diagnostic: each mount detects CAW by itself. A device to probe for compare-and-write capability; the result goes to `dmesg` and nothing is mounted. |

## Internal tuning

Leave these at their defaults unless a developer asks you to change them.

| Parameter | Default | Meaning |
|---|---|---|
| `bg_sweep_min_secs` | 30 | Minimum seconds between refreshes of other nodes' Block Group descriptors when `info` is read |
| `pf_drain_min_ms` | 500 | Minimum milliseconds between on-demand pending-free drains |
| `pf_full_backoff_ms` | 1000 | Milliseconds to skip scanning a pending-free queue already found full. `0` always scans. |
| `own_claim_resweep_secs` | 600 | Seconds after an unclean re-attach before this node sweeps its own claims again, clearing any on files nothing here uses. `0` turns it off. |

## Test-only parameters

The module also has several hundred test-only parameters: fault injection, switches that remove one protection so a suite can prove the protection matters, and timing knobs that compress a suite's waits. Some of them disable safety checks described in this documentation.

**A packaged build refuses all of them.** The DKMS and Debian packages build the module with `CETRAFS_RELEASE=1`, which makes these parameters read-only and refuses any attempt to set one at load time. `properties` shows `test_params: locked` for such a build, and `settable` for a developer build. On a developer build, setting one is logged and taints the kernel.
