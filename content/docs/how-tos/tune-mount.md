---
weight: 355
title: "Tune a live mount"
description: "Change heartbeat timing and defragmentation on a mounted volume through the controls file, and set boot-time defaults with module parameters."
toc: true
---

## Change a setting on a live mount

Write one `key=value` per write to the mount's `controls` file:

```sh
C=/proc/fs/cetrafs/<dev>/controls
echo defrag=off          | sudo tee $C    # no defragmentation at all on this mount
echo auto_defrag=off     | sudo tee $C    # only stop the background defragmenter
echo hb_interval_secs=10 | sudo tee $C
echo stale_secs=150      | sudo tee $C
cat $C                                     # read back the current values
```

A write that can't be parsed, or that is out of range, changes nothing, and a warning goes to `dmesg`. A successful change is logged at info level.

Settings made here last **only for this mount**. A remount resets them to the module defaults.

## Timing bounds

| Key | Range | Default |
|---|---|---|
| `hb_interval_secs` | 5–30 s | 15 s |
| `stale_secs` | 15–240 s, **and** at least 3 × `hb_interval_secs` | 120 s |

Because of the ratio, order matters:

- To **widen** the window, raise `stale_secs` first, then `hb_interval_secs`.
- To **narrow** it, lower `hb_interval_secs` first, then `stale_secs`.

Timing is per node by design. Each node advertises its own heartbeat rate in its registry row, and its peers judge it by that rate, so the values don't have to match across the cluster. The file-lock mode is different: it applies to the whole cluster and is set at mount.

## Set boot-time defaults

Module parameters set the starting value for every new mount:

```sh
# /etc/modprobe.d/cetrafs.conf
options cetrafs stale_secs=150 auto_defrag=1
```

Only these are meant for production: `stale_secs`, `hb_interval_secs`, `auto_defrag`, `auto_defrag_min_pct`, `auto_defrag_min_extents`, `scrub`, `scrub_interval_secs`. The others are test knobs. Module parameters **aren't bounds-checked**, because the test suites use them to compress timing. When experimenting on a production cluster, use `controls`, which is.

See the [module parameters reference](/docs/reference/module-parameters/) for the full list.
