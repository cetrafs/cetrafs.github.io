---
weight: 390
title: "Run the test suites"
description: "Run the loop-device suite, the crash rig, the soak and the release matrix, and the multi-node ctest suite on a real shared LUN."
toc: true
---

For what each tier exists to catch, and what isn't tested yet, see [How cetrafs is tested](/docs/concepts/testing/).

## Which suite tests what

| Command | Needs | Covers |
|---|---|---|
| `make check-fsck` | Nothing (no module, no mount) | Image-level `fsck` checks, with every check fed a real injected fault. Runs in seconds. |
| `make check` | root, matching kernel headers, loop devices, about 7 GiB free (`CT_MIN_FREE_MB`) | The full loop-backed integration suite: every feature end to end, plus simulated cross-node scenarios. Never touches a real device. |
| `make check-one SUITE=kernel/<name>.sh` | Same as `check` | One suite, e.g. `kernel/nslock.sh`. |
| `make check-slow` | Same, plus time | Multi-GiB sparse-file tests (default 10 GiB; override with `CETRAFS_SPARSE_TEST_SIZE_MB`). |
| `make check-crash` | `dm-log-writes`, `dm-flakey` | The crash-consistency rig: replays to every durability boundary, a power-loss sweep, and power cuts without a flush first. |
| `make soak ROUNDS=N` | Module loaded | Mixed-workload soak with a full `fsck` after each round. Fails on any anomalous round and keeps the image. Default 20 rounds; a release soak is 200 or more. |
| `make release-matrix` | All of the above | Build, `check`, crash rig, sparse, fuzzers and soak, in sequence, each with its own log and a recorded summary. `ARGS="-r 3"` repeats it; `-R` resumes with the previously failed stages first. |
| `make check-caw DEV=/dev/sdX` | A real CAW-capable device. **Destroys its contents.** | The compare-and-write paths a loop device can't reach. |
| `ctest` (multi-node) | Two or more hosts sharing one formatted LUN | Real cross-node behaviour. See below. |

{{< callout type="note" title="Loop devices can't prove everything" >}}
A loop device has no atomic COMPARE AND WRITE, and it serves "uncached" reads from the host's page cache. So `make check` proves correctness on one node, but it can't exercise real cross-node atomicity or measure performance. The multi-node suite and real hardware cover those.
{{< /callout >}}

The destructive suites (`tests/device/`, `tests/crash/`, `ctest/`) always take the device as an explicit argument. They never pick one by default.

## The multi-node suite (`ctest`)

`ctest` drives several real hosts against one shared LUN. A "node" is a separate kernel with its own machine UUID, so it can't be simulated with processes on one host.

Build it (it is a standalone Go program):

```sh
make ctest          # or: cd ctest && go build -o ctest .
```

The LUN must already be formatted with `mkfs.cetra`. On **each** host, start a worker. The worker owns the device and the mount point:

```sh
./ctest -mode=slave -addr=:9100 -device=/dev/sdX -mountpoint=/mnt/ctest
```

From any machine, run a scenario, or the full suite:

```sh
./ctest -mode=master -slaves=nodeA=10.0.0.1:9100,nodeB=10.0.0.2:9100 -scenario=full-suite
```

Scenarios include `caw` (the real primitive, asserted to have been contended), `lock-race`, `replay-race`, `fence-reclaim`, `record-write-race`, `dirent-torn`, `extent-leaf-staleness`, `inode-reuse`, `pending-free` and `dir-storm`. `-repeat N` turns any scenario into a soak and stops at the first failure.

`full-suite` is the quick per-change gate, so it leaves out two slower scenarios: `hypervisor-storm`, the one workload shaped like a real deployment, and `ns-fuzz`, which catches a format change that moves on-disk offsets. Before a release, run `-scenario=release-suite`, which is `full-suite` plus those two.

The coordinator checks that every node runs the **same** `cetrafs.ko` build and refuses to run otherwise, and it unmounts every node when it exits.
