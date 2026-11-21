---
weight: 385
title: "Validate a storage stack before deployment"
description: "Prove each layer, from the raw LUN up to live-migrating VMs, before the next, so a fault can always be traced to the layer that caused it."
toc: true
---

Before the first deployment, check what cetrafs can't check for itself: that your array and the way it is presented to the hosts behave as cetrafs assumes. And if a guest filesystem ever gets corrupted, the cause could be the array, the fabric, a hypervisor presenting the LUN, cetrafs, qemu or the guest. The way to keep that answerable is to **prove each layer clean before testing the one above it**.

| Layer | What | Trust |
|---|---|---|
| L0 | SAN array, fabric, HBA | Mature |
| L1 | How the LUN is presented to the hosts (direct, RDM, passthrough) | Mature code; **the configuration is the risk** |
| L2 | cetrafs, single node | Tested before every release; check it on your storage |
| L3 | cetrafs, whole cluster | Tested before every release; check it on your storage |
| L4 | Proxmox/qemu with VM images on cetrafs | Mature |
| L5 | Guest OS and application | |

This is about **your** deployment. The automated suites that gate every cetrafs release are described in [How cetrafs is tested](/docs/concepts/testing/). L0 and L1 matter most: they check the two properties of your SAN that cetrafs depends on and can't verify itself.

## L0: the raw LUN

Present the LUN to one host and test the block device directly, with no cetrafs.

```sh
fio --name=v --filename=/dev/sdX --rw=randrw --bs=4k --iodepth=32 --size=20G \
    --verify=crc32c --verify_fatal=1 --runtime=2h --time_based
```

Then test power-loss durability: run a `diskchecker.pl`-style client writing with `fsync`, cut power, reboot, verify.

**Pass:** zero verify errors and zero loss of `fsync`ed data. If this fails, stop. The array cache doesn't honour flushes, and nothing built on top of it can be sound. cetrafs orders every metadata write with cache flushes, so this is the property it relies on most.

## L1: shared presentation

On **each** host, against the device cetrafs will use:

1. **Atomic CAW reaches the host.** [Probe it](/docs/how-tos/check-caw/) and require `max_caw_blocks >= 1` everywhere. If it reads `0`, a hypervisor in the path isn't passing SCSI ATS through.
2. **Hosts see each other's writes.** Nothing between the hosts and the array may cache the device per host:

   ```sh
   # host A
   dd if=/dev/urandom of=/dev/sdX bs=512 count=1 seek=1000000 oflag=direct
   dd if=/dev/sdX bs=512 count=1 skip=1000000 iflag=direct | md5sum
   # host B
   blockdev --flushbufs /dev/sdX
   dd if=/dev/sdX bs=512 count=1 skip=1000000 iflag=direct | md5sum   # must match A
   ```

3. **Flushes are honoured.** No write cache in the path may absorb them.

**Pass:** CAW on every host, and reads that agree across hosts. These are the only L1 properties cetrafs depends on. Verify them; don't assume them.

## L2: cetrafs on one node

Mount on one host only.

- `fio --verify=crc32c --fsync=16 --runtime=6h` on a file on cetrafs.
- `fsstress` inside a guest filesystem image stored on cetrafs.
- Power loss: run a `diskchecker.pl`-style client against a cetrafs file, then `echo b > /proc/sysrq-trigger`, remount, verify, and run `fsck.cetra` offline.
- The content oracle, `tests/kernel/churn_oracle.sh` from the source tree, with several seeds (`CHURN_SEED`) and more rounds (`CHURN_ROUNDS`). It builds its volume as a loop image in `CT_IMG_DIR`; point that at a directory on the storage under test. It is the only check here that compares every block read back with what was written, from the cache, after dropping it, and after a remount.
- After every run: `fsck.cetra <dev>` must be clean.

**Pass:** no verify errors, no loss of `fsync`ed data, `fsck` clean once the volume has been mounted again after the crash (leaked blocks the scrubber hasn't reclaimed yet are expected), and the content oracle clean across seeds.

## L3: the cluster

Mount on every node.

- Run `fio --verify=crc32c` on all nodes at once, each on its own files.
- Power off one node in the middle of a write. The survivors must stay clean, the dead row must be reclaimed, and `fsck.cetra --live` must come back clean.
- Pull every path on one node for longer than the stale window. It must stop itself (`stopped: lease`), and its peers must take over its files only after that.
- Fill the volume to about 100% and keep writing. You should get a clean `ENOSPC` and no corruption.
- On every node, watch `dmesg | grep -i cetrafs` (any `EUCLEAN`, `WARNING` or `BUG` is a finding) and `/proc/fs/cetrafs/<dev>/info`: `cas_miscompares` must rise under contention, `free_data_blocks` must not drift, and `fsck_needed` must stay `no`.

The multi-node test suite (`ctest/`) belongs at this layer. See [Run the test suites](/docs/how-tos/run-tests/).

## L4: VMs on cetrafs

`cache=none` disks on a `nofilelock` mount.

- Run `fio --verify=crc32c --fsync=16` inside a guest.
- Live-migrate the VM **while** guest fio runs. The migration must complete with zero verify errors.
- Snapshot, migrate, delete the snapshot, all under load. The VM must boot, its data must be intact, and fsck must be clean.
- Migrate back and forth 50 times under load.

## L5: full stack with HA

Run everything above at once, as a soak, with Proxmox HA fencing enabled.

- Kill a node that is running VMs. HA must restart them on survivors, and their images must be intact.
- Cut a node off the network. HA must fence it, and it must not keep writing.
- If your HA agent declares fenced hosts dead to cetrafs, check that the VMs restart without waiting for the stale window.

## Bisecting a symptom

| Symptom | Reproduce at | Clean there → | Dirty there → |
|---|---|---|---|
| Guest filesystem corruption | L2 | Look at L3, L4, or L1 coherency | cetrafs single-node, or L0/L1 |
| Data lost after a power cut | L0, then L2 | L0 clean and L2 lost: cetrafs flush handling | L0 lost: the array cache isn't durable |
| Corruption only after migration or concurrent use | L1 coherency and CAW checks | Both fine: cetrafs at L3 | Hypervisor caching or no ATS, below cetrafs |
| Two nodes writing at once (split-brain) | L1 CAW, HA fencing | CAW fine, no fencing: fix the HA configuration | `max_caw_blocks=0`: ATS not passed through |
| Leaked space in fsck | L3 | | Check `scrub_reclaimed` is rising; otherwise report it |
| A guest reads data it never wrote | L2, with the content oracle | Look at L3 and L4 | cetrafs. **`fsck` won't catch this**: see below |
| Slow metadata operations | Expected | Each metadata operation costs real device round trips. Not a bug. | |

## fsck clean is not the same as data correct

A filesystem can be perfectly **consistent** and still return the wrong bytes. In 0.8.x, hole-punching part of a preallocated range dropped its "never written" mark, so blocks that had never been written began returning a deleted file's contents. Throughout, `fsck.cetra` reported the volume clean: one owner per block, every count matching the bitmaps, no overlap, no leak. There was nothing inconsistent to find.

So at every layer, `fsck` clean is necessary and never enough. Only a check that knows what the bytes were supposed to be can catch this kind of fault, such as `fio --verify` or the content oracle at L2, and at least one of them has to pass before a layer counts as clean.
