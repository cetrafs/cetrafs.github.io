---
weight: 437
title: "How cetrafs is tested"
linkTitle: "How it is tested"
description: "The tiers of the cetrafs test effort, the class of fault each one exists to catch, the content oracle that finds wrong bytes fsck can't see, and what is not tested yet."
toc: true
---

A bug in a clustered filesystem doesn't crash a program. It returns the wrong bytes, months later, on somebody's VM disk. So the test effort for cetrafs is deliberately larger than the feature work, and it is layered: each tier catches a class of fault the tier above it structurally can't.

This page is a map of that effort and of its known gaps. To run the suites yourself, see [Run the test suites](/docs/how-tos/run-tests/). To validate your own installation layer by layer, see [Validate a storage stack before deployment](/docs/how-tos/validate-storage-stack/).

## The gate: `make check`

`make check` is the gate that every change must pass. It runs every suite under `tests/image/` and `tests/kernel/`, about **164 suites and 1,757 individual assertions**, against a loop-backed volume. It fails if any assertion fails, and also if any suite aborts without failing one. Nothing ships on a red gate.

The kernel suites need about 7 GiB free in the working directory. A full run checks that first and stops at once if the space isn't there, rather than failing on `ENOSPC` 20 minutes in. `CT_MIN_FREE_MB` (default 7168) changes the threshold.

### `tests/image/`: the tools, with no kernel involved

17 suites. No module is loaded and nothing is mounted: `mkfs.cetra` writes the on-disk structures, a helper corrupts exactly one of them, and `fsck.cetra` must report *that* fault and exit nonzero.

This is where the on-disk format is pinned down: superblock validation, geometry, the version window that lets a previous release's volume be grown rather than rebuilt, and the roughly 99 distinct faults `fsck.cetra` can name.

### `tests/kernel/`: the regression suite

147 suites, one concern each, against a loaded module and a real mount. Roughly by area:

| Area | What it covers |
|---|---|
| Mount and superblock | Validation, refusal of damaged or foreign volumes, remount |
| Inodes, directory entries, directories | The namespace, directory growth past inline extents, reuse across nodes |
| Files, extents, hole punching | The extent tree at depths 0, 1 and 2, truncate, hole punch, sparse files, `FIEMAP` and `SEEK_HOLE`/`SEEK_DATA` |
| Allocation | Block Group and Zone Group ownership, free-space accounting |
| Locking | The whole-file exclusive lock, `flock(2)`, the per-inode namespace lock |
| Journal | Journaling and replay, including a dead node's journal |
| Scrub and defrag | Background reclaim and the online defragmenter |
| Growing a volume | `growfs.cetra`, and the version window for volumes from the previous release |
| Extended attributes | `user.*`, `trusted.*`, `security.*` and LSM labelling |

## The content oracle

Every suite above proves one *named* behaviour. That leaves a gap: nobody writes a suite for a bug nobody has imagined. The content oracle, `tests/kernel/churn_oracle.sh`, is there to close it.

Several processes hammer one volume at once with a weighted random mix of creates, appends, overwrites, sparse writes, `O_DIRECT` writes, truncates, hole punches, `fallocate`, renames, hard links, extended attributes, `fsync`, deletes and defragmentation. Meanwhile a separate thread runs `sync` and drops the page cache underneath them. The volume is filled to `ENOSPC` and emptied again, to force the allocator to hand the same blocks out again.

What makes it more than a soak is that **every 4 KiB block identifies itself**. Its content is a pure function of the seed, the file, the file's generation and the block's index, and its first 32 bytes spell those out. So a mismatch doesn't just report "corruption", it reports which kind:

| What the block says | What it means |
|---|---|
| Another file's ID | Two files share a block |
| This file, an older generation | A lost update, or a stale extent |
| All zeros where data belongs | A dropped extent: data loss |
| The right tag, the wrong payload | A torn write |
| Data where a hole belongs | A punched or preallocated range serving stale blocks |
| No tag at all | A stray write |

After each round, these gates must pass:

- every file reads back byte-exact: from the cache, after dropping the cache, and after an unmount and remount;
- the background scrubber ran;
- no orphan inode survives two quiet scrubber cycles (orphans are meant to be temporary);
- `fsck` is clean, and its count of leaked blocks is zero;
- the kernel log has no reports from the allocator's own detectors.

It is a net, not a proof: a fault that shows up in one fill out of fifteen needs more than one run. Environment variables tune it:

| Variable | Effect |
|---|---|
| `CHURN_SEED`, `CHURN_ACTORS`, `CHURN_SECS`, `CHURN_ROUNDS`, `CHURN_FILES`, `CHURN_MAXBLK` | The workload: seed, writers, duration, rounds, files, file size |
| `CHURN_SCRUB=0`, `CHURN_DEFRAG=0`, `CHURN_PRESSURE=0` | Leave out the scrubber, the defragmenter, or the `sync`/cache-drop pressure, to narrow a failure down to what causes it |
| `CHURN_SCRUB=2` | Run the scrubber only in the final quiet window |
| `CHURN_SETTLE` | Stay idle before the final unmount, to test the scrubber's quiet window |
| `CHURN_SNAP`, `CHURN_FSCK_MID` | Keep evidence: snapshot the image at the remount, and run `fsck` on the snapshot |

A failure keeps its seed, the recent operations of every writer, and the volume image, so a one-in-N event can be replayed.

### Consistent is not the same as correct

A filesystem can be perfectly **consistent** and still **wrong**. Every block belongs to exactly one file, every count matches the bitmaps, `fsck` is clean, and the bytes handed back are not the bytes that were written. `fsck` can't see that by construction: there is nothing inconsistent to find. Only a check that knows what the bytes were supposed to be can catch it, such as the content oracle or `fio --verify`.

This is not hypothetical. On its first serious run, the content oracle found a bug of exactly this kind: hole-punching part of a preallocated range turned the rest of it into ordinary data, so blocks that had never been written began returning a deleted file's contents. `fsck` reported the volume clean throughout. It was fixed in 0.9.

So `fsck` clean is necessary, and never enough. The same rule applies when you [validate your own deployment](/docs/how-tos/validate-storage-stack/): at least one check that compares the data read back with the data written has to pass before a layer counts as clean.

## Bugs at one-in-millions odds

The 0.9 cycle showed why the tiers exist. It found data-corruption bugs that no code review, no conventional regression test and no `fsck` could have found: their windows are measured in microseconds, and their odds per operation in the millions.

- **An inode number freed while it was being reused.** The background scrubber's orphan reclaim read an inode record, saw the previous file's `nlink = 0`, and freed the inode, while a create was reusing that number. The window between the check and the free measured **378 microseconds**. The randomized churn compressed those odds to about one failure in three seeded runs on a 112-core machine. Because every block identifies itself, the failure didn't say "corruption": it said that a block of file 1 held file 196619's block 0, meaning two files shared one inode.
- **State inherited from a recycled object.** A per-inode field was initialized only when the kernel first created the object, not when it reused it for another file. So one file's state could leak into the next file to land in the same memory: it silently switched off that file's automatic defragmentation, and the same kind of inherited state was one step from corrupting data. It showed up only under full-gate load, never in an isolated run, and moved between five different suites before tracing pinned it down.
- **A test control that was itself a 1-in-256 flake.** An `fsck` check altered a journal payload by writing a constant byte, which matched the random byte already there one time in 256. The alteration then changed nothing, and the control failed falsely. It took dozens of full release runs to fire once.

What catches this class, in order of importance:

1. **Randomized workloads with a content oracle.** The churn doesn't test a behaviour; it samples the possible interleavings, and the self-identifying blocks turn "something is wrong" into a typed finding that names the files involved.
2. **Tracing compiled into the source.** Lifecycle probes for directory entries, inodes and blocks stay in the code, and turned the inode race from a statistical mismatch into a trace that named the code that freed it. They record like `trace_printk`, never like `printk`: a `printk` in the window closes it. The same bug vanished for 12 straight runs under `printk` probes and came back under tracing ones.
3. **Hostile-input fuzzing**, the only tier whose inputs are adversarial rather than probable.
4. **Negative controls on the detectors themselves.** In the same cycle, two extended-attribute assertions turned out to have passed for months without testing anything, on every machine missing the `attr` package: `setfattr: command not found` was read as a refusal. A test that can't fail is worse than no test, and that includes a test that doesn't run.

A race with a microsecond window inside a millisecond operation has odds around one in a million per try, even when the workload is trying to hit it. Nothing run once per release finds it. Repetition under randomized load, evidence kept on failure, and tracing that was already recording are the only instruments on which these bugs register at all.

Every data-corruption bug cetrafs has shipped so far was invisible to the deterministic suites, and was found only under randomized load with a content oracle.

## Opt-in tiers

These aren't part of `make check`, because they are slow, destructive, or need hardware the gate can't assume.

| Tier | What it does |
|---|---|
| `make soak` (`tests/stress/`) | Mixed-workload hammering with a full `fsck` after every round, a race between the scrubber and the allocator, and a large sparse file. |
| `tests/crash/` | Crash consistency. `dm-log-writes` records every write and `dm-flakey` cuts the device at an arbitrary point; the log is replayed to that point and checked. The filesystem must come back consistent from any cut, not just a tidy one. |
| `tests/fuzz/` | Hostile images. Fields across the superblock and the metadata are mutated, and both `fsck.cetra` and the mount must refuse them without crashing. |
| `tests/device/` | Destructive, on real hardware, explicitly opt-in. The only tier that exercises the real SCSI COMPARE AND WRITE: a loop device has none, so everything else runs the single-node fallback. |

## `ctest`: the multi-node suite

A node in cetrafs is a kernel with its own machine UUID, so real cross-node behaviour can't be simulated with two processes on one machine. `ctest` drives **two or more real machines against one shared LUN**, with about 67 scenarios. It needs at least two machines; a second rig, three nodes on a Fibre Channel multipath LUN, tests beyond that minimum. Only this tier can reach:

- the whole-file exclusive lock contended from two nodes at once, and `nofilelock` for live migration;
- Zone Group ownership: claiming, fairness, taking over from a node declared stale, and the lease that stops the stale node writing;
- the per-inode namespace lock under concurrent create, mkdir, rename and unlink storms from both sides;
- cache coherency across nodes: directory entries, extent leaves, inode-number reuse, races on inode records;
- a peer replaying a dead node's journal, and the queue that passes frees to another node's Zone Group;
- the real compare-and-write under contention, and what happens on a device that has none.

Several classes of bug in cetrafs's history could only be reached this way. That is why the project rule is that code review is the first filter, never the proof.

## What each fault class is caught by

Each of these has happened at least once:

| Fault | Caught by |
|---|---|
| Two files sharing a block | `fsck`, and the oracle names both files |
| Blocks in use but marked free | `fsck`, and the allocator's own detector |
| Leaked blocks (allocated, referenced by nothing) | `fsck`, and the background scrubber |
| A hole or preallocated range serving stale data | The content oracle only: `fsck` can't see it |
| Lost writes, dropped extents | The oracle: from the cache, after dropping it, and after a remount |
| Torn reads of a record during a concurrent update | Checksums, and the oracle's per-block tags |
| Stale caches across nodes | `ctest` only |
| Counters drifting from the bitmaps | `fsck` cross-checks every cached count |
| Unreachable inodes, dangling entries, wrong link counts | `fsck`'s namespace pass |
| A crash leaving an operation half-finished | Journal replay, and `tests/crash/` |
| A corrupt or hostile image | `tests/fuzz/`, against both `fsck` and mount |
| An inode number freed while it is being reused | The oracle names both files sharing it; tracing names the code that freed it |

## The rules the suites are held to

Learned the expensive way, and enforced by a check over the test sources:

1. **A test that can't fail is worse than no test.** Every detection a tool claims has a negative control that injects the fault and requires it to be caught. Test-only module parameters exist for exactly this: each one removes a single protection, so the suite can prove that *this* protection is what prevents the damage.
2. **The code under test must be the only path to what the test observes.** Otherwise a suite can pass because something else caught the fault first.
3. **A suite that proves nothing must say so**, not pass quietly. Suites that depend on a race happening assert that it actually happened.
4. **A green run of a low-probability test is not evidence.** Those tests are run repeatedly whenever the code they cover changes.
5. **`make check`, and nothing less, validates a change** to the kernel module or the userspace tools. The tools are not a smaller risk: almost every kernel suite calls `mkfs` or `fsck`.

## What isn't tested yet

The standard the Linux filesystem world is held to is **xfstests**: about 1,200 tests that gate ext4 and XFS, run across a matrix of block sizes, formats and features. Two things about it matter more than the count. It has collected one test for every bug shipped in twenty-five years, a corpus of other people's mistakes that no project can generate by itself. And much of it is driven by two randomized tools, `fsx` and `fsstress`.

cetrafs is ahead of it in three places: the content oracle, which names the class of fault instead of reporting a bad checksum; negative controls as a rule; and `ctest`, since xfstests has no cluster tier at all. Measured against it, these are the gaps, in the order the project plans to close them:

1. **No `fsx` or `fsstress`.** `fsx` runs random reads, writes, memory-mapped I/O, truncates and hole punches against an in-memory copy of the file, and compares after every operation. It is the tool most likely to have caught the preallocation bug above, in minutes. `fsstress` does the same for the namespace. The content oracle is a home-grown `fsx`, but it has no memory-mapped operations and checks against its own model rather than a reference copy. Both tools are planned, in `make soak` and in a nightly run.
2. **Memory-mapped data is barely covered.** The one `mmap` suite tests the cross-node lock, not the data. Untested: mappings over a hole or a preallocated range, coherency with concurrent `read`/`write`, `msync` ordering, page faults racing a truncate or a hole punch, and writeback of dirty mapped pages.
3. **No configuration matrix.** Everything runs at one block size, one geometry and one set of mount options. The most important missing configuration is the whole gate under `nofilelock`, which changes cluster semantics rather than tuning anything, and which has already produced two families of bugs.
4. **Crash coverage is one scenario.** With a journal and deferred updates, the interesting cut points are many: mid-punch, mid-truncate, mid-defragmentation, between marking a block allocated and the extent that refers to it.
5. **`ENOSPC` is hit by accident, not on purpose.** Running out of space in the middle of a multi-step operation, such as growing an extent tree, a defragmentation commit, journal reservation or writeback, is a classic source of corruption and is barely tested.
6. **The soak doesn't run unattended.** A fault that shows in one fill out of fifteen needs hours, not the 90 seconds the gate can afford. A nightly soak and a nightly long run of the content oracle, with several seeds, are planned.
7. **No verified I/O at scale.** There is some `O_DIRECT` in the oracle, but no large sequential verify, no mixing of direct and buffered I/O on one file, and no queue-depth pressure. VM images are exactly that workload.
8. **Large files and large offsets are thin.** There are suites for 16 TiB files, 8 TiB extents and depth-2 trees, but no systematic sweep of the boundaries.

Most of the 147 kernel suites are **regression** tests, one for each bug already found. That is why the gate is worth running, but it looks backwards. Every new bug found so far has been found by something randomized: the namespace fuzzer, the image fuzzers, `ctest`'s storms and the content oracle. So the plan is more random generators with better oracles, not more hand-written suites.

## Related

- [Run the test suites](/docs/how-tos/run-tests/)
- [Validate a storage stack before deployment](/docs/how-tos/validate-storage-stack/)
- [Checksums and integrity](/docs/concepts/integrity/)
- [Project status](/docs/intro/status/)
