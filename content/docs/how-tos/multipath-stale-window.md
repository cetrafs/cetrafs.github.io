---
weight: 325
title: "Set the stale window for multipath"
description: "Make sure a host gives up on failed I/O before its peers give up on the host, by checking dm-multipath queueing against stale_secs."
toc: true
---

cetrafs declares a peer dead when its heartbeat has been silent for `stale_secs` (default **120 s**), and then reclaims that peer's Zone Groups and locks. dm-multipath can hold a host's I/O, heartbeat included, for longer than that. Check the two values against each other on every multipath deployment.

## The rule

> **A host must give up on failed I/O before its peers give up on the host.**

When every path to a host fails, dm-multipath **queues** I/O for `no_path_retry × polling_interval` seconds before it returns an error. For that whole time the host can't write its heartbeat, so to its peers it looks dead. If the queueing time is longer than the stale window, the peers reclaim the host's storage while its writes are still queued. When the paths come back, those writes land on blocks that another node now owns.

## 1. Find your queueing time

```sh
multipath -t | grep -A 25 '<your array vendor string>'
```

Look for `no_path_retry` and `polling_interval`, and for `fast_io_fail_tmo` as well.

| Array entry | `no_path_retry` | `polling_interval` | Queue time |
|---|---|---|---|
| Stock HPE 3PAR (`3PARdata`) | 18 | 5 s | **90 s** |

If `no_path_retry` is `queue`, I/O is queued **forever**. A cetrafs cluster can't be made safe like that. Set a finite value.

## 2. Pick a stale window

Make `stale_secs` comfortably larger than the queue time. The 120 s default clears a 90 s queue with 30 s to spare. Remember the trade-off: a longer window also means a node that really is dead keeps its storage locked for longer before the others take over.

## 3. Set it on every node

Set the boot-time default for every mount:

```sh
echo "options cetrafs stale_secs=150" | sudo tee /etc/modprobe.d/cetrafs.conf
```

It takes effect the next time the module loads. To change it on a live mount without reloading, use the `controls` file:

```sh
echo stale_secs=150 | sudo tee /proc/fs/cetrafs/<dev>/controls
```

The `controls` file enforces bounds: 15–240 s, and at least 3 × `hb_interval_secs`. The module parameter isn't bounds-checked (the test suites use that to compress timing), so check the value yourself.

{{< callout type="tip" >}}
You can shorten the other side instead, by lowering `no_path_retry` so multipath fails I/O sooner. Either way, the inequality is what matters.
{{< /callout >}}

## Related

- [Fencing and split-brain](/docs/concepts/fencing/): why a timeout alone can't tell slow from dead.
- [Tune a live mount](/docs/how-tos/tune-mount/).
