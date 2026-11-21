---
weight: 437
title: "How cetrafs is tested"
linkTitle: "How it is tested"
description: "What the cetrafs test effort covers, how each tier works, how long a full run takes, and the results of the last validation run."
toc: true
---

A clustered filesystem rarely fails by crashing. It fails by returning the wrong bytes, on another node, after a crash, months after the write, on somebody's VM disk. That failure is silent, so the test effort is built to make it loud, and it is larger than the filesystem itself: about 128,000 lines of test code, 1.4 times the kernel module and tools combined.

To run the suites yourself, see [Run the test suites](/docs/how-tos/run-tests/). To validate your own installation, see [Validate a storage stack before deployment](/docs/how-tos/validate-storage-stack/).

## In numbers

| What | Count |
|---|---|
| Regression suites in the gate (`make check`) | **837**: 764 against a mounted kernel module, 73 against the tools alone |
| Assertions per full run | **about 6,600**, all of which must pass |
| Suites with a negative control | **631 of 764** kernel suites prove they fail without the protection they test |
| Fault switches in the module | **639** test-only switches, each removing exactly one protection |
| Two-node scenarios on real shared storage | **68**, on Fibre Channel multipath and iSCSI LUNs |
| Mechanical checks on the source code | **155** |
| Bug classes on file | **59**, each audited across the whole source tree |
| Faults `fsck.cetra` can name | **118** errors, each injected one at a time by a suite |
| Crash-consistency scenarios | 7, replaying every write up to an arbitrary cut |
| Fuzz campaigns per release | 4: hostile images against `fsck` and the mount, blind and field-aware |
| Performance invariants | 22, each guarded by a test that counts operations |
| Known open defects | **none** |

## How long it takes

| Run | Time |
|---|---|
| The tools alone (`make check-fsck`) | seconds |
| One suite (`make check-one`) | seconds to a few minutes |
| **The full gate (`make check`), on one machine** | **about 8 hours** |
| A release | the full gate twice, on a normal and a KASAN build, split across three machines; then the two-node release suite, the four fuzz campaigns, the crash rig, the configuration matrix and the soak |

The full gate is long because almost every suite builds its own volume from scratch, mounts it, and runs `fsck` at the end, and because the randomized suites need enough operations to hit rare interleavings.

## What a change has to pass

1. **Its own suite, failing first.** A fix comes with a suite that reproduces the fault. The fix is then removed, or its test switch flipped, and the suite must fail. A check that has never been seen to fail doesn't count as coverage.
2. **The full gate.** All 837 suites. Nothing ships on a red gate. A change to the userspace tools gets the whole gate too, because almost every kernel suite runs `mkfs` and `fsck`.
3. **The source checks.** 155 rules read from the code itself, below.
4. **The two-node suite on real hardware.** The only tier with real COMPARE AND WRITE, real cross-node caching and real node death.
5. **The release matrix.** Crash rig, fuzzers, soak, a KASAN build, and the suites again under `nofilelock`, other geometries and a small journal.

## The tiers

Each tier catches a class of fault the others structurally can't.

| Tier | What it does | What only it catches |
|---|---|---|
| Image suites | `mkfs.cetra` writes a volume, a helper damages one structure, `fsck.cetra` must name that fault and exit nonzero. No kernel involved. | The on-disk format contract, and every fault `fsck` claims to find |
| Kernel suites | One concern per suite, on a mounted volume: namespace, extent trees, `O_DIRECT`, `mmap`, `ENOSPC`, grow, discard, journal replay, scrub, defrag, locks, error handling | Every named behaviour, and every bug found so far |
| Content oracle | Many processes, random operations, page-cache pressure, fill-and-empty cycles. Every 4 KiB block it writes says which file, generation and offset it belongs to. | Wrong bytes nobody wrote a suite for, reported by kind |
| Model checkers | `fsx`, `fsstress` and `fio` with verification, each against an in-memory model | A sequence of correct operations that adds up to a wrong file |
| Crash rig | `dm-log-writes` records every write; the log is replayed to arbitrary cuts, including mid-flush and with a volatile cache | A reference that reached the disk before what it points at |
| Fuzzing | Mutated images, blind and field-aware with the checksum fixed so the hostile value passes validation | A disk value that aims an I/O, bounds a loop or sizes a copy before anything judged it |
| Sanitizers | KASAN, a clang build, and an endianness checker | Out-of-bounds access, use-after-free, a host-order value written to disk |
| Two-node suite (`ctest`) | Real machines on one shared LUN, scripted interleavings, device cuts, node kills | Everything cross-node: lock races, stale caches, a peer replaying a dead node's journal, fencing, a node behind a live grow |

## Every check is proven to fail

**A test that can't fail is worse than no test, because it reads as coverage.** So:

- **Negative controls are part of the suite.** 631 kernel suites name the switch that removes the protection they test, and run it: with the protection the damage doesn't happen, without it the same suite must see the damage. A control that doesn't fail is reported as a failure.
- **The setup is asserted, not assumed.** "No freed block holds the marker" passes trivially when the punch freed nothing. Such suites have a separate failing exit for "the situation wasn't arranged".
- **The concurrency is real.** A control for a race starts as many actors as the fix claims to serialise.
- **The code under test is the only path to what the test observes.** Test switches exist so that nothing else catches the fault first.

A packaged build (DKMS or Debian) refuses every one of these switches, so none can be turned on in production.

## Bugs are filed by class

A fixed bug is one instance. The project keeps a registry of 59 bug classes, each phrased as the question that would have found it:

- *Is every read inside a read-decide-write forced fresh from the device?*
- *Does a cache keyed by a reusable number carry a generation?*
- *What does `nofilelock` remove from this safety argument?*
- *Is a value read off the disk a count, a length or an address, and which paths validate it?*
- *What drains this asynchronous work before what it uses is freed?*

An audit runs one pass per class and reports on every class: findings, or what was examined and found clean. A bug that fits no class becomes a new one, with a sweep of the tree for its siblings and a check that finds the next one mechanically.

## The source is checked, not only the behaviour

Some properties are cheaper to prove from the code than to provoke. The source checks run on every gate, and each one has a planted violation it must catch:

- no sleeping call under a spinlock;
- every work item, timer and callback is listed with what drains it before unmount;
- every loop in the allocator's critical sections reschedules;
- every disk address goes through the one checked lookup;
- every test switch logs and taints the kernel when set.

## Consistent is not the same as correct

A filesystem can be perfectly consistent and still wrong: one owner per block, every count matching the bitmaps, `fsck` clean, and a file returning another file's deleted data. That happened once, in 0.8.x, and `fsck` reported the volume clean throughout, because there was nothing inconsistent to find.

So consistency is only half the bar. The **content oracle** checks every block it wrote: from the cache, after dropping the cache, and after a remount. Because each block says what it should contain, a mismatch reports what went wrong, not just that something did:

| The block holds | Meaning |
|---|---|
| Another file's tag | Two files share a block |
| This file, an older generation | A lost update, or a stale extent |
| Zeros where data belongs | A dropped extent |
| The right tag, the wrong payload | A torn write |
| Data where a hole belongs | A freed or preallocated range serving stale blocks |

The randomized model checkers do the same from other angles: `fsx` runs buffered, mapped and direct I/O, truncate, preallocation and hole punching against a copy of the file kept in memory; `fsstress` runs namespace operations from several processes; `fio` verifies a large sparse file written by buffered and direct jobs at once. Each has a negative control that corrupts the model and requires the run to fail.

## Races at one-in-a-million odds

The bugs that matter most have windows of microseconds and odds per operation in the millions. Code review doesn't find them and a fixed-shape suite doesn't provoke them. The background scrubber once freed an inode number while a create was reusing it, in a window measured at 378 microseconds. The content oracle found it, at about one failure in three seeded runs on a 112-core machine, and the failure named the two files that shared the inode instead of reporting "corruption".

What catches this class is repetition under randomized load, evidence kept on failure (the seed, the recent operations of every writer, the volume image), and tracing compiled into the source that is already recording when the race lands.

## Two nodes, real storage

A cetrafs node is a kernel with its own identity, so cross-node behaviour can't be simulated with two processes on one machine. `ctest` drives real machines against one shared LUN, on Fibre Channel multipath and iSCSI rigs with two and three nodes, arm64 and amd64. It:

- races the file lock, the namespace lock, Zone Group claims and the inode bitmap from every node through real COMPARE AND WRITE;
- pulls a node's device in the middle of writes, then checks that a survivor takes its files over, replays its journal, and reads back only whole writes;
- grows the volume on one node while another node is behind the grow;
- runs namespace storms, hypervisor-shaped mixed I/O and a randomized namespace fuzzer from every node at once;
- refuses to start unless every node runs a module built from the same source.

Several classes of bug in the project's history were unreachable without it. That is why code review is the first filter, never the proof.

## Configurations, soak and performance

- **The configuration matrix** runs a slice of the kernel suites under `nofilelock`, 1 GiB Block Groups, four Zone Groups and an 8 MiB journal. `nofilelock` changes cluster semantics, not just tuning, and has produced two families of bugs.
- **The soak** runs `fsx`, `fsstress` and the content oracle in their long modes, unattended, with `fsck` after every round, and fails on any anomalous round.
- **Performance is a tested property.** A loop device serves "uncached" reads from the host's memory and has no compare-and-write, so a timing test on it measures nothing. Instead, 22 invariants (a checksum, a lock or a device read kept off a path that runs tens of thousands of times a second) are each guarded by a test that counts operations rather than timing them, and each was measured on real SAN hardware.

## The last validation run

On the {{< version >}} format, 2026-11-19:

| Stage | Result |
|---|---|
| Full gate, 837 suites | **6,623 assertions passed, 0 failed** |
| Two-node release suite, FC multipath LUN | **41 of 41** passed; 4 more need two survivors of a dead node and run on the three-node rig |
| Fuzzing `fsck`, blind and field-aware | 3,000 + 3,000 iterations, 0 findings |
| Fuzzing the mount, blind and field-aware | 300 + 300 hostile images, 0 findings, no kernel warning |
| KASAN build, full gate | 0 reports |

Every failure that run found was fixed in the same series, each with a suite that fails without the fix. Three of them were found only by the two-node tier.

## What the tests can't show

- **Your array's write cache.** cetrafs orders its writes with cache flushes. An array that acknowledges a flush before the data is safe breaks that ordering, and no test on the host can detect it. [Validate the storage stack](/docs/how-tos/validate-storage-stack/) checks it with a power cut.
- **Hardware not in the lab.** The two-node suite has run on the arrays listed in [Project status](/docs/intro/status/#validated-on). Reports from other arrays are welcome, as [issues](https://github.com/cetrafs/cetrafs/issues) or in [Discussions](https://github.com/cetrafs/cetrafs/discussions).
- **Big-endian hosts.** The format is written to be portable and an endianness checker runs on every build, but no big-endian machine has run the suites.

## Related

- [Run the test suites](/docs/how-tos/run-tests/)
- [Validate a storage stack before deployment](/docs/how-tos/validate-storage-stack/)
- [Checksums and integrity](/docs/concepts/integrity/)
- [Project status](/docs/intro/status/)
