---
weight: 390
title: "Run the test suites"
description: "Run the loop-device gate, the randomized suites, the configuration matrix, the crash rig, the soak and the release matrix, and the multi-node ctest suite on a real shared LUN."
toc: true
---

For what each tier exists to catch, and what a release goes through, see [How cetrafs is tested](/docs/concepts/testing/).

## Which suite tests what

| Command | Needs | Covers |
|---|---|---|
| `make check-fsck` | Nothing (no module, no mount) | The 73 image suites: `fsck` fed one injected fault at a time |
| `make check` | root, matching kernel headers, loop devices, about 7 GiB free (`CT_MIN_FREE_MB`) | The full gate: 837 suites, about 6,600 assertions. Never touches a real device. |
| `make check-one SUITE=kernel/<name>.sh` | Same as `check` | One suite, e.g. `kernel/nslock.sh`. `make -C tests list` prints them all. |
| `make -C tests matrix` | Same as `check`, plus room for 2.3 GiB images | A slice of the kernel suites under `nofilelock`, 1 GiB Block Groups, four Zone Groups and an 8 MiB journal. `CONFIGS="nofilelock bg1g"` picks some. |
| `make check-slow` | Same, plus time | Multi-GiB sparse-file tests (`CETRAFS_SPARSE_TEST_SIZE_MB`, default 10 GiB) |
| `make check-crash` | `dm-log-writes`, `dm-flakey` | The crash rig: every write replayed up to arbitrary cuts, including mid-flush and with a volatile cache |
| `make soak ROUNDS=N` | Module loaded | `fsx`, `fsstress` and the content oracle in their long modes, `fsck` after every round. Unattended: `SOAK_MAX_SECS` bounds it, and the exit status says whether it found anything. |
| `make release-matrix` | All of the above | Build, `check`, crash rig, sparse, fuzzers and soak, in sequence, each with its own log and a summary. `ARGS="-r 3"` repeats it; `-R` resumes with the failed stages first. |
| `make check-caw DEV=/dev/sdX` | A real CAW-capable device. **Destroys its contents.** | The compare-and-write paths a loop device can't reach |
| `make mod KASAN=1`, then `make check` | A kernel built with KASAN | The gate under the kernel's memory-error detector |
| `make mod LLVM=1` | clang | Every source compiled by clang, for its warnings |
| `make endian-check` | `sparse` | Every on-disk field access checked for byte order |
| `ctest` (multi-node) | Two or more hosts sharing one formatted LUN | Real cross-node behaviour. See below. |

`make check-fsck` runs in seconds. The full gate, `make check`, takes **about 8 hours on one machine**, and anything that includes it, such as a KASAN run or the release matrix, takes at least that long.

{{< callout type="note" title="Loop devices can't prove everything" >}}
A loop device has no atomic COMPARE AND WRITE, and it serves "uncached" reads from the host's page cache. So `make check` proves correctness on one node, but it can't exercise real cross-node atomicity or measure performance. The multi-node suite and real hardware cover those.
{{< /callout >}}

The destructive suites (`tests/device/`, `tests/crash/`, `ctest/`) always take the device as an explicit argument. They never pick one by default.

### Randomized suites, longer

`make check` runs the randomized suites at a modest size. To run them longer, or replay a failure:

```sh
FSX_LONG=1 ./tests/run.sh kernel/fsx_model.sh                   # 8 seeds x 40,000 operations
FSSTRESS_LONG=1 ./tests/run.sh kernel/fsstress_namespace.sh     # 8 processes x 5,000 operations
FSX_SEED=17 FSX_OPS=40000 ./tests/run.sh kernel/fsx_model.sh    # replay one seed
CHURN_SEED=42 CHURN_ROUNDS=20 ./tests/run.sh kernel/churn_oracle.sh
```

A failure prints the seed and the operations that replay it, and keeps the volume image.

### After an interrupted run

A `make check` that is killed doesn't clean up: it leaves its 2–3 GiB image behind, and possibly a mount, a loop device and the loaded module. Each leftover image brings the next run closer to the 7 GiB floor, until every run aborts at once with `FATAL: only NNN MiB free`. Clean up before starting again:

```sh
pgrep -af 'run.sh|make check'                 # make sure nothing is still running
umount <any cetrafs mount>; rmmod cetrafs
losetup -D                                    # free stray loop devices
rm -f /root/cetrafs-*.img /tmp/cetrafs-*.img  # wherever the images went
df -Pm /                                      # must clear CT_MIN_FREE_MB
```

## The multi-node suite (`ctest`)

`ctest` drives several real hosts against one shared LUN. A node is a separate kernel with its own machine UUID, so it can't be simulated with processes on one host.

Build it (it is a standalone Go program):

```sh
make ctest          # or: cd ctest && go build -o ctest .
```

A worker runs as root and formats, mounts and writes the shared device on request, so every request is authenticated with a shared key. Create it once and copy it to every host, readable by root only:

```sh
sudo install -m 600 /dev/null /etc/cetrafs/ctest.key
head -c 32 /dev/urandom | sudo tee /etc/cetrafs/ctest.key >/dev/null
```

The LUN must already be formatted with `mkfs.cetra`. On **each** host, start a worker on the address the coordinator reaches it on; a worker refuses to listen on every interface:

```sh
./ctest -mode=slave -addr=10.0.0.1:9100 -device=/dev/sdX -mountpoint=/mnt/ctest
```

From any machine with the key, run a scenario, or a suite:

```sh
./ctest -mode=master -slaves=nodeA=10.0.0.1:9100,nodeB=10.0.0.2:9100 -scenario=full-suite
```

There are 68 scenarios: the real compare-and-write under contention, lock races, journal replay against a fenced peer, torn records, extent-leaf staleness, inode reuse, pending frees, namespace storms, device pulls, live grows, discard and zeroing, and a randomized namespace fuzzer. `-repeat N` turns any scenario into a soak and stops at the first failure.

`full-suite` is the per-change gate. Before a release, run `-scenario=release-suite`, which adds the slower scenarios: `hypervisor-storm`, the one workload shaped like a real deployment, and `ns-fuzz`. A few scenarios need a dead node and two survivors, so three hosts.

The coordinator checks that every node runs a module built from the **same** source and refuses to run otherwise, and it unmounts every node when it exits. Run it on an isolated test network.
