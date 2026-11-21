---
weight: 355
title: "Tune a live mount"
description: "Change heartbeat timing, defragmentation and discard on a mounted volume through the controls file, and set boot-time defaults with module parameters."
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
echo discard=off         | sudo tee $C    # no automatic UNMAP, and no fstrim
echo inline_discard=on   | sudo tee $C    # UNMAP freed space as it is freed
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

Timing is per node by design. Each node advertises its own heartbeat rate and stale window in its registry row, and its peers judge it by those, so the values don't have to match across the cluster. The file-lock mode is different: it applies to the whole cluster and is set at mount.

Whatever you choose, keep the [multipath rule](/docs/how-tos/multipath-stale-window/): the longest a write can be held must be shorter than `stale_secs − hb_interval_secs`.

## Set boot-time defaults

Module parameters set the starting value for every new mount:

```sh
# /etc/modprobe.d/cetrafs.conf
options cetrafs stale_secs=150 auto_defrag=1
```

The [operator parameters](/docs/reference/module-parameters/#operator-parameters) are meant for production. The timing parameters are clamped to a wider range than `controls` allows, so keep them within the limits above. When experimenting on a production cluster, use `controls`, which enforces them. A value set there lasts until that mount is unmounted.

A packaged build refuses every test-only parameter, so a typo in `modprobe.d` can't turn one on.

See the [module parameters reference](/docs/reference/module-parameters/) for the full list.
