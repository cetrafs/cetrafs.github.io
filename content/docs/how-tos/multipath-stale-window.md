---
weight: 325
title: "Set the stale window for multipath"
description: "Make sure a host's writes can never be held longer than it is allowed to stall, by checking SCSI, iSCSI, FC and dm-multipath timers against stale_secs."
toc: true
---

cetrafs declares a peer dead when its heartbeat has been silent for `stale_secs` (default **120 s**), and then takes over that peer's Zone Groups and locks. To make that safe, a node that can't renew its own heartbeat **stops itself** one heartbeat earlier: at `stale_secs − hb_interval_secs`, 105 s with the defaults.

A node can stop issuing writes, but it can't recall one it has already issued. So a write must never be held on its way to the array for longer than that.

## The rule

> **The longest a write can be held must be shorter than `stale_secs − hb_interval_secs`.**

A write can be held in three places, one after the other:

```text
SCSI command timeout
  + transport wait          (iSCSI: noop_out_interval + noop_out_timeout + replacement_timeout;
                             FC: fast_io_fail_tmo, or dev_loss_tmo when that is off)
  + multipath queueing      (no_path_retry × polling_interval; 0 without multipath)
  < stale_secs − hb_interval_secs
```

If the sum is longer, a node whose paths all fail can have writes released after its peers have taken over its storage. They would land on blocks another node now owns.

The same window bounds how long a node rides out its own stall. When every node of the cluster loses the LUN at once, each of them stops at that point. An outage you want the cluster to survive must be shorter than `stale_secs − hb_interval_secs`.

Nothing checks this at mount time. Setting the timers is the operator's job.

## 1. Find your timers

```sh
cat /sys/block/sdX/device/timeout                          # SCSI command timeout, per path
iscsiadm -m node -o show | grep -E 'noop_out|replacement'  # iSCSI
cat /sys/class/fc_remote_ports/*/fast_io_fail_tmo          # FC
multipath -t | grep -A 25 '<your array vendor string>'     # no_path_retry, polling_interval
```

Some defaults that matter:

| Setting | Default | Note |
|---|---|---|
| iSCSI `replacement_timeout` | 120 s | Alone, the whole default stale window. Lower it. |
| iSCSI `replacement_timeout` = `-1` | | Waits forever. Can't be made safe. |
| Stock HPE 3PAR multipath entry | `no_path_retry 18`, `polling_interval 5` | 90 s of queueing |
| `no_path_retry queue` | | Queues forever. Can't be made safe. |

## 2. Make the sum fit

Two ways, and you can combine them:

- **Shorten the timers.** For example, iSCSI `replacement_timeout` to 15 s, and `no_path_retry` to a count that queues for 30–60 s.
- **Lengthen the stale window**, up to 240 s. A longer window also means a node that really is dead keeps its files locked for longer before the others take over, unless your HA agent [declares it dead](/docs/how-tos/recover-node-failure/#declare-a-fenced-host-dead).

Don't go to the other extreme. `no_path_retry fail`, with no queueing at all, turns every moment without a path, such as a switch reboot or a controller failover, into an I/O error on a metadata write, which stops the mount until it is remounted. Use a bounded count that fits the rule.

## 3. Set the stale window on every node

Set the boot-time default for every mount:

```sh
echo "options cetrafs stale_secs=150" | sudo tee /etc/modprobe.d/cetrafs.conf
```

It takes effect on the next mount after the module loads. To change it on a live mount, use the `controls` file:

```sh
echo stale_secs=150 | sudo tee /proc/fs/cetrafs/<dev>/controls
```

The `controls` file enforces 15–240 s, and at least 3 × `hb_interval_secs`. Its value lasts until that mount is unmounted. Each node advertises its own window in its registry row, and its peers judge it by that, so a change on one node is safe even before the others have it.

## On multipath, compare-and-write follows the best path

cetrafs sends compare-and-write down an ALUA-optimised path where the array reports one, follows a failover to another path, and ranks a path the SCSI layer has blocked below every other. You don't need to configure anything for this.

## Related

- [Fencing and split-brain](/docs/concepts/fencing/): why a timeout alone can't tell slow from dead.
- [Tune a live mount](/docs/how-tos/tune-mount/).
